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
 * editing the profile file. `enabled` and `deniedTools` are read when an agent is
 * created, so they apply to agents created afterwards. The worker route is read on
 * every delegation, so it applies from the next `delegate` call.
 */
export const Config = z.object({
  /** Hide the creation tools from top-level agents. Delegated children keep them. */
  enabled: z.boolean().default(true).volatile(),
  /**
   * Tools hidden from the main agent. `tools.restrict` hides the global ones; a guard
   * additionally refuses every name listed here at execution time, which is what stops
   * scope-local tools such as the native `subagent` (registered in the agent's own scope,
   * so restrict throws for it). `subagent_fork` and `workflow` children inherit the parent's
   * model and `subagent` ignores the worker route, so any of them would bypass the one route
   * every worker is meant to share. `ops_bash` and `pwsh` are denied because a shell can
   * write files, and `ralph` starts fresh agents that would not carry this gate.
   */
  deniedTools: z
    .array(z.string())
    .default([
      'edit',
      'write',
      'str_replace_editor',
      'subagent',
      'subagent_fork',
      'workflow',
      'ralph',
      'ops_bash',
      'pwsh',
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
    if (!config.enabled.get()) return
    if (isDelegatedChild(agent)) return

    const { applied, skipped, guarded, guardError } = installGate({ agent, names: config.deniedTools.get() })
    ctx.logger.info(
      `orchestrator: main agent ${agent.id}: hid [${applied.join(', ')}]; guarded [${guarded.join(', ')}]` +
        (skipped.length > 0 ? `; skipped [${skipped.join('; ')}]` : ''),
    )
    if (guardError !== undefined) {
      ctx.logger.warn(`orchestrator: main agent ${agent.id}: guard not installed: ${guardError}`)
    }
  })
}
