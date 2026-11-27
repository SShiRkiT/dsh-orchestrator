import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DELEGATE_STATUS_TOOL_NAME, DELEGATE_TOOL, ORCHESTRATE_TOOL, disabledToolMessage } from './api.js'
import { createCatalogPublisher } from './catalog.js'
import { createDelegateStatusTool } from './delegate-status.js'
import {
  READ_ONLY_NOTICE, assertReadOnlyArgumentEnabled, createDelegateTool, validateDispatchWrite,
  worktreeDetails, worktreePromptNote,
} from './delegate.js'
import { createSupervisionTurnState, installGate, isDelegatedChild, isDispatchTool } from './gate.js'
import { createOrchestrateTool } from './orchestrate.js'
import { createReadIndex, PEER_CONSULT_SOURCE_KIND } from './read-index.js'
import { mainAgentRule } from './rules.js'
import { RETRY_SOURCE_KIND, createRetry } from './retry.js'
import {
  createActionLedger, evaluateWakeupGate, inspectHostChildState, makeResumeActionKey,
  makeSettleActionKey, reconcileOnStartup,
} from './reconcile.js'
import { createSessionTools, mountSessionToolsRemote, rootSessionIdOf } from './session-tools.js'
import { createStateStore } from './state-store.js'
import { normalizeScope } from './write-scope.js'
import {
  SUPERVISE_SOURCE_KIND,
  composeNotice,
  createSupervisor,
  getSupervisionChildIds,
  hasNormalDeclarationText,
  isPureSupervisionBatch,
  isSupervisionMessage,
  summarize,
} from './supervise.js'
import { SWITCH_SOURCE_KIND, createSwitchNotices } from './switch-notice.js'
import { createDispatchTimeline } from './timeline.js'
import { DEFAULT_ALLOWED_TOOLS, NATIVE_TEAM_TOOLS, installToolSurface } from './tool-surface.js'
import { configValue, isDispatchEnabled, workerRouteFromConfig } from './worker.js'
import { createWriteLeases } from './write-lease.js'
import { formatWorktreeError, leaseFailure, releaseWriteScope, writeScopeFailure, writeScopeNotice } from './write-scope-tool.js'
import { createWorktreeManager, probeGitRepo } from './worktree.js'
import { createPersistentWorktreeTool } from './worktree-tool.js'

export { DEFAULT_ALLOWED_TOOLS, SUPERVISE_SOURCE_KIND, SWITCH_SOURCE_KIND }

export const name = '@sshirkit/dsh-orchestrator'

/**
 * Services used here: inbox projection state, the tool registry, the subagent
 * service, and the live agent/session registries the supervision adapters read.
 */
export const inject = ['sessionProjections', 'tools', 'subagents', 'agents', 'sessions']

/**
 * Every field is volatile so a switch or settings card can rewrite it without
 * editing the profile file. `enabled` and `allowedTools` are read live by the guard,
 * so the switch and the whitelist reach conversations that are already open. The worker
 * route is read on every delegation, so it applies from the next `delegate` call.
 */
export const Config = z.object({
  /** Gate dispatch and governance tools by the root session's effective switch. */
  enabled: z.boolean().default(true).volatile(),
  worktreeIsolationEnabled: z.boolean().default(true)
    .description('Git 仓库下对写任务默认启用独立 Worktree 隔离（orchestrate 按 item 隔离），非 Git 目录使用共享工作区')
    .volatile(),
  readOnlyEnabled: z.boolean().default(false).volatile(),
  peerReadOnlyConsultEnabled: z.boolean().default(false).volatile(),
  /**
   * The only tool whitelist there is. Whitelist-driven: only the names listed here stay
   * available to the main agent, and every other host, MCP or plugin tool is automatically
   * hidden and blocked. The unconfigured list also includes registered native Team tools.
   *
   * That is only the default: the panel may check any tool the host offers.
   * `tools.restrict` hides the global ones; a guard additionally refuses every name that is
   * not listed at execution time, which is what stops scope-local tools such as the native
   * `subagent` (registered in the agent's own scope, so restrict throws for it). Read on
   * every gated call, so a panel change applies to open conversations.
   */
  allowedTools: z
    .array(z.string())
    // Schemastery arrays default to []; retain the distinction between missing and explicitly empty.
    .default(undefined)
    .description(
      'Explicit main-agent whitelist. Omit to use the shipped list plus available Team tools. ' +
        'An empty list disables all whitelist entries; subagent_fork and workflow are not allowed by default.'
    )
    .volatile(),
  allowAgentTeam: z.boolean().default(true).description('Allow native Team tools on the gated main agent.').volatile(),
  /**
   * Read-only mirror of every tool the running host has registered, published by the plugin
   * for the Allowed Tools panel: a web client cannot enumerate tools itself, so the catalog
   * is handed to it through the config form it already reads (lib/catalog.js). It feeds both
   * sides — the panel's complete checklist and the gate's set of names the whitelist leaves
   * out — and is recomputed from the live registry on every `tools/change`. Never written by
   * the panel and never persisted — a settings edit stores only the paths it names — and
   * empty until the first publish, which keeps the panel's built-in fallback on a host that
   * cannot be enumerated.
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
  /** Notices allowed per child; 0 turns supervision off unless superviseUnlimited is on. */
  superviseMaxNoticesPerChild: z.number().min(0).max(20).step(1).default(3).volatile(),
  /** Ignore the notice cap and keep supervising until the child stops, delivers, or ends. */
  superviseUnlimited: z.boolean().default(false).volatile(),
  /** Also notify when a child produced no new events; off saves a model turn. */
  superviseNotifyOnNoProgress: z.boolean().default(false).volatile(),
  /** Restore only todo/write UI events; never add model history or spend model tokens. */
  restoreTodoOnSupervision: z.boolean().default(true).volatile(),
})

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Queue one plugin-authored turn on a delegated child, cold-resuming it when it is gone.
 * Exported so the adapter can be driven with plain objects instead of a running host.
 *
 * DSH `>= 0.2.2-rc.2` removed the symbol-keyed `dsh.subagent.deliverPrompt` entry; the
 * supported path is the public `subagents.prompt(request, signal)`. Two consequences are
 * accepted deliberately:
 *
 * - `parentId` is no longer used. The old entry needed the exact live sender agent, and
 *   the host used to check that the parent was alive; `prompt()` takes the child session
 *   id only, so a retry still reaches a child whose parent has since gone. The parameter
 *   stays so `createRetry`'s injected `deliverPrompt(parentId, childId, text)` signature
 *   is unchanged.
 * - The host hard-codes `source.kind = 'user'` for this path, so `RETRY_SOURCE_KIND` can
 *   no longer be attached to the prompt. A retry therefore reads as a user turn in the
 *   session log; only `source.rpcId` (the `requestId` below) traces it back.
 */
export async function deliverRetryPrompt(ctx, parentId, childId, text, requestId = randomUUID()) {
  if (typeof ctx?.subagents?.prompt !== 'function') {
    throw new Error('the host does not expose subagents.prompt')
  }
  const receipt = await ctx.subagents.prompt(
    {
      requestId,
      childSessionId: childId,
      delivery: 'queue',
      content: [{ type: 'text', text }],
    },
    new AbortController().signal,
  )
  return receipt?.messageId
}

/**
 * Lazy-load `@deepseek-ai/dsh-llm` once and return a `createUserMessage` resolver.
 *
 * Production uses the dynamic `@deepseek-ai/dsh-llm` import (never a top-level import, so
 * the plugin loads even in unit tests without host packages). A missing or broken package
 * warns once and stops retrying.
 */
function createUserMessageLoader({
  loadLlm = () => import('@deepseek-ai/dsh-llm'),
  logger,
  scope,
  disabledReason,
}) {
  let warned = false
  let cachedCreate
  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // A logger must never break a turn or a timer tick.
    }
  }
  return async () => {
    if (warned) return undefined
    if (cachedCreate !== undefined) return cachedCreate
    let llm
    try {
      llm = await loadLlm()
    } catch (error) {
      if (!warned) {
        warned = true
        warn(`orchestrator: ${scope}: cannot load @deepseek-ai/dsh-llm; ${disabledReason}: ${messageOf(error)}`)
      }
      return undefined
    }
    if (typeof llm?.createUserMessage !== 'function') {
      if (!warned) {
        warned = true
        warn(`orchestrator: ${scope}: @deepseek-ai/dsh-llm does not export createUserMessage; ${disabledReason}`)
      }
      return undefined
    }
    cachedCreate = llm.createUserMessage
    return cachedCreate
  }
}

/**
 * Build the `agent/pre-step` waterfall handler that appends a pending dispatch-switch
 * notice onto `decision.messages` right before the next real model step runs.
 *
 * Exported so unit tests can exercise broken `loadLlm` / abort / rejection paths directly.
 */
export function createSwitchPreStep({
  switchNotices,
  loadLlm = () => import('@deepseek-ai/dsh-llm'),
  logger,
  supervisionTurnState,
}) {
  const loadCreator = createUserMessageLoader({
    loadLlm,
    logger,
    scope: 'switch notice',
    disabledReason: 'notices are disabled',
  })

  return async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    const agent = payload?.agent
    if (agent === undefined || agent === null || isDelegatedChild(agent)) return decision
    if (supervisionTurnState?.isTurnActive(agent.id, payload?.turn)) return decision
    const messages = decision?.messages
    if (!Array.isArray(messages)) return decision
    // Mirror `installModelSelection`: a step 1 with no messages (or an emptied step)
    // fires no model request, so attaching a notice there would fabricate a turn or
    // spend the pending notice on a no-op step.
    const incoming = payload?.messages
    if (messages.length === 0 && (payload?.step === 1 || (Array.isArray(incoming) && incoming.length > 0))) {
      return decision
    }
    if (!switchNotices.hasPending(agent.id)) return decision

    // Resolve `createUserMessage` before consuming the pending notice, so an abort during
    // the dynamic import or an unavailable host package never drops it silently.
    const createMessage = await loadCreator()
    if (createMessage === undefined || payload?.signal?.aborted) return decision
    const notice = switchNotices.take(agent.id)
    if (notice === undefined) return decision

    try {
      const message = createMessage({
        content: [{ type: 'text', text: notice.text }],
        source: {
          kind: SWITCH_SOURCE_KIND,
          form: 'notice',
          summary: notice.enabled ? '调度模式已开启' : '调度模式已关闭',
        },
      })
      return {
        ...decision,
        messages: [...messages, message],
      }
    } catch (error) {
      try {
        logger?.warn?.(`orchestrator: main agent ${agent.id}: cannot build the switch notice: ${messageOf(error)}`)
      } catch {
        // A logger failure must never break the agent step.
      }
      return decision
    }
  }
}

/** Deep copies keep both the projection and a later append out of the cached snapshot. */
function cloneTodos(todos) {
  return structuredClone(todos)
}

/** Remember only non-empty root task lists that still belong to the current topic. */
export function createTodoSnapshotTracker(ctx, { isRegistered = () => true } = {}) {
  const snapshots = new Map()
  const restorationTokens = new WeakMap()
  const restorationKind = 'orchestrator-todo-restoration'
  const record = (session, todos, source) => {
    // Append snapshots the payload; only a token owned by this exact session is ours.
    if (source?.kind === restorationKind && restorationTokens.get(session)?.has(source.token)) return
    if (session === undefined || !Array.isArray(todos)) return
    snapshots.set(session, { todos: cloneTodos(todos), eligible: todos.length > 0 })
  }
  const canRestore = (session) => {
    const record = snapshots.get(session)
    return record?.eligible === true && record.todos.length > 0
  }
  return {
    bind(agent) {
      const session = agent?.session
      if (session === undefined || snapshots.has(session)) return
      try {
        record(session, ctx?.sessionProjections?.snapshot?.(session, ['todos'])?.values?.todos)
      } catch {
        // A missing projection must not prevent a root agent from being installed.
      }
    },
    record,
    canRestore,
    invalidate(session) {
      const record = snapshots.get(session)
      if (record !== undefined) record.eligible = false
      else if (session !== undefined) snapshots.set(session, { todos: [], eligible: false })
    },
    forget: (session) => snapshots.delete(session),
    async restore(agent, payload, config) {
      const session = agent?.session
      if (!canRestore(session) || configValue(config, 'restoreTodoOnSupervision', true) !== true) return
      if (payload?.signal?.aborted || typeof session?.append !== 'function') return
      let token
      let tokens
      try {
        if (typeof ctx?.agents?.turnBoundaryOf === 'function' &&
          ctx.agents.turnBoundaryOf(session)?.lastTurn !== payload?.turn) return
        const todos = ctx?.sessionProjections?.snapshot?.(session, ['todos'])?.values?.todos
        if (todos !== null || !isRegistered(agent)) return
        if (typeof ctx?.agents?.get === 'function' && ctx.agents.get(agent.id) !== agent) return
        const restoredTodos = cloneTodos(snapshots.get(session).todos)
        token = randomUUID()
        tokens = restorationTokens.get(session)
        if (tokens === undefined) restorationTokens.set(session, tokens = new Set())
        tokens.add(token)
        // todo/write is log-only; its projection reads todos and ignores this origin.
        await session.append('todo/write', {
          todos: restoredTodos,
          source: { kind: restorationKind, token },
        })
      } catch {
        // UI restoration is best-effort and must never interrupt a real model step.
      } finally {
        tokens?.delete(token)
        if (tokens?.size === 0) restorationTokens.delete(session)
      }
    },
  }
}

/** Auxiliary host context alone must never fabricate a supervision model request. */
function isRuntimeContext(message) {
  return ['time-context', 'runtime-context'].includes(message?.source?.kind)
}

/** Reconcile claimed notices synchronously on both sides of downstream awaits. */
function filterSupervisionMessages(messages, { liveNoticeIds, rebuildNotice, agent, staleIds }) {
  if (staleIds.size === 0 && !messages.some(isSupervisionMessage)) return messages
  return messages.flatMap((message) => {
    if (staleIds.has(message?.id)) return []
    if (!isSupervisionMessage(message)) return [message]
    const originalIds = getSupervisionChildIds(message)
    const liveIds = liveNoticeIds(message, originalIds, agent.id)
    if (liveIds.length === 0) {
      staleIds.add(message.id)
      return []
    }
    if (liveIds.length === originalIds.length) return [message]
    const rebuilt = rebuildNotice?.(message, liveIds, agent.id)
    if (rebuilt !== undefined) return [rebuilt]
    // Safe fallback for old hosts: never retain a stale child's original body.
    return [{
      ...message,
      content: [{ type: 'text', text: composeNotice(liveIds.map((childId) => ({ childId }))) }],
      source: { ...message.source, senderSessionId: liveIds[0], childIds: liveIds },
    }]
  })
}

/** Filter claimed inbox messages before any downstream handler can add model context. */
export function createSupervisionPreStep({
  ctx, config, supervisor, supervisionTurnState, todoTracker, nextStep, rebuildNotice, retainNotices,
  liveNoticeIds = (_message, ids) => ids.filter((id) => supervisor.has(id) && ctx?.agents?.get?.(id) !== undefined),
}) {
  const run = async (payload, next) => {
    const agent = payload?.agent
    if (agent === undefined || agent === null || isDelegatedChild(agent)) return nextStep(payload, next)
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const firstStep = payload?.step === 1
    if (firstStep) supervisionTurnState.clearAgent(agent.id)
    const staleIds = new Set()
    let wasSupervision = false
    let restored = false
    const reconcile = (batch) => {
      wasSupervision ||= batch.some(isSupervisionMessage)
      const remaining = filterSupervisionMessages(batch, { liveNoticeIds, rebuildNotice, agent, staleIds })
      const substantive = remaining.filter((message) => !isRuntimeContext(message))
      const hasSubstantive = substantive.length > 0
      const hasOrdinary = substantive.some((message) => !isSupervisionMessage(message))
      if (remaining.some((message) => message?.source?.kind === 'user')) todoTracker.invalidate(agent.session)
      if (hasOrdinary) supervisionTurnState.clearAgent(agent.id)
      else if (wasSupervision && !hasSubstantive) supervisionTurnState.clearTurn(agent.id, payload.turn)
      return { remaining, hasSubstantive, hasOrdinary, pure: isPureSupervisionBatch(substantive) }
    }
    const restoreOnce = () => {
      // Spend the shared budget before awaiting; reconcile at the caller after its final await.
      if (restored) return
      restored = true
      return todoTracker.restore(agent, payload, config)
    }
    let current = reconcile(messages)
    if (wasSupervision && !current.hasSubstantive) {
      await restoreOnce()
      current = reconcile(messages)
      if (!current.hasSubstantive) return { kind: 'reject' }
    }
    const pure = current.pure
    if (firstStep && pure && !payload?.signal?.aborted) {
      todoTracker.bind(agent)
      supervisionTurnState.bindTurn(agent.id, payload.turn)
    }
    let decision
    try {
      decision = await nextStep({ ...payload, messages: current.remaining }, next)
    } catch (error) {
      supervisionTurnState.clearTurn(agent.id, payload.turn)
      throw error
    }
    if (decision?.kind !== 'enter' || payload?.signal?.aborted) {
      supervisionTurnState.clearTurn(agent.id, payload.turn)
      return decision
    }
    if (!Array.isArray(decision.messages)) return decision
    current = reconcile(decision.messages)
    if ((wasSupervision && !current.hasSubstantive) || (pure && !current.hasOrdinary)) {
      await restoreOnce()
      current = reconcile(decision.messages)
    }
    if (wasSupervision && !current.hasSubstantive) return { kind: 'reject' }
    if (payload?.signal?.aborted) {
      supervisionTurnState.clearTurn(agent.id, payload.turn)
      return decision
    }
    if (wasSupervision && !current.hasSubstantive) return { kind: 'reject' }
    return current.remaining === decision.messages ? decision : { ...decision, messages: current.remaining }
  }
  return async (payload, next) => {
    const release = retainNotices?.(payload)
    try {
      return await run(payload, next)
    } finally {
      release?.()
    }
  }
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
export function createSupervision({
  ctx, config, logger = ctx?.logger, loadLlm = () => import('@deepseek-ai/dsh-llm'),
  supervisionTurnState, listAttentionItems = () => [], isActive = () => true, resolveSessionConfig,
}) {
  let pendingWarned = false
  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // A logger must never break the timer or a dispatch.
    }
  }
  const loadCreator = createUserMessageLoader({
    loadLlm,
    logger,
    scope: 'supervision',
    disabledReason: 'notices are disabled',
  })

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
      if (parent.inbox !== null && typeof parent.inbox === 'object') {
        return [parent.inbox.nextTurn, parent.inbox.nextStep].some((bucket) =>
          Array.isArray(bucket) && bucket.some(isSupervisionMessage))
      }
      const stateOf = ctx?.sessionProjections?.stateOf
      if (typeof stateOf !== 'function') throw new Error('sessionProjections.stateOf is unavailable')
      const state = stateOf.call(ctx.sessionProjections, parent.session, 'inbox')
      if (state === undefined || state === null) throw new Error('the inbox projection returned no state')
      for (const bucket of ['next-turn', 'next-step']) {
        const pending = state[bucket]
        if (!Array.isArray(pending)) continue
        for (const message of pending) {
          if (isSupervisionMessage(message)) return true
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
   *
   * `kind` is the durable `source.kind` the notice carries. Supervision keeps its own
   * kind, because `hasPendingNotice` looks for exactly that kind in the parent inbox;
   * the retry policy uses a second one, so neither ever reads the other's queue.
   */
  const pendingNoticeMeta = new Map()
  const noticeOwners = new Map()
  const claimedNotices = new Map()
  const retainedNoticeAgents = new WeakMap()
  const reconcileScheduled = new Set()
  let noticeCreator
  const hasActiveSupervisionTurn = (parentId) => {
    const parent = ctx?.agents?.get?.(parentId)
    return supervisionTurnState?.hasActiveParent(parentId) === true ||
      claimedNotices.has(parent) || retainedNoticeAgents.has(parent)
  }
  const liveRowIds = (ids, parentId, rowsByChildId) => {
    let attentionById
    return ids.filter((id) => {
      const row = rowsByChildId?.get(id)
      if (row?.kind !== 'attention') return supervisor.has(id) && isChildAlive(id)
      attentionById ??= new Map(listAttentionItems(parentId).map((entry) => [entry.childId, entry]))
      const current = attentionById.get(id)
      return current !== undefined && current.attemptSeq === row.attemptSeq
    })
  }
  const liveNoticeIds = (message, ids, parentId) =>
    liveRowIds(ids, parentId, pendingNoticeMeta.get(message.id)?.rowsByChildId)
  const inboxMessages = (parent) => [parent?.inbox?.nextTurn, parent?.inbox?.nextStep]
    .flatMap((bucket) => Array.isArray(bucket) ? bucket : [])

  /** Claimed and in-flight notices stay owned across every downstream await. */
  const pruneNoticeMeta = () => {
    for (const [id, meta] of pendingNoticeMeta) {
      if (noticeOwners.has(id)) continue
      const parent = ctx?.agents?.get?.(meta.parentId)
      if (parent === undefined || (parent.inbox && !inboxMessages(parent).some((message) => message.id === id))) {
        pendingNoticeMeta.delete(id)
      }
    }
    // Bound only unowned old-host metadata; active owners must never lose their rows.
    for (const id of pendingNoticeMeta.keys()) {
      if (pendingNoticeMeta.size <= 256) break
      if (!noticeOwners.has(id)) pendingNoticeMeta.delete(id)
    }
  }

  const ownNotice = (id) => noticeOwners.set(id, (noticeOwners.get(id) ?? 0) + 1)
  const releaseNotice = (id) => {
    const remaining = (noticeOwners.get(id) ?? 0) - 1
    if (remaining > 0) noticeOwners.set(id, remaining)
    else noticeOwners.delete(id)
  }

  /** The synchronous public claimed event bridges claim -> pre-step without a timer. */
  const claimNotice = ({ agent, message, turn } = {}) => {
    if (!agent || isDelegatedChild(agent) || !isSupervisionMessage(message) || !pendingNoticeMeta.has(message.id)) return
    let claims = claimedNotices.get(agent)
    if (claims === undefined) claimedNotices.set(agent, claims = new Map())
    if (claims.has(message.id)) return
    claims.set(message.id, turn)
    ownNotice(message.id)
  }

  /** Also release claims when another hook rejects before our pre-step ever runs. */
  const releaseClaimedNotices = (agent, turn, ids) => {
    const claims = claimedNotices.get(agent)
    if (claims === undefined) return
    for (const [id, ownerTurn] of claims) {
      if ((turn !== undefined && ownerTurn !== turn) || (ids !== undefined && !ids.has(id))) continue
      claims.delete(id)
      releaseNotice(id)
    }
    if (claims.size === 0) claimedNotices.delete(agent)
    pruneNoticeMeta()
  }

  /** Transfer pending claims to a counted pre-step owner, including concurrent re-entry. */
  const retainNotices = (payload) => {
    const agent = payload?.agent
    if (!agent || isDelegatedChild(agent)) return
    const ids = new Set((Array.isArray(payload.messages) ? payload.messages : [])
      .filter(isSupervisionMessage).map((message) => message.id).filter((id) => pendingNoticeMeta.has(id)))
    for (const id of ids) ownNotice(id)
    if (ids.size > 0) retainedNoticeAgents.set(agent, (retainedNoticeAgents.get(agent) ?? 0) + 1)
    // Transfer only this batch; another concurrent pre-step may own other claims in the same turn.
    releaseClaimedNotices(agent, payload.turn, ids)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const id of ids) releaseNotice(id)
      if (ids.size > 0) {
        const remaining = (retainedNoticeAgents.get(agent) ?? 0) - 1
        if (remaining > 0) retainedNoticeAgents.set(agent, remaining)
        else retainedNoticeAgents.delete(agent)
      }
      pruneNoticeMeta()
    }
  }

  /** Rebuild from the original rows, so a partial settlement never leaves stale text. */
  const buildNotice = (createMessage, parentId, ids, text, meta = {}) => {
    const rowsByChildId = meta.rowsByChildId ?? new Map((meta.rows ?? []).map((row) => [row.childId, { ...row }]))
    const composeMeta = { ...meta.composeMeta }
    const rows = ids.map((childId) => rowsByChildId.get(childId) ?? { childId })
    const body = text ?? composeNotice(rows, composeMeta)
    const message = createMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: SUPERVISE_SOURCE_KIND, form: 'notice', senderSessionId: ids[0], childIds: [...ids] },
    })
    return { message, meta: { parentId, rowsByChildId, composeMeta } }
  }

  /** Reuse the original rows and timestamp; old notices fall back to live log summaries. */
  const noticeMetaFor = (message, ids, parentId) => {
    const saved = pendingNoticeMeta.get(message.id)
    if (saved !== undefined) return saved
    const now = Date.now()
    const rows = ids.map((childId) => {
      try {
        return { childId, ...summarize(readEvents(childId), { now }) }
      } catch {
        return { childId }
      }
    })
    return { parentId, rows, composeMeta: { now } }
  }

  /** Claimed notices retain their id so downstream handlers cannot reintroduce old text. */
  const rebuildNotice = (message, ids, parentId) => {
    const createMessage = noticeCreator ?? ((input) => ({ ...message, ...input }))
    const updated = buildNotice(createMessage, parentId, ids, undefined, noticeMetaFor(message, ids, parentId))
    const rebuilt = { ...updated.message, id: message.id ?? updated.message.id }
    if (pendingNoticeMeta.has(message.id)) pendingNoticeMeta.set(rebuilt.id, updated.meta)
    return rebuilt
  }

  /** One pass reports races; only a bounded microtask chain may retry a failed mutation. */
  const reconcileInbox = (parentId) => {
    const parent = ctx?.agents?.get?.(parentId)
    let retry = false
    for (const message of inboxMessages(parent).filter(isSupervisionMessage)) {
      const originalIds = getSupervisionChildIds(message)
      const ids = liveNoticeIds(message, originalIds, parentId)
      if (ids.length === originalIds.length && ids.length > 0) continue
      if (ids.length > 0 && typeof parent.inbox.replace !== 'function') continue
      const updated = ids.length > 0 ? rebuildNotice(message, ids, parentId) : undefined
      const result = updated === undefined
        ? parent.inbox.remove?.(message.id)
        : parent.inbox.replace(message.id, updated)
      if (result === false) {
        retry = true
        continue
      }
      if (updated === undefined && !noticeOwners.has(message.id)) pendingNoticeMeta.delete(message.id)
    }
    pruneNoticeMeta()
    return retry
  }

  /** Inbox mutation must run outside the synchronous session/event publish stack. */
  const scheduleReconcileInbox = (parentId, attempt = 0) => {
    if (!isActive() || typeof parentId !== 'string' || reconcileScheduled.has(parentId)) return
    reconcileScheduled.add(parentId)
    queueMicrotask(() => {
      reconcileScheduled.delete(parentId)
      if (!isActive()) return
      try {
        if (reconcileInbox(parentId) && attempt < 2) scheduleReconcileInbox(parentId, attempt + 1)
      } catch (error) {
        warn(`orchestrator: supervision: cannot reconcile the parent inbox: ${messageOf(error)}`)
      }
    })
  }

  const deliverAs = async (kind, parentId, text, childIds, meta, checkQueue) => {
    if (!isActive()) return 'unavailable'
    const parent = ctx?.agents?.get?.(parentId)
    if (parent === undefined || parent === null) return 'parent-gone'
    // The dynamic import is not retried once it failed: the supervisor reschedules
    // without spending the child's budget, and one warning is enough.
    const createMessage = await loadCreator()
    if (createMessage === undefined || !isActive()) return 'unavailable'
    noticeCreator = createMessage

    if (ctx?.agents?.get?.(parentId) !== parent) return 'parent-gone'
    let message
    let noticeMeta
    if (kind === SUPERVISE_SOURCE_KIND) {
      const rowsByChildId = new Map((meta?.rows ?? []).map((row) => [row.childId, { ...row }]))
      const allIds = [...(childIds ?? []), ...[...rowsByChildId.values()]
        .filter((row) => row.kind === 'attention').map((row) => row.childId)]
      const originalIds = getSupervisionChildIds({ source: { childIds: allIds } })
      const ids = liveRowIds(originalIds, parentId, rowsByChildId)
      if (ids.length === 0) return 'stale'
      const notice = buildNotice(createMessage, parentId, ids, ids.length === originalIds.length ? text : undefined, {
        rowsByChildId, composeMeta: meta?.composeMeta,
      })
      message = notice.message
      noticeMeta = notice.meta
    } else {
      const source = { kind, form: 'notice' }
      if (Array.isArray(childIds) && typeof childIds[0] === 'string') source.senderSessionId = childIds[0]
      message = createMessage({ content: [{ type: 'text', text }], source })
    }
    const skip = checkQueue?.()
    if (skip !== undefined) return skip
    // Register identity before followup can synchronously publish a claim.
    if (noticeMeta !== undefined && message.id !== undefined) pendingNoticeMeta.set(message.id, noticeMeta)
    try {
      parent.followup(message)
    } catch (error) {
      pendingNoticeMeta.delete(message.id)
      throw error
    }
    pruneNoticeMeta()
    try {
      const flushed = await ctx?.sessions?.flush?.(parent.session)
      if (flushed === false) warn('orchestrator: supervision: the notice was queued but session flush did not acknowledge it')
    } catch (error) {
      warn(`orchestrator: supervision: the notice was queued but session flush failed: ${messageOf(error)}`)
    }
    return 'queued'
  }

  const deliver = (parentId, text, childIds, meta) => deliverAs(SUPERVISE_SOURCE_KIND, parentId, text, childIds, meta)

  /** The retry notice: same delivery, its own `source.kind`. */
  const deliverRetry = (parentId, text, childIds) => deliverAs(RETRY_SOURCE_KIND, parentId, text, childIds)

  const liveConfig = (parentId) => {
    const effective = resolveSessionConfig?.(parentId)
    return {
      enabled: configValue(config, 'superviseEnabled', true) !== false,
      intervalSeconds: effective?.superviseIntervalSeconds ?? configValue(config, 'superviseIntervalSeconds', 600),
      maxNoticesPerChild: effective?.superviseMaxNoticesPerChild ?? configValue(config, 'superviseMaxNoticesPerChild', 3),
      unlimited: effective?.superviseUnlimited ?? (configValue(config, 'superviseUnlimited', false) === true),
      notifyOnNoProgress: configValue(config, 'superviseNotifyOnNoProgress', false) === true,
    }
  }

  const supervisor = createSupervisor({
    config: liveConfig,
    now: () => Date.now(),
    isParentAlive,
    isChildAlive,
    readEvents,
    hasPendingNotice,
    hasActiveSupervisionTurn,
    listAttentionItems,
    deliver: (parentId, text, childIds, meta) => deliverAs(SUPERVISE_SOURCE_KIND, parentId, text, childIds, meta, () =>
      hasPendingNotice(parentId) || hasActiveSupervisionTurn(parentId) ? 'already-pending' : undefined),
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

  return {
    supervisor, isParentAlive, isChildAlive, readEvents, headSeq, hasPendingNotice,
    deliver, deliverRetry, rebuildNotice, liveNoticeIds, scheduleReconcileInbox, pendingNoticeMeta,
    claimNotice, releaseClaimedNotices, retainNotices,
  }
}

/**
 * The `onStarted` callback for the delegate tool: register the child, and drop
 * it once its receipt settles (either way). `onResumed` re-arms that same child when a
 * `send_message` cold resume recreates it. Exported for the same reason as
 * `createSupervision` — a plain recording object is enough to test it.
 */
export function createSupervisionHooks(supervisor, { headSeq, retry, scheduleReconcileInbox } = {}) {
  const activeParents = new Map()
  const forget = (childId) => {
    try {
      supervisor.forget(childId)
      const parentId = activeParents.get(childId) ?? dispatched.get(childId)?.parentId
      activeParents.delete(childId)
      if (parentId !== undefined) scheduleReconcileInbox?.(parentId)
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
    onStarted(parent, started, args, write) {
      const childId = started?.childId
      const parentId = parent?.id
      if (typeof childId !== 'string' || typeof parentId !== 'string') return
      const scope = write === undefined ? {} : { writeScope: write.entries, readOnly: write.readOnly, cwd: write.cwd }
      remember(childId, { parentId, label: args?.description, scope })
      activeParents.set(childId, parentId)
      // The retry policy keys on the same record: a child this plugin did not dispatch is
      // never retried, so the host's own `subagent` children stay untouched.
      try {
        retry?.track?.(childId, { parentId, label: args?.description })
      } catch {
        // A retry bookkeeping failure cannot affect the dispatch.
      }
      try {
        supervisor.track({ childId, parentId, label: args?.description, startedAt: Date.now(),
          ...(started.runId && { runId: started.runId }), ...scope })
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
        activeParents.set(childId, record.parentId)
        supervisor.track({
          childId,
          parentId: record.parentId,
          label: record.label,
          startedAt: Date.now(),
          resumed: true,
          sinceSeq: baselineOf(childId),
          ...record.scope,
        })
      } catch {
        // Supervision is best-effort; the resumed worker still runs without it.
      }
    },

    forget,
  }
}

// Cordis may start the next generation without awaiting an async effect disposer.
// Keep the reservation across module reloads, but never serialize unrelated facilities.
const domainOwnersKey = Symbol.for('@sshirkit/dsh-orchestrator/storage-domain-owners')
const domainOwners = globalThis[domainOwnersKey] ??= new WeakMap()

function reserveDomain(facility) {
  const previous = domainOwners.get(facility)
  let release
  const current = new Promise((resolve) => { release = resolve })
  const tail = Promise.resolve(previous).then(() => current)
  domainOwners.set(facility, tail)
  void tail.then(() => {
    if (domainOwners.get(facility) === tail) domainOwners.delete(facility)
  })
  return { previous, release }
}

export function apply(ctx, config) {
  let facility
  let startupError
  try {
    facility = ctx.get?.('storageDomain')
  } catch (error) {
    startupError = error
  }
  const hasStorage = typeof facility?.open === 'function'
  const stateStore = createStateStore({ facility, logger: ctx.logger })
  const actionLedger = createActionLedger({ store: stateStore })
  const domainReservation = hasStorage ? reserveDomain(facility) : undefined
  const startupAbort = new AbortController()
  const lifecycleQueue = []
  const pendingEnds = new Set()
  const endIdentity = (childId, parentId, runId) => JSON.stringify([childId, parentId, runId])
  const producerDisposers = []
  const listenerDisposers = []
  let disposing = false
  let restoring = hasStorage
  let bufferingLifecycle = hasStorage
  let readyPromise
  let disposePromise
  const supervisionTurnState = createSupervisionTurnState()
  const supervision = createSupervision({
    ctx, config, supervisionTurnState,
    isActive: () => !disposing, resolveSessionConfig: (parentId) => sessionTools.resolveSessionConfig(parentId),
  })
  const writeLeases = createWriteLeases()
  const worktrees = createWorktreeManager()
  const decorateTimeline = (row) => {
    const tree = row.worktreeId && worktrees.get(row.worktreeId)
    const leaseState = row.leaseState ?? (!row.leaseId ? 'none'
      : writeLeases.get(row.leaseId) ? 'held' : startupError ? 'unknown' : 'released')
    return { ...row, leaseState, ...(tree && tree.parentId === row.parentId && { worktree: tree }) }
  }
  const timeline = createDispatchTimeline({ backing: {
    get(childId) {
      const row = stateStore.getDelegate(childId)
      return row && decorateTimeline(row)
    },
    list: (parentId) => stateStore.listDelegates(parentId).map(decorateTimeline),
  } })
  const worktreeOf = (childId) => worktrees.getByWorktreeOrChild(childId)
  const writes = new Map()
  const batchStages = new Map()
  const detachedBatchLeases = new Set()
  const wakeups = new Map()
  const pendingEdits = new Set()
  const settlingChildren = new Set()
  // Keep recent shared/readonly delegates resumable in memory as well as in persistent hosts.
  const keepWorktreeWrite = (record) => {
    const worktree = record.worktree && worktrees.get(record.worktree.id)
    return Boolean(worktree && worktree.mergeCommit === null && worktree.state !== 'discarded')
  }
  const hostRuns = new Map()
  const earlyEnds = new Map()
  const earlyDisposals = new Map()
  const endedRuns = new Set()

  const warn = (text) => {
    try {
      ctx.logger?.warn?.(`orchestrator: ${text}`)
    } catch {
      // A logger must not break settlement or release.
    }
  }

  const assertActive = () => {
    if (disposing) throw new Error('orchestrator: 插件正在卸载')
    if (startupError) throw new Error(`orchestrator: 持久状态未验证；已拒绝操作（${messageOf(startupError)}）`)
  }
  const persist = async (operation) => {
    try {
      if (await operation === false && !disposing) throw new Error('状态写入未确认')
    } catch (error) {
      startupError ??= error
      warn(`持久化失败：${messageOf(error)}`)
      throw error
    }
  }
  const background = (operation) => { void operation.catch(() => {}) }
  const optionalSessionQuery = () => {
    try { return ctx.get?.('sessionQuery') } catch { return undefined }
  }
  const exportTree = (id) => worktrees.exportRecords().find((row) => row.id === id)
  const putTree = (id) => {
    const row = !disposing && id && exportTree(id)
    return row ? persist(stateStore.putWorktree(row)) : Promise.resolve()
  }
  const putLease = (lease) => {
    const row = !disposing && lease && writeLeases.exportLeases().find((entry) => entry.leaseId === lease.leaseId)
    return row ? persist(stateStore.putLease(row)) : Promise.resolve()
  }
  const deleteLease = (lease) => lease && !disposing
    ? persist(stateStore.deleteLease(lease.leaseId).then(() => true)) : Promise.resolve()
  const persistDelegate = (childId, record, patch = {}, entry = timeline.get(record.parentId, childId)) => {
    if (disposing) return Promise.resolve()
    if (!entry) return Promise.reject(new Error(`缺少委派记录 ${childId}`))
    const acknowledged = timeline.checkpoint(record.parentId, childId)
    return persist(stateStore.putDelegate({
      ...stateStore.getDelegate(childId), ...entry,
      childId, parentId: record.parentId, rootSessionId: record.rootSessionId ?? record.parentId,
      worktreeId: record.worktree?.id ?? entry.worktree?.id ?? null,
      pendingNextTurn: record.pendingNextTurn ?? null, ...patch,
      wakeActionKey: record.wakeActionKey ?? null,
      retry: retry.exportChildRecord(childId),
      watchCursor: supervision.supervisor.exportCursor(childId),
    })).then(acknowledged)
  }
  const queueLifecycle = (handler) => (payload) => {
    if (disposing) return
    if (bufferingLifecycle) {
      lifecycleQueue.push(() => handler(payload))
      return readyPromise
    }
    return handler(payload)
  }
  const defineReadyTool = (definition) => {
    const tool = defineTool(definition)
    const isLauncher = definition.name === DELEGATE_TOOL || definition.name === ORCHESTRATE_TOOL
    return {
      ...tool,
      async execute(args, exec) {
        if (restoring) await readyPromise
        if (isDispatchTool(definition.name)) {
          const effective = sessionTools.resolveSessionConfig(exec?.agent)
          if (!effective.enabled) throw new Error(disabledToolMessage(definition.name))
          // Check the disabled key before the host validates against the shared schema.
          if (isLauncher) assertReadOnlyArgumentEnabled(args, effective.readOnlyEnabled)
        }
        if (disposing || isLauncher) assertActive()
        return tool.execute(args, exec)
      },
    }
  }
  const worktreeResumeRefusal = (childId) => {
    const worktree = worktreeOf(childId)
    const lock = worktrees.isChildLocked(childId)
    const missing = worktree && (!worktree.worktreePath || !worktree.execCwd ||
      !existsSync(worktree.worktreePath) || !existsSync(worktree.execCwd))
    if (!lock.locked && !missing) return undefined
    const detail = missing && !['merged', 'discarded'].includes(worktree.state)
      ? '工作树或执行目录已缺失，已拒绝投递以防写入主工作区。'
      : lock.reason
    return `[worktree-child-locked] ${formatWorktreeError('worktree-child-locked', detail)}`
  }

  const closeWrite = (childId, record) => {
    const { attempt, parentId } = record
    if (!attempt) return
    attempt.replacement?.commit?.()
    record.attempt = undefined
    record.releasedLease = attempt.lease
    try {
      if (!record.batchId && record.worktree) {
        const review = worktrees.markReadyForReview(record.worktree.id)
        timeline.recordWorktreeState(childId, { parentId, id: record.worktree.id, state: review?.state })
        background(putTree(record.worktree.id))
      }
    } finally {
      if (!record.batchId) {
        releaseWriteScope(writeLeases, attempt.lease)
        if (attempt.lease) timeline.recordLeaseReleased({ childId, parentId, leaseId: attempt.lease.leaseId })
      }
      supervision.scheduleReconcileInbox(parentId)
    }
  }

  const disposeWrite = (childId, record, at = Date.now()) => {
    timeline.recordDisposed({ childId, parentId: record.parentId, at })
    closeWrite(childId, record)
    if (!record.batchId) background(persistDelegate(childId, record).then(() => deleteLease(record.releasedLease)))
  }

  const nextTurnSettings = (record, { writeScope, readOnly } = {}) => {
    const previous = record.pendingNextTurn ?? record
    const mode = readOnly ?? previous.readOnly === true
    const scope = writeScope ?? (mode ? [] : previous.writeScope)
    const checked = validateDispatchWrite({ readOnly: mode, writeScope: scope }, DELEGATE_STATUS_TOOL_NAME)
    if (mode) return { readOnly: true, writeScope: [], entries: [] }
    const normalized = normalizeScope(checked.entries, record.cwd)
    if (!normalized.ok) throw writeScopeFailure(normalized)
    if (record.worktree && normalized.outsideWorkspace.length > 0) {
      throw new Error(`独立工作树的写作用域须位于子代理执行目录内：${normalized.outsideWorkspace.join('、')}。`)
    }
    return { readOnly: false, writeScope: [...checked.entries], entries: normalized.entries }
  }

  const prepareWriteRetry = (childId, record, { reversible = false } = {}) => {
    const refusal = worktreeResumeRefusal(childId)
    if (refusal) throw new Error(refusal)
    const { parentId } = record
    const nextTurn = nextTurnSettings(record)
    if (record.pendingNextTurn?.readOnly && !sessionTools.resolveSessionConfig(parentId).readOnlyEnabled) {
      throw new Error('当前会话未启用 readOnly，请重新编辑下一轮配置。')
    }
    const replacement = writeLeases.replaceOwnerLease({
      childId, parentId, readOnly: nextTurn.readOnly, entries: nextTurn.entries,
    }, { reversible })
    if (!replacement.ok) throw leaseFailure(replacement)
    const { lease } = replacement
    const priorEntry = timeline.get(parentId, childId)
    const previous = { ...record }
    const attempt = { lease, replacement, previous, priorEntry: priorEntry ?? previous }
    record.attempt = attempt
    Object.assign(record, nextTurn, { pendingNextTurn: null, ended: false, runId: null, agent: null })
    if (!priorEntry) timeline.hydrateEntries([previous])
    timeline.recordRetry({ childId, parentId, leaseId: lease?.leaseId, ...nextTurn, pendingNextTurn: null })
    return record.attempt
  }

  const rollbackWake = async (childId, record, attempt) => {
    attempt.replacement.rollback()
    Object.assign(record, attempt.previous, { wakeActionKey: attempt.previous.wakeActionKey })
    timeline.hydrateEntries([{ ...attempt.priorEntry, updatedAt: Date.now() }])
    const oldLease = attempt.replacement.previousLease
    if (oldLease && writeLeases.has(oldLease.leaseId)) await putLease(oldLease)
    else await deleteLease(oldLease)
    if (attempt.lease?.leaseId !== oldLease?.leaseId) await deleteLease(attempt.lease)
    await persistDelegate(childId, record)
  }

  const wakeIdentity = (childId, record) => ({
    childId, parentId: record.parentId, rootSessionId: record.rootSessionId ?? record.parentId,
    runId: record.runId, attemptSeq: timeline.get(record.parentId, childId)?.attemptSeq ?? record.attemptSeq ?? 1,
  })
  const inspectChild = (identity) => inspectHostChildState({
    childId: identity.childId, expectedParentId: identity.parentId, expectedRootSessionId: identity.rootSessionId,
    agents: ctx.agents, sessions: ctx.sessions, sessionQuery: optionalSessionQuery(), signal: startupAbort.signal,
  })
  const wakeupRefusal = (childId, record) => {
    if (wakeups.has(childId) || pendingEdits.has(childId)) return 'in-flight'
    if (record.wakeActionKey) {
      const status = actionLedger.canInitiate(record.wakeActionKey)
      if (status.record?.phase !== 'done') return status.allowed ? 'delivery-unknown' : status.reason
    }
  }
  const inactiveEnough = (host, record) => !host.ownershipMismatch && (
    (host.running === false && ['live-idle', 'persisted-inactive'].includes(host.presence)) ||
    (!hasStorage && host.presence === 'unknown' && record.ended === true)
  )
  const settled = (childId, record) => !record.attempt && !record.batchId && !settlingChildren.has(childId) &&
    (record.ended === true || ['ended', 'completed', 'failed', 'aborted', 'interrupted'].includes(record.dispatchState)) &&
    !wakeupRefusal(childId, record) && !worktreeResumeRefusal(childId)

  const listReusableChildren = async (parent, signal) => {
    const candidates = new Map(stateStore.listDelegates().map((row) => [row.childId, row]))
    for (const [id, record] of writes) candidates.set(id, record)
    const rows = await Promise.all([...candidates].filter(([id, record]) =>
      record.parentId === parent.id && settled(id, record)).map(async ([childId, record]) => {
      const identity = wakeIdentity(childId, record)
      const host = await inspectChild(identity)
      if (!inactiveEnough(host, record) || !settled(childId, record) || identity.runId !== record.runId) return null
      const tree = worktreeOf(childId)
      return { childId, agentName: record.agentName ?? childId, readOnly: record.readOnly === true,
        writeScope: record.writeScope ?? [], worktree: tree ? { ...worktreeDetails(tree), state: tree.state, locked: tree.locked } : null }
    }))
    signal?.throwIfAborted?.()
    return rows.filter(Boolean)
  }

  const editNextTurn = async (parent, childId, changes, signal) => {
    assertActive()
    const row = stateStore.getDelegate(childId)
    const record = writes.get(childId) ?? row
    if (!record || record.parentId !== parent.id || record.batchId) throw new Error('只能编辑当前根会话直接委派的子代理。')
    const refusal = worktreeResumeRefusal(childId)
    if (refusal) throw new Error(refusal)
    if (!settled(childId, record)) throw new Error('子代理尚未结算或正在唤醒，请稍后重试。')
    const identity = wakeIdentity(childId, record)
    const host = await inspectChild(identity)
    signal?.throwIfAborted?.()
    assertActive()
    const current = writes.get(childId) ?? (row && hydrateWrite(stateStore.getDelegate(childId) ?? row))
    if (!current || !inactiveEnough(host, current) || !settled(childId, current) || current.runId !== identity.runId) {
      throw new Error('子代理已不处于可编辑的闲置状态。')
    }
    const { entries, ...pendingNextTurn } = nextTurnSettings(current, changes)
    if (pendingNextTurn.readOnly && !sessionTools.resolveSessionConfig(parent).readOnlyEnabled) {
      throw new Error('当前会话未启用 readOnly。')
    }
    const checked = writeLeases.check({ entries, readOnly: pendingNextTurn.readOnly, ignoreChildId: childId })
    if (!checked.ok) throw leaseFailure(checked)
    const entry = timeline.get(parent.id, childId) ?? row
    if (!entry) throw new Error('无法确认原委派记录。')
    pendingEdits.add(childId)
    try {
      const updatedAt = Date.now()
      await persistDelegate(childId, current, { pendingNextTurn, updatedAt }, entry)
      current.pendingNextTurn = pendingNextTurn
      return { childId, parentId: parent.id, pendingNextTurn }
    } finally {
      pendingEdits.delete(childId)
    }
  }

  const saveAttempt = async (childId, record) => {
    const { lease, replacement } = record.attempt ?? {}
    await putLease(lease)
    if (replacement?.previousLease && !lease) await deleteLease(replacement.previousLease)
    await persistDelegate(childId, record)
  }

  const performWake = async ({ childId, record, kind, identity, actionKey, submit }) => {
    const blocked = wakeupRefusal(childId, record)
    if (blocked) throw new Error(`唤醒门禁拒绝 ${kind}：${blocked}`)
    const reservation = { key: actionKey, kind, identity }
    wakeups.set(childId, reservation)
    let attempt
    let prepared = false
    let rejected = false
    try {
      attempt = prepareWriteRetry(childId, record, { reversible: true })
      const claim = await actionLedger.prepare(actionKey, { ...identity, kind })
      if (!claim.ok) throw new Error(`唤醒预留失败：${claim.reason}`)
      prepared = true
      record.wakeActionKey = actionKey
      await saveAttempt(childId, record)
      assertActive()
      const refusal = worktreeResumeRefusal(childId)
      if (refusal) throw new Error(refusal)
      const { result, accepted, messageId } = await submit(reservation, claim.record.requestId)
      rejected = accepted === false
      if (accepted || reservation.observed) {
        attempt.replacement.commit()
        if (!disposing) await actionLedger.markAccepted(actionKey, { messageId })
      } else if (!rejected) {
        // An absent or ambiguous receipt still owns the new scope and the deduplication entry.
        attempt.replacement.commit()
        if (!disposing) await actionLedger.markUnknown(actionKey)
      }
      return result
    } catch (error) {
      if (reservation.submitted && !reservation.observed) {
        attempt?.replacement.commit()
        if (!disposing) await actionLedger.markUnknown(actionKey, { detail: messageOf(error) })
      }
      throw error
    } finally {
      if (!reservation.observed && (!reservation.submitted || rejected)) {
        // Restore the delegate and lease before cancelling the durable deduplication entry.
        if (attempt && record.attempt === attempt) await rollbackWake(childId, record, attempt)
        if (prepared) await actionLedger.cancelPrepared(actionKey)
        if (wakeups.get(childId) === reservation) wakeups.delete(childId)
      }
    }
  }

  // The policy still owns classification and budget; the adapter owns the durable wakeup and lease.
  const retry = createRetry({
    async deliverPrompt(parentId, childId, text) {
      assertActive()
      const record = writes.get(childId)
      if (!record || record.parentId !== parentId || record.attempt || typeof ctx.subagents?.prompt !== 'function') {
        throw new Error('没有可安全恢复的委派或宿主续跑能力；已拒绝自动续跑。')
      }
      const identity = wakeIdentity(childId, record)
      const hostState = await inspectChild(identity)
      assertActive()
      const retryOrdinal = retry.exportChildRecord(childId).records[0]?.retries ?? 1
      const host = inactiveEnough(hostState, record) && hostState.presence === 'unknown'
        ? { ...hostState, presence: 'persisted-inactive', running: false } : hostState
      const gate = evaluateWakeupGate({ ...identity, kind: 'retry', retryOrdinal, worktrees, hostState: host, actionLedger })
      if (!gate.allowed || record.runId !== identity.runId || record.attempt) {
        throw new Error(`唤醒门禁拒绝自动续跑：${gate.allowed ? 'in-flight' : gate.reason}`)
      }
      return performWake({ childId, record, kind: 'retry', identity, actionKey: gate.actionKey,
        async submit(reservation, requestId) {
          if (reservation.observed) return { accepted: true }
          const mode = record.readOnly ? READ_ONLY_NOTICE : writeScopeNotice(record.attempt?.lease?.scope)
          const checkout = record.worktree ? `\n${worktreePromptNote(record.worktree)}` : ''
          reservation.submitted = true
          const messageId = await deliverRetryPrompt(ctx, parentId, childId, `${text}\n${mode}${checkout}`, requestId)
          if (!messageId && !reservation.observed) throw new Error('宿主未确认投递')
          return { result: messageId, accepted: true, messageId }
        } })
    },
    wakeParent: (...args) => disposing ? undefined : supervision.deliverRetry(...args),
    logger: ctx.logger,
  })
  const hooks = createSupervisionHooks(supervision.supervisor, {
    headSeq: supervision.headSeq,
    retry,
    scheduleReconcileInbox: supervision.scheduleReconcileInbox,
  })
  const rootAgents = new Map()
  const sessionToRootAgent = new Map()
  const todoTracker = createTodoSnapshotTracker(ctx, {
    isRegistered: (agent) => rootAgents.get(agent.id) === agent,
  })
  const currentTurnOf = (agent) => ctx.agents?.turnBoundaryOf?.(agent.session)?.lastTurn

  // The dispatch switch is volatile config: the panel writes it and the loader announces the
  // change. A notice pushed at that moment would splice into a turn the user is still reading,
  // so the change is only recorded here and delivered when that agent's next turn begins.
  const switchNotices = createSwitchNotices({
    readEnabled: (id) => dispatchEnabled(rootAgents.get(id) ?? id),
    logger: ctx.logger,
  })

  // Only bounded recent host identities are needed to bridge receipt and event ordering.
  const rememberRecent = (map, key, value) => {
    map.delete(key)
    map.set(key, value)
    if (map.size > 256) map.delete(map.keys().next().value)
  }

  const finishDetachedBatch = async (childId, record) => {
    const lease = record.releasedLease
    if (!lease || !detachedBatchLeases.has(lease.leaseId)) return
    const stageRows = stateStore.listDelegates().filter((row) => row.leaseId === lease.leaseId)
    if (stageRows.some((row) => row.childId !== childId && row.dispatchState === 'running')) return
    const tree = record.worktree && worktrees.markReadyForReview(record.worktree.id)
    if (tree) {
      await putTree(tree.id)
      for (const id of tree.childIds) {
        timeline.recordWorktreeState(id, { parentId: tree.parentId, id: tree.id, state: tree.state })
      }
    }
    for (const row of stageRows) {
      const releasedAt = Date.now()
      timeline.recordLeaseReleased({ childId: row.childId, parentId: row.parentId, leaseId: lease.leaseId, at: releasedAt })
      const confirmed = timeline.checkpoint(row.parentId, row.childId)
      await persist(stateStore.putDelegate({ ...row, leaseState: 'released', releasedAt, updatedAt: releasedAt }))
      confirmed()
    }
    await deleteLease(lease)
    releaseWriteScope(writeLeases, lease)
    detachedBatchLeases.delete(lease.leaseId)
  }

  const settleChild = (info) => {
    const childId = info?.id
    if (typeof childId !== 'string' || childId === '') return
    const runId = info.runId
    if (runId && endedRuns.has(runId)) return
    const record = writes.get(childId)
    if (record === undefined) {
      // A worker can finish before startActivation's receipt is handed back to delegate.
      if (hostRuns.get(childId)?.runId === runId && runId) rememberRecent(earlyEnds, childId, info)
      return
    }
    const wakeKey = wakeups.get(childId)?.key ?? record.wakeActionKey
    if (wakeKey && (!runId || runId === actionLedger.get(wakeKey)?.runId)) return
    if (typeof info.parentSessionId === 'string' && record.parentId !== info.parentSessionId) return
    if (record.runId && runId && record.runId !== runId) return
    if (runId) {
      endedRuns.add(runId)
      if (endedRuns.size > 256) endedRuns.delete(endedRuns.values().next().value)
    } else if (record.ended) {
      return
    }
    const settle = async () => {
      if (hasStorage) {
        assertActive()
        const identity = { ...wakeIdentity(childId, record), runId: runId ?? record.runId }
        const key = makeSettleActionKey(identity)
        const prepared = await actionLedger.prepare(key, { ...identity, kind: 'settle' })
        if (disposing) return
        if (!prepared.ok) {
          // A verified end can finish a settlement interrupted after the reservation.
          const prior = prepared.record
          if (prior?.kind !== 'settle' || prior.phase !== 'prepared' || prior.parentId !== identity.parentId ||
              prior.childId !== childId || prior.runId !== identity.runId || prior.attemptSeq !== identity.attemptSeq) return
        }
        return completeSettlement(key)
      }
      return completeSettlement()
    }
    const completeSettlement = async (key) => {
      const parentId = record.parentId
      if (!timeline.recordEnded({ childId, parentId, runId, stopReason: info.stopReason, at: Date.now() })) {
        throw new Error(`无法确认委派 ${childId} 的结算运行`)
      }
      record.ended = true
      record.agent = null
      record.runId ??= runId
      closeWrite(childId, record)
      hooks.forget(childId)
      supervision.scheduleReconcileInbox(parentId)
      const lease = record.releasedLease
      await persistDelegate(childId, record)
      if (record.batchId) await finishDetachedBatch(childId, record)
      else await deleteLease(lease)
      if (key && !disposing) await actionLedger.markDone(key)
      return true
    }
    if (settlingChildren.has(childId)) return
    settlingChildren.add(childId)
    return (async () => {
      let completed
      try {
        completed = await settle()
      } finally {
        settlingChildren.delete(childId)
      }
      if (!completed || record.batchId || disposing) return
      // Retry may start a new run before the host returns its delivery receipt.
      try {
        await retry.settle(childId, info, runId ?? record.runId)
      } finally {
        await persistDelegate(childId, record)
      }
    })().catch((error) => warn(`无法结算子代理 ${childId}：${messageOf(error)}`))
  }

  const onDelegateStarted = (parent, started, args, write, agentName) => {
    const childId = started.childId
    const parentId = parent.id
    const cachedRun = hostRuns.get(childId)
    const hostRun = cachedRun?.parentId === undefined || cachedRun.parentId === parentId ? cachedRun : undefined
    const { lease, ...metadata } = write
    const runId = hostRun?.runId ?? started.runId
    if (disposing) return
    timeline.recordDispatched({
      parentId, childId, agentName, label: args.description, readOnly: write.readOnly, writeScope: write.writeScope,
      cwd: write.cwd, allowNewReason: write.allowNewReason, leaseId: lease?.leaseId, startedAt: Date.now(), worktree: write.worktree,
    })
    timeline.recordRunStarted({ childId, parentId, runId })
    const record = {
      ...metadata,
      parentId,
      rootSessionId: parent.session?.header?.rootSessionId ?? parentId,
      label: args.description,
      agentName,
      runId,
      agent: hostRun?.agent ?? ctx.agents?.get?.(childId),
      attempt: { lease },
    }
    writes.set(childId, record)
    // Keep resumable worktree metadata through review, but bound other detached records.
    for (const [id, record] of writes) {
      if (writes.size <= 256) break
      if (record.attempt === undefined && !record.pendingNextTurn && !retry.has(id) && !wakeups.has(id) && !keepWorktreeWrite(record)) {
        writes.delete(id)
      }
    }
    hooks.onStarted(parent, { ...started, runId }, args, write)
    const durable = Promise.all([putTree(write.worktree?.id), saveAttempt(childId, record)])
    const earlyDisposal = earlyDisposals.get(childId)
    if (earlyDisposal !== undefined && earlyDisposal.agent === record.agent && earlyDisposal.runId === runId) {
      earlyDisposals.delete(childId)
      disposeWrite(childId, record, earlyDisposal.at)
      hooks.forget(childId)
    }
    const earlyEnd = earlyEnds.get(childId)
    if (earlyEnd?.parentSessionId === parent.id) {
      earlyEnds.delete(childId)
      background(Promise.resolve(settleChild(earlyEnd)))
    }
    return durable
  }

  // Legacy synchronous embedders may dispose individual registration effects.
  // The Cordis path instead has a single owner for the runtime and its handles.
  const legacyEffects = typeof ctx.get !== 'function'
  const rememberCleanup = (list, handle) => {
    if (typeof handle === 'function') list.push(handle)
    else if (typeof handle?.[Symbol.dispose] === 'function') list.push(() => handle[Symbol.dispose]())
  }
  const own = (setup, label) => {
    if (legacyEffects) return ctx.effect(setup, label)
    rememberCleanup(producerDisposers, setup())
  }
  const listen = (...args) => rememberCleanup(listenerDisposers, ctx.on(...args))
  const clean = (disposers) => {
    while (disposers.length > 0) {
      try { disposers.pop()() } catch (error) { warn(`卸载清理失败：${messageOf(error)}`) }
    }
  }
  if (legacyEffects) ctx.effect(() => () => writeLeases.clear(), 'orchestrator: write leases')

  const dispatchPersistence = {
    assertActive,
    isDisposing: () => disposing,
    async beforeLaunch(write) {
      assertActive()
      await Promise.all([putTree(write.worktree?.id), putLease(write.lease)])
    },
    async afterFailedLaunch(write) {
      await putTree(write.worktree?.id)
      await deleteLease(write.lease)
    },
  }

  const stageTracking = {
    ...dispatchPersistence,
    async stageStarted(batch, handle, stage) {
      if (disposing) return
      const { parent, write, batchId } = batch
      const childId = handle.childId
      const cached = hostRuns.get(childId)
      const runId = cached?.parentId === parent.id ? cached.runId ?? handle.runId : handle.runId
      if (write.worktree) {
        worktrees.rebindChild(write.worktree.id, childId)
        worktrees.bindChild(write.worktree.id, childId)
      }
      const record = {
        ...stage, batchId, childId, parentId: parent.id, rootSessionId: parent.session?.header?.rootSessionId ?? parent.id,
        worktree: write.worktree, runId,
      }
      batch.children.set(childId, { record, ended: false })
      batchStages.set(childId, batch)
      timeline.recordDispatched({ ...record, ...write, leaseId: write.lease?.leaseId })
      timeline.recordRunStarted({ childId, parentId: parent.id, runId })
      await Promise.all([putTree(write.worktree?.id), putLease(write.lease),
        persistDelegate(childId, record, { ...stage, batchId })])
    },
    async stageEnded(batch, handle, result) {
      if (disposing) return
      const stage = batch.children.get(handle.childId)
      if (!stage || stage.ended) return
      stage.ended = true
      const { record } = stage
      timeline.recordEnded({ ...record, stopReason: result.stopReason })
      await persistDelegate(record.childId, record, { batchId: record.batchId, itemIndex: record.itemIndex, stageIndex: record.stageIndex })
    },
    canFinishBatch(batch) {
      return batch.inFlightStarts === 0 && [...batch.children.values()].every((stage) => stage.ended)
    },
    async finishBatch(batch) {
      const { write } = batch
      await putTree(write.worktree?.id)
      for (const [childId, { record }] of batch.children) {
        if (disposing) return
        const { parentId } = record
        const tree = write.worktree && worktrees.get(write.worktree.id)
        if (tree) timeline.recordWorktreeState(childId, { parentId, id: tree.id, state: tree.state })
        if (write.lease) timeline.recordLeaseReleased({ childId, parentId, leaseId: write.lease.leaseId })
        await persistDelegate(childId, record, { batchId: record.batchId, itemIndex: record.itemIndex, stageIndex: record.stageIndex })
        batchStages.delete(childId)
      }
      await deleteLease(write.lease)
      releaseWriteScope(writeLeases, write.lease)
    },
  }

  // The same live whitelist feeds the prompt, execution guard and tool definitions.
  const catalog = createCatalogPublisher({ ctx, config })
  const allowAgentTeam = () => configValue(config, 'allowAgentTeam', true) !== false
  const isNativeTeamEnabled = (agent) => {
    try {
      // The optional host service resolves the caller's root and reads its Team projection.
      const teams = typeof ctx.get === 'function' ? ctx.get('agentTeams') : ctx.agentTeams
      return teams?.isEnabled?.(agent) === true
    } catch {
      // An unavailable service or a scope without a live Team root must not break tool rendering.
      return false
    }
  }
  const refreshSupervision = (sessionId) => {
    const changed = supervision.supervisor.refreshConfig((parentId) => {
      return sessionId === undefined || sessionTools.resolveRootId(parentId) === sessionId
    })
    if (!hasStorage || restoring) return
    for (const childId of changed) {
      const record = writes.get(childId)
      if (record?.attempt) background(persistDelegate(childId, record))
    }
  }
  const sessionTools = createSessionTools({
    facility, ctx, logger: ctx.logger, globalAllowedFor: () => allowedToolsFor(),
    globalConfigFor: () => ({
      enabled: isDispatchEnabled(config),
      worktreeIsolationEnabled: configValue(config, 'worktreeIsolationEnabled', true) !== false,
      readOnlyEnabled: configValue(config, 'readOnlyEnabled', false) === true,
      peerReadOnlyConsultEnabled: configValue(config, 'peerReadOnlyConsultEnabled', false) === true,
      workerRoute: workerRouteFromConfig(config) ?? null,
      superviseIntervalSeconds: configValue(config, 'superviseIntervalSeconds', 600),
      superviseMaxNoticesPerChild: configValue(config, 'superviseMaxNoticesPerChild', 3),
      superviseUnlimited: configValue(config, 'superviseUnlimited', false) === true,
    }),
    onConfigChanged(sessionId) {
      for (const agent of rootAgents.values()) {
        if (rootSessionIdOf(agent) === sessionId) switchNotices.observe(agent.id)
      }
      refreshSupervision(sessionId)
    },
  })
  const allowedToolsFor = (subject) => sessionTools.resolveAllowedTools(subject, {
    globalAllowed: configValue(config, 'allowedTools', undefined),
    defaultAllowed: DEFAULT_ALLOWED_TOOLS,
    allowAgentTeam: allowAgentTeam(),
    catalog: catalog.published(),
  })
  const readIndex = createReadIndex({
    enabledFor: (id) => sessionTools.resolveSessionConfig(id).peerReadOnlyConsultEnabled,
    getAgent: (id) => ctx.agents?.get?.(id),
    listAgents: () => ctx.agents?.list?.(),
    rootIdOf: sessionTools.resolveRootId,
    readOnlyOf: (agent) => (writes.get(agent.id) ?? stateStore.getDelegate(agent.id))?.readOnly,
    nameOf(agent) {
      try { return ctx.subagents.namesOf?.(agent)?.self } catch { return undefined }
    },
    resolvePeerTarget(exec) {
      const target = exec.arguments?.agent
      return target && (ctx.subagents.resolveName?.(exec.agent, target, exec.signal) ?? target)
    },
  })
  listen('tools/result', (exec, result) => {
    if (disposing) return
    background(readIndex.observe(exec, result).catch((error) => warn(`只读索引采集失败：${messageOf(error)}`)))
  }, { global: true })
  const sessionToolsRemote = mountSessionToolsRemote(ctx, sessionTools)
  if (!sessionToolsRemote.available && typeof ctx.provide === 'function') warn(sessionToolsRemote.error)
  const nativeToolNote = (allowed) => {
    const team = NATIVE_TEAM_TOOLS.some((name) => allowed?.includes(name))
      ? '原生 team_task_* 仅用于共享任务板，不替代派发或写租约。'
      : ''
    return `${team}subagent_fork / workflow 默认屏蔽。`
  }

  const worktreeDispatch = {
    worktrees,
    resolveSessionConfig: sessionTools.resolveSessionConfig,
    probeGitRepo,
    onCleanupFailed: (error) => warn(`无法清理未启动的工作树：${messageOf(error)}`),
  }

  // One registry entry per tool. The root whitelist and child mask own visibility.
  const delegateTool = createDelegateTool({
    ...worktreeDispatch,
    defineTool: defineReadyTool,
    persistence: hasStorage ? dispatchPersistence : undefined,
    subagents: ctx.subagents,
    config,
    onStarted: onDelegateStarted,
    listReusableChildren,
    nativeToolNote,
    // Direct, unscoped consumers retain the global description. Scoped declarations
    // replace it with describeFor(allowedToolsFor(scope)) without touching the registry.
    allowedTools: () => allowedToolsFor(undefined),
    leases: writeLeases,
  })
  // Both tools share the one table, so a `delegate` and a batch (or two batches) cannot
  // claim the same path at the same time; a second table would make them blind to each
  // other and defeat the exclusion entirely.
  const orchestrateTool = createOrchestrateTool({
    ...worktreeDispatch,
    defineTool: defineReadyTool,
    stageTracking,
    subagents: ctx.subagents,
    config,
    leases: writeLeases,
  })
  own(() => ctx.tools.register(delegateTool), 'orchestrator: delegate tool')
  own(() => ctx.tools.register(orchestrateTool), `orchestrator: ${ORCHESTRATE_TOOL} tool`)
  const delegateStatusTool = createDelegateStatusTool({
    defineTool: defineReadyTool,
    timeline,
    toolName: DELEGATE_STATUS_TOOL_NAME,
    editNextTurn,
    wakeActionFor({ childId, parentId }) {
      const row = writes.get(childId) ?? stateStore.getDelegate(childId)
      if (row?.parentId !== parentId) return null
      const key = wakeups.get(childId)?.key ?? row.wakeActionKey
      if (!key) return null
      const action = actionLedger.get(key)
      if (!action) return { key, phase: 'unknown' }
      return action.parentId === parentId && action.childId === childId ? action : null
    },
    isRootAgent: (agent) => !isDelegatedChild(agent),
  })
  own(() => ctx.tools.register(delegateStatusTool), `orchestrator: ${DELEGATE_STATUS_TOOL_NAME} tool`)
  const worktreeManageTool = createPersistentWorktreeTool({
    isWakePending(id) {
      const record = writes.get(id) ?? stateStore.getDelegate(id)
      return Boolean(record && wakeupRefusal(id, record))
    },
    worktrees, stateStore, timeline, assertActive, persist,
    onClosed(record) {
      const write = writes.get(record.childId)
      if (write?.worktree?.id === record.id && write.attempt === undefined) writes.delete(record.childId)
    },
    isRootAgent: (exec) => Boolean(exec?.agent) && !isDelegatedChild(exec.agent),
    defineTool: defineReadyTool,
  })
  own(() => ctx.tools.register(worktreeManageTool), `orchestrator: ${worktreeManageTool.name} tool`)

  // Resolve exactly as the native tool does without changing its argument contract.
  const resolveMessageTarget = async (exec) => {
    const target = exec.arguments?.agent
    if (typeof target !== 'string' || target === '') return {}
    assertActive()
    let childId = target
    let refusal = worktreeResumeRefusal(childId)
    if (!refusal && (writes.size > 0 || worktrees.getChildWorktreeMap().size > 0 ||
        (hasStorage && stateStore.listDelegates().length > 0)) && typeof ctx.subagents.resolveName === 'function') {
      childId = (await ctx.subagents.resolveName(exec.agent, target, exec.signal)) ?? target
      assertActive()
      refusal = worktreeResumeRefusal(childId)
    }
    if (refusal) throw new Error(refusal)
    const row = stateStore.getDelegate(childId)
    const record = writes.get(childId) ?? row
    if (!record) return { childId }
    const blocked = wakeupRefusal(childId, record)
    if (blocked) throw new Error(`唤醒门禁拒绝 send_message：${blocked}`)
    const identity = wakeIdentity(childId, record)
    const hostState = await inspectChild(identity)
    assertActive()
    if (hostState.running && !hostState.ownershipMismatch) return { childId }
    if (record.batchId) throw new Error('编排阶段不能单独恢复；请新建任务。')
    const current = writes.get(childId) ?? stateStore.getDelegate(childId)
    if (current?.parentId !== record.parentId || wakeupRefusal(childId, current) || identity.runId !== current.runId) {
      throw new Error('唤醒门禁拒绝 send_message：in-flight')
    }
    if (current.attempt || !settled(childId, current)) throw new Error('原运行仍在结算，请稍后向同一代理重试。')
    const host = inactiveEnough(hostState, current) && hostState.presence === 'unknown'
      ? { ...hostState, presence: 'persisted-inactive', running: false } : hostState
    const gate = evaluateWakeupGate({ ...identity, kind: 'resume', worktrees, hostState: host, actionLedger })
    if (!gate.allowed) throw new Error(`唤醒门禁拒绝 send_message：${gate.reason}`)
    return { childId, row, identity, key: gate.actionKey }
  }

  // Early preflight keeps lock refusals visible to direct and Code Mode callers. Reserve
  // only in tools/execute, after the host's approval and remaining pre-execute guards.
  listen('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision?.kind === 'deny' || exec.name !== 'send_message') return decision
    if (restoring) await readyPromise
    try {
      await resolveMessageTarget(exec)
      return decision
    } catch (error) {
      return { kind: 'deny', reason: `无法核验 send_message 目标「${exec.arguments?.agent}」：${messageOf(error)}` }
    }
  }, { global: true })

  listen('tools/execute', async (exec, next) => {
    if (exec.name !== 'send_message') return next()
    if (restoring) await readyPromise
    const { childId, row, identity, key: actionKey } = await resolveMessageTarget(exec)
    if (!identity) return next()
    const current = writes.get(childId) ?? hydrateWrite(row)
    if (identity.runId !== current.runId || !settled(childId, current)) {
      throw new Error('唤醒门禁拒绝 send_message：in-flight')
    }
    return performWake({ childId, record: current, kind: 'resume', identity, actionKey,
      async submit(reservation) {
        exec.signal?.throwIfAborted?.()
        if (reservation.observed) throw new Error('宿主已启动该子代理，未重复唤醒。')
        reservation.submitted = true
        const result = await next()
        const messageId = result?.value?.messageId
        const accepted = result?.isError === true ? false : (result?.isError === false || messageId ? true : undefined)
        return { result, accepted, messageId }
      },
    })
  }, { global: true })
  /**
   * The live guard of every gated main agent, keyed by agent id. One predicate covers every
   * name — global, scope-local, and calls nested inside `run_code` — so nothing has to be
   * rebuilt when the panel or the registry changes; it is dropped with the agent.
   */
  const dispatchEnabled = (subject) => sessionTools.resolveSessionConfig(subject).enabled

  const gates = new Map()

  const installFor = (agent) => installGate({
    agent,
    allowed: allowedToolsFor,
    allowAgentTeam,
    enabled: dispatchEnabled,
    checkSupervision: (current, tool, options) => supervisionTurnState.checkTool(current.id, currentTurnOf(current), tool, options),
  })

  /**
   * The Allowed Tools panel must offer every tool the host really has, including the ones
   * other plugins and MCP servers register after this plugin loaded. A web client cannot
   * enumerate tools, so the catalog is published through this plugin's config
   * (lib/catalog.js) and announced on the settings event the client mirror refreshes on.
   * A burst of registrations is one debounced read, and an unchanged catalog publishes
   * nothing at all. The first read runs here: later registrations announce themselves on
   * `tools/change`.
   */
  own(() => () => catalog.dispose(), 'orchestrator: tool catalog')
  listen('tools/change', () => {
    // Publishing keeps the panel's checklist complete. Nothing else has to happen: the
    // model-facing table is filtered per request by the surface wrapper below.
    catalog.schedule()
  })
  catalog.publish()

  /**
   * The model-facing tool table is cut at the single exit the host builds it from:
   * `ctx.tools.definitions(scope, toolSet)`. Wrapping it makes the main agent's whitelist
   * and a child's own deny list apply from the very first request of a session, without a
   * single `tools.restrict` call — and therefore without the `tools/change` storm that used
   * to make `dsh-ops` hide and re-hide the official `read`/`glob`/`grep` on every dispatch
   * (a request built inside that window saw them appear, the next saw them vanish, and the
   * cached prompt prefix was lost each time).
   */
  const rootRuleContext = ctx.get?.('systemPrompt') ?? ctx.systemPrompt
  if (typeof rootRuleContext?.context === 'function') {
    own(() => rootRuleContext.context({
      name: 'orchestrator:root-dispatch-rule',
      order: rootRuleContext.getContextOrder?.('SUBAGENT_DELEGATION'),
      interpolate: false,
      text: ({ agent, toolSet }) => {
        if (!agent || !dispatchEnabled(agent)) return ''
        if (isDelegatedChild(agent)) {
          const record = writes.get(agent.id)
          const current = record && timeline.get(record.parentId, agent.id)
          if (!record?.attempt || !current || current.attemptSeq < 2) return ''
          const scope = record.attempt.lease?.scope
          if (record.readOnly) return `本轮委派配置覆盖历史任务中的写入限制。\n${READ_ONLY_NOTICE}`
          return scope?.length ? `本轮委派配置覆盖历史任务中的写入限制。\n${writeScopeNotice(scope)}` : ''
        }
        const allowed = allowedToolsFor(agent)
        const hasDispatch = ctx.tools.definitions(agent, toolSet).some(({ name }) =>
          name === 'delegate' || name === ORCHESTRATE_TOOL)
        if (hasDispatch) return ''
        return mainAgentRule(allowed, sessionTools.resolveSessionConfig(agent))
      },
    }), 'orchestrator: root dispatch rule')
  }
  own(
    () =>
      installToolSurface({
        tools: ctx.tools,
        allowed: allowedToolsFor,
        describeDelegate: delegateTool.describeFor,
        allowAgentTeam,
        isNativeTeamEnabled,
        enabled: dispatchEnabled,
        readOnlyEnabled: (subject) => sessionTools.resolveSessionConfig(subject).readOnlyEnabled,
        describeOrchestrate: orchestrateTool.describeFor,
      }),
    'orchestrator: tool surface',
  )

  const hydrateWrite = (row, { active = false, agent } = {}) => {
    const worktree = row.worktreeId ? worktrees.get(row.worktreeId) : undefined
    const lease = row.leaseId && writeLeases.get(row.leaseId)
    const scope = row.readOnly ? null : normalizeScope(row.writeScope ?? [], row.cwd)
    const record = {
      ...row, worktree, agent, ended: !active, entries: lease?.entries ?? scope?.entries,
      attempt: active ? { lease } : undefined,
    }
    writes.set(row.childId, record)
    if (active && row.batchId && lease) detachedBatchLeases.add(lease.leaseId)
    return record
  }
  const armRun = (childId, record, { resumed = false, startedAt = Date.now() } = {}) => {
    if (record.batchId) return
    supervision.supervisor.track({
      childId, parentId: record.parentId, runId: record.runId, label: record.label,
      startedAt, resumed, readOnly: record.readOnly, cwd: record.cwd, writeScope: record.entries,
      ...(resumed && { sinceSeq: supervision.headSeq(childId) }),
    })
  }
  const runStarted = (childId, record, agent, runId) => {
    const reservation = wakeups.get(childId)
    const actionKey = reservation?.key ?? record.wakeActionKey
    const previousRun = reservation?.identity.runId ?? actionLedger.get(actionKey)?.runId
    if (actionKey && (!runId || runId === previousRun)) return
    if (record.worktree) {
      const review = worktrees.reopenForRetry(record.worktree.id)
      timeline.recordWorktreeState(childId, {
        parentId: record.parentId, id: record.worktree.id, state: review?.state, conflictFiles: review?.conflictFiles,
      })
      background(putTree(record.worktree.id))
    }
    const changedRun = runId && record.runId !== runId
    record.runId = runId ?? record.runId
    record.agent = agent
    timeline.recordRunStarted({ childId, parentId: record.parentId, runId })
    if (reservation) {
      reservation.observed = true
      record.attempt?.replacement?.commit()
      wakeups.delete(childId)
    }
    if (actionKey && !retry.has(childId)) retry.track(childId, { parentId: record.parentId, label: record.label })
    if (changedRun && (hasStorage || reservation)) armRun(childId, record, { resumed: true })
    if (actionKey) {
      record.wakeActionKey = null
      return persistDelegate(childId, record).then(() => actionLedger.markDone(actionKey))
    }
    return persistDelegate(childId, record)
  }
  const resumeFromHost = async (agent, childId, runId, parentId) => {
    if (disposing || startupError) return
    const refusal = worktreeResumeRefusal(childId)
    if (refusal) { warn(refusal); return }
    const row = stateStore.getDelegate(childId)
    const record = writes.get(childId) ?? (row && !row.batchId && hydrateWrite(row))
    if (!record || record.batchId || (parentId && record.parentId !== parentId)) return
    if (record.runId === runId && runId && !record.ended) return
    const durableWake = record.wakeActionKey && actionLedger.get(record.wakeActionKey)
    if (durableWake && durableWake.phase !== 'done') {
      // A new host run can resolve an ambiguous dispatch using the scope already persisted.
      if (!runId || runId === durableWake.runId) return
      if (!record.attempt) {
        const lease = row?.leaseId && writeLeases.get(row.leaseId)
        if (!record.readOnly && !lease) throw new Error('无法验证宿主已恢复运行的写租约。')
        record.attempt = { lease }
        record.ended = false
      }
      return runStarted(childId, record, agent, runId)
    }
    let reservation = wakeups.get(childId)
    if (!reservation) {
      const identity = wakeIdentity(childId, record)
      const key = makeResumeActionKey({ ...identity, interruptedRunId: identity.runId })
      reservation = { kind: 'resume', key, identity }
      wakeups.set(childId, reservation)
      const prepared = await actionLedger.prepare(key, { ...identity, kind: 'resume', interruptedRunId: identity.runId })
      if (!prepared.ok) {
        wakeups.delete(childId)
        warn(`未重复挂接 ${childId} 的恢复动作：${prepared.reason}`)
        return
      }
    }
    if (disposing) return
    reservation.observed = true
    if (reservation.kind === 'retry' && !reservation.submitted) {
      // A host-side resume won before the plugin called prompt().
      await actionLedger.markAccepted(reservation.key)
    }
    if (!record.attempt) {
      prepareWriteRetry(childId, record)
      record.wakeActionKey = reservation.key
      if (!retry.has(childId)) retry.track(childId, { parentId: record.parentId, label: record.label })
      armRun(childId, record, { resumed: true })
      await saveAttempt(childId, record)
    } else if (record.runId && runId && record.runId !== runId) {
      // A new native run cannot inherit a still-open, different attempt.
      warn(`子代理 ${childId} 的活动代次不匹配；保留原租约`)
      return
    }
    if (!disposing) {
      if (!retry.has(childId)) retry.track(childId, { parentId: record.parentId, label: record.label })
      await actionLedger.markAccepted(reservation.key)
      const activeRun = runId ?? hostRuns.get(childId)?.runId
      if (activeRun && activeRun !== reservation.identity.runId) await runStarted(childId, record, agent, activeRun)
    }
  }

  // The host may not mount cordis-plugin-timer, so use the platform timer through
  // the existing effect lifecycle. The period is fixed at 5 s because a tick only
  // compares clocks; a child's log is read only once it is due, so this keeps the
  // 10-second minimum interval prompt without a configurable scan. `unref` keeps a
  // short-lived CLI test process from hanging on an interval the host would own.
  const scanMs = 5000
  let scanning = false
  const timer = setInterval(() => {
    if (restoring || disposing || scanning || startupError) return
    scanning = true
    const before = new Map(supervision.supervisor.exportCursors().map((row) => [row.childId, JSON.stringify(row)]))
    const scan = async () => {
      try {
        await supervision.supervisor.tick()
        if (!disposing && hasStorage) {
          for (const cursor of supervision.supervisor.exportCursors()) {
            if (before.get(cursor.childId) !== JSON.stringify(cursor)) {
              const record = writes.get(cursor.childId)
              if (record?.attempt) await persistDelegate(cursor.childId, record)
            }
          }
        }
      } catch (error) {
        warn(`巡检失败：${messageOf(error)}`)
      } finally {
        scanning = false
      }
    }
    return scan()
  }, scanMs)
  timer?.unref?.()
  const stopTimer = () => clearInterval(timer)
  if (legacyEffects) ctx.effect(() => stopTimer, 'orchestrator: supervision timer')

  // Host lifecycle events use the parent as carrier, so both listeners are global.
  listen('subagent/start', queueLifecycle((info) => {
    const childId = info?.id
    if (typeof childId !== 'string' || childId === '') return
    const agent = ctx.agents?.get?.(childId)
    const { parentSessionId: parentId, runId } = info
    if (runId && endedRuns.has(runId)) return
    const record = writes.get(childId)
    if (typeof parentId === 'string' && record !== undefined && parentId !== record.parentId) return
    rememberRecent(hostRuns, childId, { parentId, runId, agent })
    earlyEnds.delete(childId)
    earlyDisposals.delete(childId)
    if (hasStorage) {
      if (batchStages.has(childId)) return
      if (record?.attempt && (!record.runId || !runId || record.runId === runId)) {
        return runStarted(childId, record, agent, runId)
      }
      const row = stateStore.getDelegate(childId)
      if (row && !row.batchId && row.runId !== runId) {
        return resumeFromHost(agent, childId, runId, parentId).catch((error) => warn(messageOf(error)))
      }
      return
    }
    // Keep the legacy Worktree lifecycle fallback for starts outside the tool path.
    if (record?.ended && record.attempt === undefined && runId && keepWorktreeWrite(record)) {
      try {
        prepareWriteRetry(childId, record)
        if (!retry.has(childId)) retry.track(childId, { parentId: record.parentId })
      } catch (error) {
        warn(`无法为子代理 ${childId} 的返工登记租约：${messageOf(error)}`)
      }
    }
    if (record?.attempt !== undefined && (!record.runId || !runId || record.runId === runId)) {
      return runStarted(childId, record, agent, runId)
    }
  }), { global: true })
  const receiveEnd = queueLifecycle(settleChild)
  listen('subagent/end', (info) => {
    if (bufferingLifecycle && info?.id && info.runId) {
      pendingEnds.add(endIdentity(info.id, info.parentSessionId, info.runId))
    }
    return receiveEnd(info)
  }, { global: true })

  /** Registration also covers roots that were already alive when the plugin mounted. */
  const registerRootAgent = (agent) => {
    if (agent === undefined || agent === null || isDelegatedChild(agent)) return
    if (rootAgents.get(agent.id) === agent) return
    const previous = rootAgents.get(agent.id)
    if (previous !== undefined) unregisterRootAgent(previous)
    const gate = installFor(agent)
    gates.set(agent.id, gate)
    rootAgents.set(agent.id, agent)
    sessionToRootAgent.set(agent.session, agent)
    todoTracker.bind(agent)
    sessionTools.restoreMainRoute(agent)
    switchNotices.observe(agent.id)
    if (!dispatchEnabled(agent)) return
    ctx.logger.info(
      `orchestrator: main agent ${agent.id}: armed whitelist gate (${gate.allowed.length} allowed: [${gate.allowed.join(', ')}])`,
    )
    if (gate.guardError !== undefined) {
      ctx.logger.warn(`orchestrator: main agent ${agent.id}: guard not installed: ${gate.guardError}`)
    }
  }

  const unregisterRootAgent = (agent) => {
    if (rootAgents.get(agent.id) !== agent) return
    rootAgents.delete(agent.id)
    supervision.releaseClaimedNotices(agent)
    if (sessionToRootAgent.get(agent.session) === agent) sessionToRootAgent.delete(agent.session)
    supervisionTurnState.clearAgent(agent.id)
    todoTracker.forget(agent.session)
    switchNotices.forget(agent.id)
    const gate = gates.get(agent.id)
    gates.delete(agent.id)
    try {
      gate?.dispose()
    } catch (error) {
      ctx.logger.warn(`orchestrator: main agent ${agent.id}: cannot lift the gate: ${messageOf(error)}`)
    }
  }

  own(() => () => {
    for (const agent of rootAgents.values()) unregisterRootAgent(agent)
    sessionToRootAgent.clear()
  }, 'orchestrator: root agents')

  const receiveResume = queueLifecycle(({ agent, runId }) => {
    if (!hasStorage) return hooks.onResumed(agent)
    return resumeFromHost(agent, agent.id, runId, agent.session?.header?.parentSession)
      .catch((error) => warn(`恢复子代理 ${agent.id} 失败：${messageOf(error)}`))
  })
  listen('agent/created', async (payload) => {
    if (disposing) return
    const agent = payload?.agent
    // A new root agent is the only place a preset or scope-local tool becomes visible,
    // so the catalog may have grown even though the registry itself did not change.
    catalog.schedule()
    if (agent === undefined || agent === null) return
    if (isDelegatedChild(agent)) {
      // Nothing is masked here any more: `installToolSurface` derives a child's deny list
      // from the scope itself, so the first request of a worker already lacks the pair and
      // no `tools/change` is announced. A `send_message` cold resume recreates an
      // interrupted worker, and its receipt was already settled, so supervision has
      // forgotten it; only a child this plugin dispatched is re-armed.
      if (payload?.source === 'resume') return receiveResume({ agent, runId: payload.runId })
      return
    }

    // The persisted model must be installed before the first prepared step.
    if (hasStorage) await sessionTools.ready
    if (disposing) return
    registerRootAgent(agent)
    // A resumed agent with a parentSession that still read as a main agent means the
    // depth test degraded: the cold-resume regression looked exactly like this.
    if (payload?.source === 'resume' && agent.session?.header?.parentSession !== undefined) {
      ctx.logger.warn(
        `orchestrator: agent ${agent.id} resumed with a parentSession but no delegation depth; gated it as a main agent`,
      )
    }
  })

  const registerExistingRoots = () => {
    if (disposing) return
    try {
      for (const agent of ctx.agents?.list?.() ?? []) registerRootAgent(agent)
    } catch (error) {
      warn(`cannot register existing root agents: ${messageOf(error)}`)
    }
  }
  if (hasStorage) background(sessionTools.ready.then(registerExistingRoots))
  else registerExistingRoots()

  // A gated agent that goes away takes its guard with it: the entry is the only owner of
  // the disposer, so dropping it here must not leave a predicate behind.
  listen('agent/disposed', queueLifecycle((payload) => {
    const agent = payload?.agent
    const id = agent?.id
    // A root agent going away can drop its scope-local names from the catalog.
    catalog.schedule()
    if (typeof id !== 'string') return
    const record = writes.get(id)
    // On this host disposal can precede subagent/end or even the activation receipt.
    // Only this residency can release its lease; a stale disposal must not release a retry lease.
    if (record !== undefined && !record.ended && !record.batchId && (record.agent === undefined || record.agent === agent)) {
      disposeWrite(id, record)
    } else if (record === undefined && !earlyEnds.has(id) && isDelegatedChild(agent)) {
      const hostRun = hostRuns.get(id)
      if (hostRun?.agent === agent && !endedRuns.has(hostRun.runId)) {
        rememberRecent(earlyDisposals, id, { ...hostRun, at: Date.now() })
      }
    }
    unregisterRootAgent(agent)
    supervision.scheduleReconcileInbox(id)
    if (isDelegatedChild(agent) && (record === undefined || record.agent === undefined || record.agent === agent)) {
      hooks.forget(id)
    }
  }))

  /**
   * The panel writes `enabled` and `allowedTools` as volatile config: the loader commits
   * those values into the running references and then announces the paths on this fiber.
   * Nothing has to be re-installed — the guard reads the switch per call and the surface
   * wrapper reads the whitelist per request — so this only restores the published catalog,
   * which the Loader resets to the stored default on every settings write.
   *
   * The switch itself is also recorded here, per live main agent, so the next turn can tell
   * the model what changed. Nothing is delivered now: a notice at this moment would splice
   * into a turn the user is still reading.
   */
  let lastGlobalMainRoute = JSON.stringify(sessionTools.currentMainRoute())
  const syncInheritedMainRoutes = () => {
    if (disposing) return
    const route = sessionTools.currentMainRoute()
    const fingerprint = JSON.stringify(route)
    if (fingerprint === lastGlobalMainRoute) return
    lastGlobalMainRoute = fingerprint
    for (const agent of rootAgents.values()) {
      if (!sessionTools.getSessionOverride(rootSessionIdOf(agent)).active) sessionTools.selectMainRoute(agent, route)
    }
  }

  listen('loader/volatile-update', () => {
    // Restore it before the write's own settings read answers, so the panel never falls
    // back to its built-in copy after a checkbox click.
    catalog.publish()
    for (const id of gates.keys()) switchNotices.observe(id)
    refreshSupervision()
    syncInheritedMainRoutes()
  }, { global: true })
  listen('settings/document-updated', syncInheritedMainRoutes, { global: true })

  /**
   * Deliver a recorded switch change at the start of the agent's next real model step.
   *
   * `agent/pre-step` is the host's waterfall right after `inbox.claim` and before the step
   * writes its `user/message` events. Appending there avoids `session/event` append
   * reentrancy, rides inside the user's own turn with zero extra bubbles or turns, and leaves
   * the pending flag untouched if an outer hook rejects or aborts the step.
   */
  listen('agent/inbox/claimed', (...args) => { if (!disposing) supervision.claimNotice(...args) }, { global: true })

  listen('session/event', (session, event) => {
    if (disposing) return
    const agent = sessionToRootAgent.get(session)
    if (agent === undefined || isDelegatedChild(agent)) return
    if (event?.type === 'todo/write') {
      todoTracker.record(agent.session, event.data?.todos, event.data?.source)
    } else if (event?.type === 'assistant/message') {
      const turn = event.data?.turn
      if (supervisionTurnState.isTurnActive(agent.id, turn) && hasNormalDeclarationText(event.data?.message)) {
        supervisionTurnState.markNormalDeclared(agent.id, turn)
      }
    } else if (event?.type === 'turn/end') {
      supervision.releaseClaimedNotices(agent, event.data?.turn)
      supervisionTurnState.clearTurn(agent.id, event.data?.turn)
    }
  }, { global: true })

  const preStep = createSupervisionPreStep({
      ctx,
      config,
      supervisor: supervision.supervisor,
      rebuildNotice: supervision.rebuildNotice,
      liveNoticeIds: supervision.liveNoticeIds,
      retainNotices: supervision.retainNotices,
      supervisionTurnState,
      todoTracker,
    nextStep: createSwitchPreStep({ switchNotices, logger: ctx.logger, supervisionTurnState }),
  })
  const loadPeerMessage = createUserMessageLoader({
    logger: ctx.logger,
    scope: 'peer read-only consult',
    disabledReason: 'peer context injection is disabled',
  })
  listen('agent/pre-step', async (payload, next) => {
    if (hasStorage) await sessionTools.ready
    if (restoring) await readyPromise
    if (disposing) return next()
    const agent = payload?.agent
    const incoming = payload?.messages
    const child = isDelegatedChild(agent)
    const filterRootMessages = (messages) => child || !Array.isArray(messages)
      ? messages : readIndex.prepare(agent, messages).messages
    const scoped = filterRootMessages(incoming)
    // Filter claimed and downstream messages before supervision classifies the batch.
    const enter = async () => {
      const result = await next()
      const messages = filterRootMessages(result?.messages)
      return messages === result?.messages ? result : { ...result, messages }
    }
    let decision = await preStep(scoped === incoming ? payload : { ...payload, messages: scoped }, enter)
    if (scoped !== incoming && decision?.kind === 'enter' && decision.messages?.every(isRuntimeContext)) {
      return { kind: 'reject' }
    }
    if (child && decision?.kind === 'enter' && !payload?.signal?.aborted && Array.isArray(decision.messages)) {
      const consultation = readIndex.prepare(agent, decision.messages)
      if (consultation.text) {
        const createMessage = await loadPeerMessage()
        if (createMessage && !disposing && !payload?.signal?.aborted &&
            sessionTools.resolveSessionConfig(agent).peerReadOnlyConsultEnabled) {
          try {
            const note = createMessage({
              content: [{ type: 'text', text: consultation.text }],
              source: { kind: PEER_CONSULT_SOURCE_KIND, form: 'notice', summary: '平级只读咨询' },
            })
            decision = { ...decision, messages: [...decision.messages, note] }
            consultation.acknowledge?.()
          } catch (error) {
            warn(`无法注入平级只读咨询：${messageOf(error)}`)
          }
        }
      }
    }
    return decision
  }, { global: true })

  // Register the lifecycle edges above before opening storage; events captured during I/O
  // are replayed before tools are let through the readiness gate.
  const startRecovery = async () => {
    await domainReservation.previous
    if (disposing) return
    await stateStore.open()
    await sessionTools.ready
    if (disposing) return
    if (stateStore.hasUnsafeState()) startupError ??= new Error('存储域无法完整读取；原始数据已保留')
    const snapshot = stateStore.getSnapshot()
    await reconcileOnStartup({
      snapshot, store: stateStore, worktrees, leases: writeLeases, retry, actionLedger,
      supervise: supervision.supervisor, agents: ctx.agents, sessions: ctx.sessions,
      sessionQuery: optionalSessionQuery(), signal: startupAbort.signal, logger: ctx.logger,
      readOnly: Boolean(startupError),
      onProtectionUnverified() { startupError ??= new Error('部分工作树或写租约没有通过水合校验') },
      hasPendingEnd(row) {
        return Boolean(row.runId && pendingEnds.has(endIdentity(row.childId, row.parentId, row.runId)))
      },
      onReattachRunning(row) {
        const refusal = worktreeResumeRefusal(row.childId)
        if (refusal) { warn(refusal); return }
        const record = hydrateWrite(row, { active: true, agent: ctx.agents?.get?.(row.childId) })
        armRun(row.childId, record, { startedAt: row.startedAt })
      },
      async onDelegateReconciled(row) {
        const tree = row.worktreeId && worktrees.get(row.worktreeId)
        if (tree?.state !== 'active' || stateStore.listDelegates().some((other) =>
          other.worktreeId === tree.id && other.childId !== row.childId &&
          (other.dispatchState === 'running' || (other.wakeActionKey && actionLedger.get(other.wakeActionKey)?.phase !== 'done')))) return
        const review = worktrees.markReadyForReview(tree.id)
        await putTree(tree.id)
        for (const childId of tree.childIds) timeline.recordWorktreeState(childId, {
          id: tree.id, parentId: tree.parentId, state: review?.state,
        })
      },
    })
    bufferingLifecycle = false
    for (const dispatch of lifecycleQueue.splice(0)) {
      if (disposing) return
      await dispatch()
    }
    pendingEnds.clear()
    if (!disposing && !startupError) await stateStore.pruneHistory()
  }
  readyPromise = hasStorage ? startRecovery().catch((error) => {
    if (!disposing) startupError ??= error
  }).finally(() => {
    restoring = false
    bufferingLifecycle = false
    lifecycleQueue.length = 0
    pendingEnds.clear()
    if (startupError && !disposing) warn(`恢复保护状态失败：${messageOf(startupError)}`)
  }) : stateStore.open()

  ctx.effect(() => () => {
    if (disposePromise) return disposePromise
    disposing = true
    if (!legacyEffects) stopTimer()
    startupAbort.abort()
    const closing = Promise.all([
      stateStore.close().catch((error) => warn(`关闭存储域失败：${messageOf(error)}`)),
      sessionToolsRemote.dispose().catch((error) => warn(`卸载会话 Remote 失败：${messageOf(error)}`)),
      sessionTools.close().catch((error) => warn(`关闭会话存储域失败：${messageOf(error)}`)),
    ])
    disposePromise = closing.finally(() => {
      try {
        clean(listenerDisposers)
        for (const cursor of supervision.supervisor.exportCursors()) supervision.supervisor.forget(cursor.childId)
        writeLeases.clear()
        worktrees.clear()
        writes.clear()
        batchStages.clear()
        wakeups.clear()
      } finally {
        domainReservation?.release()
      }
    })
    // Unpublish dispatch producers before a younger fiber registers the same tool names.
    // Already queued storage writes and the actual domain close still share one ordered chain.
    clean(producerDisposers)
    return disposePromise
  }, 'orchestrator: lifecycle')
}
