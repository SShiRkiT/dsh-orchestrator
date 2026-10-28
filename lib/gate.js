/**
 * The main-agent gate. Dependency-free, so the whole gate can be tested without
 * the DSH runtime.
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
 */

/** The one tool the main agent keeps: delegating on the configured worker route. */
export const DELEGATE_TOOL = 'delegate'

/**
 * Restrict one tool at a time. `tools.restrict` throws for a name the agent does
 * not inherit, so a single unknown name must not discard the others.
 */
export function restrictEach(agent, names) {
  const applied = []
  const skipped = []
  for (const tool of names) {
    try {
      agent.ctx.tools.restrict({ deny: [tool] })
      applied.push(tool)
    } catch (error) {
      skipped.push(`${tool} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return { applied, skipped }
}

/** What the guard may deny: everything it was given except `delegate`. */
function guardedNames(names) {
  return [...names].filter((name) => name !== DELEGATE_TOOL)
}

/**
 * Build the guard predicate. It must never deny `delegate`, even if the config lists
 * it: that tool is the only way the main agent is meant to get work done.
 */
export function denyGuard(names) {
  const denied = new Set(guardedNames(names))
  return (exec) => {
    const tool = exec?.name
    if (typeof tool !== 'string' || !denied.has(tool)) return undefined
    return `orchestrator: "${tool}" is not available to the main agent. The main agent only plans; hand every action to a worker with the delegate tool.`
  }
}

/**
 * Hide what `restrict` can hide, then refuse every denied name at execution time.
 * A guard failure is reported, not thrown: the hidden tools stay hidden either way and
 * a broken gate must not break agent creation.
 */
export function installGate({ agent, names }) {
  // Snapshot at call time, so a later config change applies to agents created afterwards only.
  const snapshot = [...names]
  const { applied, skipped } = restrictEach(agent, snapshot)
  let guardError
  try {
    agent.ctx.tools.guard(denyGuard(snapshot))
  } catch (error) {
    guardError = error instanceof Error ? error.message : String(error)
  }
  return { applied, skipped, guarded: guardedNames(snapshot), guardError }
}
