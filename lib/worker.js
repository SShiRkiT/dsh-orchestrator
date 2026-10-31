/**
 * Shared worker plumbing for `delegate` and `orchestrate`. Dependency-free: the
 * host's `defineTool` is passed in by the caller, so the request shaping can be
 * tested without the DSH runtime.
 *
 * Both tools must read the route from the same config fields and build the same
 * `startActivation` spec; keeping that here is what prevents route drift.
 */

/** The worker route from config, in the `AgentOptions` shape `startActivation` takes. */
export function readRoute(config) {
  const provider = String(config.workerProvider.get() ?? '').trim()
  const model = String(config.workerModel.get() ?? '').trim()
  if (provider === '' || model === '') {
    throw new Error('orchestrator: the worker route is not configured (set workerProvider and workerModel)')
  }
  const effort = String(config.workerReasoningEffort.get() ?? '').trim()
  // Changing the route without naming an effort lets the model resolve its own default,
  // so an empty effort is simply left out rather than sent as an empty string.
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/** One optional string parameter, trimmed; a wrong type fails loudly. */
function stringArg(args, key, tool) {
  const value = args?.[key]
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`${tool}: "${key}" must be a string when provided`)
  return value.trim()
}

/**
 * A per-call route override, named like the native `subagent` tool's parameters.
 *
 * It exists for one case only: the user explicitly names a model for a specific
 * delegation. Provider and model belong together, so a half-specified override is
 * refused instead of silently falling back to the configured route. An omitted
 * effort leaves the route's own effort out, so the selected model resolves its
 * own default.
 */
export function readRouteOverride(args, tool) {
  const provider = stringArg(args, 'provider', tool)
  const model = stringArg(args, 'model', tool)
  const effort = stringArg(args, 'reasoning_effort', tool)
  if (provider === '' && model === '' && effort === '') return undefined
  if (provider === '' || model === '') {
    throw new Error(`${tool}: "provider" and "model" must be given together to override the worker route`)
  }
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * Workers answer in the language the request was written in. The worker never sees
 * the parent conversation, so the instruction has to travel with the prompt.
 */
export function languageNote(prompt) {
  let language = 'the same language as this request'
  if (/[\u4e00-\u9fff]/.test(prompt)) language = 'Simplified Chinese'
  else if (/[\u0400-\u04ff]/.test(prompt)) language = 'Russian'
  else if (/[\u3040-\u30ff]/.test(prompt)) language = 'Japanese'
  else if (/[\uac00-\ud7af]/.test(prompt)) language = 'Korean'
  return 'Reply in ' + language + '.\n\n'
}

/**
 * The spec handed to `ctx.subagents.startActivation`.
 *
 * `agentOptions` is the route read from config, or the explicit per-call override
 * when the user named one; either way exactly one route reaches the host.
 * `delivery` differs per tool: `delegate` answers the parent, `orchestrate`
 * answers the caller that is waiting for `run.result`.
 */
export function buildSpawnActivation({
  cwd,
  prompt,
  label,
  parent,
  route,
  maxDepth,
  signal,
  outputSchema,
  delivery,
}) {
  const request = {
    ...(cwd === undefined ? {} : { cwd }),
    prompt: [{ type: 'text', text: prompt }],
    parent,
    agentOptions: route,
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  }
  return { provider: 'spawn', label, request, signal, delivery }
}
