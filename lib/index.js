import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { createDelegateTool } from './delegate.js'
import { installGate } from './gate.js'
import { STAGES, initialState, reduceStage } from './stage.js'

export const name = 'dsh-orchestrator'

/** Services used here: the projection registry, the tool registry and the subagent service. */
export const inject = ['sessionProjections', 'tools', 'subagents']

/**
 * Stage projection. The registry calls `.parse` on these schemas, so they must be
 * zod schemas (schemastery objects have no `.parse`), as the native plan projection does.
 */
const stageProjection = {
  key: 'orchestrator',
  stateVersion: 1,
  stateSchema: zod.object({ stage: zod.enum(STAGES), plan: zod.boolean() }).strict(),
  init: (_header, inheritedEventCount) => initialState(inheritedEventCount),
  apply: reduceStage,
  wire: {
    viewSchema: zod.object({ stage: zod.enum(STAGES), plan: zod.boolean() }),
    view: (state) => ({ stage: state.stage, plan: state.plan }),
  },
}

/**
 * Every field is volatile so a switch or settings card can rewrite it without
 * editing the profile file. `enabled` and `deniedTools` are read live by the guard,
 * so the switch reaches conversations that are already open. The worker route is
 * read on every delegation, so it applies from the next `delegate` call.
 */
export const Config = z.object({
  /** Hide the creation tools from top-level agents. Delegated children keep them. */
  enabled: z.boolean().default(true).volatile(),
  /**
   * Tools hidden from the main agent. The main agent plans; every action belongs to a
   * worker, so this list covers all built-in tools except the ones planning needs:
   * `delegate`, `send_message`, `todo_write` and `ask_user_question`. `tools.restrict`
   * hides the global ones; a guard additionally refuses every name listed here at
   * execution time, which is what stops scope-local tools such as the native `subagent`
   * (registered in the agent's own scope, so restrict throws for it). `subagent_fork` and
   * `workflow` children inherit the parent's model and `subagent` ignores the worker route,
   * so any of them would bypass the one route every worker is meant to share. Shells
   * (`ops_bash`, `pwsh`) are denied because a shell can do anything, and `ralph` starts
   * fresh agents that would not carry this gate.
   */
  deniedTools: z
    .array(z.string())
    .default([
      'edit',
      'write',
      'str_replace_editor',
      'apply_patch',
      'read',
      'grep',
      'glob',
      'list',
      'ops_read_files',
      'ops_discover_tools',
      'ops_bash',
      'pwsh',
      'bash',
      'shell',
      'web_search',
      'web_fetch',
      'read_image',
      'acp_read_original_image',
      'acp_status',
      'acp_cache',
      'present',
      'sidebar_open',
      'job_output',
      'job_kill',
      'job_list',
      'schedule_create',
      'schedule_update',
      'schedule_delete',
      'schedule_list',
      'session_search',
      'session_trace',
      'session_event_search',
      'session_event_read',
      'session_event_trace',
      'subagent',
      'subagent_fork',
      'workflow',
      'ralph',
      'create_worktree',
      'working_directory',
      'interrupt_agent',
      'list_agents',
      'create_goal',
      'update_goal',
      'get_goal',
      'skill',
      'compress',
      'decompress',
      'search_context',
    ])
    .volatile(),
  /** Route every `delegate` worker runs on. Empty means unconfigured, which fails loudly. */
  workerProvider: z.string().default('').volatile(),
  workerModel: z.string().default('').volatile(),
  /** Optional. Empty leaves the effort out so the worker model resolves its own default. */
  workerReasoningEffort: z.string().default('').volatile(),
})

/** A delegated child carries a delegation depth above zero; the main agent has none. */
function isDelegatedChild(agent) {
  const depth = agent.options?.subagentDepth
  return typeof depth === 'number' && depth > 0
}

export function apply(ctx, config) {
  ctx.sessionProjections.register(stageProjection)

  // One registration for every agent; children get it too and are bounded by maxDepth.
  ctx.effect(
    () => ctx.tools.register(createDelegateTool({ defineTool, subagents: ctx.subagents, config })),
    'orchestrator: delegate tool',
  )

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    if (isDelegatedChild(agent)) return

    // Installed even while the switch is off: the guard follows the switch per call,
    // so turning dispatch mode on in an open conversation takes effect at once.
    const { applied, skipped, guarded, guardError } = installGate({
      agent,
      names: () => config.deniedTools.get(),
      enabled: () => config.enabled.get(),
    })
    if (!config.enabled.get()) return
    ctx.logger.info(
      `orchestrator: main agent ${agent.id}: hid [${applied.join(', ')}]; guarded [${guarded.join(', ')}]` +
        (skipped.length > 0 ? `; skipped [${skipped.join('; ')}]` : ''),
    )
    if (guardError !== undefined) {
      ctx.logger.warn(`orchestrator: main agent ${agent.id}: guard not installed: ${guardError}`)
    }
  })
}
