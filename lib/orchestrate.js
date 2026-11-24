/**
 * Declarative fan-out / pipeline orchestration. Dependency-free: `defineTool` and
 * the subagent service are passed in, so scheduling and result shaping are unit
 * testable without the DSH runtime.
 *
 * One worker call per item and stage; stages of one item are strictly sequential,
 * different items are independent (no global stage barrier). Each worker uses its
 * stage's explicit route, the batch override, or the configured worker route, in
 * that order. Every worker uses `delivery: 'caller'` and, when the stage declares
 * one, `outputSchema`.
 *
 * A writable batch declares one top-level `writeScope`. In Git isolation each item
 * owns a checkout, lease and audit across all its stages. Shared mode preserves the
 * atomic batch lease and workspace snapshot; a conflict starts no workers.
 */

import { randomUUID } from 'node:crypto'
import { DELIVERY, LIMITS, ORCHESTRATE_TOOL, ORCHESTRATION_KIND, disabledToolMessage } from './api.js'
import {
  READ_ONLY_NOTICE, TEAM_TASK_ID_PARAMETER, auditNotice, discardEmptyWorktree, dispatchWorkspaceRoot,
  dispatchWriteParameters, parseTeamTaskId, prepareDispatchWrite, settleDispatchWrite,
  validateDispatchIsolation, validateDispatchWrite, worktreeAuditSummary, worktreeDetails,
  worktreeFailure, worktreePromptNote,
} from './delegate.js'
import { teamTaskPromptNote } from './rules.js'
import { assertObjectSchema, isJsonValue, validateJsonSchemaValue } from './schema.js'
import { buildSpawnActivation, isDispatchEnabled, readRoute, readRouteOverride } from './worker.js'
import { probeGitRepo } from './worktree.js'
import { dispatchCwd, formatWorktreeError, releaseWriteScope, writeScopeNotice } from './write-scope-tool.js'

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(message) {
  throw new Error(`orchestrate: ${message}`)
}

function within(value, bounds) {
  return value >= bounds.min && value <= bounds.max
}

const ARGUMENT_KEYS = Object.freeze([
  'cwd',
  'items',
  'stages',
  'maxConcurrency',
  'provider',
  'model',
  'reasoning_effort',
  'team_task_id',
  'writeScope',
  'readOnly',
  'isolation',
  'expectedFingerprints',
  'expectedTargets',
])
const STAGE_KEYS = Object.freeze(['name', 'prompt', 'schema', 'provider', 'model', 'reasoning_effort'])

/**
 * Reject fields the tool does not implement. Silently ignoring a typo would run
 * workers with a different configuration than the caller believes.
 */
function rejectUnknownKeys(value, allowed, at) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    fail(`${at} has unknown field "${key}" (allowed: ${allowed.join(', ')})`)
  }
}

/**
 * Validate and normalise `execute` arguments. Everything that can fail globally
 * (shape, unknown fields, limits, stage schema and route) fails here, before any worker starts.
 */
export function parseOrchestrateArgs(args) {
  if (!isPlainObject(args)) fail('arguments must be an object')
  rejectUnknownKeys(args, ARGUMENT_KEYS, 'arguments')
  const teamTaskId = parseTeamTaskId(args.team_task_id, ORCHESTRATE_TOOL)

  if (!Array.isArray(args.items)) fail('"items" must be a JSON array')
  if (!within(args.items.length, LIMITS.items)) {
    fail(`"items" must contain ${LIMITS.items.min}..${LIMITS.items.max} entries (got ${args.items.length})`)
  }
  args.items.forEach((item, index) => {
    if (!isJsonValue(item)) fail(`item ${index + 1} is not a lossless JSON value`)
  })

  if (!Array.isArray(args.stages)) fail('"stages" must be an array')
  if (!within(args.stages.length, LIMITS.stages)) {
    fail(`"stages" must contain ${LIMITS.stages.min}..${LIMITS.stages.max} stages (got ${args.stages.length})`)
  }
  const stages = args.stages.map((stage, index) => {
    const at = `stage ${index + 1}`
    if (!isPlainObject(stage)) fail(`${at} must be an object`)
    rejectUnknownKeys(stage, STAGE_KEYS, at)
    if (typeof stage.name !== 'string' || stage.name.trim() === '') fail(`${at} requires a non-empty "name"`)
    if (typeof stage.prompt !== 'string' || stage.prompt.trim() === '') fail(`${at} requires a non-empty "prompt"`)
    if (stage.schema !== undefined) {
      try {
        assertObjectSchema(stage.schema, `${at}.schema`)
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    }
    const route = readRouteOverride(stage, `${ORCHESTRATE_TOOL}.stages[${index}]`)
    return {
      name: stage.name,
      prompt: stage.prompt,
      ...(stage.schema === undefined ? {} : { schema: stage.schema }),
      ...(route === undefined ? {} : { route }),
    }
  })

  if (args.maxConcurrency !== undefined) {
    if (!Number.isInteger(args.maxConcurrency) || !within(args.maxConcurrency, LIMITS.maxConcurrency)) {
      fail(
        `"maxConcurrency" must be an integer in ${LIMITS.maxConcurrency.min}..${LIMITS.maxConcurrency.max} (got ${JSON.stringify(args.maxConcurrency)})`,
      )
    }
  }

  let cwd
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== 'string') fail('"cwd" must be a string')
    cwd = args.cwd.trim()
    if (cwd === '') fail('"cwd" must be a non-empty string when provided')
  }

  // The dispatch layer validates write arguments before this parser runs.
  const { writeScope, readOnly } = args

  return {
    cwd,
    items: args.items,
    stages,
    maxConcurrency: args.maxConcurrency ?? LIMITS.maxConcurrency.default,
    writeScope,
    readOnly: readOnly === true,
    ...(teamTaskId === undefined ? {} : { teamTaskId }),
  }
}

/**
 * A worker-visible prompt: stage instruction, original item and previous output.
 *
 * Every stage receives the batch's normalized scope or the explicit read-only constraint.
 */
export function buildStagePrompt({
  stage,
  stageIndex,
  stageCount,
  item,
  itemIndex,
  itemCount,
  previous,
  writeScope,
  readOnly,
  baselineId,
  worktree,
  teamTaskId,
}) {
  const lines = [
    stage.prompt.trim(),
    '',
    '你在批处理任务中负责其中一个阶段，看不到父会话，所需信息都在下面。',
    '',
    `阶段 "${stage.name}"（${stageIndex + 1}/${stageCount}），条目 ${itemIndex + 1}/${itemCount}。`,
    '',
    '原始条目 (JSON):',
    JSON.stringify(item),
    '',
  ]
  if (previous === undefined) {
    lines.push('这是第一个阶段，请直接产出该条目在本阶段的结果。')
  } else {
    lines.push(`上一阶段 "${previous.stageName}" 输出 (JSON):`)
    lines.push(JSON.stringify(previous.output))
    lines.push('')
    lines.push('在此基础上继续，产出该条目在本阶段的结果。')
  }
  if (stage.schema !== undefined) {
    lines.push('')
    lines.push(
      '本阶段返回一个 JSON 对象：优先调用一次 structured_output 工具，把最终对象传给它，不要用文本作答。',
    )
    lines.push(
      '若 structured_output 不可用，则只输出符合阶段 schema 的 JSON 对象，不要解释、不要 Markdown、不要代码块。',
    )
  }
  // Unlike a single delegation, a batch has no per-worker description carrying the
  // declaration, so the constraint always travels with the prompt.
  lines.push('')
  lines.push(readOnly ? READ_ONLY_NOTICE : writeScopeNotice(writeScope))
  if (baselineId !== undefined) lines.push(`写后审计基线：${baselineId}。`)
  if (worktree) lines.push('', worktreePromptNote(worktree))
  if (teamTaskId !== undefined) lines.push('', teamTaskPromptNote(teamTaskId))
  return lines.join('\n')
}

/** Text parts of a worker's content output, concatenated in order. */
export function collectText(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  let text = ''
  for (const part of output) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      text += part.text
    }
  }
  return text
}

/**
 * Turn one settled worker result into the stage output.
 *
 * `run.result.structured` is authoritative when present: an invalid structured
 * value fails the stage and is never replaced by the text.
 *
 * A schema stage may also be recovered from text. A host that never dispatches
 * `structured_output` ends a text answer as `error` even though the worker
 * finished, so for schema stages `completed` and `error` are both accepted; any
 * other stop reason (aborted, max-tokens, refusal, ...) is never recovered. The
 * concatenated text must be one strict JSON document that fully validates; the
 * text itself is never echoed, only the schema violations.
 */
export function readStageOutput(stage, result) {
  if (result === null || typeof result !== 'object') throw new Error('worker returned no result')
  const schema = stage.schema
  const recoverable = result.stopReason === 'completed' || (schema !== undefined && result.stopReason === 'error')
  if (!recoverable) {
    throw new Error(`worker stopped with reason "${String(result.stopReason)}" before finishing the stage`)
  }
  const text = collectText(result.output)

  if (schema === undefined) return text

  if (Object.hasOwn(result, 'structured') && result.structured !== undefined) {
    const violations = validateJsonSchemaValue(schema, result.structured)
    if (violations.length > 0) {
      throw new Error(`structured result does not match the stage schema: ${violations.join('; ')}`)
    }
    return result.structured
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      'stage schema requires a structured result, but the worker returned text that is not strictly JSON (or no text)',
    )
  }
  const violations = validateJsonSchemaValue(schema, parsed)
  if (violations.length > 0) {
    throw new Error(`text result does not match the stage schema: ${violations.join('; ')}`)
  }
  return parsed
}

function abortReason(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  if (reason !== undefined) return new Error(String(reason))
  const error = new Error('orchestrate was aborted')
  error.name = 'AbortError'
  return error
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bounded worker slots. A slot is held from just before `startActivation` until
 * the worker's result has been read and the child disposed, so the cap bounds
 * live workers rather than just calls in flight.
 */
function createLimiter(limit) {
  let active = 0
  const waiters = []
  return {
    get active() {
      return active
    },
    acquire(signal) {
      signal?.throwIfAborted()
      if (active < limit) {
        active += 1
        return Promise.resolve()
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: undefined }
        waiter.onAbort = () => {
          const at = waiters.indexOf(waiter)
          if (at !== -1) waiters.splice(at, 1)
          reject(abortReason(signal))
        }
        signal?.addEventListener('abort', waiter.onAbort, { once: true })
        waiters.push(waiter)
      })
    },
    release() {
      const waiter = waiters.shift()
      if (waiter === undefined) {
        active -= 1
        return
      }
      // The slot moves to the next waiter; `active` stays the same.
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    },
  }
}

/**
 * Run the plan. Returns the unified result, or throws for a global failure
 * (abort, oversized result, an internal error outside per-item isolation).
 *
 * A writable batch's normalized `writeScope` is already leased by the caller and
 * reaches the worker prompts, not the result payload.
 */
export async function runOrchestration({
  plan,
  parent,
  batchRoute,
  defaultRoute,
  maxDepth,
  subagents,
  signal,
  writeScope,
  baselineId,
  itemIsolation,
  stageTracking,
  sharedBatch,
}) {
  const { cwd, items, stages, maxConcurrency, readOnly, teamTaskId } = plan
  const limiter = createLimiter(maxConcurrency)
  const results = new Array(items.length).fill(null)
  const errors = []
  const active = new Set()
  const disposals = new Map()
  let agentsStarted = 0

  // A handle disposed before its result is read would otherwise leave a rejected
  // result promise unhandled; consume it best effort.
  const observeResult = (handle) => {
    const result = handle.result
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(undefined, () => {})
    }
  }

  const dispose = (handle) => {
    if (handle === null || typeof handle !== 'object' || typeof handle.dispose !== 'function') {
      return Promise.resolve()
    }
    const known = disposals.get(handle)
    if (known !== undefined) return known
    // Disposal is best effort: a worker that already finished needs no cleanup,
    // and an abort must not be blocked by a failing teardown.
    const pending = Promise.resolve()
      .then(() => {
        observeResult(handle)
        return handle.dispose()
      })
      .catch(() => {})
    disposals.set(handle, pending)
    return pending
  }

  const onAbort = () => {
    for (const handle of active) void dispose(handle)
  }
  if (signal.aborted) throw abortReason(signal)
  signal.addEventListener('abort', onAbort, { once: true })

  const runStage = async ({ stage, stageIndex, prompt, itemIndex, workspace }) => {
    let acquired = false
    let started
    const batch = workspace?.batch ?? sharedBatch
    let result
    try {
      if (!itemIsolation) {
        await limiter.acquire(signal)
        acquired = true
      }
      if (signal.aborted) throw abortReason(signal)
      const spec = buildSpawnActivation({
        cwd: workspace?.worktree.execCwd ?? cwd,
        prompt,
        label: `orchestrate ${stage.name} (item ${itemIndex + 1}/${items.length}, stage ${stageIndex + 1}/${stages.length})`,
        parent,
        route: stage.route ?? batchRoute ?? defaultRoute,
        maxDepth,
        signal,
        outputSchema: stage.schema,
        delivery: DELIVERY.orchestrate,
      })
      // Race the start itself against abort: a hanging startActivation must not
      // delay cancellation. A handle that only resolves after the abort is
      // disposed on arrival and is never dispatched.
      const startPromise = Promise.resolve().then(async () => {
        if (signal.aborted) throw abortReason(signal)
        stageTracking?.assertActive()
        if (batch) batch.inFlightStarts += 1
        try {
          const handle = await subagents.startActivation(spec)
          if (batch && handle?.childId) {
            try {
              await stageTracking.stageStarted(batch, handle, { itemIndex, stageIndex, label: spec.label })
            } catch (error) {
              await dispose(handle)
              throw error
            }
          }
          return handle
        } finally {
          if (batch) batch.inFlightStarts -= 1
        }
      })
      const settledStart = startPromise.then(
        (handle) => ({ handle }),
        (error) => ({ error }),
      )
      // A start still in flight can launch a writer even after cancellation. Do not remove
      // or audit the checkout until a late receipt has been observed and disposed.
      if (workspace) {
        const pending = settledStart.then(async ({ handle }) => {
          if (!handle || typeof handle !== 'object') return
          // A receipt without a child or result is not evidence that a stage ran.
          workspace.started ||= (typeof handle.childId === 'string' && handle.childId.length > 0) ||
            typeof handle.result?.then === 'function'
          if (workspace.started) itemIsolation.bind(workspace, handle)
          if (signal.aborted) await dispose(handle)
        })
        workspace.pending = pending
        void pending.finally(() => {
          if (workspace.pending === pending) workspace.pending = undefined
        }).catch(() => {})
      }
      started = await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        settledStart.then((outcome) => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) {
            // Late handle: clean it up without dispatching its worker.
            if (outcome.handle !== undefined) void dispose(outcome.handle)
            reject(abortReason(signal))
            return
          }
          if (Object.hasOwn(outcome, 'error')) reject(outcome.error)
          else resolve(outcome.handle)
        })
      })
      if (
        started === null ||
        typeof started !== 'object' ||
        started.result === undefined ||
        typeof started.result.then !== 'function'
      ) {
        throw new Error('subagent startActivation did not return a result promise')
      }
      if (signal.aborted) throw abortReason(signal)
      // Count only handles that are valid and not already aborted, so a late
      // start never appears in agentsStarted.
      agentsStarted += 1
      active.add(started)
      // Race the worker against the abort signal: cancellation must not wait for a
      // worker that ignores its own signal, and the handle is disposed in `finally`.
      result = await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal))
        signal.addEventListener('abort', onAbort, { once: true })
        started.result.then(
          (value) => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          (error) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        )
      })
      if (signal.aborted) throw abortReason(signal)
      return readStageOutput(stage, result)
    } finally {
      try {
        if (started !== undefined) {
          active.delete(started)
          await dispose(started)
          if (batch && result) await stageTracking.stageEnded(batch, started, result)
        }
      } finally {
        if (acquired) limiter.release()
      }
    }
  }

  const runItem = async (item, index) => {
    let acquired = false
    let workspace
    let previous
    let output
    let stageIndex = 0
    try {
      if (itemIsolation) {
        await limiter.acquire(signal)
        acquired = true
        signal.throwIfAborted()
        workspace = itemIsolation.prepare(index)
        if (workspace.batch) await stageTracking.beforeLaunch(workspace.write)
      }
      for (; stageIndex < stages.length; stageIndex += 1) {
        if (signal.aborted) throw abortReason(signal)
        const stage = stages[stageIndex]
        const prompt = buildStagePrompt({
          stage,
          stageIndex,
          stageCount: stages.length,
          item,
          itemIndex: index,
          itemCount: items.length,
          previous,
          writeScope: workspace?.write.writeScope ?? writeScope,
          readOnly,
          baselineId: workspace?.write.baseline?.baselineId ?? baselineId,
          worktree: workspace?.worktree,
          teamTaskId,
        })
        output = await runStage({ stage, stageIndex, prompt, itemIndex: index, workspace })
        previous = { stageName: stage.name, output }
      }
      return { index, output, stopReason: 'completed' }
    } catch (error) {
      if (signal.aborted) throw abortReason(signal)
      errors.push({ index, stage: stages[stageIndex].name, stageIndex, message: messageOf(error) })
      return null
    } finally {
      try {
        if (workspace) {
          const finish = () => itemIsolation.finish(workspace, index)
          if (workspace.pending && signal.aborted) itemIsolation.defer(workspace.pending, finish)
          else {
            await workspace.pending
            await finish()
          }
        }
      } finally {
        if (acquired) limiter.release()
      }
    }
  }

  try {
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        results[index] = await runItem(item, index)
      }),
    )
    if (signal.aborted) throw abortReason(signal)
    const rejected = settled.find((entry) => entry.status === 'rejected')
    if (rejected !== undefined) throw rejected.reason
  } finally {
    signal.removeEventListener('abort', onAbort)
    await Promise.all([...disposals.values()])
  }

  errors.sort((a, b) => a.index - b.index || a.stageIndex - b.stageIndex)
  const payload = {
    kind: ORCHESTRATION_KIND,
    agentsStarted,
    results,
    errors: errors.map(({ index, stage, message }) => ({ index, stage, message })),
  }
  const serialized = JSON.stringify(payload)
  if (serialized.length > LIMITS.serializedResultChars) {
    fail(
      `serialized result is ${serialized.length} characters, above the ${LIMITS.serializedResultChars} character limit; reduce items, stages or output size`,
    )
  }
  return payload
}

/**
 * The aggregate owner id of one batch. A batch is one write unit, so the lease table
 * records it like a child: `batch-<parent>-<n>` is what `details[].owner` names and what
 * `release` frees at the end.
 *
 * The identity must also be unique against leases restored from an earlier process.
 */
function nextBatchId(parent) {
  return `batch-${String(parent?.id ?? 'parent')}-${randomUUID()}`
}

const newBatch = (batchId, parent, write) => ({
  batchId, parent, write, children: new Map(), inFlightStarts: 0,
})

function prepareItemIsolation({
  isolation, worktrees, args, exec, parent, checked, leases, batchId, probeRepo, getWorkspaceRoot,
  captureGit, auditGit, onAudited, onWorktreeChild, onCleanupFailed, stageTracking,
}) {
  const sourceCwd = dispatchCwd(args, exec)
  const workspaceRoot = dispatchWorkspaceRoot(exec, getWorkspaceRoot)
  const forced = isolation.mode === 'worktree'
  const fallback = (result, quiet = false) => {
    if (forced) throw worktreeFailure(result)
    return quiet ? {} : { isolationFallback: { code: result.code, message: formatWorktreeError(result.code, result) } }
  }
  if (!worktrees) return fallback({ code: 'worktree-create-failed', message: '工作树管理器不可用。' })
  let probe
  try {
    probe = probeRepo(sourceCwd)
  } catch (error) {
    return fallback({ code: 'worktree-create-failed', message: messageOf(error) })
  }
  if (!probe.isGit || !probe.headCommit) return fallback({ code: probe.reason ?? 'not-git-repo' }, true)

  const create = (index) => worktrees.create({
    sourceCwd, workspaceRoot, label: `orchestrate item ${index + 1}`,
    parentId: parent.id ?? null, batchId, itemIndex: index,
  })
  // The first checkout doubles as the containment check. Once any worker can run,
  // no item may fall back to the main checkout.
  const first = create(0)
  if (!first.ok) return fallback(first)
  let seed = first.worktree
  const rows = []
  return {
    rows,
    disposeUnused() {
      if (seed && !stageTracking?.isDisposing()) discardEmptyWorktree(worktrees, seed, onCleanupFailed)
    },
    itemIsolation: {
      prepare(index) {
        const created = index === 0 ? { ok: true, worktree: seed } : create(index)
        if (index === 0) seed = undefined
        if (!created.ok) throw worktreeFailure(created)
        const worktree = created.worktree
        try {
          const write = prepareDispatchWrite({
            args, exec, parent, leases, childId: `${batchId}:item:${index}`, tool: ORCHESTRATE_TOOL,
            checked, worktree, captureGit,
          })
          const batch = stageTracking ? newBatch(batchId, parent, write) : undefined
          return { worktree, write, batch, started: false }
        } catch (error) {
          discardEmptyWorktree(worktrees, worktree, onCleanupFailed)
          throw error
        }
      },
      bind({ worktree }, handle) {
        const childId = handle.childId
        if (typeof childId !== 'string' || childId === '') return
        if (worktrees.get(worktree.id)?.childId !== childId) worktrees.rebindChild(worktree.id, childId)
        worktrees.bindChild?.(worktree.id, childId)
        onWorktreeChild?.(worktree, handle, parent)
      },
      async finish({ worktree, write, started, batch }, itemIndex) {
        if (stageTracking?.isDisposing() || (batch && !stageTracking.canFinishBatch(batch))) return
        let audit
        try {
          if (!started) {
            discardEmptyWorktree(worktrees, worktree, onCleanupFailed)
            return
          }
          audit = settleDispatchWrite(write.baseline, auditGit)
          worktrees.markReadyForReview(worktree.id, worktreeAuditSummary(audit))
          const { id: worktreeId, branch, path } = worktreeDetails(worktree)
          rows.push({ itemIndex, worktreeId, branch, path, audit })
          onAudited?.({ childId: `${batchId}:item:${itemIndex}`, parentId: parent.id, audit, itemIndex, worktree })
        } finally {
          if (batch) await stageTracking.finishBatch(batch, audit)
          else releaseWriteScope(leases, write.lease)
        }
      },
      defer(pending, finish) {
        void pending.finally(finish).catch((error) => onCleanupFailed?.(error))
      },
    },
  }
}

function aggregateItemAudits(rows) {
  const summary = { added: 0, modified: 0, deleted: 0, violations: 0, truncated: false }
  const changedFiles = []
  const violations = []
  for (const { itemIndex, audit } of rows) {
    for (const key of ['added', 'modified', 'deleted', 'violations']) summary[key] += audit.summary[key]
    summary.truncated ||= audit.summary.truncated === true
    changedFiles.push(...audit.changedFiles.map((entry) => ({ ...entry, itemIndex })))
    violations.push(...audit.violations.map((entry) => ({ ...entry, path: `item ${itemIndex + 1}: ${entry.path}`, itemIndex })))
  }
  return {
    passed: rows.every(({ audit }) => audit.passed), readOnly: false, isolationLevel: 'git-worktree',
    isolationNote: '每个条目独立完成 Git 审计；具体证据见 details.itemAudits。',
    changedFiles, violations, summary,
  }
}

export function createOrchestrateTool({
  defineTool, subagents, config, leases, onAudited, worktrees, onWorktreeChild, onCleanupFailed,
  isWorktreeEnabled = () => true, getWorkspaceRoot,
  captureGitBaseline: captureGit, auditGitBaseline: auditGit, probeGitRepo: probeRepo = probeGitRepo,
  stageTracking,
}) {
  // This description does not repeat `mainAgentRule`: only `delegate` opens with it.
  // The plumbing still accepts the whitelist fields a shared factory passes down so a
  // caller does not have to branch, but they are unused here.
  const enabled = () => isDispatchEnabled(config)
  const ruleLead = '主代理规则同 delegate。'
  const body =
    '按 item 派发子代理：单 stage 即批量扇出；多 stage 时各 item 独立走完阶段，无全局屏障，每阶段自动附带指令、原始 item 与上阶段输出。' +
    '声明 schema 的阶段输出校验过的 JSON，否则为文本；单 item 失败置为 null 并记入 errors。' +
    'maxConcurrency 限制并发数；非只读调用必填 writeScope。Git 写任务默认按 item 分配独立 Worktree，同 item 多 stage 复用一树，结算后保留，由 worktree_manage 评审、合回或丢弃。' +
    '非 Git 自动降级：共享模式整批共享一个写租约，冲突时整批失败不排队；readOnly: true 不占租约，仅做逻辑写后审计，不是物理隔离。' +
    '无关批次可并发调用；单任务请用 delegate。'
  const descriptionOf = () => (enabled() ? ruleLead + body : body)

  const tool = defineTool({
    name: ORCHESTRATE_TOOL,
    description: descriptionOf(),
    parameters: {
      cwd: {
        type: 'string',
        description: '初始工作目录（相对路径基于当前目录）；省略则继承。',
      },
      ...dispatchWriteParameters({ batch: true }),
      team_task_id: TEAM_TASK_ID_PARAMETER,
      items: {
        type: 'array',
        required: true,
        description: `JSON 条目数组（${LIMITS.items.min}..${LIMITS.items.max}），每项对应独立任务。`,
        items: { type: 'json' },
      },
      stages: {
        type: 'array',
        required: true,
        description:
          `顺序执行的阶段（${LIMITS.stages.min}..${LIMITS.stages.max}），单阶段即扇出。` +
          '路由优先级：阶段覆盖 > 顶层批次覆盖 > 面板默认 worker 路由。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              required: true,
              description: '阶段名称，用于错误标识。',
            },
            prompt: {
              type: 'string',
              required: true,
              description: '阶段指令，自动附带原始条目与上阶段输出。',
            },
            schema: {
              type: 'object',
              additionalProperties: true,
              description:
                '可选对象根 JSON Schema（支持 type/properties/required/additionalProperties/items/enum/const/oneOf）。',
            },
            provider: {
              type: 'string',
              description:
                '可选阶段路由覆盖：仅当用户显式点名（当前消息或 AGENTS.md 等工作区指令）时与 model 同传；优先于顶层批次覆盖。',
            },
            model: {
              type: 'string',
              description:
                '可选阶段路由覆盖：仅当用户显式点名（当前消息或 AGENTS.md 等工作区指令）时与 provider 同传；优先于顶层批次覆盖。',
            },
            reasoning_effort: {
              type: 'string',
              description:
                '可选阶段推理强度：仅当用户点名时才设置，须与阶段 provider/model 同传；作为整组覆盖优先于顶层批次，不继承后备路由的推理强度。',
            },
          },
        },
      },
      maxConcurrency: {
        type: 'integer',
        description: `并发子代理上限（${LIMITS.maxConcurrency.min}..${LIMITS.maxConcurrency.max}，默认 ${LIMITS.maxConcurrency.default}）。`,
      },
      provider: {
        type: 'string',
        description:
          '可选批次路由覆盖：仅当用户显式点名（当前消息或 AGENTS.md 等工作区指令）时与 model 同传；适用于无阶段覆盖的阶段，省略走 worker 路由。',
      },
      model: {
        type: 'string',
        description:
          '可选批次路由覆盖：仅当用户显式点名（当前消息或 AGENTS.md 等工作区指令）时与 provider 同传；适用于无阶段覆盖的阶段，省略走 worker 路由。',
      },
      reasoning_effort: {
        type: 'string',
        description: '可选推理强度：仅当用户点名时才设置，须与 provider/model 同传。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: ORCHESTRATION_KIND },
          agentsStarted: { type: 'integer' },
          audit: { type: 'object', additionalProperties: true },
          details: { type: 'object', additionalProperties: true },
          results: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    index: { type: 'integer' },
                    output: { type: 'json' },
                    stopReason: { type: 'string' },
                  },
                },
              ],
            },
          },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                stage: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `orchestration finished: ${value.results.filter((entry) => entry !== null).length}/${value.results.length} items, ` +
            `${value.errors.length} errors, ${value.agentsStarted} workers started` +
            (value.audit?.passed === false ? `\n不得验收为通过。\n${auditNotice(value.audit)}` : '') +
            (value.details?.worktrees?.length
              ? '\n请用 worktree_manage 逐项 inspect / merge / discard：\n' + value.details.worktrees.map((worktree) =>
                `item ${worktree.itemIndex + 1}：${worktree.worktreeId}（${worktree.branch}）${worktree.audit.passed ? '审计通过' : '审计失败'}`).join('\n')
              : '') +
            (value.details?.isolationFallback ? `\n已降级为共享工作区：${value.details.isolationFallback.message}` : ''),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!enabled()) throw new Error(disabledToolMessage(ORCHESTRATE_TOOL))
      const parent = exec?.agent
      if (!parent) throw new Error('orchestrate requires a calling agent (exec.agent was undefined)')
      const isolation = validateDispatchIsolation(args)
      const checked = validateDispatchWrite(args, ORCHESTRATE_TOOL)
      // Even if every stage overrides it, reject an invalid batch override.
      const batchRoute = readRouteOverride(args, ORCHESTRATE_TOOL)
      const plan = parseOrchestrateArgs(args)
      const signal = exec.signal
      if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
        throw new Error('orchestrate requires a cancellation signal')
      }
      signal.throwIfAborted()
      // Read the panel route only when needed, before acquiring any lease or Worktree.
      const defaultRoute = batchRoute === undefined && plan.stages.some((stage) => stage.route === undefined)
        ? readRoute(config)
        : undefined
      const maxDepth = subagents.resolveMaxDepth(undefined)
      signal.throwIfAborted()
      const childId = nextBatchId(parent)
      let isolationFallback
      if (!checked.readOnly && (isolation.mode === 'worktree' ||
          (isolation.mode === 'auto' && worktrees && isWorktreeEnabled()))) {
        const isolated = prepareItemIsolation({
          isolation, worktrees, args, exec, parent, checked, leases, batchId: childId, probeRepo, getWorkspaceRoot,
          captureGit, auditGit, onAudited, onWorktreeChild, onCleanupFailed, stageTracking,
        })
        if (isolated.itemIsolation) {
          try {
            const result = await runOrchestration({
              plan, parent, batchRoute, defaultRoute, maxDepth, subagents, signal,
              itemIsolation: isolated.itemIsolation, stageTracking,
            })
            const rows = isolated.rows.sort((left, right) => left.itemIndex - right.itemIndex)
            const audit = rows.length === 0 ? undefined : aggregateItemAudits(rows)
            return {
              ...result,
              ...(audit && { audit }),
              details: {
                worktrees: rows,
                itemAudits: rows.map(({ itemIndex, worktreeId, audit }) => ({ itemIndex, worktreeId, audit })),
                ...(audit && { writeAudit: audit }),
              },
            }
          } finally {
            isolated.disposeUnused()
          }
        }
        isolationFallback = isolated.isolationFallback
      }
      // Shared mode keeps the atomic batch lease and one snapshot audit.
      const write = prepareDispatchWrite({ args, exec, parent, leases, childId, tool: ORCHESTRATE_TOOL, checked })
      const sharedBatch = stageTracking ? newBatch(childId, parent, write) : undefined
      let result
      let audit
      try {
        if (sharedBatch) await stageTracking.beforeLaunch(write)
        result = await runOrchestration({
          plan,
          parent,
          batchRoute,
          defaultRoute,
          maxDepth,
          subagents,
          signal,
          writeScope: write.lease?.scope,
          baselineId: write.baseline?.baselineId,
          stageTracking,
          sharedBatch,
        })
      } finally {
        if (!stageTracking?.isDisposing() && (!sharedBatch || stageTracking.canFinishBatch(sharedBatch))) {
          try {
            audit = settleDispatchWrite(write.baseline)
            // On abort or another thrown error there is no result to attach evidence to.
            if (audit !== undefined) onAudited?.({ childId, parentId: parent.id, audit, hasResult: result !== undefined })
          } finally {
            if (sharedBatch) await stageTracking.finishBatch(sharedBatch, audit)
            else releaseWriteScope(leases, write.lease)
          }
        }
      }
      return {
        ...result,
        ...(audit && { audit }),
        ...(isolationFallback && { details: { isolationFallback } }),
      }
    },
  })
  // The host reads `description` while it builds a request; keep it a live getter for the
  // same reason as `delegate`, even though this text no longer depends on the whitelist.
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: descriptionOf,
  })
  return tool
}
