import { randomUUID } from 'node:crypto'

const isId = (value) => typeof value === 'string' && value.length > 0
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const rowsOf = (value) => Array.isArray(value) ? value : []
const copy = (value) => value == null ? value : structuredClone(value)
const rootOf = ({ rootSessionId, parentId }) => rootSessionId || parentId || 'unknown'
const runOf = (runId, attemptSeq) => runId || `attempt-${attemptSeq ?? 0}`

export function makeSettleActionKey({ childId, runId, attemptSeq, ...owner } = {}) {
  return `settle:${rootOf(owner)}:${childId}:${runOf(runId, attemptSeq)}`
}

export function makeResumeActionKey({ childId, interruptedRunId, attemptSeq, ...owner } = {}) {
  return `resume:${rootOf(owner)}:${childId}:${runOf(interruptedRunId, attemptSeq)}`
}

export function makeRetryActionKey({ childId, failedRunId, attemptSeq, retryOrdinal, ...owner } = {}) {
  return `retry:${rootOf(owner)}:${childId}:${runOf(failedRunId, attemptSeq)}:${retryOrdinal ?? 1}`
}

export function makeParentNoticeActionKey({ parentId, childId, kind, seqOrId } = {}) {
  return `notice:${parentId || 'unknown'}:${childId || 'unknown'}:${kind || 'generic'}:${seqOrId ?? 0}`
}

const PHASE_REFUSALS = {
  prepared: 'in-flight', accepted: 'already-accepted', unknown: 'delivery-unknown', done: 'already-done',
}

const ACTION_KEY_BUILDERS = new Map([
  ['settle', makeSettleActionKey], ['resume', makeResumeActionKey], ['retry', makeRetryActionKey],
])

// Strip only the final ordinal; a run identity can itself contain colons.
function resumeKeyForRetry(key) {
  const ordinalAt = key.lastIndexOf(':')
  return `resume:${key.slice('retry:'.length, ordinalAt)}`
}

/** Reserve before yielding, then persist before the caller may perform the side effect. */
export function createActionLedger({ store, initialActions = [], now = Date.now } = {}) {
  const records = new Map()
  const writes = new Map()

  function hydrate(actions) {
    for (const record of rowsOf(actions)) {
      if (isId(record?.key) && !records.has(record.key)) records.set(record.key, copy(record))
    }
  }

  function canInitiate(key, { allowRetryUnknown = false } = {}) {
    const record = records.get(key)
    if (!record) return { allowed: true, reason: 'new', record: null }
    if (record.phase === 'unknown' && allowRetryUnknown === true) {
      return { allowed: true, reason: 'unknown-retry-allowed', record: copy(record) }
    }
    const reason = Object.hasOwn(PHASE_REFUSALS, record.phase)
      ? PHASE_REFUSALS[record.phase] : 'delivery-unknown'
    return { allowed: false, reason, record: copy(record) }
  }

  function findWakeupConflict(key) {
    if (key.startsWith('retry:')) {
      const decision = canInitiate(resumeKeyForRetry(key))
      return decision.allowed ? null : decision
    }
    if (key.startsWith('resume:')) {
      for (const candidate of records.keys()) {
        if (candidate.startsWith('retry:') && resumeKeyForRetry(candidate) === key) {
          return canInitiate(candidate)
        }
      }
    }
    return null
  }

  function persist(record) {
    if (typeof store?.putAction !== 'function') return Promise.resolve()
    const write = (writes.get(record.key) ?? Promise.resolve()).then(async () => {
      // A closed or stale store may explicitly reject a write without throwing.
      if (await store.putAction(copy(record)) === false) {
        throw new Error('action record was not persisted')
      }
    })
    const tail = write.catch(() => {})
    writes.set(record.key, tail)
    void tail.then(() => {
      if (writes.get(record.key) === tail) writes.delete(record.key)
    })
    return write
  }

  async function prepare(key, meta = {}) {
    if (!isId(key)) throw new TypeError('action key must be a non-empty string')
    const decision = canInitiate(key, meta)
    const refusal = decision.allowed ? findWakeupConflict(key) : decision
    if (refusal) return { ok: false, reason: refusal.reason, record: refusal.record }

    const at = now()
    const previous = decision.record
    const record = {
      key,
      kind: previous?.kind ?? meta.kind ?? key.split(':', 1)[0],
      phase: 'prepared',
      rootSessionId: previous?.rootSessionId ?? meta.rootSessionId,
      parentId: previous?.parentId ?? meta.parentId,
      childId: previous?.childId ?? meta.childId,
      runId: previous?.runId ?? meta.runId ?? meta.interruptedRunId ?? meta.failedRunId,
      attemptSeq: previous?.attemptSeq ?? meta.attemptSeq,
      requestId: previous?.requestId || meta.requestId || `req-${randomUUID()}`,
      messageId: previous?.messageId ?? meta.messageId,
      detail: copy(meta.detail ?? previous?.detail),
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    }
    records.set(key, record)
    // On an ambiguous storage failure, retain the reservation instead of reopening the gate.
    await persist(record)
    return { ok: true, record: copy(record) }
  }

  async function advance(key, phase, patch) {
    const previous = records.get(key)
    if (!previous) return null
    if ((previous.phase === 'done' && phase !== 'done') ||
        (previous.phase === 'accepted' && phase === 'unknown')) return copy(previous)

    const { messageId = previous.messageId, detail = previous.detail } = patch
    const record = { ...previous, phase, messageId, detail: copy(detail), updatedAt: now() }
    records.set(key, record)
    await persist(record)
    return copy(record)
  }

  hydrate(initialActions)
  return {
    hydrate,
    get: (key) => copy(records.get(key)) ?? null,
    list: () => [...records.values()].map(copy),
    canInitiate,
    findWakeupConflict,
    prepare,
    async cancelPrepared(key) {
      const record = records.get(key)
      if (record?.phase !== 'prepared') return
      await store?.deleteAction?.(key)
      if (records.get(key) === record) records.delete(key)
    },
    markAccepted: (key, patch = {}) => advance(key, 'accepted', patch),
    markUnknown: (key, patch = {}) => advance(key, 'unknown', patch),
    markDone: (key, patch = {}) => advance(key, 'done', patch),
    hasProcessedRun(kind, params = {}) {
      const build = ACTION_KEY_BUILDERS.get(kind)
      if (!build) return false
      const { runId, interruptedRunId = runId, failedRunId = runId } = params
      return records.has(build({ ...params, interruptedRunId, failedRunId }))
    },
  }
}

const NOT_FOUND_CODES = new Set(['SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_NOT_FOUND'])

async function readOnlySession(sessionQuery, sessionId, signal, consume) {
  let observation
  try {
    signal?.throwIfAborted?.()
    if (typeof sessionQuery?.observeSession === 'function') {
      observation = await sessionQuery.observeSession(sessionId, { signal })
    } else if (typeof sessionQuery?.readSession === 'function') {
      observation = await sessionQuery.readSession(sessionId)
    } else {
      throw new Error('sessionQuery unavailable')
    }
    signal?.throwIfAborted?.()
    if (observation == null || typeof observation !== 'object') {
      throw new Error('sessionQuery returned no observation')
    }
    return consume(observation)
  } finally {
    observation?.[Symbol.dispose]?.()
  }
}

function sessionEvidence(observation) {
  return {
    header: observation.header ?? observation.session ?? null,
    inheritedEventCount: isCount(observation.inheritedEventCount) ? observation.inheritedEventCount : 0,
    events: rowsOf(observation.events),
  }
}

function extractHeadSeq(agent, sessions, childId) {
  const explicit = agent?.headSeq
  if (isCount(explicit)) return explicit
  try {
    const log = agent?.session?.log ?? sessions?.get?.(childId)?.log
    if (Array.isArray(log)) {
      const seq = log.at(-1)?.seq
      return isCount(seq) ? seq : log.length
    }
  } catch {
    // The head is advisory; a log read failure cannot change online presence.
  }
  return null
}

function unknownChild(childId, error) {
  return {
    childId, presence: 'unknown', alive: null, running: null, ownershipMismatch: false,
    lastTurnEndKind: null, headSeq: null, error: String(error?.message || 'sessionQuery unavailable'),
    evidenceSource: 'unknown',
  }
}

/** Read only. In particular, neither session access path activates a cold session. */
export async function inspectHostChildState({
  childId, expectedParentId, expectedRootSessionId, agents, sessions, sessionQuery, signal,
} = {}) {
  if (!isId(childId)) return unknownChild(childId, new Error('invalid childId'))
  let agent
  try {
    agent = await agents?.get?.(childId)
  } catch (error) {
    // Failed registry reads do not establish that a child is offline.
    return unknownChild(childId, error)
  }
  const ownershipConflicts = (header) => Boolean(
    (expectedParentId && header?.parentSession && header.parentSession !== expectedParentId) ||
    (expectedRootSessionId && isId(header?.rootSessionId ?? header?.rootSession) &&
      (header.rootSessionId ?? header.rootSession) !== expectedRootSessionId),
  )
  const onlineOwnershipMismatch = ownershipConflicts(agent?.session?.header)
  const onlineIdle = agent != null && agent.status !== 'running'
  if (agent?.status === 'running') {
    return {
      childId, presence: 'live-running', alive: true, running: true, ownershipMismatch: onlineOwnershipMismatch,
      lastTurnEndKind: null, headSeq: extractHeadSeq(agent, sessions, childId), evidenceSource: 'agents',
    }
  }
  try {
    return await readOnlySession(sessionQuery, childId, signal, (observation) => {
      const { header, inheritedEventCount, events } = sessionEvidence(observation)
      const ownershipMismatch = onlineOwnershipMismatch || ownershipConflicts(header)
      const lastEnd = events.slice(inheritedEventCount).findLast((event) =>
        event?.type === 'turn/end' || event?.kind === 'turn/end')
      return {
        childId, presence: onlineIdle ? 'live-idle' : 'persisted-inactive', alive: onlineIdle,
        running: false, ownershipMismatch, lastTurnEndKind: lastEnd?.data?.reason?.kind ?? lastEnd?.reason?.kind ?? null,
        headSeq: events.length, inheritedEventCount, header,
        evidenceSource: onlineIdle ? 'agents+sessionQuery' : 'sessionQuery',
      }
    })
  } catch (error) {
    if (onlineIdle) {
      return {
        childId, presence: 'live-idle', alive: true, running: false, ownershipMismatch: onlineOwnershipMismatch,
        lastTurnEndKind: null, headSeq: extractHeadSeq(agent, sessions, childId), evidenceSource: 'agents',
      }
    }
    if (NOT_FOUND_CODES.has(error?.code)) {
      return {
        childId, presence: 'not-found', alive: false, running: false, ownershipMismatch: false,
        lastTurnEndKind: null, headSeq: 0, evidenceSource: 'sessionQuery',
      }
    }
    return unknownChild(childId, error)
  }
}

function noNotice(checked) {
  return { checked, delivered: false, via: null, messageId: null, stopReason: null, seq: null }
}

/** A marker describes native delivery, not the identity or completion of a particular run. */
export async function inspectParentSettlementNotice({
  parentId, childId, afterSeq = 0, sessionQuery, signal,
} = {}) {
  if (!isId(parentId) || !isId(childId)) return noNotice(false)
  const isMatch = (source) => source?.kind === 'subagent-settled' && source.senderSessionId === childId
  try {
    return await readOnlySession(sessionQuery, parentId, signal, (observation) => {
      const { inheritedEventCount, events } = sessionEvidence(observation)
      const start = Math.max(inheritedEventCount, isCount(afterSeq) ? afterSeq : 0)
      for (let index = events.length - 1; index >= start; index -= 1) {
        const event = events[index]
        const data = event?.data
        const type = event?.type ?? event?.kind
        let message
        let source
        let via
        if (type === 'agent/inbox/spliced') {
          message = rowsOf(data?.inserted).findLast((row) => isMatch(row?.source))
          source = message?.source
          via = 'inbox'
        } else if (type === 'user/message') {
          message = data?.message ?? data
          source = isMatch(data?.source) ? data.source : message?.source
          via = 'user-message'
        }
        if (isMatch(source)) {
          const messageId = message?.id ?? message?.messageId ?? data?.messageId
          const stopReason = source.stopReason ?? message?.stopReason ?? data?.stopReason
          return {
            checked: true, delivered: true, via,
            messageId: isId(messageId) ? messageId : null,
            stopReason: isId(stopReason) ? stopReason : null,
            seq: isCount(event.seq) ? event.seq : index + 1,
          }
        }
      }
      return noNotice(true)
    })
  } catch {
    return noNotice(false)
  }
}

export function evaluateWakeupGate({
  actionLedger, worktrees, hostState, kind, rootSessionId, parentId, childId, runId, attemptSeq, retryOrdinal,
} = {}) {
  const deny = (reason) => ({ allowed: false, reason })
  const lock = worktrees?.isChildLocked?.(childId)
  if (Boolean(lock && (lock === true || lock.locked))) return deny('worktree-child-locked')
  if (hostState?.running === true) return deny('already-running')
  if (!hostState || hostState.presence === 'unknown' || hostState.ownershipMismatch === true) {
    return deny('host-state-unverified')
  }
  if (hostState.presence === 'not-found') return deny('child-not-found')
  if (kind !== 'resume' && kind !== 'retry') return deny('invalid-kind')

  const identity = { rootSessionId, parentId, childId, attemptSeq }
  const resumeKey = makeResumeActionKey({ ...identity, interruptedRunId: runId })
  const resume = actionLedger?.canInitiate?.(resumeKey)
  if (resume?.allowed === false) return deny(resume.reason)

  const retryKey = kind === 'retry' ? makeRetryActionKey({ ...identity, failedRunId: runId, retryOrdinal }) : null
  if (retryKey) {
    const retry = actionLedger?.canInitiate?.(retryKey)
    if (retry?.allowed === false) return deny(retry.reason)
  }
  const conflict = actionLedger?.findWakeupConflict?.(resumeKey)
  if (conflict) return deny(conflict.reason)
  return { allowed: true, reason: 'ok', actionKey: retryKey ?? resumeKey, resumeKey, retryKey }
}

const TERMINAL_STATES = new Set(['ended', 'completed', 'aborted', 'interrupted', 'failed', 'lost'])
const FAILURE_REASONS = new Set(['error', 'blocked', 'max-tokens'])

function buildRetrySnapshotFromDelegates(delegates, actions) {
  const records = []
  const seenRuns = new Map()
  function rememberRun(runId, childId) {
    if (isId(runId) && !seenRuns.get(runId)) seenRuns.set(runId, isId(childId) ? childId : null)
  }
  for (const delegate of delegates) {
    const retry = delegate?.retry
    if (!retry || !isId(delegate.childId)) continue
    for (const record of Array.isArray(retry.records) ? retry.records : [retry]) {
      if (!record || (record.childId && record.childId !== delegate.childId)) continue
      const parentId = record.parentId ?? delegate.parentId
      if (isId(parentId)) {
        records.push({ ...record, childId: delegate.childId, parentId, label: record.label ?? delegate.label })
      }
    }
    for (const run of rowsOf(retry.seenRuns)) {
      if (run?.childId && run.childId !== delegate.childId) continue
      rememberRun(run?.runId ?? run, delegate.childId)
    }
  }
  for (const action of actions) {
    if (action?.kind === 'settle' && action.phase === 'done') rememberRun(action.runId, action.childId)
  }
  return {
    records,
    seenRuns: [...seenRuns].map(([runId, childId]) => childId ? { runId, childId } : runId),
  }
}

function terminalState(reason) {
  if (reason === 'completed' || reason === 'aborted') return { dispatchState: reason, stopReason: reason }
  if (FAILURE_REASONS.has(reason)) return { dispatchState: 'failed', stopReason: reason }
  return { dispatchState: 'interrupted', stopReason: 'interrupted' }
}

async function deleteLeases(store, ids) {
  if (ids.length === 0) return
  if (typeof store?.deleteLeases === 'function') await store.deleteLeases(ids)
  else for (const id of ids) await store?.deleteLease?.(id)
}

function isDelegateLease(lease) {
  return lease?.ownerKind === 'delegate' || lease?.ownerKind === 'child'
}

function leaseOwner(lease) {
  if (lease?.ownerKind != null) return isDelegateLease(lease) ? lease.ownerId ?? lease.childId : null
  return lease?.childId
}

async function updateTimeline(timeline, record) {
  if (typeof timeline?.upsert === 'function') await timeline.upsert(record)
  else if (typeof timeline?.update === 'function') await timeline.update(record)
  else await timeline?.hydrateEntries?.([record])
}

/** Restore protections first; reconciliation only reads the host and never wakes a child. */
export async function reconcileOnStartup({
  snapshot, store, worktrees, leases, timeline, retry, supervise, actionLedger,
  agents, sessions, sessionQuery, now = Date.now, signal, logger,
  onReattachRunning, onDelegateReconciled, onDelegateUpdated, hasPendingEnd, onProtectionUnverified,
  readOnly = false, decorateTimeline = (record) => record,
} = {}) {
  const at = now()
  const delegates = rowsOf(snapshot?.delegates)
  const leaseRows = rowsOf(snapshot?.leases)
  const actions = rowsOf(snapshot?.actions)
  const ledger = actionLedger ?? createActionLedger({ store, now })

  const worktreeRows = rowsOf(snapshot?.worktrees)
  const hydratedTrees = await worktrees?.hydrateRecords?.(worktreeRows)
  const hydrated = await leases?.hydrateLeases?.(leaseRows, { now: at })
  if (hydratedTrees?.skipped > 0 || hydrated?.skippedInvalid > 0) {
    readOnly = true
    onProtectionUnverified?.()
  }
  const expiredIds = Array.isArray(hydrated?.expiredLeaseIds)
    ? hydrated.expiredLeaseIds
    : leaseRows.filter((row) => Number.isFinite(row?.expiresAt) && row.expiresAt <= at).map((row) => row.leaseId)
  const expired = new Set(expiredIds.filter(isId))
  if (!readOnly) await deleteLeases(store, [...expired])
  await timeline?.hydrateEntries?.(delegates.map(decorateTimeline))
  await ledger.hydrate?.(actions)
  await retry?.hydrateState?.(buildRetrySnapshotFromDelegates(delegates, actions), { now: at })

  const summary = {
    reattachedRunning: 0, settledDuringOffline: 0, interruptedChildren: 0, lostChildren: 0,
    unknownChildren: 0, keptLeases: 0, releasedLeases: 0, expiredLeases: expired.size,
  }
  const leaseById = new Map(leaseRows.filter((row) => isId(row?.leaseId)).map((row) => [row.leaseId, row]))
  const leasesByChild = new Map()
  for (const lease of leaseById.values()) {
    const owner = leaseOwner(lease)
    if (expired.has(lease.leaseId) || !isId(owner)) continue
    const owned = leasesByChild.get(owner) ?? []
    owned.push(lease.leaseId)
    leasesByChild.set(owner, owned)
  }
  const knownLeaseIds = new Set([...leaseById.keys(), ...rowsOf(await leases?.list?.()).map((row) => row?.leaseId)])
  const accounted = new Set(expired)
  const batchMatches = (lease, record) => isId(record.batchId) && lease?.ownerKind === 'batch' &&
    (lease.ownerId === record.batchId || lease.ownerId === `${record.batchId}:item:${record.itemIndex}`) &&
    lease.parentId === record.parentId
  const pendingBatchStages = new Map()
  for (const record of delegates) {
    if (batchMatches(leaseById.get(record.leaseId), record)) {
      const stages = pendingBatchStages.get(record.leaseId) ?? new Set()
      stages.add(record.childId)
      pendingBatchStages.set(record.leaseId, stages)
    }
  }
  const inspect = (childId, expectedParentId, expectedRootSessionId) => inspectHostChildState({
    childId, expectedParentId, expectedRootSessionId, agents, sessions, sessionQuery, signal,
  })

  function keep(id) {
    if (!isId(id) || accounted.has(id)) return
    accounted.add(id)
    summary.keptLeases += 1
  }

  async function release(id) {
    if (!isId(id) || accounted.has(id)) return
    if (typeof store?.deleteLease === 'function') await store.deleteLease(id)
    else await deleteLeases(store, [id])
    await leases?.release?.(id)
    accounted.add(id)
    summary.releasedLeases += 1
  }

  for (const record of delegates) {
    signal?.throwIfAborted?.()
    if (!isId(record?.childId)) continue
    const { childId, parentId, rootSessionId, runId, leaseId } = record
    const childLeases = new Set(leasesByChild.get(childId))
    if (isId(leaseId) && !expired.has(leaseId) && (knownLeaseIds.has(leaseId) || await leases?.get?.(leaseId))) {
      childLeases.add(leaseId)
    }
    if (TERMINAL_STATES.has(record.dispatchState) && record.auditState !== 'pending' && childLeases.size === 0) continue

    const host = await inspect(childId, parentId, rootSessionId)
    signal?.throwIfAborted?.()
    const leaseMismatch = [...childLeases].some((id) => {
      const stored = leaseById.get(id)
      const owner = leaseOwner(stored)
      if (batchMatches(stored, record)) return false
      return (stored?.ownerKind != null && !isDelegateLease(stored)) ||
        (isId(owner) && owner !== childId) ||
        (isId(parentId) && isId(stored?.parentId) && stored.parentId !== parentId)
    })
    const pendingEnd = () => hasPendingEnd?.(record) === true
    if ((host.presence === 'unknown' && !pendingEnd()) || host.ownershipMismatch || leaseMismatch) {
      for (const id of childLeases) keep(id)
      summary.unknownChildren += 1
      try {
        logger?.warn?.(`orchestrator: startup reconciliation could not verify child ${childId}; retaining protections`)
      } catch {
        // A logger must not change the decision.
      }
      continue
    }
    if (host.presence === 'live-running' || pendingEnd()) {
      for (const id of childLeases) keep(id)
      if (record.watchCursor != null) {
        await supervise?.hydrateCursor?.(childId, record.watchCursor, {
          currentRunId: runId, currentHeadSeq: host.headSeq, now: at,
        })
      }
      await onReattachRunning?.(record, host)
      summary.reattachedRunning += 1
      continue
    }

    if (readOnly) continue
    if (record.wakeActionKey && ledger.get?.(record.wakeActionKey)?.phase !== 'done') {
      // Offline state can describe the prior run, not a possibly dispatched new activation.
      for (const id of childLeases) keep(id)
      summary.unknownChildren += 1
      continue
    }
    const lost = host.presence === 'not-found'
    const terminal = lost ? { dispatchState: 'lost', stopReason: 'lost' } : terminalState(host.lastTurnEndKind)
    const outcome = lost ? 'lost' : terminal.dispatchState === 'interrupted' ? 'interrupted' : 'settled-offline'
    const updated = { ...record, ...terminal, endedAt: record.endedAt ?? at, updatedAt: at }
    if (record.auditState === 'pending') updated.auditState = 'incomplete'
    if (lost || record.auditState === 'pending') updated.incomplete = true
    const batchStages = pendingBatchStages.get(leaseId)
    if (!batchStages && (isId(leaseId) || childLeases.size > 0 || lost)) updated.leaseState = 'released'
    if (!lost && sessionQuery && isId(parentId)) {
      const notice = await inspectParentSettlementNotice({
        parentId, childId, afterSeq: record.parentNoticeAfterSeq ?? record.parentHeadSeq, sessionQuery, signal,
      })
      if (notice.delivered) updated.nativeNoticeDetected = true
    }
    signal?.throwIfAborted?.()
    if (pendingEnd()) {
      for (const id of childLeases) keep(id)
      await onReattachRunning?.(record, host)
      summary.reattachedRunning += 1
      continue
    }
    if (await store?.putDelegate?.(updated) === false) throw new Error('delegate record was not persisted')
    batchStages?.delete(childId)
    for (const id of childLeases) if (!pendingBatchStages.has(id)) await release(id)
    await updateTimeline(timeline, decorateTimeline(updated))
    await onDelegateReconciled?.(updated, host, outcome)
    await onDelegateUpdated?.(updated, host, outcome)
    if (lost) summary.lostChildren += 1
    else if (outcome === 'interrupted') summary.interruptedChildren += 1
    else summary.settledDuringOffline += 1
  }

  if (readOnly) return { actionLedger: ledger, summary }
  for (const [id, lease] of leaseById) {
    signal?.throwIfAborted?.()
    if (accounted.has(id)) continue
    const stages = pendingBatchStages.get(id)
    if (stages) {
      if (stages.size > 0) keep(id)
      else {
        await release(id)
        for (const record of delegates.filter((row) => row.leaseId === id)) {
          const updated = store?.getDelegate?.(record.childId) ?? record
          await updateTimeline(timeline, decorateTimeline({ ...updated, leaseState: 'released' }))
        }
      }
      continue
    }
    const childId = leaseOwner(lease)
    if (!isId(childId)) {
      keep(id)
      continue
    }
    const host = await inspect(childId, lease.parentId, lease.rootSessionId)
    signal?.throwIfAborted?.()
    if ((host.presence === 'not-found' || host.presence === 'live-idle' || host.presence === 'persisted-inactive') &&
        host.running === false && !host.ownershipMismatch) await release(id)
    else keep(id)
  }
  return { actionLedger: ledger, summary }
}
