/**
 * The main-agent gate. Dependency-free, so the whole gate can be tested without
 * the DSH runtime.
 *
 * The gate follows the dispatch switch instead of the moment an agent was created:
 * the guard is installed for every top-level agent and reads `enabled()` on each
 * call, so turning the switch on in an already open conversation takes effect at
 * once. Hiding is a separate, reversible step.
 *
 * Two mechanisms, because one is not enough:
 * - `tools.restrict` hides a tool from the agent, but only for GLOBAL tools. It throws
 *   `tools.restrict() names unknown global tool "x"` for a tool registered in the agent's
 *   own scope, which is where DSH registers the native `subagent` tool. A throw leaves the
 *   tool visible and callable, so hiding alone cannot make the gate real.
 * - `tools.guard` takes a synchronous predicate over an attempted execution and applies to
 *   the agent's own scope too, so a scope-local tool such as `subagent`, and any shell tool
 *   that could write files, can be refused at call time. It also covers calls nested inside
 *   `run_code`.
 *
 * The native `workflow` is deliberately not in the delegation set: only `delegate` and
 * `orchestrate` are allowed through, and both use the configured worker route.
 */

import { DELEGATE_TOOL, ORCHESTRATE_TOOL } from './api.js'

export { DELEGATE_TOOL }

/**
 * Whether an agent is a delegated child. Mirrors the host's `delegationDepthOf`
 * (`Math.max(header.delegationDepth ?? 0, options.subagentDepth ?? 0)`): the
 * persisted session header is the authoritative, monotonic record, and it is the
 * only depth that survives a cold resume. A resumed child is rebuilt from options
 * holding just provider/model/effort, with no `subagentDepth`, so reading the live
 * options alone would misclassify it as the main agent; the runtime value may only
 * deepen the depth, never lower it. A dirty value (negative, fractional, NaN, a
 * string) is treated as absent instead of throwing, because a throw inside the
 * `agent/created` hook would break the host's announce path. A GUI fork is a new
 * root session — it has a `parentSession` but a depth of zero — so it is still
 * gated as a main agent, which is why the test is depth-based, not origin-based.
 */
export function isDelegatedChild(agent) {
  const runtime = agent?.options?.subagentDepth
  const persisted = agent?.session?.header?.delegationDepth
  const floor = Number.isSafeInteger(persisted) && persisted > 0 ? persisted : 0
  const live = Number.isSafeInteger(runtime) && runtime > 0 ? runtime : 0
  return Math.max(floor, live) > 0
}

/** Tools the main agent keeps: delegation on the configured worker route. */
export const DELEGATION_TOOLS = new Set([DELEGATE_TOOL, ORCHESTRATE_TOOL])

/**
 * Restrict one tool at a time. `tools.restrict` throws for a name the agent does
 * not inherit, so a single unknown name must not discard the others. Each
 * restriction hands back its disposer, so the gate can be lifted again.
 */
export function restrictEach(agent, names) {
  const applied = []
  const skipped = []
  const disposers = []
  for (const tool of names) {
    try {
      const dispose = agent.ctx.tools.restrict({ deny: [tool] })
      applied.push(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      skipped.push(`${tool} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return { applied, skipped, disposers }
}

/**
 * The effective deny list. A profile that spells out `deniedTools` replaces the
 * schema default instead of extending it, so the shipped list is always merged in:
 * a stale profile can add names but never silently shrink the gate back to a few
 * tools.
 */
export function mergeDenied(defaults, configured) {
  const merged = new Set()
  for (const name of defaults ?? []) merged.add(name)
  for (const name of configured ?? []) merged.add(name)
  return [...merged]
}

/** What the guard may deny: everything it was given except the delegation tools. */
function guardedNames(names) {
  return [...names].filter((name) => !DELEGATION_TOOLS.has(name))
}

/**
 * Build a guard predicate for a fixed list. Kept separate from `installGate`,
 * which reads its list per call.
 */
export function denyGuard(names) {
  const denied = new Set(guardedNames(names))
  return (exec) => {
    const tool = exec?.name
    if (typeof tool !== 'string' || !denied.has(tool)) return undefined
    return `orchestrator: "${tool}" is not available to the main agent. The main agent only plans; hand every action to a worker with the delegate or orchestrate tools.`
  }
}

/**
 * Install a switch-aware gate on one top-level agent.
 *
 * `names()` and `enabled()` are read live. While the switch is off the guard lets
 * everything through and lifts any earlier restriction; while it is on the guard
 * hides the list once and refuses a denied name at execution time, which is what
 * covers scope-local tools such as `subagent`. A guard failure is reported, not
 * thrown: a broken gate must not break agent creation.
 */
export function installGate({ agent, names, enabled }) {
  let hidden = false
  let disposers = []

  const hide = () => {
    const result = restrictEach(agent, [...names()])
    disposers = result.disposers
    hidden = true
    return result
  }

  const unhide = () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A restriction that is already gone needs no further cleanup.
      }
    }
    disposers = []
    hidden = false
  }

  const installed = enabled() ? hide() : { applied: [], skipped: [] }
  let guardError
  try {
    agent.ctx.tools.guard((exec) => {
      if (!enabled()) {
        if (hidden) unhide()
        return undefined
      }
      if (!hidden) hide()
      const tool = exec?.name
      if (typeof tool !== 'string' || DELEGATION_TOOLS.has(tool)) return undefined
      if (!names().includes(tool)) return undefined
      return `orchestrator: "${tool}" is not available to the main agent. The main agent only plans; hand every action to a worker with the delegate or orchestrate tools.`
    })
  } catch (error) {
    guardError = error instanceof Error ? error.message : String(error)
  }
  return {
    applied: installed.applied,
    skipped: installed.skipped,
    guarded: guardedNames(names()),
    guardError,
  }
}
