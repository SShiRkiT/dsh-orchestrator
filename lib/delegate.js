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

import { DELEGATE_TOOL, DELIVERY } from './api.js'
import { mainAgentRule } from './rules.js'
import { buildSpawnActivation, languageNote, readRoute, readRouteOverride } from './worker.js'
import { WRITE_LEASE_CODES } from './write-lease.js'
import { WRITE_SCOPE_CODES, isWindowsPath, normalizeScope, parseWriteScope } from './write-scope.js'

export { DELEGATE_TOOL, languageNote, readRoute, readRouteOverride }

/**
 * The codes a `writeScope` failure shows to the model. The lease table's internal
 * `write-lease-*` codes never escape: `lib/write-scope.js` and `lib/write-lease.js` are
 * implementation, and a caller branches on these four names only.
 */
export const WRITE_SCOPE_TOOL_CODES = Object.freeze({
  conflict: 'write-scope-conflict',
  invalid: 'write-scope-invalid',
  cwdMissing: 'write-scope-cwd-missing',
  limit: 'write-scope-limit',
})

/** A tool error with a stable code; callers branch on `code`, never on the message. */
export class WriteScopeError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'WriteScopeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** The issue's `details` cap; the refusal is already decided past this point. */
const MAX_CONFLICT_DETAILS = 16

/** Conflict rows in a deterministic order: by path, then by owner. */
function conflictDetails(conflicts) {
  const seen = new Set()
  const rows = []
  for (const conflict of Array.isArray(conflicts) ? conflicts : []) {
    const path = conflict?.path
    const owner = conflict?.childId
    if (typeof path !== 'string' || typeof owner !== 'string') continue
    const key = `${path}\u0000${owner}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ path, owner, label: null })
  }
  rows.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    if (left.owner === right.owner) return 0
    return left.owner < right.owner ? -1 : 1
  })
  return rows.slice(0, MAX_CONFLICT_DETAILS)
}

/** Map a `write-scope-*` refusal into the tool-level namespace. */
function writeScopeFailure(result) {
  const code =
    result.code === WRITE_SCOPE_CODES.noCwd
      ? WRITE_SCOPE_TOOL_CODES.cwdMissing
      : WRITE_SCOPE_TOOL_CODES.invalid
  return new WriteScopeError(code, result.message)
}

/** Map a lease-table refusal into the tool-level namespace. */
function leaseFailure(result) {
  if (result.code === WRITE_LEASE_CODES.conflict) {
    return new WriteScopeError(
      WRITE_SCOPE_TOOL_CODES.conflict,
      result.message,
      conflictDetails(result.conflicts),
    )
  }
  if (result.code === WRITE_LEASE_CODES.capacity) {
    return new WriteScopeError(WRITE_SCOPE_TOOL_CODES.limit, result.message)
  }
  return new WriteScopeError(WRITE_SCOPE_TOOL_CODES.invalid, result.message)
}

/** The parent directory the host resolves a relative dispatch `cwd` against. */
function inheritedCwd(exec) {
  const candidates = [
    exec?.cwd,
    exec?.agent?.cwd,
    exec?.agent?.session?.header?.cwd,
    exec?.agent?.session?.cwd,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function isAbsolutePath(value) {
  if (isWindowsPath(value)) {
    return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)
  }
  return value.startsWith('/')
}

function joinCwd(base, relative) {
  return `${base.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`
}

/**
 * The directory a declared scope resolves against. An omitted `cwd` inherits the parent
 * directory, exactly like `startActivation` does for the child; when the host exposes
 * none, `normalizeScope` reports `write-scope-cwd-missing` instead of guessing.
 */
function dispatchCwd(args, exec) {
  const explicit = typeof args?.cwd === 'string' ? args.cwd.trim() : ''
  const inherited = inheritedCwd(exec)
  if (explicit === '') return inherited
  if (isAbsolutePath(explicit) || inherited === undefined) return explicit
  return joinCwd(inherited, explicit)
}

/** The delegate spec: the prompt carries the language note and delivery answers the parent. */
export function buildActivation({ args, parent, route, maxDepth, signal }) {
  return buildSpawnActivation({
    cwd: args.cwd,
    prompt: languageNote(args.prompt) + args.prompt,
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
  allowedTools,
  deniedTools,
  leases,
}) {
  // `allowedTools` is the Allowed Tools whitelist the gate enforces: a function when the
  // host owns the list, read again whenever the description is rendered, so a settings
  // change reaches the prompt without re-registering the tool. A fixed array is still
  // accepted, for tests and callers that have no live config. `deniedTools` is accepted
  // only as a legacy alias, so an older caller cannot silently describe the wrong rule.
  const list = allowedTools ?? deniedTools
  const liveAllowed = typeof list === 'function' ? list : () => list
  const rule = () => mainAgentRule(liveAllowed())
  const body =
    '把一个自包含任务交给子代理执行。子代理看不到本会话，prompt 必须写清目标、允许修改的文件、' +
    '验收命令与兜底方案；它按用户配置的 worker 路由运行，不要自行指定模型。本调用立即返回子代理 id，' +
    '结束时由运行时自动通知你。严禁要求子代理调用 send_message 汇报结果，它的收尾消息会在结束时自动送达。' +
    '多个独立子任务应在同一轮发起全部调用（delegate 可并发安全调用）；同构批量任务请用 orchestrate。' +
    '严禁两个子代理修改同一文件；写任务请用 writeScope 声明允许修改的文件或目录，插件会在派发前拒绝与其他写者重叠的声明。' +
    '子代理仍在运行时可用 send_message 纠偏，已结束的可用 send_message ' +
    '追加任务（它保留自己的上下文）。长时间运行的子代理会被插件每隔几分钟巡检：收到「【插件巡检…】」' +
    '消息（来自插件，不是用户）时，用 send_message 纠正跑偏的子代理；无需处理时单行回复并结束回合。'

  // A provisional id lets the lease be registered before the host names the child: the
  // conflict has to be refused before `startActivation` (AC1). `rebind` moves the same
  // lease to the real child id once the host has created it.
  let pending = 0
  const nextPendingChildId = (parent) => {
    pending += 1
    return `pending:${String(parent?.id ?? 'parent')}:${String(pending)}`
  }

  /** Normalize and claim the declared scope, or return undefined when none was declared. */
  const acquireLease = (args, exec, parent) => {
    const declared = args?.writeScope
    if (declared === undefined || declared === null) return undefined
    if (leases === undefined || typeof leases.acquire !== 'function') {
      throw new WriteScopeError(
        WRITE_SCOPE_TOOL_CODES.invalid,
        'delegate 收到 writeScope，但插件没有可用的写租约表（leases），无法与其他写者判重。',
      )
    }
    const parsed = parseWriteScope(declared)
    if (!parsed.ok) throw writeScopeFailure(parsed)
    const normalized = normalizeScope(parsed.entries, dispatchCwd(args, exec))
    if (!normalized.ok) throw writeScopeFailure(normalized)
    const acquired = leases.acquire({
      childId: nextPendingChildId(parent),
      parentId: typeof parent?.id === 'string' ? parent.id : '',
      entries: normalized.entries,
    })
    if (!acquired.ok) throw leaseFailure(acquired)
    // The shipped table answers `{ lease }`; accepting a bare record keeps a test double
    // from having to reproduce the snapshot shape exactly.
    const lease = acquired.lease ?? acquired
    if (typeof lease?.leaseId !== 'string' || lease.leaseId === '') {
      throw new WriteScopeError(
        WRITE_SCOPE_TOOL_CODES.invalid,
        'delegate: 租约表没有返回可用的 leaseId，无法登记写作用域。',
      )
    }
    return {
      leaseId: lease.leaseId,
      scope: Array.isArray(lease.scope) ? lease.scope : [],
    }
  }

  const tool = defineTool({
    name: DELEGATE_TOOL,
    description: rule() + body,
    parameters: {
      cwd: {
        type: 'string',
        description: '子代理初始工作目录（相对路径基于你的当前目录）；省略则继承当前目录。',
      },
      writeScope: {
        type: 'array',
        items: { type: 'string' },
        // Deliberately no default and no minItems: omitting the field means "not declared"
        // (no conflict check, old behaviour), while an empty array is an invalid declaration.
        description:
          '可选：本子代理允许写入的文件或目录清单。省略表示未声明（不做冲突检测，保持旧行为）；' +
          '一旦给出，插件在派发前把它归一化，并与所有在租的写作用域求交，相交则本次派发直接失败，' +
          '错误 code 为 write-scope-conflict。相对路径基于 cwd 解析；目录用尾随 "/" 或 "/**"；' +
          '单个 "*" 表示认领整个工作区（不推荐，会让所有并发写互相冲突）。' +
          '这是声明而非授权：它不扩大子代理的工具权限，也不阻止它在声明外写入。',
      },
      description: {
        type: 'string',
        required: true,
        description: '任务简述（3-5 个词），用于展示。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: '交给子代理的完整任务说明；它看不到本会话。',
      },
      provider: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名该子代理的 provider 与 model 时才传，且需与 model 同时给出；' +
          '两者都省略时使用调度面板的 worker 路由。严禁自行选择模型。仅限本次派发，禁止复用历史轮次或摘要中的模型。',
      },
      model: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名该子代理的 provider 与 model 时才传，且需与 provider 同时给出；' +
          '两者都省略时使用调度面板的 worker 路由。严禁自行选择模型。仅限本次派发，禁止复用历史轮次或摘要中的模型。',
      },
      reasoning_effort: {
        type: 'string',
        description:
          '可选，仅与 provider 和 model 同时使用：该子代理的推理强度。省略则由所选模型决定默认值；仅当用户点名时才设置。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
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
      render: (_args, value) => [{ type: 'text', text: `已启动子代理 ${value.subagentId}` }],
    },
    // Workers are independent by contract, so several may be started in one message.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('delegate requires a calling agent (exec.agent was undefined)')
      // Requiredness is declared in the schema, but direct tool use still needs the contract checked.
      if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') throw new Error('delegate requires a non-empty prompt')
      if (typeof args?.description !== 'string' || args.description.trim() === '') throw new Error('delegate requires a non-empty description')
      // An explicit per-call override wins and is never read from config; otherwise the
      // route is read at call time, so a changed route applies from this delegation on.
      const route = readRouteOverride(args, DELEGATE_TOOL) ?? readRoute(config)
      exec.signal.throwIfAborted()
      const spec = buildActivation({
        args,
        parent,
        route,
        maxDepth: subagents.resolveMaxDepth(undefined),
        signal: exec.signal,
      })
      // The lease is claimed before the host starts the child: a conflict is a refusal, not
      // a post-mortem. `handedOff` is what separates a live child from a failed dispatch.
      const held = acquireLease(args, exec, parent)
      let handedOff = false
      try {
        const started = await subagents.startActivation(spec)
        const childId = started?.childId
        if (typeof childId !== 'string' || childId === '') {
          throw new Error('delegate: startActivation returned no child id')
        }
        let writeScope
        if (held !== undefined) {
          let scope = held.scope
          // `rebind` is what keeps the lease attached to the real child; a test double that
          // only implements the acquire/release contract still gets a usable result.
          if (typeof leases.rebind === 'function') {
            const rebound = leases.rebind(held.leaseId, { childId })
            if (!rebound.ok) {
              throw new WriteScopeError(WRITE_SCOPE_TOOL_CODES.invalid, rebound.message)
            }
            if (Array.isArray(rebound.lease?.scope)) scope = rebound.lease.scope
          }
          writeScope = { leaseId: held.leaseId, scope: [...scope] }
        }
        // From here on the child owns the lease: `subagent/end` and `agent/disposed` release
        // it, because the child outlives this tool call.
        handedOff = true
        // Supervision is best-effort: a missing or broken callback must neither fail the
        // dispatch nor change what the main agent receives back.
        try {
          const notified = typeof onStarted === 'function' ? onStarted(parent, started, args) : undefined
          // The callback is synchronous, but tolerate an async one without awaiting it.
          if (notified !== undefined && typeof notified.catch === 'function') notified.catch(() => {})
        } catch {
          // Deliberately swallowed: a supervision bug cannot be allowed to affect dispatch.
        }
        return {
          kind: 'activation',
          subagentId: childId,
          ...(writeScope === undefined ? {} : { writeScope }),
        }
      } finally {
        // A dispatch that never handed the child off must not leak its reservation. A live
        // child's lease is released by the lifecycle hooks instead, not here.
        if (held !== undefined && !handedOff && typeof leases.release === 'function') {
          leases.release(held.leaseId)
        }
      }
    },
  })
  // The host reads `description` while it builds a request (its own run_code tool uses a
  // getter for the same reason), so this keeps the rule text in step with the gate.
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: () => rule() + body,
  })
  return tool
}
