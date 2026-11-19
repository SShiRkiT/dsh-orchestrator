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

import { DELEGATE_TOOL, DELIVERY, disabledToolMessage } from './api.js'
import { mainAgentRule } from './rules.js'
import { buildSpawnActivation, isDispatchEnabled, languageNote, readRoute, readRouteOverride } from './worker.js'
import { WriteScopeError, WRITE_SCOPE_TOOL_CODES, claimWriteScope, requireWriteScope } from './write-scope-tool.js'

export { DELEGATE_TOOL, languageNote, readRoute, readRouteOverride }

/**
 * The tool-level write-scope seam is shared with `orchestrate`, so both tools refuse with
 * the same `write-scope-*` codes and the same `details` rows. It is re-exported here
 * because `delegate` was the first tool to declare it and callers import it from the tool
 * they use.
 */
export { WriteScopeError, WRITE_SCOPE_TOOL_CODES } from './write-scope-tool.js'

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
  const enabled = () => isDispatchEnabled(config)
  const rule = () => mainAgentRule(liveAllowed())
  const body =
    '把一个自包含任务交给子代理执行。子代理看不到本会话，prompt 须写清目标、允许修改的文件、验收命令与兜底方案，派发时必填 writeScope。' +
    '调用立即返回子代理 id，结束时自动通知；严禁要求子代理用 send_message 汇报。' +
    '运行中可用 send_message 纠偏，结束后可追加任务。' +
    '多个独立任务在同一轮并发发起；同构批量请用 orchestrate。'
  const descriptionOf = () => (enabled() ? rule() + body : body)

  // A provisional id lets the lease be registered before the host names the child: the
  // conflict has to be refused before `startActivation` (AC1). `rebind` moves the same
  // lease to the real child id once the host has created it.
  let pending = 0
  const nextPendingChildId = (parent) => {
    pending += 1
    return `pending:${String(parent?.id ?? 'parent')}:${String(pending)}`
  }

  /** Normalize and claim the declared scope. A missing declaration is refused here. */
  const acquireLease = (args, exec, parent) =>
    claimWriteScope({
      args,
      exec,
      parent,
      leases,
      childId: nextPendingChildId(parent),
      tool: 'delegate',
    })

  const tool = defineTool({
    name: DELEGATE_TOOL,
    description: descriptionOf(),
    parameters: {
      cwd: {
        type: 'string',
        description: '初始工作目录（相对路径基于当前目录）；省略则继承。',
      },
      writeScope: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        // Required, with no default and no minItems: omitting the field is refused with
        // `write-scope-missing`, while an empty array is refused as `write-scope-invalid`.
        description:
          '必填：允许写入的文件/目录清单（至少一项）。' +
          '派发前与在租作用域求交，冲突报 write-scope-conflict。' +
          '相对路径基于 cwd；目录用 "/" 或 "/**"；不推荐 "*"。仅声明，不扩大权限也不阻止越界写入。',
      },
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
      if (!enabled()) throw new Error(disabledToolMessage(DELEGATE_TOOL))
      const parent = exec.agent
      if (!parent) throw new Error('delegate requires a calling agent (exec.agent was undefined)')
      // Requiredness is declared in the schema, but direct tool use still needs the
      // contract checked: no route is read and no worker starts without a declaration.
      requireWriteScope(args, DELEGATE_TOOL)
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
          writeScope: { leaseId: held.leaseId, scope: [...scope] },
        }
      } finally {
        // A dispatch that never handed the child off must not leak its reservation. A live
        // child's lease is released by the lifecycle hooks instead, not here.
        if (!handedOff && typeof leases.release === 'function') {
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
    get: descriptionOf,
  })
  return tool
}
