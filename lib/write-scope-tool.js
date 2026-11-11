/**
 * The write-scope seam shared by the two dispatching tools.
 *
 * `lib/write-scope.js` decides what a declaration means and `lib/write-lease.js` decides
 * who may hold what; neither knows how a tool reports a refusal, and neither should — they
 * are pure policy. This module is that seam for `delegate` and `orchestrate`: it resolves
 * the dispatch directory, claims a lease before any worker exists, and turns a refusal
 * into the four tool-level codes plus the `details` rows that
 * `docs/zh/03-issue-0001-write-scope.md` §6.7.3 pins down.
 *
 * One copy exists because both tools must refuse with the *same* `write-scope-conflict`
 * payload; two copies would drift the moment either tool is edited. The lease table's
 * internal `write-lease-*` codes never escape here.
 */

import { WRITE_LEASE_CODES } from './write-lease.js'
import { WRITE_SCOPE_CODES, isWindowsPath, normalizeScope, parseWriteScope } from './write-scope.js'

/** The codes a `writeScope` failure shows to the model; callers branch on these. */
export const WRITE_SCOPE_TOOL_CODES = Object.freeze({
  conflict: 'write-scope-conflict',
  invalid: 'write-scope-invalid',
  cwdMissing: 'write-scope-cwd-missing',
  limit: 'write-scope-limit',
})

/** A tool error with a stable code; callers branch on `code`, never on the message. */
export class WriteScopeError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'WriteScopeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** The issue's `details` cap; the refusal is already decided past this point. */
const MAX_CONFLICT_DETAILS = 16

/** Conflict rows in a deterministic order: by path, then by owner. */
function conflictDetails(conflicts) {
  const seen = new Set()
  const rows = []
  for (const conflict of Array.isArray(conflicts) ? conflicts : []) {
    const path = conflict?.path
    const owner = conflict?.childId
    if (typeof path !== 'string' || typeof owner !== 'string') continue
    const key = `${path}\u0000${owner}`
    if (seen.has(key)) continue
    seen.add(key)
    // The lease table keeps no task label, so the field stays `null` rather than being
    // omitted: a consumer may read `details[0].label` without a compatibility branch.
    rows.push({ path, owner, label: null })
  }
  rows.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    if (left.owner === right.owner) return 0
    return left.owner < right.owner ? -1 : 1
  })
  return rows.slice(0, MAX_CONFLICT_DETAILS)
}

/** Map a `write-scope-*` refusal into the tool-level namespace. */
export function writeScopeFailure(result) {
  const code =
    result.code === WRITE_SCOPE_CODES.noCwd
      ? WRITE_SCOPE_TOOL_CODES.cwdMissing
      : WRITE_SCOPE_TOOL_CODES.invalid
  return new WriteScopeError(code, result.message)
}

/** Map a lease-table refusal into the tool-level namespace. */
export function leaseFailure(result) {
  if (result.code === WRITE_LEASE_CODES.conflict) {
    return new WriteScopeError(
      WRITE_SCOPE_TOOL_CODES.conflict,
      result.message,
      conflictDetails(result.conflicts),
    )
  }
  if (result.code === WRITE_LEASE_CODES.capacity) {
    return new WriteScopeError(WRITE_SCOPE_TOOL_CODES.limit, result.message)
  }
  return new WriteScopeError(WRITE_SCOPE_TOOL_CODES.invalid, result.message)
}

/** The parent directory the host resolves a relative dispatch `cwd` against. */
function inheritedCwd(exec) {
  const candidates = [
    exec?.cwd,
    exec?.agent?.cwd,
    exec?.agent?.session?.header?.cwd,
    exec?.agent?.session?.cwd,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function isAbsolutePath(value) {
  if (isWindowsPath(value)) {
    return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)
  }
  return value.startsWith('/')
}

function joinCwd(base, relative) {
  return `${base.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`
}

/**
 * The directory a declared scope resolves against. An omitted `cwd` inherits the parent
 * directory, exactly like `startActivation` does for the child; when the host exposes
 * none, `normalizeScope` reports `write-scope-cwd-missing` instead of guessing.
 */
export function dispatchCwd(args, exec) {
  const explicit = typeof args?.cwd === 'string' ? args.cwd.trim() : ''
  const inherited = inheritedCwd(exec)
  if (explicit === '') return inherited
  if (isAbsolutePath(explicit) || inherited === undefined) return explicit
  return joinCwd(inherited, explicit)
}

/**
 * Claim the declared scope for one dispatch, or return `undefined` when nothing was
 * declared.
 *
 * The lease exists before `startActivation`, so a conflict is a refusal rather than a
 * post-mortem. `childId` may be provisional: `delegate` reserves with its own id and
 * rebinds once the host names the child (AC1), while an `orchestrate` batch keeps one
 * aggregate id for its whole life.
 *
 * @returns `{ leaseId, scope }` — `scope` is the normalized, absolute list the worker may
 *   be told about — or `undefined` when `args.writeScope` is absent.
 */
export function claimWriteScope({ args, exec, parent, leases, childId, tool = '工具' }) {
  const declared = args?.writeScope
  if (declared === undefined || declared === null) return undefined
  if (leases === undefined || typeof leases.acquire !== 'function') {
    throw new WriteScopeError(
      WRITE_SCOPE_TOOL_CODES.invalid,
      `${tool} 收到 writeScope，但插件没有可用的写租约表（leases），无法与其他写者判重。`,
    )
  }
  const parsed = parseWriteScope(declared)
  if (!parsed.ok) throw writeScopeFailure(parsed)
  const normalized = normalizeScope(parsed.entries, dispatchCwd(args, exec))
  if (!normalized.ok) throw writeScopeFailure(normalized)
  const acquired = leases.acquire({
    childId,
    parentId: typeof parent?.id === 'string' ? parent.id : '',
    entries: normalized.entries,
  })
  if (!acquired.ok) throw leaseFailure(acquired)
  // The shipped table answers `{ lease }`; accepting a bare record keeps a test double
  // from having to reproduce the snapshot shape exactly.
  const lease = acquired.lease ?? acquired
  if (typeof lease?.leaseId !== 'string' || lease.leaseId === '') {
    throw new WriteScopeError(
      WRITE_SCOPE_TOOL_CODES.invalid,
      `${tool}: 租约表没有返回可用的 leaseId，无法登记写作用域。`,
    )
  }
  return { leaseId: lease.leaseId, scope: Array.isArray(lease.scope) ? [...lease.scope] : [] }
}

/**
 * Best-effort release for a reservation the dispatch itself still owns. A live child's
 * lease is released by the plugin's lifecycle hooks instead, not here; a batch is over
 * when its last worker settles, so `orchestrate` releases its own lease.
 *
 * A teardown must not mask the dispatch result, and a leaked lease heals on its TTL.
 */
export function releaseWriteScope(leases, held) {
  if (held === undefined || held === null) return
  if (leases === undefined || typeof leases.release !== 'function') return
  try {
    leases.release(held.leaseId)
  } catch {
    // Swept by the table's TTL; an exception here would replace the real outcome.
  }
}

/**
 * The paragraph a worker of a declared batch reads. It is a constraint, not a grant: the
 * declaration does not widen the worker's tool surface, and a write outside it is the
 * later fingerprint check's business, not this one's.
 */
export function writeScopeNotice(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return undefined
  return (
    `本批次的写作用域（整批共享，允许写入这些路径）：${scope.join(', ')}。` +
    '写作用域是声明而非授权：它不扩大你的工具权限，也不阻止你在声明外写入；' +
    '但请把改动限制在上述路径内，不要修改声明外的文件。'
  )
}
