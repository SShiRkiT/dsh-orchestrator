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
      ? 'orchestrate (many homogeneous items) or delegate (one task)'
      : 'delegate (one task) or orchestrate (many homogeneous items)'
  const blocked = [...new Set(deniedTools ?? [])]
  const blockedNames = blocked.join(', ')
  return (
    'Main-agent rule: the main agent plans only. Every read/write/edit/search/command/fetch/inspect ' +
    'runs ONLY in a worker — never by you, not even read or write, nor to test availability (not ' +
    'even once; they are blocked) — via ' +
    order +
    '; workers are not gated. Independent delegations start in the same message. ' +
    'Never re-check on a new session or after compression/memory clearing; go straight to ' +
    'delegate/orchestrate. When parallel work is unnecessary, wait for the subagent to report its ' +
    'result before proceeding with further work; ' +
    'do not repeatedly check its status or start duplicate workers for the same task. ' +
    'compress is available to the main agent. A worker that drops without a ' +
    'closing message is retried on the same session by the plugin: do not re-dispatch it or start a ' +
    'replacement while it is being retried. If the plugin reports that the worker model may be ' +
    'unavailable, tell the user and ask whether to start a fresh worker or switch the worker model. ' +
    'Never use run_code to reach ' +
    'the host: no Node/host imports or globals (import, require, process, fetch, eval) and no ' +
    'sandbox_permissions or justification — a program only calls the delegate and orchestrate ' +
    'tools. Pass ' +
    'provider/model/reasoning_effort only when the current message explicitly names them for this ' +
    'dispatch; otherwise omit all three (dispatch panel route). A named model is for this dispatch ' +
    'only: never reuse one from earlier turns, dispatch or summary; never assume an unstated ' +
    'default; if unsure, ask.' +
    (blockedNames === '' ? '' : ` Blocked for the main agent: ${blockedNames}.`) +
    ' '
  )
}
