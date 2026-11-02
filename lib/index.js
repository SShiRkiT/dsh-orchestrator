import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { ORCHESTRATE_TOOL } from './api.js'
import { createCatalogPublisher } from './catalog.js'
import { createDelegateTool } from './delegate.js'
import { effectiveDenied, installGate, isDelegatedChild } from './gate.js'
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
 * editing the profile file. `enabled`, `deniedTools` and `allowedTools` are read live
 * by the guard, so the switch reaches conversations that are already open. The worker
 * route is read on every delegation, so it applies from the next `delegate` call.
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
  'subagent',
  'subagent_fork',
  'workflow',
  'ralph',
  'create_worktree',
  'working_directory',
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
   * worker, so this list covers every built-in tool except the handful planning needs by
   * default: `delegate`, `orchestrate`, `send_message`, `todo_write`, `ask_user_question`
   * and `compress`, which is left out so the main agent can compress its own context.
   * That is only the default: the panel may deny any tool the host offers.
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
  /**
   * Names removed from the deny list above, i.e. tools the user re-allows for the main
   * agent. Without it a built-in name could never be re-allowed: `deniedTools` replaces
   * the schema default instead of extending it, so it can only add. The effective list
   * is (DEFAULT_DENIED_TOOLS + deniedTools) - allowedTools, with no exception: any name
   * the panel offers can be denied, the delegation tools included. Both keys are read on
   * every guarded call, so the panel applies to open conversations.
   */
  allowedTools: z
    .array(z.string())
    .default([])
    .volatile(),
  /**
   * Read-only mirror of the tools the running host offers, published by the plugin for
   * the Denied Tools panel: a web client cannot enumerate tools itself, so the catalog
   * is handed to it through the config form it already reads (lib/catalog.js). Never
   * written by the panel and never persisted — a settings edit stores only the paths it
   * names — and empty until the first publish, which keeps the panel's built-in fallback
   * on a host that cannot be enumerated.
   */
  toolCatalog: z.array(z.string()).default([]).volatile(),
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

  /**
   * The highest `seq` in the child's log right now. A cold-resumed worker re-enters the
   * registry with this as its baseline, so its pre-interrupt history is not summarised
   * again as new activity. An unreadable log is simply "no baseline".
   */
  const headSeq = (childId) => {
    let head = 0
    try {
      for (const event of readEvents(childId)) {
        const seq = event?.seq
        if (typeof seq === 'number' && Number.isFinite(seq) && seq > head) head = seq
      }
    } catch {
      return 0
    }
    return head
  }

  return { supervisor, isParentAlive, isChildAlive, readEvents, headSeq, hasPendingNotice, deliver }
}

/**
 * The `onStarted` callback for the delegate tool: register the child, and drop
 * it once its receipt settles (either way). `onResumed` re-arms that same child when a
 * `send_message` cold resume recreates it. Exported for the same reason as
 * `createSupervision` — a plain recording object is enough to test it.
 */
export function createSupervisionHooks(supervisor, { headSeq } = {}) {
  const forget = (childId) => {
    try {
      supervisor.forget(childId)
    } catch {
      // A registry failure here cannot affect the dispatch either.
    }
  }

  /**
   * The children this plugin dispatched itself, oldest first. Only these may be re-armed
   * by a cold resume: the host's own `subagent` tool also creates delegated children, and
   * they never entered supervision, so resuming one must not start a timer on it. The map
   * is bounded because a long-lived host never reports a worker gone for good.
   */
  const dispatched = new Map()
  const MAX_DISPATCHED = 128
  const remember = (childId, record) => {
    dispatched.delete(childId)
    dispatched.set(childId, record)
    while (dispatched.size > MAX_DISPATCHED) {
      const oldest = dispatched.keys().next().value
      dispatched.delete(oldest)
    }
  }

  const baselineOf = (childId) => {
    try {
      const value = typeof headSeq === 'function' ? headSeq(childId) : undefined
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    } catch {
      return 0
    }
  }

  return {
    onStarted(parent, started, args) {
      const childId = started?.childId
      const parentId = parent?.id
      if (typeof childId !== 'string' || typeof parentId !== 'string') return
      remember(childId, { parentId, label: args?.description })
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

    /**
     * A cold resume is a fresh activation of a worker the receipt once released, so the
     * registry has no entry for it any more. Re-arm it from the dispatch record (the host
     * gives no `result` here, so cleanup falls back to the liveness, budget and parent
     * rules inside the supervisor). A child this plugin never dispatched, or one already
     * tracked, is left alone — a repeated event must not restart the clock or the budget.
     */
    onResumed(agent) {
      const childId = agent?.id
      if (typeof childId !== 'string' || childId === '') return
      const record = dispatched.get(childId)
      if (record === undefined) return
      try {
        if (typeof supervisor.has === 'function' && supervisor.has(childId)) return
      } catch {
        // An unreadable registry means "no entry"; re-tracking is idempotent anyway.
      }
      try {
        supervisor.track({
          childId,
          parentId: record.parentId,
          label: record.label,
          startedAt: Date.now(),
          resumed: true,
          sinceSeq: baselineOf(childId),
        })
      } catch {
        // Supervision is best-effort; the resumed worker still runs without it.
      }
    },

    forget,
  }
}

export function apply(ctx, config) {
  ctx.sessionProjections.register(stageProjection)

  const supervision = createSupervision({ ctx, config })
  const hooks = createSupervisionHooks(supervision.supervisor, { headSeq: supervision.headSeq })

  // The rule text the delegation tools show names exactly the tools the gate refuses,
  // read from the same effective list, so the prompt cannot drift from the enforcement
  // even when a profile adds or re-allows names of its own. The list is a function
  // because both keys are volatile: the tools re-read it when their description is
  // rendered, and the guard re-reads it on every call.
  const deniedTools = () =>
    effectiveDenied(
      DEFAULT_DENIED_TOOLS,
      configValue(config, 'deniedTools', []),
      configValue(config, 'allowedTools', []),
    )

  // One registration for every agent; children get it too and are bounded by maxDepth.
  // The definitions are kept so the worker shadow below can look up each name per scope.
  const delegateTool = createDelegateTool({
    defineTool,
    subagents: ctx.subagents,
    config,
    onStarted: hooks.onStarted,
    deniedTools,
  })
  const orchestrateTool = createOrchestrateTool({ defineTool, subagents: ctx.subagents, config, deniedTools })
  ctx.effect(() => ctx.tools.register(delegateTool), 'orchestrator: delegate tool')
  ctx.effect(() => ctx.tools.register(orchestrateTool), `orchestrator: ${ORCHESTRATE_TOOL} tool`)

  /**
   * The Denied Tools panel must offer every tool the host really has, including the ones
   * other plugins and MCP servers register after this plugin loaded. A web client cannot
   * enumerate tools, so the catalog is published through this plugin's config
   * (lib/catalog.js) and announced on the settings event the client mirror refreshes on.
   * A burst of registrations is one debounced read, and an unchanged catalog publishes
   * nothing at all. The first read runs here: later registrations announce themselves on
   * `tools/change`.
   */
  const catalog = createCatalogPublisher({ ctx, config })
  ctx.effect(() => () => catalog.dispose(), 'orchestrator: tool catalog')
  ctx.on('tools/change', () => catalog.schedule())
  catalog.publish()

  /**
   * A delegated child inherits the same global tool table as the main agent, so it also
   * reads the main-agent rule in both delegation descriptions — and may take that rule
   * as a ban on its own tools. Scoped registrations shadow globals, so the child's own
   * scope gets a short, role-neutral pair instead. The global tools, and therefore every
   * description the main agent sees, are untouched.
   *
   * A definition is immutable, so one worker pair serves every child scope. A child a
   * preset filtered the tool out of is left alone: registering the shadow in its own
   * scope would defeat that filter, because restrictions only mask inherited tools.
   *
   * A failure is reported, never thrown: a broken shadow must not break child creation,
   * and the worst case is the old long description.
   */
  const workerTools = [
    {
      tool: delegateTool,
      shadow: createDelegateTool({
        defineTool,
        subagents: ctx.subagents,
        config,
        onStarted: hooks.onStarted,
        deniedTools,
        forWorker: true,
      }),
    },
    {
      tool: orchestrateTool,
      shadow: createOrchestrateTool({ defineTool, subagents: ctx.subagents, config, deniedTools, forWorker: true }),
    },
  ]
  const shadowDelegationForWorker = (agent) => {
    for (const { tool, shadow } of workerTools) {
      try {
        // The per-scope view: undefined means a preset hid the tool from this child.
        if (agent.ctx.tools.get(tool.name, agent) === undefined) continue
      } catch {
        // An older host without a per-scope lookup: install the shadow anyway.
      }
      try {
        agent.ctx.tools.register(shadow)
      } catch (error) {
        try {
          ctx.logger?.warn?.(`orchestrator: worker ${agent.id}: cannot shorten the "${shadow.name}" description: ${messageOf(error)}`)
        } catch {
          // A logging failure must not break child creation either.
        }
      }
    }
  }

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

  /**
   * The live gate of every gated main agent, keyed by agent id. A restriction is a mask
   * the host evaluates on each request but whose names are fixed when `restrict()` runs,
   * so the panel's writes only reach an open conversation's tool table once the mask is
   * replaced — see the `loader/volatile-update` listener below.
   */
  const gates = new Map()

  const installFor = (agent) =>
    installGate({ agent, names: deniedTools, enabled: () => config.enabled.get() })

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    // A new root agent is the only place a preset or scope-local tool becomes visible,
    // so the catalog may have grown even though the registry itself did not change.
    catalog.schedule()
    if (agent === undefined || agent === null) return
    if (isDelegatedChild(agent)) {
      shadowDelegationForWorker(agent)
      // A `send_message` cold resume recreates an interrupted worker, and its receipt was
      // already settled, so supervision has forgotten it. Only a child this plugin
      // dispatched is re-armed; a host `subagent` child stays unsupervised as before.
      if (payload?.source === 'resume') hooks.onResumed(agent)
      return
    }

    // Installed even while the switch is off: the guard follows the switch per call,
    // so turning dispatch mode on in an open conversation takes effect at once.
    const gate = installFor(agent)
    gates.set(agent.id, gate)
    const { applied, skipped, guarded, guardError } = gate
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

  // A gated agent that goes away takes its gate with it: the entry is the only owner of
  // the mask handles, so dropping it here must not leave them behind.
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    const id = agent?.id
    // A root agent going away can drop its scope-local names from the catalog.
    catalog.schedule()
    if (typeof id !== 'string') return
    // A disposed worker must not keep a supervision slot: until it is resumed its session
    // is gone, and the tick would only read a dead log. A resume re-arms it above.
    if (isDelegatedChild(agent)) hooks.forget(id)
    const gate = gates.get(id)
    if (gate === undefined) return
    gates.delete(id)
    try {
      gate.dispose()
    } catch (error) {
      ctx.logger.warn(`orchestrator: main agent ${id}: cannot lift the gate: ${messageOf(error)}`)
    }
  })

  /**
   * The panel writes `enabled`, `deniedTools` and `allowedTools` as volatile config: the
   * loader commits those values into the running references and then announces the paths
   * on this fiber, which is why the guard already sees a switch flip immediately. The
   * model's tool table is different: the registry stores the names it was handed by
   * `restrict()`, so it has to be handed the new ones. Re-installing here rebuilds that
   * mask for every live main agent, and the next model request — the next `preStep`
   * assembly, with no new session and no switch off/on — sees the new table.
   */
  ctx.on('loader/volatile-update', () => {
    // The Loader commits the profile's raw value into every volatile field it was handed,
    // so a panel write (or any other settings write) resets the published catalog to the
    // stored default. Restore it here, before the write's own settings read answers, so
    // the panel never falls back to its built-in copy after a checkbox click.
    catalog.publish()
    let roots = []
    try {
      if (typeof ctx.agents?.roots === 'function') roots = ctx.agents.roots()
    } catch (error) {
      ctx.logger.warn(`orchestrator: cannot enumerate live agents for a Denied Tools refresh: ${messageOf(error)}`)
      return
    }
    for (const agent of roots) {
      if (isDelegatedChild(agent)) continue
      try {
        const gate = gates.get(agent.id)
        if (gate === undefined) {
          gates.set(agent.id, installFor(agent))
          continue
        }
        if (gate.refresh() && config.enabled.get()) {
          ctx.logger.info(`orchestrator: main agent ${agent.id}: re-applied the Denied Tools mask`)
        }
      } catch (error) {
        ctx.logger.warn(`orchestrator: main agent ${agent.id}: cannot re-apply the Denied Tools mask: ${messageOf(error)}`)
      }
    }
  })
}
