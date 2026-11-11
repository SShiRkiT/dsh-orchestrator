/**
 * Single-writer leases: the table that makes "one writer per file" enforceable.
 *
 * Why this exists: `delegate` and `orchestrate` are declared concurrency-safe
 * (`lib/delegate.js:109`, `lib/orchestrate.js:576`), and the plugin keeps no state shared
 * between two calls (Issue #1, R4/R5). The only rule is one sentence in a tool
 * description, so a second writer is discovered after both wrote the same bytes. This
 * module is the missing `Map<path, lease>`: a writer claims its scope before the host
 * starts it, and the next dispatch whose scope intersects is refused *before* any worker
 * exists.
 *
 * One lease per child, `mode: 'exclusive'` only. A child that is dispatched again — or an
 * `orchestrate` item crossing a stage — re-acquires with the same `childId`, and the new
 * reach is merged into the lease it already holds, so the time between stages cannot be
 * used by another writer. A *different* child always conflicts.
 *
 * Why a TTL instead of a reference count: a child can die without settling — host restart,
 * killed process, model failure — and a lease that outlives its writer refuses every later
 * dispatch. That leak is the named risk in `docs/zh/03-issue-0001-write-scope.md` §4, so
 * the table heals on its own: every `acquire` sweeps expired leases first, and `sweep` /
 * `renew` are exposed for a supervisor that wants to keep a long run alive. A TTL must
 * therefore exceed the host's dispatch ceiling; the default is deliberately generous.
 *
 * Why a full table is an error instead of an eviction: evicting a *live* lease would
 * silently break the mutual exclusion it exists to provide. `write-lease-capacity` is a
 * surfaced refusal, never a quiet guess about which writer is disposable.
 *
 * Dependency-free and injected: the clock and the id generator come from the caller,
 * exactly like `createRetry` (`lib/retry.js:124`), so the whole policy is testable
 * without the DSH runtime.
 */

import { describeScope, isNormalizedScope, mergeScope, normalizeScope, overlaps } from './write-scope.js'

/** Structured refusal codes; callers branch on these, never on the message text. */
export const WRITE_LEASE_CODES = Object.freeze({
  conflict: 'write-lease-conflict',
  invalid: 'write-lease-invalid',
  capacity: 'write-lease-capacity',
  expired: 'write-lease-expired',
  unknown: 'write-lease-unknown',
})

/** The only mode of the first version: one writer, everyone else is refused. */
export const LEASE_MODE = 'exclusive'

/**
 * Default time to live. It has to be longer than a normal dispatch — a lease that expires
 * under a live worker lets a second writer in — and short enough that a lease leaked by a
 * crashed host heals without an operator.
 */
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000

/** Bound on live leases; a full table fails loudly instead of evicting a live writer. */
export const MAX_LEASES = 256

/** A refusal names a handful of conflicts; the decision is already made by then. */
const MAX_CONFLICT_ROWS = 64

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/** A positive finite millisecond count, or `undefined` for "not a TTL". */
function ttlOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function formatTime(value) {
  if (!Number.isFinite(value)) return '未知时间'
  return new Date(value).toISOString()
}

/** A refusal that is not about the scope itself. */
function invalid(message) {
  return { ok: false, code: WRITE_LEASE_CODES.invalid, message }
}

/**
 * Every live lease that intersects `entries`.
 *
 * Pure: the table passes its own snapshot in, and `orchestrate` can pass a simulated list
 * to pre-check a whole batch without registering anything. Rows are capped: past the cap
 * the refusal is already decided, and a pathological scope must not allocate without end.
 */
export function leaseConflicts(entries, leases, { ignoreChildId, ignoreLeaseIds } = {}) {
  const conflicts = []
  if (!Array.isArray(entries) || !Array.isArray(leases)) return conflicts
  const ignored = new Set(ignoreLeaseIds ?? [])
  for (const lease of leases) {
    if (lease === null || typeof lease !== 'object') continue
    if (ignoreChildId !== undefined && lease.childId === ignoreChildId) continue
    if (ignored.has(lease.leaseId)) continue
    const held = Array.isArray(lease.entries) ? lease.entries : []
    for (const claimed of entries) {
      if (conflicts.length >= MAX_CONFLICT_ROWS) return conflicts
      for (const holder of held) {
        if (!overlaps(claimed, holder)) continue
        conflicts.push({
          leaseId: lease.leaseId,
          childId: lease.childId,
          parentId: lease.parentId,
          mode: lease.mode,
          expiresAt: lease.expiresAt,
          path: claimed.path,
          holderPath: holder.path,
        })
        break
      }
    }
  }
  return conflicts
}

/**
 * The refusal text for a conflict list. It names the holder and both paths, because the
 * caller's next decision (serialize, split the scope, or pick another file) depends on
 * which other worker is in the way.
 */
export function describeConflicts(conflicts, { limit = 6 } = {}) {
  const rows = Array.isArray(conflicts) ? conflicts : []
  if (rows.length === 0) return ''
  const shown = rows.slice(0, Math.max(1, limit))
  const parts = shown.map(
    (row) =>
      `${row.path} ← 子代理 ${row.childId}（租约 ${row.leaseId}，声明了 ${row.holderPath}，${formatTime(row.expiresAt)} 到期）`,
  )
  const rest = rows.length - shown.length
  const tail = rest > 0 ? `；另有 ${rest} 处冲突未列出` : ''
  return (
    '写作用域冲突：同一文件同一时间只允许一个写者。本次声明与已持有租约相交：' +
    parts.join('；') +
    tail +
    '。请改为串行派发，或把这些路径从其中一方的写作用域中移除。'
  )
}

/** Human-readable one-line summary of a lease, for logs and notices. */
export function describeLease(lease) {
  if (lease === null || typeof lease !== 'object') return '（无效租约）'
  return (
    `租约 ${lease.leaseId}（子代理 ${lease.childId}，父代理 ${lease.parentId}，` +
    `写作用域 ${describeScope(lease.entries)}，${formatTime(lease.expiresAt)} 到期）`
  )
}

/**
 * Build the lease table.
 *
 * @param options.now - injectable clock; a throwing clock falls back to `Date.now()`.
 * @param options.ttlMs - default time to live, per acquire.
 * @param options.maxLeases - bound on live leases.
 * @param options.newId - injectable id generator; must return a non-empty string.
 * @returns `{ acquire, check, release, releaseChild, releaseByChild, rebind, renew, sweep,
 *   get, has, list, clear, size }`. No method throws: a refusal is a value with a
 *   `write-lease-*` code.
 */
export function createWriteLeases(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const defaultTtl = ttlOf(opts.ttlMs) ?? DEFAULT_LEASE_TTL_MS
  const maxLeases =
    Number.isInteger(opts.maxLeases) && opts.maxLeases > 0 ? opts.maxLeases : MAX_LEASES

  /** Insertion-ordered lease records; order is stable for logs and tests. */
  const byId = new Map()
  /** `childId -> leaseId`, the one-lease-per-child invariant. */
  const byChild = new Map()
  let sequence = 0

  const currentTime = () => {
    try {
      const value = typeof opts.now === 'function' ? Number(opts.now()) : Date.now()
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      // A broken clock must not break a dispatch decision.
      return Date.now()
    }
  }

  const nextId = () => {
    if (typeof opts.newId === 'function') {
      try {
        const generated = opts.newId()
        if (isNonEmptyString(generated)) return generated
      } catch {
        // Fall through to the built-in generator.
      }
    }
    sequence += 1
    return `lease-${String(currentTime())}-${String(sequence)}`
  }

  /** Frozen deep-enough copy, so a caller cannot rewrite the table by mutation. */
  const snapshot = (lease) =>
    Object.freeze({
      leaseId: lease.leaseId,
      childId: lease.childId,
      parentId: lease.parentId,
      scope: Object.freeze([...lease.scope]),
      entries: Object.freeze(lease.entries.map((entry) => Object.freeze({ ...entry }))),
      mode: lease.mode,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      baselineId: lease.baselineId,
    })

  const drop = (lease) => {
    byId.delete(lease.leaseId)
    if (byChild.get(lease.childId) === lease.leaseId) byChild.delete(lease.childId)
  }

  const conflictResult = (conflicts) => ({
    ok: false,
    code: WRITE_LEASE_CODES.conflict,
    message: describeConflicts(conflicts),
    conflicts,
  })

  /** Raw declaration (`scope` + `cwd`) or a normalized one (`entries`), never both. */
  const resolveEntries = (input) => {
    if (input.scope !== undefined && input.entries !== undefined) {
      return invalid('scope 与 entries 只能给一个：entries 用于复用 normalizeScope() 已经算好的结果。')
    }
    if (input.entries !== undefined) {
      if (!isNormalizedScope(input.entries)) {
        return invalid('entries 必须是 normalizeScope() 返回的 entries 数组。')
      }
      return { ok: true, entries: input.entries }
    }
    return normalizeScope(input.scope, input.cwd, {
      caseInsensitive: input.caseInsensitive,
      realpath: input.realpath,
    })
  }

  /** Reclaim expired leases; returns them so the caller can log the leak. */
  const sweep = (at) => {
    const moment = Number.isFinite(at) ? at : currentTime()
    const expired = []
    for (const lease of byId.values()) {
      if (lease.expiresAt <= moment) expired.push(lease)
    }
    for (const lease of expired) drop(lease)
    return expired.map((lease) => snapshot(lease))
  }

  /**
   * Claim a scope. A conflict is a value, never a throw: the caller refuses the dispatch
   * and shows `message` as the tool error.
   *
   * `childId` may be provisional. `delegate` must refuse a conflicting dispatch before
   * `startActivation` (AC1), but the host names the child only after it is created, so the
   * caller reserves the lease with its own id and calls `rebind` once the child exists.
   */
  const acquire = (input) => {
    if (input === null || typeof input !== 'object') {
      return invalid('acquire 需要一个对象参数：{ childId, parentId, scope, cwd }。')
    }
    if (!isNonEmptyString(input.childId)) return invalid('childId 必须是非空字符串。')
    if (!isNonEmptyString(input.parentId)) return invalid('parentId 必须是非空字符串。')
    if (input.mode !== undefined && input.mode !== LEASE_MODE) {
      return invalid(`首版只支持 mode="${LEASE_MODE}"，收到 ${JSON.stringify(input.mode)}。`)
    }
    const ttlMs = input.ttlMs === undefined ? defaultTtl : ttlOf(input.ttlMs)
    if (ttlMs === undefined) return invalid('ttlMs 必须是正数（毫秒）。')

    const normalized = resolveEntries(input)
    if (!normalized.ok) return normalized
    const entries = normalized.entries
    if (!Array.isArray(entries) || entries.length === 0) {
      return invalid('写作用域为空，无法登记租约。')
    }

    const at = currentTime()
    // Sweeping before the check is what keeps a leaked lease from blocking forever.
    sweep(at)

    const held = byId.get(byChild.get(input.childId))
    if (held !== undefined) {
      const merged = mergeScope(held.entries, entries)
      const conflicts = leaseConflicts(merged, [...byId.values()], {
        ignoreChildId: held.childId,
      })
      if (conflicts.length > 0) return conflictResult(conflicts)
      held.entries = merged
      held.scope = merged.map((entry) => entry.path)
      held.expiresAt = at + ttlMs
      if (isNonEmptyString(input.baselineId)) held.baselineId = input.baselineId
      return { ok: true, lease: snapshot(held), reused: true }
    }

    const conflicts = leaseConflicts(entries, [...byId.values()])
    if (conflicts.length > 0) return conflictResult(conflicts)

    if (byId.size >= maxLeases) {
      return {
        ok: false,
        code: WRITE_LEASE_CODES.capacity,
        message:
          `租约表已满（${byId.size}/${maxLeases}）：先释放已结束子代理的租约` +
          '（结算与 agent/disposed 会释放），不要靠调大上限掩盖泄漏。',
      }
    }

    const leaseId = isNonEmptyString(input.leaseId) ? input.leaseId : nextId()
    if (byId.has(leaseId)) {
      return invalid(`leaseId ${JSON.stringify(leaseId)} 已被占用；同一 childId 续期请直接再 acquire。`)
    }

    const lease = {
      leaseId,
      childId: input.childId,
      parentId: input.parentId,
      scope: entries.map((entry) => entry.path),
      entries,
      mode: LEASE_MODE,
      issuedAt: at,
      expiresAt: at + ttlMs,
      baselineId: isNonEmptyString(input.baselineId) ? input.baselineId : null,
    }
    byId.set(leaseId, lease)
    byChild.set(lease.childId, leaseId)
    return { ok: true, lease: snapshot(lease), reused: false }
  }

  /**
   * Pre-flight check without registering anything: the answer a caller needs to decide
   * between refusing one dispatch and serializing a batch. Expired leases are ignored, so
   * a check cannot report a conflict the next acquire would have swept away.
   */
  const check = (input) => {
    if (input === null || typeof input !== 'object') {
      return invalid('check 需要一个对象参数：{ scope, cwd }。')
    }
    const normalized = resolveEntries(input)
    if (!normalized.ok) return normalized
    const at = currentTime()
    const live = []
    for (const lease of byId.values()) {
      if (lease.expiresAt > at) live.push(lease)
    }
    const conflicts = leaseConflicts(normalized.entries, live, {
      ignoreChildId: input.ignoreChildId,
      ignoreLeaseIds: input.ignoreLeaseIds,
    })
    if (conflicts.length === 0) return { ok: true, entries: normalized.entries, conflicts }
    return conflictResult(conflicts)
  }

  /** Release one lease by id. Idempotent: an unknown id is `{ released: false }`. */
  const release = (leaseId) => {
    if (!isNonEmptyString(leaseId)) return { released: false }
    const lease = byId.get(leaseId)
    if (lease === undefined) return { released: false }
    drop(lease)
    return { released: true, lease: snapshot(lease) }
  }

  /**
   * Release every lease a child holds. Settlement (`subagent/end`) and `agent/disposed`
   * only know the child id, so this is the release path those hooks actually call.
   */
  const releaseChild = (childId) => {
    const released = []
    if (isNonEmptyString(childId)) {
      for (const lease of [...byId.values()]) {
        if (lease.childId !== childId) continue
        drop(lease)
        released.push(snapshot(lease))
      }
    }
    return { released: released.length, leases: released }
  }

  /**
   * Point a reserved lease at the child the host finally created. The `leaseId` does not
   * change, so a refusal message can still name a stable identity.
   */
  const rebind = (leaseId, patch = {}) => {
    const lease = isNonEmptyString(leaseId) ? byId.get(leaseId) : undefined
    if (lease === undefined) {
      return {
        ok: false,
        code: WRITE_LEASE_CODES.unknown,
        message: `没有租约 ${JSON.stringify(leaseId)}。`,
      }
    }
    if (lease.expiresAt <= currentTime()) {
      return {
        ok: false,
        code: WRITE_LEASE_CODES.expired,
        message: `租约 ${leaseId} 已过期（${formatTime(lease.expiresAt)}），不能改绑；请重新 acquire。`,
      }
    }
    const nextChild = patch.childId === undefined ? lease.childId : patch.childId
    const nextParent = patch.parentId === undefined ? lease.parentId : patch.parentId
    if (!isNonEmptyString(nextChild) || !isNonEmptyString(nextParent)) {
      return invalid('rebind 的 childId 与 parentId 必须是非空字符串。')
    }
    const occupied = byChild.get(nextChild)
    if (occupied !== undefined && occupied !== leaseId) {
      return invalid(`子代理 ${nextChild} 已持有租约 ${occupied}，不能再挂第二份。`)
    }
    if (byChild.get(lease.childId) === leaseId) byChild.delete(lease.childId)
    lease.childId = nextChild
    lease.parentId = nextParent
    byChild.set(nextChild, leaseId)
    return { ok: true, lease: snapshot(lease) }
  }

  /**
   * Extend a lease that is still live. An already expired lease is reclaimed rather than
   * revived: its claim was void while nobody held it, so a worker must not write on it.
   */
  const renew = (leaseId, ttlMs) => {
    const lease = isNonEmptyString(leaseId) ? byId.get(leaseId) : undefined
    if (lease === undefined) {
      return {
        renewed: false,
        code: WRITE_LEASE_CODES.unknown,
        message: `没有租约 ${JSON.stringify(leaseId)}。`,
      }
    }
    const at = currentTime()
    if (lease.expiresAt <= at) {
      drop(lease)
      return {
        renewed: false,
        code: WRITE_LEASE_CODES.expired,
        message: `租约 ${leaseId} 已过期（${formatTime(lease.expiresAt)}），已被回收；请重新 acquire。`,
      }
    }
    const ttl = ttlMs === undefined ? defaultTtl : ttlOf(ttlMs)
    if (ttl === undefined) {
      return { renewed: false, code: WRITE_LEASE_CODES.invalid, message: 'ttlMs 必须是正数（毫秒）。' }
    }
    lease.expiresAt = at + ttl
    return { renewed: true, lease: snapshot(lease) }
  }

  return {
    acquire,
    check,
    release,
    releaseChild,
    // The plugin wiring releases by child id from the host's lifecycle edges; both names
    // point at the same function so a caller can use the one its contract spells.
    releaseByChild: releaseChild,
    rebind,
    renew,
    sweep,
    get(leaseId) {
      const lease = isNonEmptyString(leaseId) ? byId.get(leaseId) : undefined
      return lease === undefined ? undefined : snapshot(lease)
    },
    has(leaseId) {
      return isNonEmptyString(leaseId) && byId.has(leaseId)
    },
    list() {
      return [...byId.values()].map((lease) => snapshot(lease))
    },
    /** Drop every lease, e.g. when the plugin itself is reloaded. */
    clear() {
      const removed = byId.size
      byId.clear()
      byChild.clear()
      return removed
    },
    get size() {
      return byId.size
    },
  }
}
