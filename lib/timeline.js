const WORKTREE_STATES = new Set([
  'active', 'ready_for_review', 'merged', 'discarded', 'merge_conflict', 'cleanup_failed',
])
const TERMINAL_DISPATCH_STATES = new Set(['ended', 'completed', 'interrupted', 'aborted', 'failed', 'lost'])
const OPEN_WORKTREE_STATES = new Set(['active', 'ready_for_review', 'merge_conflict', 'cleanup_failed'])
const isId = (value) => typeof value === 'string' && value.length > 0
const idOrNull = (value) => isId(value) ? value : null
const textOrNull = (value) => typeof value === 'string' ? value : null
const snapshot = (entry) => structuredClone(entry)


const isCompleted = (entry) => entry.dispatchState === 'ended'
const isEvictable = (entry) => isCompleted(entry) && !entry.pendingNextTurn && !OPEN_WORKTREE_STATES.has(entry.worktree?.state)
const queryPriority = (entry) => isCompleted(entry) ? 1 : 0
const newestFirst = (left, right) => right.updatedAt - left.updatedAt

function initialWorktree(worktree) {
  if (worktree == null || typeof worktree !== 'object') return null
  const { id, path, execCwd, branch, baseCommit } = worktree
  return {
    id: idOrNull(id), path: textOrNull(path ?? worktree.worktreePath), execCwd: textOrNull(execCwd),
    branch: textOrNull(branch), baseCommit: idOrNull(baseCommit),
    state: 'active', mergeCommit: null, conflictFiles: [], locked: false,
  }
}

function normalizeWorktreeState(state) {
  if (state === 'ready') return 'ready_for_review'
  const normalized = typeof state === 'string' ? state.replaceAll('-', '_') : null
  return WORKTREE_STATES.has(normalized) ? normalized : null
}

function persistedWorktree(row) {
  const tree = row.worktree
  if (tree == null && !isId(row.worktreeId) && !isId(row.worktreeState)) return null
  const restored = initialWorktree({ ...tree, id: tree?.id ?? row.worktreeId })
  restored.state = normalizeWorktreeState(tree?.state ?? row.worktreeState) ?? restored.state
  restored.commits = countOr(tree?.commits, 0)
  restored.dirty = tree?.dirty === true
  restored.mergeCommit = idOrNull(tree?.mergeCommit)
  restored.conflictFiles = textList(tree?.conflictFiles)
  restored.locked = tree?.locked === true
  return restored
}

const countOr = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback
const timeOrNull = (value) => Number.isFinite(value) ? value : null
const textList = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []

function initialAttempt({ readOnly, leaseId, startedAt }) {
  return {
    readOnly: readOnly === true,
    runId: null,
    dispatchState: 'running',
    leaseState: readOnly !== true && isId(leaseId) ? 'held' : 'none',
    leaseId: idOrNull(leaseId),
    startedAt,
    endedAt: null,
    disposedAt: null,
    releasedAt: null,
    updatedAt: startedAt,
    stopReason: null,
  }
}

/** Bounded, in-memory acceptance evidence. It does not own a lease or enforce isolation. */
export function createDispatchTimeline({
  maxPerParent = 64,
  maxParents = 64,
  now = () => Date.now(),
} = {}) {
  for (const [name, value, minimum] of [
    ['maxPerParent', maxPerParent, 1],
    ['maxParents', maxParents, 1],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`${name} 必须是大于或等于 ${minimum} 的安全整数。`)
    }
  }
  const parents = new Map()
  const timestamp = (at) => Number.isFinite(at) ? at : now()

  function lookup({ parentId, childId }) {
    if (parentId !== undefined) return parents.get(parentId)?.get(childId)
    // Some host callbacks have only a child id. Do not guess if it is ambiguous.
    let match
    for (const records of parents.values()) {
      const candidate = records.get(childId)
      if (candidate === undefined) continue
      if (match !== undefined) return undefined
      match = candidate
    }
    return match
  }

  function touch(entry, at) {
    entry.updatedAt = Math.max(entry.updatedAt, at)
    const records = parents.get(entry.parentId)
    records.delete(entry.childId)
    records.set(entry.childId, entry)
    parents.delete(entry.parentId)
    parents.set(entry.parentId, records)
    return true
  }

  function evictOldest(records) {
    let oldest
    let oldestEvictable
    for (const entry of records.values()) {
      if (!oldest || entry.updatedAt < oldest.updatedAt) oldest = entry
      if (isEvictable(entry) && (!oldestEvictable || entry.updatedAt < oldestEvictable.updatedAt)) {
        oldestEvictable = entry
      }
    }
    records.delete((oldestEvictable ?? oldest).childId)
  }

  function evictParent() {
    let oldestOrdinary
    let oldestAt = Infinity
    for (const [parentId, records] of parents) {
      let latest = -Infinity
      let ordinary = true
      for (const entry of records.values()) {
        if (!isEvictable(entry)) { ordinary = false; break }
        latest = Math.max(latest, entry.updatedAt)
      }
      if (ordinary && latest < oldestAt) {
        oldestOrdinary = parentId
        oldestAt = latest
      }
    }
    // Preserve the old LRU fallback if there are only protected parents.
    parents.delete(oldestOrdinary ?? parents.keys().next().value)
  }

  function exportEntries() {
    return JSON.parse(JSON.stringify([...parents.values()].flatMap((rows) => [...rows.values()])))
  }

  function hydrateEntries(rows, { replace = false } = {}) {
    const result = { restored: 0, skipped: 0 }
    if (!Array.isArray(rows)) return result
    if (replace) parents.clear()
    for (const row of rows) {
      if (!isId(row?.parentId) || !isId(row?.childId)) {
        result.skipped += 1
        continue
      }
      const { parentId, childId } = row
      const startedAt = timestamp(row.startedAt ?? row.updatedAt ?? row.endedAt)
      const updatedAt = timeOrNull(row.updatedAt) ?? Math.max(startedAt, timeOrNull(row.endedAt) ?? startedAt)
      const previous = lookup({ parentId, childId })
      if (previous && previous.updatedAt > updatedAt) {
        result.skipped += 1
        continue
      }
      const worktree = persistedWorktree(row)
      const entry = { childId, parentId, worktree, ...initialAttempt({ ...row, startedAt }) }
      const dispatchState = row.dispatchState
      entry.dispatchState = TERMINAL_DISPATCH_STATES.has(dispatchState) ? 'ended'
        : idOrNull(dispatchState) ?? (Number.isFinite(row.endedAt) ? 'ended' : entry.dispatchState)
      entry.attemptSeq = countOr(row.attemptSeq, 1)
      for (const key of ['runId', 'leaseState']) {
        if (isId(row[key])) entry[key] = row[key]
      }
      for (const key of ['label', 'cwd', 'stopReason']) entry[key] = textOrNull(row[key])
      for (const key of ['endedAt', 'disposedAt', 'releasedAt']) entry[key] = timeOrNull(row[key])
      entry.writeScope = textList(row.writeScope)
      entry.pendingNextTurn = row.pendingNextTurn ? snapshot(row.pendingNextTurn) : null
      if (isId(row.allowNewReason)) entry.allowNewReason = row.allowNewReason
      for (const key of ['agentName', 'rootSessionId', 'batchId']) if (isId(row[key])) entry[key] = row[key]
      for (const key of ['itemIndex', 'stageIndex']) {
        const index = countOr(row[key], null)
        if (index !== null) entry[key] = index
      }
      if (!parents.has(parentId)) parents.set(parentId, new Map())
      entry.updatedAt = updatedAt
      touch(entry, updatedAt)
      result.restored += 1
    }
    for (const records of parents.values()) {
      while (records.size > maxPerParent) evictOldest(records)
    }
    while (parents.size > maxParents) evictParent()
    return result
  }

  function recordDispatched({ parentId, childId, agentName, label, readOnly, writeScope, cwd, leaseId, allowNewReason,
    startedAt, worktree }) {
    if (!isId(parentId) || !isId(childId)) return false
    if (!parents.has(parentId)) parents.set(parentId, new Map())
    const records = parents.get(parentId)
    const isolatedTree = initialWorktree(worktree)
    const entry = {
      childId,
      parentId,
      ...(isId(agentName) && { agentName }),
      label: textOrNull(label),
      ...(isId(allowNewReason) && { allowNewReason }),
      pendingNextTurn: null,
      writeScope: Array.isArray(writeScope) ? writeScope.filter((item) => typeof item === 'string') : [],
      cwd: textOrNull(cwd),
      attemptSeq: records.get(childId)?.attemptSeq ?? 1,
      worktree: isolatedTree,
      ...initialAttempt({ readOnly, leaseId, startedAt: timestamp(startedAt) }),
    }
    touch(entry, entry.startedAt)
    if (records.size > maxPerParent) evictOldest(records)
    if (parents.size > maxParents) evictParent()
    return true
  }

  function recordRunStarted({ childId, runId, parentId }) {
    const entry = lookup({ childId, parentId })
    if (!entry || !isId(runId) || (entry.runId && entry.runId !== runId)) return false
    entry.runId = runId
    return touch(entry, timestamp())
  }

  function recordRetry({ childId, leaseId, readOnly, writeScope, pendingNextTurn, startedAt, parentId }) {
    const entry = lookup({ childId, parentId })
    if (!entry) return false
    const at = timestamp(startedAt)
    Object.assign(entry, initialAttempt({
      readOnly: readOnly ?? entry.readOnly,
      leaseId,
      startedAt: at,
    }), { attemptSeq: entry.attemptSeq + 1 })
    if (writeScope !== undefined) entry.writeScope = textList(writeScope)
    if (pendingNextTurn !== undefined) entry.pendingNextTurn = snapshot(pendingNextTurn)
    return touch(entry, at)
  }

  function recordDisposed({ childId, at, parentId }) {
    const entry = lookup({ childId, parentId })
    if (!entry) return false
    entry.disposedAt = timestamp(at)
    return touch(entry, entry.disposedAt)
  }

  function recordEnded({ childId, runId, stopReason, at, parentId }) {
    const entry = lookup({ childId, parentId })
    if (!entry || (isId(runId) && entry.runId && entry.runId !== runId)) return false
    entry.runId ??= idOrNull(runId)
    entry.dispatchState = 'ended'
    entry.endedAt = timestamp(at)
    entry.stopReason = textOrNull(stopReason)
    return touch(entry, entry.endedAt)
  }

  function recordWorktreeState(childId, patch) {
    if (patch == null || typeof patch !== 'object') return false
    const entry = lookup({ childId, parentId: patch.parentId })
    const worktree = entry?.worktree
    if (!worktree || (patch.id !== undefined && patch.id !== worktree.id)) return false
    worktree.state = normalizeWorktreeState(patch.state) ?? worktree.state
    if (patch.mergeCommit === null || isId(patch.mergeCommit)) worktree.mergeCommit = patch.mergeCommit
    if (Array.isArray(patch.conflictFiles)) {
      worktree.conflictFiles = patch.conflictFiles.filter((file) => typeof file === 'string')
    }
    if (typeof patch.locked === 'boolean') worktree.locked = patch.locked
    return touch(entry, timestamp(patch.at))
  }

  function recordLeaseReleased({ childId, leaseId, at, parentId }) {
    const entry = lookup({ childId, parentId })
    if (!entry || (leaseId != null && leaseId !== entry.leaseId)) return false
    entry.leaseState = 'released'
    entry.releasedAt = timestamp(at)
    return touch(entry, entry.releasedAt)
  }

  function get(parentId, childId) {
    const entry = parents.get(parentId)?.get(childId)
    return entry ? snapshot(entry) : null
  }

  function queryParent(parentId, { childId, includeCompleted = true, limit = 20 } = {}) {
    const records = parents.get(parentId)
    const entry = records?.get(childId)
    const entries = childId === undefined ? [...(records?.values() ?? [])] : entry ? [entry] : []
    const filtered = includeCompleted ? entries : entries.filter((item) => item.dispatchState !== 'ended')
    const counts = {
      running: 0, ended: 0, worktreePendingReview: 0,
    }
    for (const item of filtered) {
      const state = item.worktree?.state
      if (state === 'ready_for_review' || state === 'merge_conflict') counts.worktreePendingReview += 1
      if (item.dispatchState !== 'ended') counts.running += 1
      else counts.ended += 1
    }
    const items = filtered.reverse()
      .sort((left, right) => queryPriority(left) - queryPriority(right) || newestFirst(left, right))
      .slice(0, limit)
      .map(snapshot)
    return { parentId, total: filtered.length, counts, items }
  }


  return {
    recordDispatched, recordRunStarted, recordRetry, recordDisposed, recordEnded,
    recordLeaseReleased, recordWorktreeState,
    get, queryParent, exportEntries, hydrateEntries,
  }
}
