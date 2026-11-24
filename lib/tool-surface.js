/**
 * The model-facing tool surface. Everything a request carries about tools — the `tools`
 * declaration array, the executor's own sections and a plugin's prompt blocks such as
 * `# Bash command execution: ops_bash` — is built from one host call:
 * `tools.definitions(scope, toolSet)`. Wrapping that call is therefore the only place a
 * mask can be both complete and quiet.
 *
 * Complete, because `tools.restrict` only hides INHERITED (global) tools. A tool a plugin
 * registers in the agent's own scope — every `ops_*` tool, the native `subagent` — stays
 * visible unconditionally, and `restrict` throws `unknown global tool` for it.
 *
 * Quiet, because every `restrict`/dispose pair announces `tools/change`, and listeners
 * react by churning the table: `dsh-ops` clears the official `read`/`glob`/`grep` shadows
 * on that event and re-installs them from an async retry queue (25/100/400/1000 ms). A
 * request assembled inside that window saw the official tools, the next one saw them gone:
 * the table gained 3 and lost 3, the cached prompt prefix was rewritten twice, and the
 * conversation cache was lost with it.
 *
 * The wrapper reads the live whitelist (main agent) or a fixed deny list (delegated child)
 * at request time, so a panel write or a switch flip applies from the very next request
 * without a single event. It also shadows the official `read`/`glob`/`grep` as soon as
 * their `dsh-ops` replacement is registered — the state the async hide queue is heading to
 * — so the transient leak never reaches a request.
 */

import { DELEGATE_STATUS_TOOL_NAME, DELEGATE_TOOL, ORCHESTRATE_TOOL } from './api.js'
import { viewNames } from './catalog.js'
import { isDelegatedChild, resolveEffectiveAllowedTools } from './gate.js'
import { TEAM_SHARED_GOAL_RULE } from './rules.js'
import { RUN_CODE_TOOL } from './run-code-guard.js'

export { DEFAULT_BLOCKED_NATIVE_TOOLS, NATIVE_TEAM_TOOLS, resolveEffectiveAllowedTools } from './gate.js'

/**
 * The shipped main-agent whitelist while dispatch mode is on. The Web client mirrors
 * this order. Delegation remains event-driven: use the completion notice, not `wait_agent`.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  // Delegation, audit and worker control
  'delegate',
  'orchestrate',
  'delegate_status',
  'worktree_manage',
  'send_message',
  'interrupt_agent',
  // Planning, user clarification & context compression
  'todo_write',
  'ask_user_question',
  'compress',
]

/**
 * The official tool a `dsh-ops` replacement stands in for, used only when both are
 * registered. `bash`/`pwsh` are deliberately absent: whether `pwsh` is hidden is a user
 * setting (`hidePwsh`), not a rule, and the observed churn is limited to these three.
 */
export const OFFICIAL_SHADOW = Object.freeze([
  ['read', 'ops_inspect_local_file'],
  ['glob', 'ops_glob'],
  ['grep', 'ops_grep'],
])

/** One wrapper per tool service, so a second install is a no-op with the same disposer. */
const SURFACE = Symbol.for('dsh-orchestrator.toolSurface')
// Cordis exports this as symbols.original. Use its global key without adding a dependency.
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const ROOT_ONLY_TOOLS = new Set([DELEGATE_STATUS_TOOL_NAME, 'worktree_manage'])

/** A name a definition carries, or `''` for a shape this wrapper does not understand. */
function nameOf(definition) {
  const name = definition?.name
  return typeof name === 'string' ? name : ''
}

/**
 * Install the filtering wrapper on `tools.definitions`.
 *
 * `allowed` is the live Allowed Tools whitelist (a plain array is accepted too), `enabled`
 * is the dispatch switch and `workerDeny` the names a delegated child must not see.
 * `delegate_status` and `worktree_manage` are root-only in either mode, including with a
 * custom deny list.
 * `allowAgentTeam` gates Team tools for the main agent, and `isNativeTeamEnabled(scope)`
 * reads the host's root mode for guidance only. The call returns a disposer that restores
 * the original `definitions`; a second install on the same
 * service hands back the first disposer instead of stacking wrappers.
 */
export function installToolSurface({
  tools,
  allowed,
  describeDelegate,
  allowAgentTeam = true,
  isNativeTeamEnabled = () => false,
  enabled = () => true,
  workerDeny = [DELEGATE_TOOL, ORCHESTRATE_TOOL],
  disabledDeny = [DELEGATE_TOOL, ORCHESTRATE_TOOL],
  shadow = OFFICIAL_SHADOW,
} = {}) {
  // Cordis returns a new method proxy on every ordinary get. Patch the actual service so
  // neither the saved method nor the ownership check depends on the caller's context proxy.
  const target = tools?.[CORDIS_ORIGINAL] ?? tools
  if (target === undefined || target === null) return () => {}
  const installed = target[SURFACE]
  if (installed !== undefined) return installed.dispose

  const originalDescriptor = Object.getOwnPropertyDescriptor(target, 'definitions')
  const original = target.definitions
  if (typeof original !== 'function') return () => {}
  const liveAllowed = typeof allowed === 'function' ? allowed : () => allowed
  const liveAllowAgentTeam = typeof allowAgentTeam === 'function' ? allowAgentTeam : () => allowAgentTeam
  const deny = new Set([...ROOT_ONLY_TOOLS, ...(workerDeny ?? [])])
  const offDeny = new Set(disabledDeny ?? [])
  const pairs = (shadow ?? []).filter((entry) => Array.isArray(entry) && entry.length === 2)

  /**
   * The names this request already carries, plus whatever the scope's registry view knows.
   * The list matters as much as the view: a replacement registered for this very request is
   * in the list even when the view is unreadable.
   */
  const presentNames = (service, scope, list) => {
    const present = new Set()
    for (const definition of list) {
      const name = nameOf(definition)
      if (name !== '') present.add(name)
    }
    try {
      const view = typeof service?.view === 'function' ? service.view(scope) : undefined
      for (const name of viewNames(view)) present.add(name)
    } catch {
      // An unreadable view leaves the list's own names; the filter still applies.
    }
    return present
  }

  /** Official names whose replacement is registered: hide them whatever the queue says. */
  const shadowedOf = (present) => {
    const hidden = new Set()
    for (const [official, replacement] of pairs) {
      if (present.has(replacement)) hidden.add(official)
    }
    return hidden
  }

  const mainSurface = (list, present, scope) => {
    // The plugin entry supplies the shipped defaults via `allowed`; omitted values share the gate's empty base.
    const allowedForScope = resolveEffectiveAllowedTools(liveAllowed(scope), { allowAgentTeam: liveAllowAgentTeam() })
    const allow = new Set(allowedForScope)
    const shadowed = shadowedOf(present)
    const visible = list.filter((definition) => {
      const name = nameOf(definition)
      if (name === '') return true
      // `run_code` is the PTC transport: delegate/orchestrate are SDK functions inside it,
      // so dropping it would leave a PTC session with no way to delegate at all. A host in
      // native mode never lists it, and the argument guard still covers the escapes.
      if (name === RUN_CODE_TOOL) return true
      return allow.has(name) && !shadowed.has(name)
    })
    const visibleNames = new Set(visible.map(nameOf))
    // A registered tool is not necessarily admitted to this step. Use the filtered list,
    // not the catalog. Emit the guidance once, even when both dispatch tools are present.
    const teamGuideTool = visibleNames.has('team_task_create') && isNativeTeamEnabled(scope)
      ? (visibleNames.has(DELEGATE_TOOL) ? DELEGATE_TOOL : ORCHESTRATE_TOOL)
      : undefined
    return visible.map((definition) => {
      const name = nameOf(definition)
      const describe = name === DELEGATE_TOOL && typeof describeDelegate === 'function'
      if (!describe && name !== teamGuideTool) return definition
      let description = describe ? describeDelegate(allowedForScope) : definition.description
      if (name === teamGuideTool) description = `${description} ${TEAM_SHARED_GOAL_RULE}`
      return Object.defineProperties(Object.create(Object.getPrototypeOf(definition)), {
        ...Object.getOwnPropertyDescriptors(definition),
        description: { value: description, enumerable: true, configurable: true },
      })
    })
  }

  const workerSurface = (list, present) => {
    const shadowed = shadowedOf(present)
    return list.filter((definition) => {
      const name = nameOf(definition)
      if (name === '') return true
      return !deny.has(name) && !shadowed.has(name)
    })
  }

  let disposed = false
  const definitions = function definitions(scope, toolSet) {
    if (disposed) return original.call(this, scope, toolSet)
    // Keep the host's calling context; a detached call falls back to the raw service.
    const service = this ?? target
    const list = original.call(service, scope, toolSet)
    if (!Array.isArray(list)) return list
    // The context-global view feeds the Allowed Tools panel: it must stay complete.
    if (scope === undefined || scope === null) return list
    const delegated = isDelegatedChild(scope)
    if (!enabled()) {
      if (!delegated && offDeny.size === 0) return list
      return list.filter((definition) => {
        const name = nameOf(definition)
        return name === '' || (!offDeny.has(name) && !(delegated && ROOT_ONLY_TOOLS.has(name)))
      })
    }
    const present = presentNames(service, scope, list)
    return delegated ? workerSurface(list, present) : mainSurface(list, present, scope)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      // A third party may still call this wrapper. Leave its outer method intact.
      if (Object.getOwnPropertyDescriptor(target, 'definitions')?.value === definitions) {
        if (originalDescriptor === undefined) delete target.definitions
        else Object.defineProperty(target, 'definitions', originalDescriptor)
      }
    } finally {
      if (target[SURFACE]?.dispose === dispose) delete target[SURFACE]
    }
  }
  Object.defineProperty(target, 'definitions', {
    value: definitions,
    configurable: originalDescriptor?.configurable ?? true,
    enumerable: originalDescriptor?.enumerable ?? true,
    writable: originalDescriptor?.writable ?? true,
  })
  target[SURFACE] = { dispose }
  return dispose
}
