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
 */

import { DELEGATE_TOOL, DELIVERY } from './api.js'
import { buildSpawnActivation, languageNote, readRoute } from './worker.js'

export { DELEGATE_TOOL, languageNote, readRoute }

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

export function createDelegateTool({ defineTool, subagents, config, onStarted }) {
  return defineTool({
    name: DELEGATE_TOOL,
    description:
      'Hand one self-contained task to a worker agent. The worker does not see this conversation, ' +
      'so the prompt must carry the goal, the allowed files, the acceptance command and the ' +
      'fallback. It runs on the worker route chosen by the user; do not pick a model. ' +
      'This returns its id immediately and the runtime notifies you when it finishes. ' +
      'When several subtasks are independent, start all of their workers in the same turn — ' +
      'delegate is safe to call concurrently — so they work in parallel instead of one at a ' +
      'time; a very simple task is the one case for a single worker, while many homogeneous ' +
      'items belong to orchestrate. Weigh that yourself: it is guidance, not a hard rule. Never ' +
      'start two workers on the same file. Use send_message to correct a worker that is still ' +
      'running, or to give a finished worker a follow-up task: it keeps its own context and ' +
      'remains a full worker. Whether the next step reuses that worker or starts a new one is ' +
      'your call, based on how closely the new task relates to what the worker already did. ' +
      'A worker that runs for a long time is inspected by the plugin every few minutes. A ' +
      '「【插件巡检…】」 message comes from the plugin, not the user: use send_message to steer a ' +
      'worker that is off track, or reply with one line and end the turn when no action is needed.',
    parameters: {
      cwd: {
        type: 'string',
        description: 'Initial worker working directory. Relative paths use your current directory; omitted inherits it.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
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
      // Requiredness is declared in the schema, but direct tool use still needs the contract checked.
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
      // Supervision is best-effort: a missing or broken callback must neither fail the
      // dispatch nor change what the main agent receives back.
      try {
        const notified = typeof onStarted === 'function' ? onStarted(parent, started, args) : undefined
        // The callback is synchronous, but tolerate an async one without awaiting it.
        if (notified !== undefined && typeof notified.catch === 'function') notified.catch(() => {})
      } catch {
        // Deliberately swallowed: a supervision bug cannot be allowed to affect dispatch.
      }
      return { kind: 'activation', subagentId: started.childId }
    },
  })
}
