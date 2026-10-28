/**
 * Delegation tool. Dependency-free: `defineTool` is passed in, so the request
 * building can be tested without the DSH runtime.
 *
 * Why this exists (see docs/adr/0001): the native `subagent` tool's `agentOptions`
 * are plain config with no volatile field, so a settings write cannot change the
 * default worker route. This tool reads the route from the plugin's own volatile
 * config on every call, so a change applies from the next delegation.
 */

export const DELEGATE_TOOL = 'delegate'

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
 * Workers answer in the language the request was written in. The worker never sees the
 * parent conversation, so the instruction has to travel with the prompt.
 */
export function languageNote(prompt) {
  let language = 'the same language as this request'
  if (/[\u4e00-\u9fff]/.test(prompt)) language = 'Simplified Chinese'
  else if (/[\u0400-\u04ff]/.test(prompt)) language = 'Russian'
  else if (/[\u3040-\u30ff]/.test(prompt)) language = 'Japanese'
  else if (/[\uac00-\ud7af]/.test(prompt)) language = 'Korean'
  return 'Reply in ' + language + '.\n\n'
}

/** The spec handed to `ctx.subagents.startActivation`. */
export function buildActivation({ args, parent, route, maxDepth, signal }) {
  const request = {
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    prompt: [{ type: 'text', text: languageNote(args.prompt) + args.prompt }],
    parent,
    agentOptions: route,
    ...(maxDepth === undefined ? {} : { maxDepth }),
  }
  return { provider: 'spawn', label: args.description, request, signal, delivery: 'parent' }
}

export function createDelegateTool({ defineTool, subagents, config }) {
  return defineTool({
    name: DELEGATE_TOOL,
    description:
      'Hand one self-contained task to a worker agent. The worker does not see this conversation, ' +
      'so the prompt must carry the goal, the allowed files, the acceptance command and the ' +
      'fallback. It runs on the worker route chosen by the user; do not pick a model. ' +
      'This returns its id immediately and the runtime notifies you when it finishes. ' +
      'Start independent tasks together in one message so they run in parallel; never start two ' +
      'workers on the same file. Use send_message to steer a worker that is still running.',
    parameters: {
      cwd: {
        type: 'string',
        description: 'Initial worker working directory. Relative paths use your current directory; omitted inherits it.',
      },
      description: {
        type: 'string',
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        description: 'The complete task for the worker. It does not see this conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    // Workers are independent by contract, so several may be started in one message.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('delegate requires a calling agent (exec.agent was undefined)')
      // The host's schema dialect has no required keyword, so the contract is checked here.
      if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') throw new Error('delegate requires a non-empty prompt')
      if (typeof args?.description !== 'string' || args.description.trim() === '') throw new Error('delegate requires a non-empty description')
      // Read at call time, so a changed route applies from this delegation on.
      const route = readRoute(config)
      exec.signal.throwIfAborted()
      const spec = buildActivation({
        args,
        parent,
        route,
        maxDepth: subagents.resolveMaxDepth(undefined),
        signal: exec.signal,
      })
      const started = await subagents.startActivation(spec)
      return { kind: 'activation', subagentId: started.childId }
    },
  })
}
