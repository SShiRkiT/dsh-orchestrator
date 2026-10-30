/**
 * The main-agent rule, rendered into the opening of both delegation tool
 * descriptions. It lives apart from `gate.js` so the prompt and the enforcement
 * read from the same deny list and cannot drift: the blocked tools named in the
 * text are the ones the gate actually refuses, never a hand-typed copy.
 *
 * A description is the first thing a main agent reads about delegation, and the
 * same description is registered for delegating children too, so the rule says
 * outright that a delegated worker is not gated. Without that, a worker could
 * read the rule as a ban on its own tools.
 */

import { DELEGATE_TOOL, ORCHESTRATE_TOOL } from './api.js'

/**
 * Build the rule text. `preferred` names the tool whose description this will open,
 * so each description recommends itself first and the other one second.
 */
export function mainAgentRule(deniedTools, preferred = DELEGATE_TOOL) {
  const order =
    preferred === ORCHESTRATE_TOOL
      ? 'orchestrate for many homogeneous items, or delegate for one task'
      : 'delegate for one task, or orchestrate for many homogeneous items'
  const blocked = [...new Set(deniedTools ?? [])].join(', ')
  return (
    'Main-agent rule: the main agent plans only and never runs a tool itself (a delegated worker ' +
    'is not gated and keeps its own tools). Before acting, decide whether the task needs any tool ' +
    'action — a file read or write, a shell command, a search, a fetch, an image read, a session ' +
    'history read, a schedule change, or anything else. If it does, hand it to a worker at once: ' +
    order +
    ', and independent delegations start together in the same message. Never probe a blocked ' +
    'tool just to see whether it is allowed — it is not, and that rejected call only costs a ' +
    'step; the rejection is the fallback, not the first move.' +
    (blocked === '' ? '' : ` Blocked for the main agent: ${blocked}.`) +
    ' '
  )
}
