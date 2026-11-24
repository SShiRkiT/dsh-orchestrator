/**
 * Delegation tool. Dependency-free: `defineTool` is passed in, so the request
 * building can be tested without the DSH runtime.
 *
 * Why this exists (see docs/adr/0001): the native `subagent` tool's `agentOptions`
 * are plain config with no volatile field, so a settings write cannot change the
 * default worker route. This tool reads the route from the plugin's own volatile
 * config on every call, so a change applies from the next delegation.
 *
 * Route reading and request shaping live in `worker.js`, shared with `orchestrate`.
 * A delegated child does not inherit this tool any more (`lib/index.js` restricts
 * it away), so the description and the parameters can assume a main-agent reader:
 * there is only one text, and it is written for the planner.
 */

import { statSync } from 'node:fs'
import path from 'node:path'
import { DELEGATE_TOOL, DELIVERY, disabledToolMessage } from './api.js'
import { mainAgentRule } from './rules.js'
import { buildSpawnActivation, isDispatchEnabled, languageNote, readRoute, readRouteOverride } from './worker.js'
import { auditBaseline, captureBaseline, formatAuditReport } from './write-audit.js'
import { auditGitBaseline, captureGitBaseline, formatGitAuditReport } from './git-audit.js'
import { validateWriteScopeInput } from './write-lease.js'
import { ROOT_CLAIM, SCOPE_KIND, normalizeScope } from './write-scope.js'
import {
  ISOLATION_MODES, WriteScopeError, WRITE_SCOPE_TOOL_CODES, claimWriteScope, dispatchCwd,
  formatWorktreeError, parseIsolation, releaseWriteScope, requireWriteScope, writeScopeFailure,
} from './write-scope-tool.js'

export { DELEGATE_TOOL, languageNote, readRoute, readRouteOverride }

/**
 * The tool-level write-scope seam is shared with `orchestrate`, so both tools refuse with
 * the same `write-scope-*` codes and the same `details` rows. It is re-exported here
 * because `delegate` was the first tool to declare it and callers import it from the tool
 * they use.
 */
export { WriteScopeError, WRITE_SCOPE_TOOL_CODES } from './write-scope-tool.js'

export const READ_ONLY_NOTICE = '本任务仅限只读，不得写入文件。不占写租约；宿主未提供逐子代理物理只读隔离，由插件做逻辑写后审计并告警。'

export function dispatchWriteParameters({ batch = false } = {}) {
  return {
    writeScope: {
      type: 'array',
      items: { type: 'string' },
      description:
        '非只读任务必填：允许写入的文件或目录（至少一项）；readOnly: true 必须省略此项或传空数组。' +
        (batch ? '共享模式下整批共享一个写租约；隔离模式下每条目独立租用。' : '') +
        '冲突报 write-scope-conflict。相对路径基于 cwd，目录用 "/" 或 "/**"；声明不扩大权限，也不阻止越界写入。',
    },
    readOnly: { type: 'boolean', default: false, description: `设为 true 时：${READ_ONLY_NOTICE}` },
    isolation: {
      type: 'string',
      enum: [...ISOLATION_MODES],
      description: 'auto（默认，受 worktreeIsolationEnabled 控制）：Git 写任务自动使用独立 Worktree，非 Git 使用共享工作区与快照审计。' +
        'worktree：强制隔离，非 Git、空仓或超出工作区边界时报错，不降级。shared：使用共享工作区。readOnly: true 不建树，不能组合 worktree。',
    },
    expectedFingerprints: {
      type: 'object',
      // The host's author dialect only accepts a boolean here; execute checks each value.
      additionalProperties: true,
      description: '可选：从工作区相对文件路径到预期旧 SHA-256（64 位十六进制）的映射，结算时与派发前的磁盘基线比对。',
    },
    expectedTargets: {
      type: 'array',
      items: { type: 'string' },
      description: '可选：结算时预期仍存在的文件，使用基于 cwd 的相对路径。',
    },
  }
}

const invalidWrite = (message) => new WriteScopeError(WRITE_SCOPE_TOOL_CODES.invalid, message)
function isRelativeFile(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !normalized.endsWith('/')
}

export function validateDispatchWrite(args, tool) {
  const { writeScope, readOnly, expectedFingerprints, expectedTargets } = args ?? {}
  if (readOnly !== undefined && typeof readOnly !== 'boolean') throw invalidWrite('readOnly 必须是布尔值。')
  // Preserve the established tool-level error for a missing declaration.
  if (readOnly !== true) requireWriteScope(args, tool)
  const checked = validateWriteScopeInput({ writeScope, readOnly })
  if (!checked.ok) throw writeScopeFailure(checked)
  if (expectedFingerprints !== undefined) {
    const prototype = expectedFingerprints == null ? undefined : Object.getPrototypeOf(expectedFingerprints)
    if ((prototype !== Object.prototype && prototype !== null) ||
        !Object.entries(expectedFingerprints).every(([filename, hash]) => isRelativeFile(filename) &&
          typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash))) {
      throw invalidWrite('expectedFingerprints 必须是工作区相对文件路径到 64 位十六进制 SHA-256 的对象。')
    }
  }
  if (expectedTargets !== undefined && (!Array.isArray(expectedTargets) || !expectedTargets.every(isRelativeFile))) {
    throw invalidWrite('expectedTargets 必须是工作区相对文件路径数组。')
  }
  return checked
}

export function validateDispatchIsolation(args) {
  const parsed = parseIsolation(args?.isolation)
  if (!parsed.ok) throw new WriteScopeError(parsed.code, parsed.message)
  if (args?.readOnly === true && parsed.explicit && parsed.mode === 'worktree') {
    throw new WriteScopeError('isolation-invalid', '只读任务不支持强制独立 Worktree：请省略 isolation 或使用 auto/shared。')
  }
  return parsed
}

export const worktreeFailure = (result) => new WriteScopeError(result.code, formatWorktreeError(result.code, result))

export function dispatchWorkspaceRoot(exec, getWorkspaceRoot) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : getWorkspaceRoot?.(exec) ?? null
}

export function worktreeDetails(worktree) {
  return { id: worktree.id, branch: worktree.branch, path: worktree.worktreePath, execCwd: worktree.execCwd }
}

export function worktreePromptNote(worktree) {
  return `你在独立 Worktree（分支 ${worktree.branch}）中工作，仅修改声明的作用域；请勿自行合并主分支。\n主代理会用 worktree_manage 评审、合回或丢弃交付。`
}

export function discardEmptyWorktree(worktrees, worktree, onCleanupFailed) {
  try {
    const result = worktrees.discard(worktree.id, { force: true, lockChild: false })
    if (!result.ok) onCleanupFailed?.(worktreeFailure(result))
  } catch (error) {
    onCleanupFailed?.(error)
  }
}

export function captureDispatchBaseline({ cwd, writeScope, readOnly, expectedFingerprints, expectedTargets }) {
  // Never turn an absent/foreign mock cwd into our process directory or audit a virtual one.
  let noDirectory = typeof cwd !== 'string' || !path.isAbsolute(cwd)
  if (!noDirectory) {
    try {
      noDirectory = !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()
    } catch (error) {
      // Permission or I/O failures must be reported by the audit instead of passing silently.
      noDirectory = error?.code === 'ENOTDIR'
    }
  }
  if (noDirectory) {
    if (Object.keys(expectedFingerprints ?? {}).length > 0 || (expectedTargets?.length ?? 0) > 0) {
      throw invalidWrite('需要存在的工作目录才能验证 expectedFingerprints 或 expectedTargets。')
    }
    return undefined
  }
  try {
    return captureBaseline({ cwd, writeScope, readOnly, expectedFingerprints, expectedTargets })
  } catch (error) {
    throw invalidWrite(error instanceof Error ? error.message : String(error))
  }
}

function relocateWriteScope(entries, sourceCwd) {
  const normalized = normalizeScope(entries, sourceCwd)
  if (!normalized.ok) throw writeScopeFailure(normalized)
  if (normalized.outsideWorkspace.length > 0) {
    throw invalidWrite(`独立 Worktree 的写作用域必须在源 cwd 内：${normalized.outsideWorkspace.join('、')}。`)
  }
  return normalized.entries.map((entry) => {
    if (entry.kind === SCOPE_KIND.root) return ROOT_CLAIM
    const relative = path.relative(sourceCwd, entry.path) || '.'
    return entry.kind === SCOPE_KIND.dir ? `${relative}/` : relative
  })
}

export function prepareDispatchWrite({
  args, exec, parent, leases, childId, tool, checked, worktree, captureGit = captureGitBaseline,
}) {
  const sourceCwd = dispatchCwd(args, exec)
  const cwd = worktree?.execCwd ?? sourceCwd
  const readOnly = checked.readOnly
  const writeScope = readOnly ? [] : worktree
    ? relocateWriteScope(checked.entries, sourceCwd)
    : typeof args.writeScope === 'string' ? [args.writeScope] : [...args.writeScope]
  const leaseArgs = worktree ? { ...args, cwd, writeScope } : args
  const held = readOnly ? null : claimWriteScope({ args: leaseArgs, exec, parent, leases, childId, tool })
  try {
    const entries = held === null ? [] : leases.get?.(held.leaseId)?.entries ?? normalizeScope(writeScope, cwd).entries
    const baseline = worktree
      ? captureGit({ ...args, worktree, cwd, repoRoot: worktree.repoRoot, writeScope, readOnly })
      : captureDispatchBaseline({ ...args, cwd, writeScope, readOnly })
    return { lease: held, entries, cwd, writeScope, readOnly, baseline, ...(worktree && { worktree }) }
  } catch (error) {
    releaseWriteScope(leases, held)
    throw error
  }
}

export function settleDispatchWrite(baseline, auditGit = auditGitBaseline) {
  if (baseline === undefined) return undefined
  const git = baseline.kind === 'git-worktree' || baseline.mode === 'git-worktree' || Boolean(baseline.worktree)
  try {
    return git ? auditGit(baseline) : auditBaseline(baseline)
  } catch (error) {
    return {
      baselineId: baseline.baselineId,
      passed: false,
      readOnly: baseline.readOnly,
      isolationLevel: git ? 'git-worktree' : 'logical-post-audit',
      isolationNote: git ? 'Git 工作树审计失败，不能验收。' : '审计失败，不能据此确认写入合规；本模式不是物理隔离。',
      changedFiles: [],
      violations: [{ code: 'audit-incomplete', path: '.', reason: error instanceof Error ? error.message : String(error) }],
      summary: { added: 0, modified: 0, deleted: 0, violations: 1, truncated: baseline.truncated },
    }
  }
}

export function worktreeAuditSummary(audit) {
  return {
    commits: audit.git?.commits?.length ?? 0,
    dirty: (audit.git?.dirtyFiles?.length ?? 0) > 0,
    auditPassed: audit.passed,
  }
}

export function auditNotice(audit) {
  if (audit?.passed !== false) return ''
  return audit.git ? formatGitAuditReport(audit) : formatAuditReport(audit)
}

/** The delegate spec: the prompt carries the language note and delivery answers the parent. */
export function buildActivation({ args, parent, route, maxDepth, signal, baselineId, worktree }) {
  return buildSpawnActivation({
    cwd: worktree?.execCwd ?? args.cwd,
    prompt: languageNote(args.prompt) + args.prompt +
      (args.readOnly === true ? `\n\n${READ_ONLY_NOTICE}` : '') +
      (baselineId === undefined ? '' : `\n写后审计基线：${baselineId}。`) +
      (worktree ? `\n\n${worktreePromptNote(worktree)}` : ''),
    label: args.description,
    parent,
    route,
    maxDepth,
    signal,
    delivery: DELIVERY.delegate,
  })
}

export function createDelegateTool({
  defineTool,
  subagents,
  config,
  onStarted,
  nativeToolNote,
  allowedTools,
  deniedTools,
  leases,
  worktrees,
  isWorktreeEnabled = () => true,
  getWorkspaceRoot,
  captureGitBaseline: captureGit,
  onCleanupFailed,
  persistence,
}) {
  // `allowedTools` is the Allowed Tools whitelist the gate enforces: a function when the
  // host owns the list, read again whenever the description is rendered, so a settings
  // change reaches the prompt without re-registering the tool. A fixed array is still
  // accepted, for tests and callers that have no live config. `deniedTools` is accepted
  // only as a legacy alias, so an older caller cannot silently describe the wrong rule.
  const list = allowedTools ?? deniedTools
  const liveAllowed = typeof list === 'function' ? list : () => list
  const enabled = () => isDispatchEnabled(config)
  const rule = () => mainAgentRule(liveAllowed())
  const body =
    '把一个自包含任务交给子代理执行。子代理看不到本会话，prompt 须写清目标、允许修改的文件、验收命令与兜底方案。非只读任务必填 writeScope；只读任务设 readOnly: true，不占租约，只做逻辑写后审计而非物理隔离。' +
    '立即返回子代理 ID 及宿主提供的 agentName，二者均可填 send_message.agent。结束时自动通知，严禁要求子代理用 send_message 汇报。' +
    '独立 Worktree 交付物须经 worktree_manage 评审、合回或丢弃。' +
    '多个独立任务在同一轮并发发起；同构批量请用 orchestrate。'
  const descriptionOf = () => (enabled() ? rule() + (nativeToolNote?.() ?? '') + body : body)

  // A provisional id lets the lease be registered before the host names the child: the
  // conflict has to be refused before `startActivation` (AC1). `rebind` moves the same
  // lease to the real child id once the host has created it.
  let pending = 0
  const nextPendingChildId = (parent) => {
    pending += 1
    return `pending:${String(parent?.id ?? 'parent')}:${String(pending)}`
  }

  const tool = defineTool({
    name: DELEGATE_TOOL,
    description: descriptionOf(),
    parameters: {
      cwd: {
        type: 'string',
        description: '初始工作目录（相对路径基于当前目录）；省略则继承。',
      },
      ...dispatchWriteParameters(),
      description: {
        type: 'string',
        required: true,
        description: '任务简述（3-5 词），用于展示。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: '交给子代理的完整任务说明；它看不到本会话。',
      },
      provider: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名（当前消息或 AGENTS.md 等工作区指令）时与 model 同传；省略走 worker 路由。',
      },
      model: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名（当前消息或 AGENTS.md 等工作区指令）时与 provider 同传；省略走 worker 路由。',
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
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
          agentName: { type: 'string' },
          readOnly: { type: 'boolean' },
          baselineId: { type: 'string' },
          worktree: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' }, branch: { type: 'string' }, path: { type: 'string' }, execCwd: { type: 'string' },
            },
          },
          details: { type: 'object', additionalProperties: true },
          writeScope: {
            type: 'object',
            additionalProperties: false,
            properties: {
              leaseId: { type: 'string' },
              scope: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已启动子代理 ${value.subagentId}` +
          (value.agentName ? `（send_message.agent: ${value.agentName}）` : '') + (value.worktree
          ? `\n独立 Worktree ${value.worktree.id}（${value.worktree.branch}）：${value.worktree.path}；执行目录 ${value.worktree.execCwd}。完成后请用 worktree_manage 评审。`
          : value.details?.isolationFallback ? `\n已降级为共享工作区：${value.details.isolationFallback.message}` : ''),
      }],
    },
    // Workers are independent by contract, so several may be started in one message.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!enabled()) throw new Error(disabledToolMessage(DELEGATE_TOOL))
      const parent = exec.agent
      if (!parent) throw new Error('delegate requires a calling agent (exec.agent was undefined)')
      const isolation = validateDispatchIsolation(args)
      const checked = validateDispatchWrite(args, DELEGATE_TOOL)
      if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') throw new Error('delegate requires a non-empty prompt')
      if (typeof args?.description !== 'string' || args.description.trim() === '') throw new Error('delegate requires a non-empty description')
      // An explicit per-call override wins and is never read from config; otherwise the
      // route is read at call time, so a changed route applies from this delegation on.
      const route = readRouteOverride(args, DELEGATE_TOOL) ?? readRoute(config)
      exec.signal.throwIfAborted()
      const maxDepth = subagents.resolveMaxDepth(undefined)
      let worktree
      let isolationFallback
      const forced = isolation.mode === 'worktree'
      if (!checked.readOnly && (forced || (isolation.mode === 'auto' && isWorktreeEnabled()))) {
        if (!worktrees && forced) throw worktreeFailure({ code: 'worktree-create-failed', message: '工作树管理器不可用。' })
        if (worktrees) {
          const created = worktrees.create({
            sourceCwd: dispatchCwd(args, exec), workspaceRoot: dispatchWorkspaceRoot(exec, getWorkspaceRoot),
            label: args.description, parentId: parent.id ?? null,
          })
          if (created.ok) worktree = created.worktree
          else if (forced) throw worktreeFailure(created)
          else if (!['not-git-repo', 'unborn-head'].includes(created.code)) {
            isolationFallback = { code: created.code, message: formatWorktreeError(created.code, created) }
          }
        }
      }
      let write
      let handedOff = false
      let childStarted = false
      try {
        // Claim the execution checkout and freeze the baseline before the host can run the child.
        write = prepareDispatchWrite({
          args, exec, parent, leases, childId: nextPendingChildId(parent), tool: DELEGATE_TOOL, checked,
          worktree, captureGit,
        })
        const held = write.lease
        const baselineId = write.baseline?.baselineId
        const spec = buildActivation({ args, parent, route, maxDepth, signal: exec.signal, baselineId, worktree })
        if (persistence) {
          await persistence.beforeLaunch(write)
          persistence.assertActive()
          exec.signal.throwIfAborted()
        }
        const started = await subagents.startActivation(spec)
        const childId = started?.childId
        if (typeof childId !== 'string' || childId === '') {
          throw new Error('delegate: startActivation returned no child id')
        }
        childStarted = true
        const agentName = typeof started.name === 'string' && started.name.trim() && started.name !== childId
          ? started.name : undefined
        if (worktree) {
          worktrees.rebindChild(worktree.id, childId)
          worktrees.bindChild?.(worktree.id, childId)
        }
        let scope = held?.scope
        // `rebind` attaches a writable dispatch to the real child, never a read-only one.
        if (held !== null && typeof leases.rebind === 'function') {
          const rebound = leases.rebind(held.leaseId, { childId })
          if (!rebound.ok) {
            throw new WriteScopeError(WRITE_SCOPE_TOOL_CODES.invalid, rebound.message)
          }
          if (Array.isArray(rebound.lease?.scope)) scope = rebound.lease.scope
        }
        // From here on the child owns the lease: `subagent/end` and `agent/disposed` release
        // it, because the child outlives this tool call.
        handedOff = true
        // Supervision is best-effort: a missing or broken callback must neither fail the
        // dispatch nor change what the main agent receives back.
        if (persistence) {
          await onStarted?.(parent, started, args, write, agentName)
        } else {
          try {
            const notified = onStarted?.(parent, started, args, write, agentName)
            notified?.catch?.(() => {})
          } catch {
            // Standalone supervision is best-effort; it does not own dispatch durability.
          }
        }
        const isolated = worktree && worktreeDetails(worktree)
        return {
          kind: 'activation',
          subagentId: childId,
          ...(agentName && { agentName }),
          ...(held === null ? { readOnly: true } : { writeScope: { leaseId: held.leaseId, scope: [...scope] } }),
          ...(baselineId === undefined ? {} : { baselineId }),
          ...(isolated ? { worktree: isolated, details: { worktree: isolated } } : {}),
          ...(isolationFallback ? { details: { isolationFallback } } : {}),
        }
      } finally {
        if (!handedOff && !childStarted && !persistence?.isDisposing()) {
          releaseWriteScope(leases, write?.lease)
          if (worktree) discardEmptyWorktree(worktrees, worktree, onCleanupFailed)
          if (persistence) await persistence.afterFailedLaunch({ ...write, worktree })
        } else if (!handedOff && !persistence) {
          releaseWriteScope(leases, write?.lease)
        }
      }
    },
  })
  // The host reads `description` while it builds a request (its own run_code tool uses a
  // getter for the same reason), so this keeps the rule text in step with the gate.
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: descriptionOf,
  })
  return tool
}
