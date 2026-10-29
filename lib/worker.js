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
 * `agentOptions` is always the single route read from config; callers cannot
 * override provider or model. `delivery` differs per tool: `delegate` answers the
 * parent, `orchestrate` answers the caller that is waiting for `run.result`.
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
