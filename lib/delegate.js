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

import path from 'node:path'
import { DELEGATE_TOOL, DELIVERY, disabledToolMessage } from './api.js'
import { mainAgentRule, teamTaskPromptNote } from './rules.js'
import { buildSpawnActivation, configValue, isDispatchEnabled, languageNote, readRoute, readRouteOverride } from './worker.js'
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

export const READ_ONLY_NOTICE = '本任务仅限只读，不得写入文件。不占写租约；宿主未提供逐子代理物理只读隔离。'

function parseAllowNewReason(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error('allowNewReason 必须是非空字符串。'), { code: 'delegate-invalid-new-reason' })
  }
  return value.trim()
}

function requireReuse(candidates) {
  if (candidates.length === 0) return
  const { childId, agentName } = candidates[0]
  throw Object.assign(new Error(
    `[delegate-reuse-required] 当前会话有闲置可续跑的子代理：${candidates.map((row) => row.agentName).join('、')}。` +
    `请用 send_message({ agent: ${JSON.stringify(agentName)}, message: '...' }) 复用。` +
    `需改范围或只读模式时，先调用 delegate_status({ action: 'edit', childId: ${JSON.stringify(childId)}, ... })，再用 send_message。` +
    '确实无法复用时才传入非空 allowNewReason 说明原因后新建。',
  ), { code: 'delegate-reuse-required', details: { candidates } })
}

export const TEAM_TASK_ID_PARAMETER = Object.freeze({
  type: 'string',
  description: '可选共享任务 ID，仅供对齐。',
})

export function parseTeamTaskId(value, tool) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${tool}: "team_task_id" must be a string when provided`)
  }
  return value.trim() || undefined
}

export function dispatchWriteParameters({ batch = false, readOnlyEnabled = true } = {}) {
  return {
    writeScope: {
      type: 'array',
      items: { type: 'string' },
      description:
        (readOnlyEnabled ? '写任务必填（至少一项），相对 cwd，目录以 "/" 或 "/**" 结尾。只读模式时省略或空数组。'
          : '必填（至少一项），相对 cwd，目录以 "/" 或 "/**" 结尾。只读调研请使用 shared 并明确禁止修改文件。') +
        '租约冲突报 write-scope-conflict，声明不扩大或强制权限。' +
        (batch ? '共享模式整批共用一租约，隔离模式每条目独立租用。' : ''),
    },
    ...(readOnlyEnabled && { readOnly: { type: 'boolean', default: false, description: '启用 true 则禁止写入，无写租约和物理只读隔离。' } }),
    isolation: {
      type: 'string',
      enum: [...ISOLATION_MODES],
      description: 'auto 按设置：Git 写入用独立树，非 Git 共享。worktree 强制隔离，失败报错。shared 共用工作区。' +
        (readOnlyEnabled ? 'readOnly 打开时只读不建树，与 worktree 互斥。' : ''),
    },
  }
}

export const READ_ONLY_DISABLED = 'readOnly 参数当前未启用，请移除此参数。只读调研请使用 isolation: "shared"，并在任务中明确禁止修改文件。'

const invalidWrite = (message) => new WriteScopeError(WRITE_SCOPE_TOOL_CODES.invalid, message)

export function assertReadOnlyArgumentEnabled(args, enabled) {
  if (!enabled && args != null && Object.hasOwn(args, 'readOnly')) throw invalidWrite(READ_ONLY_DISABLED)
}

export function validateDispatchWrite(args, tool, readOnlyEnabled = true) {
  assertReadOnlyArgumentEnabled(args, readOnlyEnabled)
  const { writeScope, readOnly } = args ?? {}
  if (readOnly !== undefined && typeof readOnly !== 'boolean') throw invalidWrite('readOnly 必须是布尔值。')
  // Preserve the established tool-level error for a missing declaration.
  if (readOnly !== true) requireWriteScope(args, tool)
  const checked = validateWriteScopeInput({ writeScope, readOnly })
  if (!checked.ok) throw writeScopeFailure(checked)
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
  args, exec, parent, leases, childId, tool, checked, worktree,
}) {
  const sourceCwd = dispatchCwd(args, exec)
  const cwd = worktree?.execCwd ?? sourceCwd
  const readOnly = checked.readOnly
  const writeScope = readOnly ? [] : worktree
    ? relocateWriteScope(checked.entries, sourceCwd)
    : typeof args.writeScope === 'string' ? [args.writeScope] : [...args.writeScope]
  const leaseArgs = worktree ? { ...args, cwd, writeScope } : args
  const held = readOnly ? null : claimWriteScope({ args: leaseArgs, exec, parent, leases, childId, tool })
  const entries = held === null ? [] : leases.get?.(held.leaseId)?.entries ?? normalizeScope(writeScope, cwd).entries
  return { lease: held, entries, cwd, writeScope, readOnly, ...(worktree && { worktree }) }
}

/** The delegate spec: the prompt carries the language note and delivery answers the parent. */
export function buildActivation({ args, parent, route, maxDepth, signal, worktree, teamTaskId }) {
  return buildSpawnActivation({
    cwd: worktree?.execCwd ?? args.cwd,
    prompt: languageNote(args.prompt) + args.prompt +
      (args.readOnly === true ? `\n\n${READ_ONLY_NOTICE}` : '') +
      (worktree ? `\n\n${worktreePromptNote(worktree)}` : '') +
      (teamTaskId === undefined ? '' : `\n\n${teamTaskPromptNote(teamTaskId)}`),
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
  resolveSessionConfig,
  getWorkspaceRoot,
  listReusableChildren,
  onCleanupFailed,
  persistence,
}) {
  // Direct callers may provide an unscoped display list. Model-facing descriptions
  // are rendered explicitly on scoped copies by tool-surface, never through this list.
  const legacyList = allowedTools ?? deniedTools
  const legacyAllowed = typeof legacyList === 'function' ? legacyList : () => legacyList
  const globalReadOnly = () => configValue(config, 'readOnlyEnabled', false) === true
  const body = 'Team 任务板只作对齐。派发单个独立任务。子代理看不到本会话，prompt 须写清目标、允许修改的文件、验收命令与兜底方案。' +
    '立即返回子代理 ID 及宿主提供的 agentName，二者均可填 send_message.agent。结束时自动通知，严禁要求子代理用 send_message 汇报。' +
    '多个独立任务在同一轮并发发起；同构批量请用 orchestrate。'
  const describeFor = (allowed, options = {}) => {
    const { enabled = isDispatchEnabled(config), readOnlyEnabled = globalReadOnly() } = options
    const rule = enabled ? mainAgentRule(allowed, { readOnlyEnabled }) + (nativeToolNote?.(allowed) ?? '') : ''
    return rule + body
  }
  const descriptionOf = () => legacyList === undefined ? body : describeFor(legacyAllowed())

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
        description: '初始工作目录，省略则继承，相对当前 cwd',
      },
      ...dispatchWriteParameters(),
      description: {
        type: 'string',
        required: true,
        description: '任务简述展示，3–5 词。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: '交给子代理的完整任务说明。',
      },
      team_task_id: TEAM_TASK_ID_PARAMETER,
      allowNewReason: { type: "string", description: "无法复用已有子代理的原因。" },
      provider: {
        type: 'string',
        description:
          '仅当用户显式点名（当前消息或 AGENTS.md 等工作区指令）时与 model 同传；省略走 worker 路由。',
      },
      model: {
        type: 'string',
        description:
          '与 provider 同传；省略走 worker 路由。',
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
      const parent = exec?.agent
      const effective = resolveSessionConfig?.(parent)
      if (!(effective?.enabled ?? isDispatchEnabled(config))) throw new Error(disabledToolMessage(DELEGATE_TOOL))
      if (!parent) throw new Error('delegate requires a calling agent (exec.agent was undefined)')
      const checked = validateDispatchWrite(args, DELEGATE_TOOL, effective?.readOnlyEnabled ?? globalReadOnly())
      const isolation = validateDispatchIsolation(args)
      if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') throw new Error('delegate requires a non-empty prompt')
      if (typeof args?.description !== 'string' || args.description.trim() === '') throw new Error('delegate requires a non-empty description')
      const teamTaskId = parseTeamTaskId(args.team_task_id, DELEGATE_TOOL)
      const allowNewReason = parseAllowNewReason(args.allowNewReason)
      if (allowNewReason === undefined && listReusableChildren) {
        requireReuse(await listReusableChildren(parent, exec.signal))
      }
      // An explicit per-call override wins and is never read from config; otherwise the
      // route is read at call time, so a changed route applies from this delegation on.
      const route = readRouteOverride(args, DELEGATE_TOOL) ?? effective?.workerRoute ?? readRoute(config)
      exec.signal.throwIfAborted()
      const maxDepth = subagents.resolveMaxDepth(undefined)
      let worktree
      let isolationFallback
      const forced = isolation.mode === 'worktree'
      if (!checked.readOnly && (forced || (isolation.mode === 'auto' && (effective?.worktreeIsolationEnabled ?? isWorktreeEnabled(parent))))) {
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
        // Claim the execution checkout before the host can run the child.
        write = prepareDispatchWrite({
          args, exec, parent, leases, childId: nextPendingChildId(parent), tool: DELEGATE_TOOL, checked,
          worktree,
        })
        if (allowNewReason !== undefined) write.allowNewReason = allowNewReason
        const held = write.lease
        const spec = buildActivation({
          args, parent, route, maxDepth, signal: exec.signal, worktree, teamTaskId,
        })
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
  // Direct consumers keep a readable default. Request-scoped definitions supply their
  // resolved list explicitly rather than changing the registered tool's description.
  Object.defineProperties(tool, {
    description: { enumerable: true, configurable: true, get: descriptionOf },
    describeFor: { value: describeFor },
  })
  return tool
}
