import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { ORCHESTRATE_TOOL } from './api.js'
import { createDelegateTool } from './delegate.js'
import { installGate, isDelegatedChild, mergeDenied } from './gate.js'
import { createOrchestrateTool } from './orchestrate.js'
import { STAGES, initialState, reduceStage } from './stage.js'
import { SUPERVISE_SOURCE_KIND, createSupervisor } from './supervise.js'

export { SUPERVISE_SOURCE_KIND }

export const name = 'dsh-orchestrator'

/**
 * Services used here: the projection registry, the tool registry, the subagent
 * service, and the live agent/session registries the supervision adapters read.
 */
export const inject = ['sessionProjections', 'tools', 'subagents', 'agents', 'sessions']

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
export const DEFAULT_DENIED_TOOLS = [
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
  'decompress',
  'search_context',
]

export const Config = z.object({
  /** Hide the creation tools from top-level agents. Delegated children keep them. */
  enabled: z.boolean().default(true).volatile(),
  /**
   * Tools hidden from the main agent. The main agent plans; every action belongs to a
   * worker, so this list covers all built-in tools except the ones planning needs:
   * `delegate`, `orchestrate`, `send_message`, `todo_write`, `ask_user_question` and
   * `compress`, which is left out so the main agent can compress its own context.
   * `tools.restrict` hides the global ones; a guard additionally refuses every name
   * listed here at execution time, which is what stops scope-local tools such as the
   * native `subagent` (registered in the agent's own scope, so restrict throws for it).
   * `subagent_fork` and `workflow` children inherit the parent's model and `subagent`
   * ignores the worker route, so any of them would bypass the one route every worker is
   * meant to share. Shells (`ops_bash`, `pwsh`) are denied because a shell can do
   * anything, and `ralph` starts fresh agents that would not carry this gate.
   */
  deniedTools: z
    .array(z.string())
    .default(DEFAULT_DENIED_TOOLS)
    .volatile(),
  /** Route every `delegate` worker runs on. Empty means unconfigured, which fails loudly. */
  workerProvider: z.string().default('').volatile(),
  workerModel: z.string().default('').volatile(),
  /** Optional. Empty leaves the effort out so the worker model resolves its own default. */
  workerReasoningEffort: z.string().default('').volatile(),
  /**
   * Supervision of long-running `delegate` children. Every field is volatile and
   * read again on each scan, so a settings change applies without a restart.
   * `orchestrate` workers are deliberately not supervised: their parent waits
   * inside the tool call, so a notice would always be stale by the time it ran.
   */
  superviseEnabled: z.boolean().default(true).volatile(),
  /** How long a child may run before its parent is woken with one summary notice, in seconds. */
  superviseIntervalSeconds: z.number().min(10).max(86400).step(1).default(600).volatile(),
  /** Notices allowed per child; 0 means no cap. */
  superviseMaxNoticesPerChild: z.number().min(0).max(20).default(3).volatile(),
  /** Also notify when a child produced no new events; off saves a model turn. */
  superviseNotifyOnNoProgress: z.boolean().default(false).volatile(),
})

/** Read one config field whether it is a schemastery ref or a plain value. */
function configValue(config, key, fallback) {
  try {
    const field = config?.[key]
    const value = typeof field?.get === 'function' ? field.get() : field
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the host side of supervision: the four adapters `createSupervisor`
 * needs, bound to the live registries. Exported so tests can drive the
 * adapters with plain objects instead of a running host.
 *
 * `loadLlm` is injectable only so the lazy import can be exercised without the
 * host package: production always uses the dynamic `@deepseek-ai/dsh-llm`
 * import, which is never a top-level import (the plugin must load even when the
 * package is not resolvable in a unit test).
 */
export function createSupervision({ ctx, config, logger = ctx?.logger, loadLlm = () => import('@deepseek-ai/dsh-llm') }) {
  let pendingWarned = false
  let llmWarned = false
  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // A logger must never break the timer or a dispatch.
    }
  }

  /** `ctx.agents.get(id)` returning undefined is the host's "not live" answer. */
  const isParentAlive = (parentId) => ctx?.agents?.get?.(parentId) !== undefined
  const isChildAlive = (childId) => ctx?.agents?.get?.(childId) !== undefined

  /**
   * The child's own session log. `Session.log` is the append-only event array
   * (`seq`, `time`, `type`, `data`); the supervisor reads it directly, which
   * costs no model tokens.
   */
  const readEvents = (childId) => {
    const session = ctx?.sessions?.get?.(childId)
    if (session === undefined || session === null) throw new Error(`no live session for child ${childId}`)
    if (!Array.isArray(session.log)) throw new Error(`session ${childId} has no readable event log`)
    return session.log
  }

  /**
   * Whether the parent already has an undelivered supervision notice. The inbox
   * projection state is `{ 'next-turn': Message[], 'next-step': Message[] }`;
   * its shape is not a declared public API, so every failure here is swallowed:
   * returning false risks one duplicate notice, while throwing would make the
   * supervisor treat every parent as always pending.
   */
  const hasPendingNotice = (parentId) => {
    const parent = ctx?.agents?.get?.(parentId)
    if (parent === undefined || parent === null) return false
    try {
      const stateOf = ctx?.sessionProjections?.stateOf
      if (typeof stateOf !== 'function') throw new Error('sessionProjections.stateOf is unavailable')
      const state = stateOf.call(ctx.sessionProjections, parent.session, 'inbox')
      if (state === undefined || state === null) throw new Error('the inbox projection returned no state')
      for (const bucket of ['next-turn', 'next-step']) {
        const pending = state[bucket]
        if (!Array.isArray(pending)) continue
        for (const message of pending) {
          if (message?.source?.kind === SUPERVISE_SOURCE_KIND) return true
        }
      }
      return false
    } catch (error) {
      if (!pendingWarned) {
        pendingWarned = true
        warn(`orchestrator: supervision: cannot read the parent inbox; duplicate notices are possible: ${messageOf(error)}`)
      }
      return false
    }
  }

  /**
   * Queue one notice on the parent with `followup` — never `steer`, which would
   * splice into a user turn that is already running. A missing parent is final
   * (`parent-gone`); a missing `@deepseek-ai/dsh-llm` is not fatal: return
   * `unavailable` so the supervisor logs it and keeps the notice budget.
   */
  const deliver = async (parentId, text, childIds) => {
    const parent = ctx?.agents?.get?.(parentId)
    if (parent === undefined || parent === null) return 'parent-gone'
    // The dynamic import is not retried once it failed: the supervisor reschedules
    // without spending the child's budget, and one warning is enough.
    if (llmWarned) return 'unavailable'

    let llm
    try {
      llm = await loadLlm()
    } catch (error) {
      if (!llmWarned) {
        llmWarned = true
        warn(`orchestrator: supervision: cannot load @deepseek-ai/dsh-llm; notices are disabled: ${messageOf(error)}`)
      }
      return 'unavailable'
    }
    if (typeof llm?.createUserMessage !== 'function') {
      if (!llmWarned) {
        llmWarned = true
        warn('orchestrator: supervision: @deepseek-ai/dsh-llm does not export createUserMessage; notices are disabled')
      }
      return 'unavailable'
    }

    const source = { kind: SUPERVISE_SOURCE_KIND, form: 'notice' }
    if (Array.isArray(childIds) && typeof childIds[0] === 'string') source.senderSessionId = childIds[0]
    const message = llm.createUserMessage({ content: [{ type: 'text', text }], source })
    parent.followup(message)
    try {
      const flushed = await ctx?.sessions?.flush?.(parent.session)
      if (flushed === false) warn('orchestrator: supervision: the notice was queued but session flush did not acknowledge it')
    } catch (error) {
      warn(`orchestrator: supervision: the notice was queued but session flush failed: ${messageOf(error)}`)
    }
    return 'queued'
  }

  // Live getters: an interval change applies without rebuilding the supervisor.
  const liveConfig = {
    get enabled() {
      return configValue(config, 'superviseEnabled', true) !== false
    },
    get intervalSeconds() {
      return configValue(config, 'superviseIntervalSeconds', 600)
    },
    get maxNoticesPerChild() {
      return configValue(config, 'superviseMaxNoticesPerChild', 3)
    },
    get notifyOnNoProgress() {
      return configValue(config, 'superviseNotifyOnNoProgress', false) === true
    },
  }

  const supervisor = createSupervisor({
    config: liveConfig,
    now: () => Date.now(),
    isParentAlive,
    isChildAlive,
    readEvents,
    hasPendingNotice,
    deliver,
    logger,
  })

  return { supervisor, isParentAlive, isChildAlive, readEvents, hasPendingNotice, deliver }
}

/**
 * The `onStarted` callback for the delegate tool: register the child, and drop
 * it once its receipt settles (either way). Exported for the same reason as
 * `createSupervision` — a plain recording object is enough to test it.
 */
export function createSupervisionHooks(supervisor) {
  const forget = (childId) => {
    try {
      supervisor.forget(childId)
    } catch {
      // A registry failure here cannot affect the dispatch either.
    }
  }

  return {
    onStarted(parent, started, args) {
      const childId = started?.childId
      const parentId = parent?.id
      if (typeof childId !== 'string' || typeof parentId !== 'string') return
      try {
        supervisor.track({ childId, parentId, label: args?.description, startedAt: Date.now() })
      } catch {
        // Still subscribe to the receipt below: an untracked child is harmless.
      }
      const settled = started?.result
      if (settled !== null && typeof settled === 'object' && typeof settled.then === 'function') {
        try {
          settled.then(() => forget(childId), () => forget(childId))
        } catch {
          // A hostile thenable must not break the dispatch.
        }
      }
    },
  }
}

export function apply(ctx, config) {
  ctx.sessionProjections.register(stageProjection)

  const supervision = createSupervision({ ctx, config })
  const hooks = createSupervisionHooks(supervision.supervisor)

  // The rule text the delegation tools show names exactly the tools the gate refuses,
  // read from the same merged list, so the prompt cannot drift from the enforcement
  // even when a profile adds names of its own.
  const deniedTools = mergeDenied(DEFAULT_DENIED_TOOLS, configValue(config, 'deniedTools', []))

  // One registration for every agent; children get it too and are bounded by maxDepth.
  ctx.effect(
    () =>
      ctx.tools.register(
        createDelegateTool({
          defineTool,
          subagents: ctx.subagents,
          config,
          onStarted: hooks.onStarted,
          deniedTools,
        }),
      ),
    'orchestrator: delegate tool',
  )

  ctx.effect(
    () => ctx.tools.register(createOrchestrateTool({ defineTool, subagents: ctx.subagents, config, deniedTools })),
    `orchestrator: ${ORCHESTRATE_TOOL} tool`,
  )

  // The host may not mount cordis-plugin-timer, so use the platform timer through
  // the existing effect lifecycle. The period is fixed at 5 s because a tick only
  // compares clocks; a child's log is read only once it is due, so this keeps the
  // 10-second minimum interval prompt without a configurable scan. `unref` keeps a
  // short-lived CLI test process from hanging on an interval the host would own.
  const scanMs = 5000
  ctx.effect(
    () => {
      const timer = setInterval(() => {
        void Promise.resolve(supervision.supervisor.tick()).catch((error) => {
          ctx.logger?.warn?.(`orchestrator: supervision timer: ${messageOf(error)}`)
        })
      }, scanMs)
      if (typeof timer?.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    },
    'orchestrator: supervision timer',
  )

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    if (isDelegatedChild(agent)) return

    // Installed even while the switch is off: the guard follows the switch per call,
    // so turning dispatch mode on in an open conversation takes effect at once.
    const { applied, skipped, guarded, guardError } = installGate({
      agent,
      names: () => mergeDenied(DEFAULT_DENIED_TOOLS, config.deniedTools.get()),
      enabled: () => config.enabled.get(),
    })
    // A resumed agent with a parentSession that still read as a main agent means the
    // depth test degraded: the cold-resume regression looked exactly like this.
    if (payload?.source === 'resume' && agent.session?.header?.parentSession !== undefined) {
      ctx.logger.warn(
        `orchestrator: agent ${agent.id} resumed with a parentSession but no delegation depth; gated it as a main agent`,
      )
    }
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
