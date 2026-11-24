export const INLINE_AUDIT_SOURCE_KIND = 'orchestrator-write-audit-inline'

const DEFAULT_ISOLATION = 'logical-post-audit'
const WORKTREE_ISOLATION = 'git-worktree'
const WORKTREE_STATES = new Set([
  'active', 'ready_for_review', 'merged', 'discarded', 'merge_conflict', 'cleanup_failed',
])
const TERMINAL_DISPATCH_STATES = new Set(['ended', 'completed', 'interrupted', 'aborted', 'failed', 'lost'])
const OPEN_WORKTREE_STATES = new Set(['active', 'ready_for_review', 'merge_conflict', 'cleanup_failed'])
const isId = (value) => typeof value === 'string' && value.length > 0
const idOrNull = (value) => isId(value) ? value : null
const textOrNull = (value) => typeof value === 'string' ? value : null
const snapshot = (entry) => structuredClone(entry)

function copyMetadata(value) {
  if (typeof value === 'string') return value
  if (value == null || typeof value !== 'object') return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function copyViolation(value) {
  const result = {}
  for (const key of ['kind', 'code', 'path', 'reason', 'phase', 'changeType', 'expected', 'actual']) {
    if (typeof value?.[key] === 'string' || value?.[key] === null) result[key] = value[key]
  }
  if (value?.detail !== undefined) result.detail = copyMetadata(value.detail)
  return result
}

const isCompleted = (entry) => entry.dispatchState === 'ended' && entry.auditState !== 'pending'
const isEvictable = (entry) => isCompleted(entry) &&
  (entry.auditState !== 'failed' || Boolean(entry.auditDeliveredVia)) &&
  !OPEN_WORKTREE_STATES.has(entry.worktree?.state)
const needsAttention = (entry) => entry.dispatchState === 'ended' &&
  (entry.auditState === 'pending' || (entry.auditState === 'failed' && !entry.auditDeliveredVia))
const queryPriority = (entry) => isCompleted(entry) && entry.auditState !== 'failed' ? 1 : 0
const newestFirst = (left, right) => right.updatedAt - left.updatedAt

function initialWorktree(worktree) {
  if (worktree == null || typeof worktree !== 'object') return null
  const { id, path, execCwd, branch, baseCommit } = worktree
  return {
    id: idOrNull(id), path: textOrNull(path ?? worktree.worktreePath), execCwd: textOrNull(execCwd),
    branch: textOrNull(branch), baseCommit: idOrNull(baseCommit),
    state: 'active', commits: 0, dirty: false, mergeCommit: null, conflictFiles: [], locked: false,
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

function initialAttempt({ readOnly, baselineId, leaseId, startedAt, worktree }) {
  return {
    readOnly: readOnly === true,
    runId: null,
    baselineId: idOrNull(baselineId),
    dispatchState: 'running',
    auditState: isId(baselineId) ? 'pending' : 'unmanaged',
    leaseState: readOnly !== true && isId(leaseId) ? 'held' : 'none',
    leaseId: idOrNull(leaseId),
    startedAt,
    endedAt: null,
    disposedAt: null,
    auditedAt: null,
    releasedAt: null,
    updatedAt: startedAt,
    stopReason: null,
    violations: [],
    truncatedViolations: 0,
    incomplete: false,
    isolation: worktree ? WORKTREE_ISOLATION : isId(baselineId) ? DEFAULT_ISOLATION : null,
    auditSummary: null,
    auditDeliveredVia: null,
  }
}

/** Bounded, in-memory acceptance evidence. It does not own a lease or enforce isolation. */
export function createDispatchTimeline({
  maxPerParent = 64,
  maxParents = 64,
  maxViolations = 32,
  now = () => Date.now(),
} = {}) {
  for (const [name, value, minimum] of [
    ['maxPerParent', maxPerParent, 1],
    ['maxParents', maxParents, 1],
    ['maxViolations', maxViolations, 0],
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
      const entry = { childId, parentId, worktree, ...initialAttempt({ ...row, startedAt, worktree }) }
      const dispatchState = row.dispatchState
      entry.dispatchState = TERMINAL_DISPATCH_STATES.has(dispatchState) ? 'ended'
        : idOrNull(dispatchState) ?? (Number.isFinite(row.endedAt) ? 'ended' : entry.dispatchState)
      entry.attemptSeq = countOr(row.attemptSeq, 1)
      for (const key of ['runId', 'auditState', 'leaseState']) {
        if (isId(row[key])) entry[key] = row[key]
      }
      for (const key of ['label', 'cwd', 'stopReason', 'auditDeliveredVia']) entry[key] = textOrNull(row[key])
      for (const key of ['endedAt', 'disposedAt', 'auditedAt', 'releasedAt']) entry[key] = timeOrNull(row[key])
      entry.writeScope = textList(row.writeScope)
      entry.incomplete = row.incomplete === true
      if (Object.hasOwn(row, 'isolation')) entry.isolation = copyMetadata(row.isolation)
      entry.auditSummary = copyMetadata(row.auditSummary)
      const violations = Array.isArray(row.violations) ? row.violations : []
      entry.violations = violations.slice(0, maxViolations).map(copyViolation)
      entry.truncatedViolations = countOr(row.truncatedViolations, 0) + Math.max(0, violations.length - maxViolations)
      for (const key of ['agentName', 'rootSessionId', 'batchId']) if (isId(row[key])) entry[key] = row[key]
      for (const key of ['itemIndex', 'stageIndex']) {
        const index = countOr(row[key], null)
        if (index !== null) entry[key] = index
      }
      if (Array.isArray(row.expectedTargets)) entry.expectedTargets = textList(row.expectedTargets)
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

  function recordDispatched({ parentId, childId, agentName, label, readOnly, writeScope, cwd, baselineId, leaseId,
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
      writeScope: Array.isArray(writeScope) ? writeScope.filter((item) => typeof item === 'string') : [],
      cwd: textOrNull(cwd),
      attemptSeq: records.get(childId)?.attemptSeq ?? 1,
      worktree: isolatedTree,
      ...initialAttempt({ readOnly, baselineId, leaseId, startedAt: timestamp(startedAt), worktree: isolatedTree }),
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

  function recordRetry({ childId, baselineId, leaseId, readOnly, startedAt, parentId }) {
    const entry = lookup({ childId, parentId })
    if (!entry) return false
    const at = timestamp(startedAt)
    Object.assign(entry, initialAttempt({
      readOnly: readOnly ?? entry.readOnly,
      baselineId,
      leaseId,
      startedAt: at,
      worktree: entry.worktree,
    }), { attemptSeq: entry.attemptSeq + 1 })
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
    if (Number.isSafeInteger(patch.commits) && patch.commits >= 0) worktree.commits = patch.commits
    if (typeof patch.dirty === 'boolean') worktree.dirty = patch.dirty
    if (patch.mergeCommit === null || isId(patch.mergeCommit)) worktree.mergeCommit = patch.mergeCommit
    if (Array.isArray(patch.conflictFiles)) {
      worktree.conflictFiles = patch.conflictFiles.filter((file) => typeof file === 'string')
    }
    if (typeof patch.locked === 'boolean') worktree.locked = patch.locked
    return touch(entry, timestamp(patch.at))
  }

  function recordAudit(event, report, metadata) {
    // Legacy callers supply flat evidence; Git settlement may also supply the raw audit.
    const evidence = typeof event === 'string' ? { ...metadata, childId: event } : event
    const audit = report ?? evidence.audit
    const { childId, runId, baselineId, passed, incomplete, unmanaged, violations, summary,
      isolation, git, at, parentId } = { ...audit, ...evidence }
    const entry = lookup({ childId, parentId })
    if (!entry || (isId(runId) && entry.runId && entry.runId !== runId) ||
        (isId(baselineId) && entry.baselineId && entry.baselineId !== baselineId)) return false
    const rows = Array.isArray(violations) ? violations : []
    entry.baselineId ??= idOrNull(baselineId)
    entry.incomplete = incomplete === true || (incomplete === undefined && git != null &&
      (summary?.truncated === true || rows.some((row) => row?.code === 'audit-incomplete')))
    if (unmanaged === true) {
      entry.auditState = 'unmanaged'
    } else {
      entry.auditState = !entry.incomplete && isId(baselineId) && passed === true ? 'passed' : 'failed'
    }
    entry.violations = rows.slice(0, maxViolations).map(copyViolation)
    entry.truncatedViolations = Math.max(0, rows.length - maxViolations)
    entry.auditedAt = timestamp(at)
    entry.auditSummary = textOrNull(summary)
    if (git != null && entry.worktree) {
      entry.worktree.commits = git.commits?.length ?? 0
      entry.worktree.dirty = (git.dirtyFiles?.length ?? 0) > 0
    }
    const explicitIsolation = copyMetadata(audit?.isolationLevel || evidence.isolationLevel || isolation)
    entry.isolation = explicitIsolation ?? (git != null || entry.worktree
      ? entry.isolation
      : entry.auditState === 'unmanaged' ? null : DEFAULT_ISOLATION)
    return touch(entry, entry.auditedAt)
  }

  function recordLeaseReleased({ childId, leaseId, at, parentId }) {
    const entry = lookup({ childId, parentId })
    if (!entry || (leaseId != null && leaseId !== entry.leaseId)) return false
    entry.leaseState = 'released'
    entry.releasedAt = timestamp(at)
    return touch(entry, entry.releasedAt)
  }

  function markAuditDelivered({ childId, via, parentId }) {
    const entry = lookup({ childId, parentId })
    if (!entry || via !== 'inline-pre-step') return false
    entry.auditDeliveredVia = via
    return touch(entry, timestamp())
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
      running: 0, endedPendingAudit: 0, auditPassed: 0, auditFailed: 0, auditUnmanaged: 0, worktreePendingReview: 0,
    }
    for (const item of filtered) {
      const state = item.worktree?.state
      if (state === 'ready_for_review' || state === 'merge_conflict') counts.worktreePendingReview += 1
      if (item.dispatchState !== 'ended') counts.running += 1
      else if (item.auditState === 'pending') counts.endedPendingAudit += 1
      else if (item.auditState === 'passed') counts.auditPassed += 1
      else if (item.auditState === 'failed') counts.auditFailed += 1
      else counts.auditUnmanaged += 1
    }
    const items = filtered.reverse()
      .sort((left, right) => queryPriority(left) - queryPriority(right) || newestFirst(left, right))
      .slice(0, limit)
      .map(snapshot)
    return { parentId, total: filtered.length, counts, items }
  }

  function listAttentionItems(parentId) {
    return [...(parents.get(parentId)?.values() ?? [])].reverse()
      .filter(needsAttention)
      .sort(newestFirst)
      .map(snapshot)
  }

  return {
    recordDispatched, recordRunStarted, recordRetry, recordDisposed, recordEnded, recordAudit,
    recordLeaseReleased, markAuditDelivered, recordWorktreeState,
    get, queryParent, listAttentionItems, exportEntries, hydrateEntries,
  }
}

function worktreeDeliveryNotice(worktree, passed) {
  const id = worktree?.id ?? '未知'
  if (worktree?.state === 'discarded') {
    return worktree.mergeCommit ? `工作树 ${id} 已清理，其交付物此前已合回。`
      : `工作树 ${id} 的交付物已丢弃，未合回主仓。`
  }
  if (worktree?.state === 'merged' || (worktree?.state === 'cleanup_failed' && worktree.mergeCommit)) {
    return `工作树 ${id} 的交付物已合回。`
  }
  return passed
    ? `交付物保留在工作树 ${id}，尚未合回主仓，请调用 worktree_manage 执行 inspect / merge / discard。`
    : `违规现场保留在工作树 ${id}，尚未合回主仓；请先调用 worktree_manage 执行 inspect 核查。`
}

/** Render same-frame evidence without implying that a logical audit is a sandbox. */
export function formatInlineAuditNotice(records) {
  const entries = Array.isArray(records) ? records
    : records == null ? [] : [{ childId: records.childId, entry: records.entry ?? records }]
  const lines = []
  for (const { childId, entry } of entries) {
    const prefix = `【${childId}】` + (entry?.agentName ? `（${entry.agentName}）` : '')
    const baseline = entry?.baselineId ?? '无'
    const worktree = entry?.worktree
    const isolated = entry?.isolation === WORKTREE_ISOLATION || worktree != null
    const branch = worktree?.branch ?? '未知'
    switch (entry?.auditState) {
      case 'passed':
        if (isolated) {
          const changes = `新增提交 ${worktree?.commits ?? 0} 个${worktree?.dirty ? '，含未提交改动' : ''}`
          lines.push(`${prefix}写作用域审计已通过（基线 ${baseline}；git-worktree 独立检出，分支 ${branch}，${changes}）。` +
            worktreeDeliveryNotice(worktree, true))
        } else {
          lines.push(`${prefix}写作用域审计已通过（基线 ${baseline}；${entry.readOnly ? '只读逻辑审计' : '作用域内变更'}）。`)
        }
        break
      case 'failed': {
        const violations = entry.violations ?? []
        const omitted = entry.truncatedViolations
        const count = `${violations.length + (Number.isInteger(omitted) ? omitted : 0)}${omitted === true ? '+' : ''}`
        const isolation = isolated ? `；git-worktree 工作树 ${worktree?.id ?? '未知'}，分支 ${branch}` : ''
        lines.push(`${prefix}不得验收为通过。写作用域审计未通过（基线 ${baseline}，${count} 项${isolation}）：`)
        for (const row of violations) {
          const kind = row.kind ?? row.code ?? '违规'
          const detail = row.detail ?? row.reason
          const path = row.path ? `：${JSON.stringify(row.path)}` : ''
          lines.push(`- ${kind}${path}${detail ? `（${JSON.stringify(detail)}）` : ''}`)
        }
        if (omitted) lines.push(Number.isInteger(omitted) ? `另有 ${omitted} 项未列出。` : '其余违规未列出。')
        if (entry.incomplete) lines.push('审计采样不完整或超限。')
        lines.push(isolated ? worktreeDeliveryNotice(worktree)
          : 'logical-post-audit：只做工作区逻辑写后审计，不是物理隔离；不能阻止写入、覆盖工作区外或区分并发写入者。')
        break
      }
      case 'pending':
        lines.push(isolated
          ? `${prefix}执行已结束，但 git-worktree 工作树 ${worktree?.id ?? '未知'}（分支 ${branch}）的写作用域审计仍为 pending（尚未结算），不得直接验收通过；验收前请调用 delegate_status 核验终态。`
          : `${prefix}执行已结束，但写作用域审计仍为 pending（尚未结算），不得直接验收通过；验收前请调用 delegate_status 核验终态。`)
        break
      default:
        lines.push(isolated
          ? `${prefix}git-worktree 工作树 ${worktree?.id ?? '未知'}（分支 ${branch}）未纳入本插件写作用域审计基线（unmanaged），请调用 worktree_manage 执行 inspect 核查。`
          : `${prefix}未纳入本插件写作用域审计基线（unmanaged），请按需核验工作区变更。`)
    }
  }
  return lines.join('\n')
}
