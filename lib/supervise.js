/**
 * Subagent supervision. Pure functions plus one dependency-injected supervisor,
 * so the whole thing is testable without the DSH runtime.
 *
 * Why this exists: a child agent can run for many minutes and never report back.
 * The host offers no "interrupt the main agent while it is busy" mechanism, and a
 * message sent to an idle agent only starts a new turn. So the plugin reads the
 * child's session log (no model tokens spent), summarizes it, and wakes the main
 * agent through `followup` at most once per interval for all children of that
 * parent. The main agent then decides whether to steer with send_message or leave
 * the child alone.
 *
 * Nothing here calls setInterval, imports a host package, or touches ctx: wiring
 * a timer, `readEvents`, `deliver` and the liveness checks is the host adapter's
 * job. The only thing this module knows about the host event log is the shape
 * handled by `eventName` / `eventData` / `eventSeq` / `eventTime` and the two
 * text extractors below, kept in one place because host fields may change.
 */

import { posix } from 'node:path'
import { SCOPE_KIND, coversPath, isNormalizedScope, normalizeScope } from './write-scope.js'

/**
 * `source.kind` the wiring should put on the queued message, so a second notice
 * for the same parent can be recognized as already pending.
 */
export const SUPERVISE_SOURCE_KIND = 'orchestrator-supervision'
export const SUPERVISION_NORMAL_TEXT = '巡检：正常'

/** Only plugin-authored supervision messages participate in a supervision turn. */
export function isSupervisionMessage(message) {
  return message?.source?.kind === SUPERVISE_SOURCE_KIND
}

/** Prefer the complete id list, retaining the sender fallback for older notices. */
export function getSupervisionChildIds(message) {
  const source = message?.source
  const ids = Array.isArray(source?.childIds) ? source.childIds : [source?.senderSessionId]
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.trim() !== ''))]
}

/** Mixed inbox batches must retain the semantics of their ordinary messages. */
export function isPureSupervisionBatch(messages) {
  return Array.isArray(messages) && messages.length > 0 && messages.every((message) => isSupervisionMessage(message))
}

/** Recognise a standalone declaration, never a sentence merely discussing it. */
export function hasNormalDeclarationText(assistantMessage) {
  const content = assistantMessage?.content
  if (!Array.isArray(content)) return false
  const isDeclaration = (line) =>
    line.trim().replace(/^[*_`]+/, '').replace(/[*_`。.!！]+$/, '').trim() === SUPERVISION_NORMAL_TEXT
  return content.some((part) => {
    if (part?.type !== 'text' || typeof part.text !== 'string') return false
    return part.text.split(/\r?\n/).some(isDeclaration)
  })
}

/** Defaults, filled in by the module because config may be partial. */
const DEFAULTS = Object.freeze({
  enabled: true,
  intervalSeconds: 600,
  maxNoticesPerChild: 3,
  unlimited: false,
  notifyOnNoProgress: false,
  repeatThreshold: 3,
  noticeMaxChars: 2000,
})

/** `lastText` is capped here, and a notice may shrink it further. */
const LAST_TEXT_MAX = 300

/**
 * Only the most recent tool calls are inspected for a loop. An old streak of
 * three identical calls should not keep warning forever after the child moved on.
 */
const REPEAT_WINDOW = 20

/** Candidate per-child text lengths tried before dropping children from a notice. */
const TEXT_LIMITS = [LAST_TEXT_MAX, 240, 180, 120, 80, 40, 0]

const NOTICE_HINT = [
  '请对每个子代理作出决定（以上子代理均仍在运行且尚未交付报告，本回合已硬禁止调用 todo_write）：',
  'A) 方向正确（无需干预）：严禁调用任何工具，仅回复一行「巡检：正常」并立刻结束本回合；',
  'B) 跑偏或打转：禁止回复「巡检：正常」，请直接用调研工具或 send_message 纠偏；',
  'C) 需中止或换路：禁止回复「巡检：正常」，请先说明原因并用中断/控制或已有工具调整执行路线。',
]

// ---------------------------------------------------------------------------
// Event adapters: the one place that knows the host field names.
// ---------------------------------------------------------------------------

/** `type` is what the session log uses today; `name` is accepted for older logs. */
function eventName(event) {
  const name = event?.type ?? event?.name ?? event?.kind
  return typeof name === 'string' ? name : undefined
}

/** Event payload. Missing or non-object payloads read as an empty object. */
function eventData(event) {
  const data = event?.data
  return data !== null && typeof data === 'object' ? data : {}
}

function eventSeq(event) {
  return asNumber(event?.seq)
}

/** Milliseconds since the epoch. Accepts a number, a Date, or a parseable string. */
function eventTime(event) {
  const time = event?.time
  const direct = asNumber(time)
  if (direct !== undefined) return direct
  if (time instanceof Date) {
    const ms = time.getTime()
    return Number.isFinite(ms) ? ms : undefined
  }
  if (typeof time === 'string') {
    const ms = Date.parse(time)
    return Number.isFinite(ms) ? ms : undefined
  }
  return undefined
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** The tool a `tool/call` names, if the event carries one. */
function toolName(event) {
  const data = eventData(event)
  const name = data.name ?? data.toolName ?? data.tool
  return typeof name === 'string' && name !== '' ? name : undefined
}

/**
 * The arguments of a `tool/call`. The session log shape is not declared as a
 * stable API, so the common spellings are accepted; when none is present the
 * call is compared by its tool name alone.
 */
function toolArgs(event) {
  const data = eventData(event)
  const keys = ['arguments', 'args', 'input', 'parameters', 'params', 'toolInput', 'tool_input']
  for (const key of keys) {
    if (data[key] !== undefined) return normalizeArgs(data[key])
  }
  return undefined
}

function normalizeArgs(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function toolSignature(event, name = toolName(event)) {
  return `${name}\u0000${stableKey(toolArgs(event) ?? null)}`
}

/** Stable string for an arbitrary JSON-ish value: object key order does not matter. */
function stableKey(value) {
  const seen = new WeakSet()
  const walk = (current) => {
    if (current === null) return 'null'
    const type = typeof current
    if (type === 'string') return JSON.stringify(current)
    if (type === 'number') return Number.isFinite(current) ? String(current) : JSON.stringify(String(current))
    if (type === 'boolean') return String(current)
    if (type === 'bigint') return `bigint:${current}`
    if (type === 'undefined') return 'undefined'
    if (type === 'function' || type === 'symbol') return `"${type}"`
    if (seen.has(current)) return '"[circular]"'
    seen.add(current)
    let text
    if (Array.isArray(current)) {
      text = `[${current.map(walk).join(',')}]`
    } else {
      const keys = Object.keys(current).sort()
      text = `{${keys.map((key) => `${JSON.stringify(key)}:${walk(current[key])}`).join(',')}}`
    }
    seen.delete(current)
    return text
  }
  try {
    return walk(value)
  } catch {
    return '"[unserializable]"'
  }
}

/**
 * Plain text out of an assistant message. Handles a string, a content array of
 * `{ type: 'text', text }` parts, and the `{ message: ... }` / `{ content: ... }`
 * wrappers the log may use. Non-text parts are ignored.
 */
function extractText(value, plainOnly = false) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    let text = ''
    for (const part of value) text += extractText(part, plainOnly)
    return text
  }
  if (value !== null && typeof value === 'object') {
    if (plainOnly && value.type !== undefined && value.type !== 'text') return ''
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (Array.isArray(value.content)) return extractText(value.content, plainOnly)
    if (value.message !== undefined) return extractText(value.message, plainOnly)
    if (typeof value.delta === 'string') return value.delta
  }
  return ''
}

function assistantText(event, plainOnly = false) {
  const data = eventData(event)
  for (const candidate of [data.message, data.text, data.content, data.delta]) {
    const text = extractText(candidate, plainOnly)
    if (text.trim() !== '') return text.trim()
  }
  return ''
}

/** Cut to `max` characters, ellipsis included in the limit. */
function clip(text, max) {
  if (typeof text !== 'string' || max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return '…'
  return `${text.slice(0, max - 1)}…`
}

/** Longest run of the same tool+arguments signature in the recent window. */
function maxRepeatCount(signatures) {
  const recent = signatures.slice(-REPEAT_WINDOW)
  let best = 0
  let run = 0
  let previous
  for (const signature of recent) {
    if (signature === previous) {
      run += 1
    } else {
      run = 1
      previous = signature
    }
    if (run > best) best = run
  }
  return best
}

// ---------------------------------------------------------------------------
// Runtime semantics, not a protocol for the worker's final report.
// ---------------------------------------------------------------------------

const DIAGNOSES = Object.freeze({
  scope_drift: ['high', '越界漂移'],
  error_loop: ['medium-high', '连续碰壁'],
  tool_loop: ['medium', '原地打转'],
  stalled: ['medium', '停滞无进展'],
  advancing: ['normal', '正常推进'],
})
const ERROR_WINDOW = 4
const ERROR_STREAK_WINDOW = 20
const ERROR_THRESHOLD = 3
const HOTSPOT_WINDOW = 6
const EVIDENCE_LIMIT = 4
const TARGET_KEYS = ['path', 'file_path', 'filePath', 'target', 'paths']
const EXPLICIT_OUTPUT_KEYS = ['output_path', 'outputPath', 'destination_path', 'destinationPath']
const OUTPUT_KEYS = [...EXPLICIT_OUTPUT_KEYS, 'destination', 'dest', 'to']
const WRITE_TOOL = /^(?:apply_patch|(?:write|edit|multi_edit|patch|delete|remove|create|append|replace|rename|move|copy)(?:_(?:file|files|directory|dir|text))?|mkdir|rmdir|file_(?:write|edit|patch|delete|move|copy))$/
const SHELL_TOOL = /^(?:bash|sh|shell|terminal|exec_command|run_command|powershell)$/
const LOOKUP_TOOL = /^(?:read(?:_file)?|read_image|glob|grep|list(?:_files|_directory)?|search(?:_files)?|web_fetch|web_search)$/

function toolLeaf(name) {
  return typeof name === 'string' ? name.split('__').at(-1).toLowerCase().replace(/-/g, '_') : ''
}

function oneLine(text, size = 120) {
  return typeof text === 'string' ? clip(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim(), size) : ''
}

function literalTarget(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[\u0000-\u001f]/.test(value)
}

function shellLiteral(token) {
  if (/^[<>&;|]/.test(token)) return undefined
  const target = token.replace(/^(['"])(.*)\1$/, '$2')
  if (!literalTarget(target) || /[$`*?'"%(){}]/.test(target) || /^~(?:[\\/]|$)/.test(target)) return undefined
  if (/^(?:\/dev\/|(?:nul|con|conout\$|conin\$)(?:[:.]|$))/i.test(target)) return undefined
  return target
}

/** Recognize literal redirections and simple write commands without evaluating shell text. */
function shellTargets(args) {
  const command = args?.command ?? args?.cmd
  if (typeof command !== 'string' || /[\r\n]|<<|\\[<>]/.test(command)) return { paths: [], changesDirectory: false }
  const tokens = command.match(/(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"<>;&|]+)+|>>?|[<;&|]+/g) ?? []
  const changesDirectory = tokens.some((token) => /^(?:cd|pushd|popd|Set-Location)$/i.test(token))
  const paths = []
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] !== '>' && tokens[index] !== '>>') continue
    const target = shellLiteral(tokens[index + 1])
    if (target !== undefined) paths.push(target)
  }

  const [program, ...operands] = tokens
  // Do not guess option values, expansion, or destinations of compound commands.
  if (/^(?:touch|mkdir|rmdir|rm|mv|cp)$/.test(program) && operands.length > 0 &&
    operands.every((token) => !token.startsWith('-') && shellLiteral(token) !== undefined)) {
    if (program === 'cp' && operands.length === 2) paths.push(shellLiteral(operands.at(-1)))
    else if (program !== 'cp' && (program !== 'mv' || operands.length === 2)) {
      paths.push(...operands.map(shellLiteral))
    }
  }
  return { paths, changesDirectory }
}

function writeIntent(name, args) {
  const leaf = toolLeaf(name)
  const writes = WRITE_TOOL.test(leaf)
  const keys = writes ? [...TARGET_KEYS, ...OUTPUT_KEYS] : EXPLICIT_OUTPUT_KEYS
  const targets = keys.flatMap((key) => [args?.[key]].flat()).filter(literalTarget)
  if (/^(?:move|rename)(?:_|$)|^file_move$/.test(leaf)) {
    targets.push(...[args?.source, args?.src, args?.from].filter(literalTarget))
  }
  if (leaf === 'apply_patch' || leaf === 'patch') {
    const patch = typeof args === 'string' ? args : args?.patch ?? args?.input
    if (typeof patch === 'string') {
      for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
        if (literalTarget(match[1].trim())) targets.push(match[1].trim())
      }
    }
  }
  const shell = SHELL_TOOL.test(leaf) ? shellTargets(args) : undefined
  if (shell) targets.push(...shell.paths)
  return {
    writes: writes || targets.length > 0,
    targets: [...new Set(targets)],
    changesDirectory: shell?.changesDirectory === true,
    workdir: shell ? args?.workdir ?? args?.cwd : undefined,
  }
}

function relativeKey(value, windows) {
  const path = posix.normalize(windows ? value.replace(/\\/g, '/') : value).replace(/\/$/, '')
  return windows ? path.toLowerCase() : path
}

const ROOTED_PATH = /^(?:[\\/]|[A-Za-z]:|~(?:[\\/]|$))/

function commandCwd(workdir, cwd) {
  if (!literalTarget(workdir)) return cwd
  const resolved = normalizeScope(workdir, cwd).entries?.[0]?.path
  // The scope helper emits portable slash-separated UNC paths; restore the flavour for its cwd input.
  return resolved?.startsWith('//') ? resolved.replace(/\//g, '\\') : resolved ?? workdir
}

/** Unknown cwd or an unresolvable target is not evidence of a boundary violation. */
function scopeCheck(writeScope, cwd) {
  const normalized = isNormalizedScope(writeScope) ? writeScope : normalizeScope(writeScope, cwd).entries
  if (normalized) {
    if (normalized.some(({ kind }) => kind === SCOPE_KIND.root)) return () => false
    return (target, targetCwd) => {
      const options = { cwd: targetCwd }
      return normalizeScope(target, options.cwd).ok && !coversPath(normalized, target, options)
    }
  }
  const entries = typeof writeScope === 'string' ? [writeScope] : writeScope
  if (cwd || !Array.isArray(entries) || entries.length === 0 || entries.some((entry) =>
    !literalTarget(entry) || ROOTED_PATH.test(entry) || /[*?]/.test(entry.replace(/[\\/]\*\*[\\/]*$/, ''))
  )) return () => false

  // Without a cwd, two relative paths still share a lexical coordinate system.
  return (target, targetCwd) => {
    if (targetCwd || ROOTED_PATH.test(target) || /[*?]/.test(target)) return false
    const windows = target.includes('\\') || entries.some((entry) => entry.includes('\\'))
    const key = relativeKey(target, windows)
    return !entries.some((entry) => {
      const dir = /[\\/](?:\*\*[\\/]*)?$/.test(entry)
      const base = relativeKey(entry.replace(/[\\/]\*\*[\\/]*$/, '') || '.', windows)
      if (base === key) return dir || !/[\\/]$/.test(target)
      if (!dir) return false
      if (base === '.') return key !== '..' && !key.startsWith('../')
      return key.startsWith(`${base}/`)
    })
  }
}

function resultMarker(event, tool) {
  const data = eventData(event)
  const blocks = [data, data.result, data.output, data.message, data.meta, data.result?.meta]
  const forced = eventName(event) === 'tool/error' || blocks.some((block) =>
    block?.isError === true || block?.is_error === true || block?.success === false || block?.ok === false ||
    Boolean(block?.error)
  )
  const knownLookupSuccess = !forced && LOOKUP_TOOL.test(toolLeaf(tool)) && blocks.some((block) =>
    block?.isError === false || block?.is_error === false || block?.success === true || block?.ok === true
  )
  for (const block of blocks) {
    const code = asNumber(block?.exitCode ?? block?.exit_code)
    if (code !== undefined && code !== 0) return `[exit code: ${code}]`
    // A successful read/search can legitimately return source code containing error markers.
    if (knownLookupSuccess) continue
    const text = extractText(block, true) || extractText(block?.output, true) || extractText(block?.stderr, true)
    for (const match of text.matchAll(/\[exit code:\s*(-?\d+)\s*\]/gi)) {
      if (Number(match[1]) !== 0) return `[exit code: ${match[1]}]`
    }
    const marker = text.match(/\b(?:ENOENT|EACCES|FAILED)\b|\b(?:[A-Za-z]+)?Error:/)
    if (marker) return marker[0]
  }
  if (forced) {
    const code = data.error?.code ?? data.result?.error?.code
    return typeof code === 'string' && /^[A-Z0-9_-]+$/.test(code) ? oneLine(code, 48) : '工具错误标记'
  }
  return undefined
}

function callIdentity(data) {
  return data.callId ?? data.toolCallId ?? data.tool_call_id ?? data.message?.toolCallId ?? data.message?.source?.callId
}

function remember(list, item, max) {
  if (list.length === max) list.shift()
  list.push(item)
}

function trailingCount(items, matches) {
  let count = 0
  for (let index = items.length - 1; index >= 0 && matches(items[index]); index -= 1) count += 1
  return count
}

/**
 * Classify an ordered, parsed runtime log without I/O, clocks or report tags.
 * `prevSummary` is the preceding scan's summary (or just its `lastSeq`); `elapsedMs`
 * is the time since that scan, or since the worker began on its first inspection.
 * Optional `now`/`startedAt` let the first scan use timestamps rather than guessing
 * wall time. `runSinceSeq` excludes activity before a cold resume.
 */
export function classifyProgress(events, context = {}) {
  const {
    writeScope, readOnly, cwd, prevSummary, elapsedMs, now, startedAt,
    sinceSeq, runSinceSeq, repeatThreshold, stalledAfterMs,
  } = context ?? {}
  const runSince = asNumber(runSinceSeq)
  const since = asNumber(prevSummary?.lastSeq ?? sinceSeq) ?? runSince
  const watchFrom = since !== undefined && runSince !== undefined ? Math.max(since, runSince) : since
  const checkScope = scopeCheck(writeScope, cwd)
  const calls = []
  const results = []
  const violations = []
  const inFlight = new Map()
  let lastCall
  let lastText = ''
  let lastTextOrder = -1
  let lastProgressAt = asNumber(startedAt)
  let progressed = false
  let scopeViolations = 0
  let order = 0

  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const seq = eventSeq(event)
    if (runSince !== undefined && seq !== undefined && seq <= runSince) continue
    const data = eventData(event)
    const type = eventName(event)
    const fresh = watchFrom === undefined || seq === undefined || seq > watchFrom
    order += 1

    if (type === 'tool/call') {
      const tool = toolName(event)
      if (!tool) continue
      const call = { seq, tool, order, event }
      remember(calls, call, REPEAT_WINDOW)
      const id = callIdentity(data)
      if (id !== undefined) inFlight.set(id, call)
      lastCall = call
      if (fresh && (readOnly === true || writeScope !== undefined)) {
        const args = toolArgs(event)
        const { writes, targets, changesDirectory, workdir } = writeIntent(tool, args)
        const targetCwd = commandCwd(workdir, cwd)
        const bad = readOnly === true && writes ? (targets.length ? targets : [undefined])
          : changesDirectory ? [] : targets.filter((target) => checkScope(target, targetCwd))
        for (const target of bad) {
          scopeViolations += 1
          remember(violations, { seq, tool, target: target === undefined ? undefined : oneLine(target) }, EVIDENCE_LIMIT)
        }
      }
    } else if (type === 'tool/result' || type === 'tool/error') {
      const id = callIdentity(data)
      const call = id === undefined ? lastCall : inFlight.get(id)
      const tool = toolName(event) ?? call?.tool
      if (id !== undefined) inFlight.delete(id)
      remember(results, { seq, tool, event }, ERROR_STREAK_WINDOW)
    } else if (type === 'assistant/message' || type === 'assistant/delta') {
      const text = assistantText(event, true).replace(/\s+/g, ' ')
      if (text === '' || text === lastText) continue
      lastText = text
      lastTextOrder = order
    } else if (type !== 'step/start' && type !== 'step/end' && type !== 'turn/start') {
      continue
    }
    const time = eventTime(event)
    if (time !== undefined) lastProgressAt = Math.max(lastProgressAt ?? time, time)
    if (fresh) progressed = true
  }

  for (const call of calls) call.signature = toolSignature(call.event, call.tool)
  const outcomes = results.map(({ seq, tool, event }) => ({ seq, tool, marker: resultMarker(event, tool) }))
  const lastResult = outcomes.at(-1)
  const lastSignature = calls.at(-1)?.signature
  const errorStreak = trailingCount(outcomes, ({ marker }) => marker !== undefined)
  const repeatStreak = trailingCount(calls, ({ signature }) => signature === lastSignature)
  const metrics = { errorStreak, repeatStreak, scopeViolations, toolCallsInWindow: calls.length }
  const diagnostic = (status, reason, evidence = []) => {
    const [severity, label] = DIAGNOSES[status]
    return { status, severity, label, reason, evidence, metrics }
  }

  if (scopeViolations > 0) {
    const { tool, target } = violations.at(-1)
    const detail = target ? `（目标：${target}）` : ''
    const reason = readOnly === true ? `只读子代理调用了 ${oneLine(tool, 48)}${detail}`
      : `${oneLine(tool, 48)} 的写入目标不在声明作用域内${detail}`
    return diagnostic('scope_drift', reason, violations)
  }
  const recentOutcomes = outcomes.slice(-ERROR_WINDOW)
  const failures = recentOutcomes.filter(({ marker }) => marker !== undefined)
  if (lastResult?.marker !== undefined && failures.length >= ERROR_THRESHOLD) {
    const description = errorStreak >= ERROR_THRESHOLD ? `最近连续 ${errorStreak} 次工具结果失败`
      : `最近 ${recentOutcomes.length} 次工具结果中 ${failures.length} 次失败，最新一次仍未恢复`
    const tool = lastResult.tool ? `${oneLine(lastResult.tool, 48)}：` : ''
    return diagnostic('error_loop', `${description}（${tool}${lastResult.marker}）`, failures)
  }
  const threshold = positiveInteger(repeatThreshold, DEFAULTS.repeatThreshold)
  const callEvidence = ({ seq, tool }) => ({ seq, tool })
  if (repeatStreak >= threshold) {
    const tool = oneLine(lastCall.tool, 48)
    return diagnostic('tool_loop', `检测到同一工具调用连续重复 ${repeatStreak} 次，可能原地打转（${tool}）`,
      calls.slice(-Math.min(repeatStreak, EVIDENCE_LIMIT)).map(callEvidence))
  }
  const hotspot = calls.slice(-Math.max(HOTSPOT_WINDOW, 2 * threshold))
  if (hotspot.length >= Math.max(HOTSPOT_WINDOW, 2 * threshold) && hotspot[0].order > lastTextOrder &&
    hotspot.every(({ tool }) => LOOKUP_TOOL.test(toolLeaf(tool)))) {
    const counts = new Map()
    for (const { signature } of hotspot) counts.set(signature, (counts.get(signature) ?? 0) + 1)
    if (counts.size <= 2 && [...counts.values()].every((count) => count >= threshold)) {
      return diagnostic('tool_loop', `最近 ${hotspot.length} 次工具调用反复查询 ${counts.size} 组相同参数，期间无新文本推进`,
        hotspot.slice(-EVIDENCE_LIMIT).map(callEvidence))
    }
  }

  const elapsed = asNumber(elapsedMs)
  const at = asNumber(now)
  const idleFor = at !== undefined && lastProgressAt !== undefined ? Math.max(0, at - lastProgressAt) : undefined
  // A still-running tool gets one additional window; a newly completed tool counts as progress.
  const patience = positiveNumber(stalledAfterMs, DEFAULTS.intervalSeconds * 1000) * (inFlight.size > 0 ? 2 : 1)
  const quietLongEnough = !progressed && (elapsed === undefined ? prevSummary !== undefined : elapsed >= patience)
  if (quietLongEnough || (idleFor !== undefined && idleFor >= patience)) {
    const duration = idleFor ?? elapsed
    const span = duration === undefined ? '自上次巡检以来' : `近 ${formatDuration(duration)} 内`
    return diagnostic('stalled', `${span}未观察到新增工具调用、有效步骤或文本推进`,
      [{ lastProgressAt, idleMs: duration, inFlightTools: inFlight.size }])
  }
  return diagnostic('advancing', '未发现明显异常推进模式')
}

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

/**
 * Summarize a child's event log.
 *
 * Total counts (`turns`, `steps`, `lastText`, `repeated`) cover the whole log;
 * `toolCalls` and `newEvents` cover only events with `seq > sinceSeq`. `repeated`
 * is computed over the latest `REPEAT_WINDOW` `tool/call` events, so a streak in
 * the distant past stops warning once the child moves on.
 *
 * Missing fields are tolerated: an absent `seq` simply cannot be "new", and an
 * absent `time` leaves the corresponding timestamp undefined. `semantic` adds
 * a runtime diagnosis and accepts the optional `classifyProgress` context.
 */
export function summarize(events, { sinceSeq = 0, now, startedAt, ...context } = {}) {
  const list = Array.isArray(events) ? events : []
  const since = asNumber(sinceSeq) ?? 0
  const at = asNumber(now) ?? Date.now()
  const started = asNumber(startedAt)

  let turns = 0
  let steps = 0
  let toolCalls = 0
  let newEvents = 0
  let lastSeq = 0
  let lastActivityAt
  let lastTool
  let lastToolAt
  let lastText = ''
  const recentCalls = []

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const name = eventName(event)
    const seq = eventSeq(event)
    const time = eventTime(event)

    if (seq !== undefined) {
      if (seq > lastSeq) lastSeq = seq
      if (seq > since) newEvents += 1
    }
    if (time !== undefined && (lastActivityAt === undefined || time > lastActivityAt)) {
      lastActivityAt = time
    }

    if (name === 'turn/start') {
      turns += 1
    } else if (name === 'step/start') {
      steps += 1
    } else if (name === 'tool/call') {
      if (seq !== undefined && seq > since) toolCalls += 1
      const tool = toolName(event)
      if (tool !== undefined) {
        lastTool = tool
        lastToolAt = time
        remember(recentCalls, { event, tool }, REPEAT_WINDOW)
      }
    } else if (name === 'assistant/message') {
      const text = assistantText(event)
      if (text !== '') lastText = clip(text, LAST_TEXT_MAX)
    }
  }

  return {
    turns,
    steps,
    runMs: started === undefined ? 0 : Math.max(0, at - started),
    toolCalls,
    lastTool,
    lastToolAt,
    repeated: maxRepeatCount(recentCalls.map(({ event, tool }) => toolSignature(event, tool))),
    lastText,
    lastSeq,
    lastActivityAt,
    newEvents,
    semantic: classifyProgress(list, {
      ...context,
      sinceSeq: since,
      now,
      startedAt: started,
      elapsedMs: context.elapsedMs ?? (started === undefined ? undefined : Math.max(0, at - started)),
    }),
  }
}

// ---------------------------------------------------------------------------
// composeNotice
// ---------------------------------------------------------------------------

function positiveInteger(value, fallback) {
  const number = asNumber(value)
  if (number === undefined || number <= 0) return fallback
  return Math.floor(number)
}

function nonNegativeInteger(value, fallback) {
  const number = asNumber(value)
  if (number === undefined || number < 0) return fallback
  return Math.floor(number)
}

function formatDuration(ms) {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, '0')}s`
  }
  return `${seconds}s`
}

function renderRow(row, number, textLimit, at, threshold) {
  const childId = typeof row.childId === 'string' && row.childId !== '' ? row.childId : '(未知)'
  const label = typeof row.label === 'string' && row.label !== '' ? row.label : '未命名'

  const started = asNumber(row.startedAt)
  const runMs = started === undefined ? 0 : Math.max(0, at - started)
  if (row.kind === 'sibling') {
    const status = row.status ?? '同行在跑，本拍仅展示'
    return [
      `${number}) 子代理 ${childId}（${status}）`,
      `   任务：${label} ｜ 已运行 ${formatDuration(runMs)}`,
    ].join('\n')
  }

  const turns = nonNegativeInteger(row.turns, 0)
  const steps = nonNegativeInteger(row.steps, 0)
  const toolCalls = nonNegativeInteger(row.toolCalls, 0)
  const repeated = nonNegativeInteger(row.repeated, 0)
  const tool = typeof row.lastTool === 'string' && row.lastTool !== '' ? row.lastTool : '无'
  const lastText = typeof row.lastText === 'string' ? row.lastText : ''

  const lines = [
    `${number}) 子代理 ${childId}（仍在运行，尚未交付报告）`,
    `   任务：${label}`,
    `   已运行 ${formatDuration(runMs)} ｜ 轮次 ${turns} ｜ 步骤 ${steps}`,
    `   自上次巡检新增工具调用 ${toolCalls} 次 ｜ 最近工具：${tool}`,
  ]
  if (lastText !== '' && textLimit > 0) {
    lines.push(`   最后输出：${clip(lastText, textLimit)} [仅最新文本前${textLimit}字摘录，不代表最终成败]`)
  }
  const semantic = row.semantic
  if (semantic && semantic.status !== 'advancing') {
    lines.push(`   语义诊断：[${oneLine(semantic.label, 24)}] ${oneLine(semantic.reason, 200)}`)
  } else if (!semantic && repeated >= threshold) {
    // Rows from older callers still get their original warning.
    lines.push(`   ⚠ 检测到同一工具调用连续重复 ${repeated} 次，可能原地打转`)
  }
  if (row.newEvents === 0) {
    lines.push('   （自上次巡检无新活动）')
  }
  return lines.join('\n')
}

/**
 * Build one parent's panoramic notice. Legacy rows without `kind` are treated
 * as triggers. Trim excerpts first, then omit siblings before triggers.
 * The unabridged running and sibling rows remain available to the delivery adapter.
 * `index`/`max` describe the trigger budget (`max = 0` means unlimited).
 */
export function composeNotice(rows, { now, index, max, maxChars = 2000, repeatThreshold = 3 } = {}) {
  const at = asNumber(now) ?? Date.now()
  const noticeIndex = positiveInteger(index, 1)
  const noticeMax = nonNegativeInteger(max, 0)
  const limitChars = positiveInteger(maxChars, DEFAULTS.noticeMaxChars)
  const threshold = positiveInteger(repeatThreshold, DEFAULTS.repeatThreshold)
  const allRows = Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object') : []
  // Ignore legacy attention rows rather than presenting ended children as running.
  const triggers = allRows.filter((row) => row.kind !== 'attention' && row.kind !== 'sibling')
  const siblings = allRows.filter((row) => row.kind === 'sibling')
  const orderedRows = [...triggers, ...siblings]

  const header =
    noticeMax > 0
      ? `【插件巡检｜第 ${noticeIndex}/${noticeMax} 次】以下内容由 dsh-orchestrator 自动生成，不是用户消息。`
      : `【插件巡检｜第 ${noticeIndex} 次】以下内容由 dsh-orchestrator 自动生成，不是用户消息。`

  const build = (keep, textLimit) => {
    const parts = [header]
    for (let i = 0; i < keep; i += 1) {
      parts.push(renderRow(orderedRows[i], i + 1, textLimit, at, threshold))
    }
    const dropped = orderedRows.length - keep
    if (dropped > 0) parts.push(`另有 ${dropped} 个子代理未列出。`)
    parts.push(...NOTICE_HINT)
    return parts.join('\n')
  }

  for (let keep = orderedRows.length; keep >= 1; keep -= 1) {
    for (const textLimit of TEXT_LIMITS) {
      const candidate = build(keep, textLimit)
      if (candidate.length <= limitChars) return candidate
    }
  }

  // Either there are no rows, or even one row with no summary text is too long.
  const tail = build(0, 0)
  return tail.length <= limitChars ? tail : tail.slice(0, limitChars)
}

// ---------------------------------------------------------------------------
// createSupervisor
// ---------------------------------------------------------------------------

function readConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: source.enabled !== false,
    intervalSeconds: positiveNumber(source.intervalSeconds, DEFAULTS.intervalSeconds),
    maxNoticesPerChild: nonNegativeInteger(source.maxNoticesPerChild, DEFAULTS.maxNoticesPerChild),
    unlimited: source.unlimited === true,
    notifyOnNoProgress: source.notifyOnNoProgress === true,
    repeatThreshold: positiveInteger(source.repeatThreshold, DEFAULTS.repeatThreshold),
    noticeMaxChars: positiveInteger(source.noticeMaxChars, DEFAULTS.noticeMaxChars),
  }
}

function positiveNumber(value, fallback) {
  const number = asNumber(value)
  if (number === undefined || number <= 0) return fallback
  return number
}

function intervalMsOf(config) {
  return Math.max(1, Math.round(config.intervalSeconds * 1000))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The stateful half. Every host capability is injected:
 *
 * - `config`: an object or a synchronous getter keyed by parent ID. It is read
 *   when tracking, restoring, and inspecting children; missing fields use `DEFAULTS`.
 *   `intervalSeconds` is the minimum age before a child can trigger a notice.
 * - `now()`, `isParentAlive(parentId)`, `isChildAlive(childId)`,
 *   `readEvents(childId)`, `hasPendingNotice(parentId)`, optional
 *   `hasActiveSupervisionTurn(parentId)`,
 *   `deliver(parentId, text, childIds, { rows, composeMeta })`, `logger`.
 *   The adapters other than `now` may return a value or a Promise.
 * - `deliver` receives active child ids only. `sibling` rows are display-only.
 * - `track` accepts optional child metadata: `writeScope`, `readOnly`, `cwd`.
 *
 * `tick` never throws because of one child or parent: read, summarize, pending
 * check and delivery failures are logged and skipped (or retried next interval).
 * Two overlapping ticks are serialized by an in-progress flag, so one interval
 * can never produce two notices.
 */
export function createSupervisor(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const entries = new Map()
  let ticking = false

  const logger = opts.logger !== null && typeof opts.logger === 'object' ? opts.logger : {}
  const warn = (message) => {
    try {
      if (typeof logger.warn === 'function') logger.warn(message)
    } catch {
      // A logger must not break supervision.
    }
  }

  const currentTime = () => {
    try {
      const value = typeof opts.now === 'function' ? opts.now() : undefined
      return asNumber(value) ?? Date.now()
    } catch {
      return Date.now()
    }
  }

  const idOrNull = (value) => typeof value === 'string' && value !== '' ? value : null
  const countOr = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback
  const timeOr = (value, fallback) => Number.isFinite(value) ? value : fallback
  const copyScope = (scope) => Array.isArray(scope)
    ? scope.map((claim) => isNormalizedScope([claim]) ? { ...claim } : claim)
    : scope

  const configFor = (parentId) => {
    try {
      return readConfig(typeof opts.config === 'function' ? opts.config(parentId) : opts.config)
    } catch (error) {
      warn(`orchestrator: supervision: cannot read config for ${parentId}: ${errorMessage(error)}`)
      return readConfig({ enabled: false })
    }
  }
  const isEnabled = (config) => config.enabled && (config.unlimited || config.maxNoticesPerChild > 0)
  const withinBudget = (entry, config) => config.unlimited || entry.noticesSent < config.maxNoticesPerChild

  function refreshDeadline(entry, intervalMs) {
    // Preserve an advance made for a skipped notice while replacing the interval.
    entry.nextDueAt += intervalMs - entry.intervalMs
    entry.intervalMs = intervalMs
  }

  function refreshConfig(matchesParent = () => true) {
    const intervals = new Map()
    const changed = []
    for (const entry of entries.values()) {
      if (!matchesParent(entry.parentId)) continue
      if (!intervals.has(entry.parentId)) intervals.set(entry.parentId, intervalMsOf(configFor(entry.parentId)))
      const intervalMs = intervals.get(entry.parentId)
      if (intervalMs === entry.intervalMs) continue
      refreshDeadline(entry, intervalMs)
      changed.push(entry.childId)
    }
    return changed
  }

  const track = (entry) => {
    if (entry === null || typeof entry !== 'object') return
    const childId = entry.childId
    const parentId = entry.parentId
    if (typeof childId !== 'string' || childId === '') return
    if (typeof parentId !== 'string' || parentId === '') return

    const intervalMs = intervalMsOf(configFor(parentId))
    const runId = idOrNull(entry.runId)
    const previous = entries.get(childId)
    if (runId !== null && previous?.runId === runId && previous.parentId === parentId) {
      // A duplicate attach may enrich metadata, but cannot rewind the same run.
      if (typeof entry.label === 'string') previous.label = entry.label
      if (typeof entry.readOnly === 'boolean') previous.readOnly = entry.readOnly
      if (entry.writeScope !== undefined) previous.writeScope = copyScope(entry.writeScope)
      if (entry.cwd !== undefined) previous.cwd = entry.cwd
      refreshDeadline(previous, intervalMs)
      return
    }
    const startedAt = asNumber(entry.startedAt) ?? currentTime()
    // A resumed worker is a new run of the same task: the interrupt that stopped it was
    // not the child's fault, so its notice budget starts over. Its log still holds the
    // pre-interrupt history, which must not be reported as fresh activity, so the
    // baseline is the caller's head-of-log mark when it has one.
    const newRun = runId !== null && previous?.runId != null && runId !== previous.runId
    const resumed = entry.resumed === true || newRun
    const sinceSeq = resumed ? asNumber(entry.sinceSeq) ?? (newRun ? 0 : previous?.lastSeq ?? 0) : undefined
    entries.set(childId, {
      childId,
      parentId,
      runId: runId ?? (resumed ? null : previous?.runId ?? null),
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : '',
      startedAt,
      nextDueAt: startedAt + intervalMs,
      // A plain re-track refreshes the task and the deadline but keeps the budget used.
      noticesSent: resumed ? 0 : previous?.noticesSent ?? 0,
      lastSeq: sinceSeq ?? 0,
      runSinceSeq: sinceSeq,
      writeScope: copyScope(entry.writeScope),
      readOnly: entry.readOnly === true,
      cwd: entry.cwd,
      intervalMs,
    })
  }

  function exportCursor(childId) {
    const entry = entries.get(childId)
    if (!entry) return null
    const { parentId, runId, runSinceSeq, lastSeq, lastInspectionAt, nextDueAt,
      intervalMs, noticesSent, startedAt } = entry
    return { childId, parentId, runId, runSinceSeq: runSinceSeq ?? null, lastSeq,
      lastInspectionAt: lastInspectionAt ?? null, nextDueAt, intervalMs, noticesSent, startedAt }
  }

  function exportCursors() {
    return [...entries.keys()].map(exportCursor)
  }

  function hydrateCursor(childId, cursor, { currentRunId, currentHeadSeq, now } = {}) {
    if (!idOrNull(childId) || !cursor || typeof cursor !== 'object' || Array.isArray(cursor) ||
        (cursor.childId != null && cursor.childId !== childId)) return false
    const previous = entries.get(childId)
    const parentId = idOrNull(cursor.parentId) ?? previous?.parentId
    if (!parentId || (previous && previous.parentId !== parentId)) return false
    const savedRunId = idOrNull(cursor.runId)
    const runId = idOrNull(currentRunId) ?? previous?.runId ?? savedRunId
    const sameRun = runId === savedRunId
    const at = timeOr(now, currentTime())
    const configuredInterval = intervalMsOf(configFor(parentId))
    const intervalMs = sameRun ? positiveNumber(cursor.intervalMs, configuredInterval) : configuredInterval
    const head = countOr(currentHeadSeq, 0)
    const startedAt = sameRun ? timeOr(cursor.startedAt, at) : at
    const savedDeadline = timeOr(cursor.nextDueAt, startedAt + intervalMs)
    const lastInspectionAt = sameRun ? timeOr(cursor.lastInspectionAt, undefined) : undefined
    const runSinceSeq = sameRun ? countOr(cursor.runSinceSeq, undefined) : head
    const lastSeq = sameRun ? Math.max(runSinceSeq ?? 0, countOr(cursor.lastSeq, 0)) : head
    const noticesSent = sameRun ? countOr(cursor.noticesSent, 0) : 0
    if (previous?.runId === runId && (previous.lastSeq > lastSeq || previous.noticesSent > noticesSent ||
        (previous.lastInspectionAt ?? -Infinity) > (lastInspectionAt ?? -Infinity))) return false
    entries.set(childId, {
      childId, parentId, runId, startedAt, intervalMs: configuredInterval, lastSeq, runSinceSeq, lastInspectionAt, noticesSent,
      nextDueAt: sameRun ? Math.max(at, savedDeadline + configuredInterval - intervalMs) : at + configuredInterval,
      label: typeof cursor.label === 'string' ? cursor.label : previous?.label ?? '',
      readOnly: typeof cursor.readOnly === 'boolean' ? cursor.readOnly : previous?.readOnly ?? false,
      writeScope: copyScope(cursor.writeScope ?? previous?.writeScope),
      cwd: typeof cursor.cwd === 'string' ? cursor.cwd : previous?.cwd,
    })
    return true
  }

  function hydrateCursors(cursors, options) {
    const result = { restored: 0, skipped: 0 }
    if (!Array.isArray(cursors)) return result
    for (const cursor of cursors) {
      if (hydrateCursor(cursor?.childId, cursor, options)) result.restored += 1
      else result.skipped += 1
    }
    return result
  }

  const forget = (childId) => {
    entries.delete(childId)
  }

  const isCurrent = ({ entry }) => entries.get(entry.childId) === entry

  const isNoticeBlocked = async (parentId) => {
    for (const name of ['hasPendingNotice', 'hasActiveSupervisionTurn']) {
      try {
        if (typeof opts[name] === 'function' && (await opts[name](parentId)) === true) return true
      } catch (error) {
        warn(`orchestrator: supervision: ${name}(${parentId}) failed: ${errorMessage(error)}`)
        // A duplicate wake-up is worse than a delayed notice.
        return true
      }
    }
    return false
  }

  const tick = async (nowOverride) => {
    if (ticking) return
    ticking = true
    try {
      const at = asNumber(nowOverride) ?? currentTime()
      const configs = new Map()

      // A parent that is gone takes every registration with it, before any reads.
      const parentIds = new Set()
      for (const entry of entries.values()) parentIds.add(entry.parentId)
      for (const parentId of parentIds) {
        const config = configFor(parentId)
        configs.set(parentId, config)
        // Retain paused registrations so live settings can re-arm them.
        if (!isEnabled(config)) continue
        let alive = true
        if (typeof opts.isParentAlive === 'function') {
          try {
            alive = (await opts.isParentAlive(parentId)) !== false
          } catch (error) {
            warn(`orchestrator: supervision: isParentAlive(${parentId}) failed: ${errorMessage(error)}`)
            alive = true
          }
        }
        if (alive) continue
        for (const [childId, entry] of entries) {
          if (entry.parentId === parentId) entries.delete(childId)
        }
      }
      if (entries.size === 0) return

      const activeByParent = new Map()

      for (const entry of [...entries.values()]) {
        // A callback may have forgotten it while we awaited a previous entry.
        if (entries.get(entry.childId) !== entry) continue

        const config = configs.get(entry.parentId)
        if (!config) continue
        const intervalMs = intervalMsOf(config)
        refreshDeadline(entry, intervalMs)
        if (!isEnabled(config)) continue

        let childAlive = true
        if (typeof opts.isChildAlive === 'function') {
          try {
            childAlive = (await opts.isChildAlive(entry.childId)) !== false
          } catch (error) {
            warn(`orchestrator: supervision: isChildAlive(${entry.childId}) failed: ${errorMessage(error)}`)
            childAlive = true
          }
        }
        if (entries.get(entry.childId) !== entry) continue
        if (!childAlive) {
          entries.delete(entry.childId)
          continue
        }

        const child = { entry }
        let batch = activeByParent.get(entry.parentId)
        if (batch === undefined) {
          batch = []
          activeByParent.set(entry.parentId, batch)
        }
        batch.push(child)

        if (at < entry.nextDueAt) {
          child.status = '同行在跑，暂未到下一次巡检点'
          continue
        }

        // Retain capped children so a config change can resume supervision.
        if (!withinBudget(entry, config)) {
          child.status = '同行在跑，巡检预算已用完'
          continue
        }

        let events
        try {
          events = typeof opts.readEvents === 'function' ? await opts.readEvents(entry.childId) : []
        } catch (error) {
          warn(`orchestrator: supervision: readEvents(${entry.childId}) failed: ${errorMessage(error)}`)
          continue // A failed inspection stays due unless the parent batch is rescheduled.
        }

        let summary
        try {
          summary = summarize(events, {
            sinceSeq: entry.lastSeq,
            runSinceSeq: entry.runSinceSeq,
            now: at,
            startedAt: entry.startedAt,
            prevSummary: entry.lastInspectionAt === undefined ? undefined : { lastSeq: entry.lastSeq },
            elapsedMs: Math.max(0, at - (entry.lastInspectionAt ?? entry.startedAt)),
            repeatThreshold: config.repeatThreshold,
            stalledAfterMs: intervalMs,
            writeScope: entry.writeScope,
            readOnly: entry.readOnly,
            cwd: entry.cwd,
          })
        } catch (error) {
          warn(`orchestrator: supervision: summarize(${entry.childId}) failed: ${errorMessage(error)}`)
          continue
        }

        if (!isCurrent(child)) continue
        const { status } = summary.semantic
        const actionable = status === 'scope_drift' || status === 'error_loop' || status === 'tool_loop'
        // Keep the quiet-child policy: silence alone does not wake the parent
        // unless quiet or unlimited notices are enabled.
        if (summary.newEvents === 0 && !actionable && !config.notifyOnNoProgress && !config.unlimited) {
          child.status = '同行在跑，本周期暂无新增工具调用'
          entry.lastInspectionAt = at
          entry.nextDueAt = at + intervalMs
          continue
        }

        child.summary = summary
      }

      for (const [parentId, batch] of activeByParent) {
        const nextDueAt = at + intervalMsOf(configFor(parentId))
        if (!batch.some((child) => child.summary && isCurrent(child))) continue

        // Pending or claimed notices delay the whole batch, without spending budget
        // or letting a sibling with a slightly later deadline wake the parent again.
        const deferParent = () => {
          for (const child of batch.filter(isCurrent)) {
            child.entry.nextDueAt = Math.max(child.entry.nextDueAt, nextDueAt)
          }
        }
        if (await isNoticeBlocked(parentId)) {
          deferParent()
          continue
        }

        const active = batch.filter(isCurrent)
        const config = configFor(parentId)
        if (!isEnabled(config)) continue
        const triggers = active.filter(({ entry, summary }) =>
          summary !== undefined && entry.nextDueAt <= at && withinBudget(entry, config))
        if (triggers.length === 0) continue

        const index = triggers.reduce((highest, { entry }) => Math.max(highest, entry.noticesSent), 0) + 1
        const rows = triggers.map(({ entry, summary }) => ({
          childId: entry.childId,
          kind: 'running',
          label: entry.label,
          startedAt: entry.startedAt,
          turns: summary.turns,
          steps: summary.steps,
          toolCalls: summary.toolCalls,
          lastTool: summary.lastTool,
          lastToolAt: summary.lastToolAt,
          repeated: summary.repeated,
          lastText: summary.lastText,
          newEvents: summary.newEvents,
          semantic: summary.semantic,
        }))
        // A child whose log could not be inspected retains the existing skip behavior.
        const siblingRows = active.filter(({ status }) => status !== undefined).map(({ entry, status }) => ({
          childId: entry.childId,
          kind: 'sibling',
          label: entry.label,
          startedAt: entry.startedAt,
          status,
        }))
        rows.push(...siblingRows)
        const childIds = rows.map(({ childId }) => childId)
        const composeMeta = {
          now: at,
          index,
          // `max: 0` renders "第 N 次" without a denominator, which is exactly what an
          // unlimited run should show.
          max: config.unlimited ? 0 : config.maxNoticesPerChild,
          maxChars: config.noticeMaxChars,
          repeatThreshold: config.repeatThreshold,
        }
        const text = composeNotice(rows, composeMeta)

        let result
        try {
          result = typeof opts.deliver === 'function'
            ? await opts.deliver(parentId, text, childIds, { rows, composeMeta })
            : 'queued'
        } catch (error) {
          warn(`orchestrator: supervision: deliver(${parentId}) failed: ${errorMessage(error)}`)
          for (const { entry } of triggers.filter(isCurrent)) entry.nextDueAt = nextDueAt
          continue
        }

        if (result === 'stale') continue
        if (result === 'queued') {
          for (const child of active.filter(isCurrent)) {
            const { entry, summary } = child
            entry.nextDueAt = at + entry.intervalMs
            if (!triggers.includes(child)) continue
            entry.noticesSent += 1
            // A tail window can report a lower max than a previous read; never go backwards.
            entry.lastSeq = Math.max(entry.lastSeq, summary.lastSeq)
            entry.lastInspectionAt = at
          }
        } else if (result === 'parent-gone') {
          for (const [childId, entry] of entries) {
            if (entry.parentId === parentId) entries.delete(childId)
          }
        } else if (result === 'already-pending') {
          deferParent()
        } else {
          warn(`orchestrator: supervision: deliver(${parentId}) returned ${String(result)}`)
          for (const { entry } of triggers.filter(isCurrent)) entry.nextDueAt = nextDueAt
        }
      }
    } catch (error) {
      // Last line of defence: a supervision bug must never propagate into the host.
      warn(`orchestrator: supervision: tick failed: ${errorMessage(error)}`)
    } finally {
      ticking = false
    }
  }

  const has = (childId) => entries.has(childId)
  const size = () => entries.size

  return { track, forget, has, tick, size, refreshConfig, exportCursor, exportCursors, hydrateCursor, hydrateCursors }
}
