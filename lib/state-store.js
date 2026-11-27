import { Buffer } from 'node:buffer'

const DOMAIN_NAME = /^[a-z][a-z0-9_]*$/
const RECORD_KEY = /^(?:k|u)_[a-zA-Z0-9_-]*$/
const INITIAL_GLOBAL = Object.freeze({ schemaVersion: 1, generation: 0, updatedAt: 0 })
const DEFAULT_LIMITS = Object.freeze({
  maxTerminalDelegates: 256,
  maxDoneActions: 512,
  maxClosedWorktrees: 256,
  terminalTtlMs: 7 * 24 * 3600 * 1000,
})

const isId = (value) => typeof value === 'string' && value.length > 0
const isText = (value) => typeof value === 'string'
const isBoolean = (value) => typeof value === 'boolean'
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const isTime = (value) => Number.isFinite(value) && value >= 0
const isListOf = (check) => (value) => Array.isArray(value) && Array.from(value).every(check)
const isTextList = isListOf(isText)
const isIdList = isListOf(isId)
const isNonBlank = (value) => isText(value) && value.trim() !== ''
const isNextTurn = (value) => isObject(value) && isBoolean(value.readOnly) &&
  isIdList(value.writeScope) && (value.readOnly ? value.writeScope.length === 0 : value.writeScope.length > 0)

function isObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isLeaseEntries = isListOf((entry) => isObject(entry) && isId(entry.path) &&
  isId(entry.key) && ['file', 'dir', 'root'].includes(entry.kind))

const TABLES = {
  worktrees: {
    key: 'id',
    fields: {
      parentId: isText, childId: isText, childIds: isIdList, batchId: isText, itemIndex: isCount,
      repoRoot: isText, sourceCwd: isText, subPath: isText, worktreePath: isText, execCwd: isText,
      branch: isText, baseBranch: isText, baseCommit: isText, label: isText, state: isId,
      mergeCommit: isText, cleaned: isBoolean, locked: isBoolean, createdAt: isTime,
      updatedAt: isTime,
    },
  },
  delegates: {
    key: 'childId',
    fields: {
      parentId: isText, rootSessionId: isText, agentName: isId, label: isText, cwd: isText, readOnly: isBoolean,
      writeScope: isTextList, batchId: isText, itemIndex: isCount,
      stageIndex: isCount, worktreeId: isText, leaseId: isText, attemptSeq: isCount, runId: isText,
      dispatchState: isId, stopReason: isText, leaseState: isId,
      startedAt: isTime, endedAt: isTime,
      updatedAt: isTime, retry: isObject, watchCursor: isObject,
      wakeActionKey: isText,
      pendingNextTurn: isNextTurn, allowNewReason: isNonBlank,
      disposedAt: isTime, releasedAt: isTime,
    },
  },
  leases: {
    key: 'leaseId',
    fields: {
      ownerKind: isText, ownerId: isText, parentId: isText, entries: isLeaseEntries,
      issuedAt: isTime, expiresAt: isTime,
    },
  },
  actions: {
    key: 'key',
    fields: {
      kind: isId, phase: (value) => ['prepared', 'accepted', 'unknown', 'done'].includes(value),
      rootSessionId: isText, parentId: isText, childId: isText, runId: isText, attemptSeq: isCount,
      requestId: isText, messageId: isText, detail: () => true, createdAt: isTime, updatedAt: isTime,
    },
  },
}
const TABLE_NAMES = Object.keys(TABLES)

/** Distinguish malformed UTF-16 from valid Unicode, without losing any JS code units. */
export function encodeRecordKey(rawKey) {
  if (!isText(rawKey)) throw new TypeError('record key must be a string')
  return rawKey.isWellFormed()
    ? `k_${Buffer.from(rawKey, 'utf8').toString('base64url')}`
    : `u_${Buffer.from(rawKey, 'utf16le').toString('base64url')}`
}

export function decodeRecordKey(encodedKey) {
  if (!isText(encodedKey) || !RECORD_KEY.test(encodedKey)) {
    throw new TypeError('invalid encoded record key')
  }
  const rawKey = Buffer.from(encodedKey.slice(2), 'base64url')
    .toString(encodedKey.startsWith('k_') ? 'utf8' : 'utf16le')
  // Buffer accepts non-canonical Base64 and replaces malformed UTF-8.
  if (encodeRecordKey(rawKey) !== encodedKey) throw new TypeError('invalid encoded record key')
  return rawKey
}

function copyJson(value, ancestors = new Set()) {
  if (value === null || isText(value) || isBoolean(value) || Number.isFinite(value)) return value
  if ((!Array.isArray(value) && !isObject(value)) || ancestors.has(value)) {
    throw new TypeError('expected plain JSON data')
  }
  ancestors.add(value)
  const copy = Array.isArray(value)
    ? Array.from(value, (item) => copyJson(item, ancestors))
    : Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, copyJson(item, ancestors)]))
  ancestors.delete(value)
  return copy
}

function normalizeRecord(table, value) {
  const { key, fields } = TABLES[table]
  if (!isObject(value) || value.__corrupt === true || !Object.hasOwn(value, key) || !isId(value[key])) {
    throw new TypeError(`${table}.${key} must be a non-empty string in a plain record`)
  }
  const record = { [key]: value[key] }
  for (const [field, check] of Object.entries(fields)) {
    if (!Object.hasOwn(value, field)) continue
    const item = value[field]
    if (item === undefined) continue
    if (item !== null && !check(item)) throw new TypeError(`invalid ${table}.${field}`)
    record[field] = copyJson(item)
  }
  return record
}

function tableSpec(table) {
  return {
    valueSchema: {
      parse(raw) {
        try {
          return normalizeRecord(table, raw)
        } catch {
          // Single JSON units cannot back up individual rows. Skip the value, not the domain.
          return { __corrupt: true, rawType: typeof raw }
        }
      },
    },
  }
}

function isGlobal(raw) {
  return isObject(raw) && raw.schemaVersion === INITIAL_GLOBAL.schemaVersion &&
    isCount(raw.generation) && isTime(raw.updatedAt)
}

function domainSpec(name, onInvalidGlobal) {
  const schema = {
    parse(raw) {
      if (raw === null) throw new Error('global cannot be null')
      if (isGlobal(raw)) {
        return { schemaVersion: raw.schemaVersion, generation: raw.generation, updatedAt: raw.updatedAt }
      }
      onInvalidGlobal()
      return { ...INITIAL_GLOBAL }
    },
    safeParse(raw) {
      try {
        return { success: true, data: schema.parse(raw) }
      } catch (error) {
        return { success: false, error }
      }
    },
  }
  return {
    name,
    version: INITIAL_GLOBAL.schemaVersion,
    layout: 'single',
    tables: Object.fromEntries(TABLE_NAMES.map((table) => [table, tableSpec(table)])),
    global: { schema, initial: { ...INITIAL_GLOBAL } },
  }
}

const isTombstone = (record) => record.locked === true || record.cleaned === true ||
  Boolean(record.mergeCommit) || record.state === 'merged' || record.state === 'discarded'
const OPEN_WORKTREE_STATES = new Set([
  'active', 'ready', 'cleanup-failed', 'ready_for_review', 'cleanup_failed', 'merge_conflict',
])
const CLOSED_WORKTREE_STATES = new Set(['closed', 'merged', 'discarded'])
const needsWorktreeReview = (record) => record.state === 'discarded'
  ? record.cleaned === false
  : !CLOSED_WORKTREE_STATES.has(record.state) || record.cleaned !== true ||
    !(record.state === 'merged' || record.mergeCommit)
const TERMINAL_DISPATCH_STATES = new Set([
  'ended', 'completed', 'interrupted', 'aborted', 'failed', 'lost',
])

function lastTouched(record) {
  return record.updatedAt ?? record.endedAt ?? record.createdAt ?? record.startedAt
}

function historyKeys(records, max, cutoff) {
  const retained = []
  const expired = []
  for (const [id, record] of records) {
    const timestamp = lastTouched(record)
    if (timestamp !== undefined && timestamp <= cutoff) expired.push(id)
    else retained.push([id, timestamp ?? Number.NEGATIVE_INFINITY])
  }
  retained.sort(([, left], [, right]) => right - left)
  return [...expired, ...retained.slice(max).map(([id]) => id)]
}

/** One store per plugin instance. Reads return detached data; writes settle after durability. */
export function createStateStore({
  ctx, facility, domainName = 'dsh_orchestrator_state', logger, limits, now = Date.now,
} = {}) {
  if (!isText(domainName) || !DOMAIN_NAME.test(domainName) || /\s/.test(domainName)) {
    throw new TypeError('invalid storage domain name')
  }
  const records = Object.fromEntries(TABLE_NAMES.map((table) => [table, new Map()]))
  const handles = Object.create(null)
  let domain
  let generation = 0
  let corruptCount = 0
  let unsafeState = false
  let opened = false
  let closing = false
  let openPromise
  let closePromise
  let writeChain = Promise.resolve()

  function warn(message) {
    try {
      logger?.warn?.(`orchestrator: state store: ${message}`)
    } catch {
      // Logging must not prevent fallback or teardown.
    }
  }

  function currentTime() {
    const value = now()
    if (!isTime(value)) throw new TypeError('invalid state store clock')
    return value
  }

  function hydrate(candidate, spec) {
    const loaded = Object.fromEntries(TABLE_NAMES.map((table) => [table, new Map()]))
    const candidateHandles = Object.create(null)
    let skipped = 0
    for (const table of TABLE_NAMES) {
      const handle = candidate.table(table)
      candidateHandles[table] = handle
      for (const [encoded, value] of handle.entries()) {
        const record = spec.tables[table].valueSchema.parse(value)
        const id = record[TABLES[table].key]
        if (record.__corrupt || encodeRecordKey(id) !== encoded) {
          skipped += 1
          continue
        }
        loaded[table].set(id, record)
      }
    }
    return { loaded, candidateHandles, skipped }
  }

  async function start() {
    let candidate
    try {
      const storage = facility ?? ctx?.get?.('storageDomain')
      if (typeof storage?.open === 'function') {
        const spec = domainSpec(domainName, () => {
          unsafeState = true
          warn('invalid global data; using defaults')
        })
        candidate = await storage.open(spec)
        const { loaded, candidateHandles, skipped } = hydrate(candidate, spec)
        corruptCount = skipped
        if (skipped > 0) {
          unsafeState = true
          warn(`skipped ${skipped} corrupt record(s) while opening ${domainName}`)
        }

        const current = spec.global.schema.parse(candidate.global.get())
        const next = {
          schemaVersion: INITIAL_GLOBAL.schemaVersion,
          generation: current.generation + 1,
          updatedAt: currentTime(),
        }
        if (!isGlobal(next)) throw new RangeError('invalid next storage generation')
        // Do not rewrite a single-layout document before a damaged ledger is reviewed.
        if (!unsafeState) await candidate.global.set(next)
        Object.assign(records, loaded)
        Object.assign(handles, candidateHandles)
        generation = next.generation
        domain = candidate
      }
    } catch (error) {
      unsafeState = true
      warn(`cannot open ${domainName}; using memory: ${error instanceof Error ? error.message : String(error)}`)
      if (candidate) {
        try {
          await candidate.close()
        } catch (closeError) {
          warn(`cannot release partially opened ${domainName}: ${String(closeError)}`)
        }
      }
    }
    if (!domain) generation = 1
    opened = true
    return store
  }

  function open() {
    if (closing) return Promise.resolve(false)
    openPromise ??= Promise.resolve().then(start)
    return openPromise
  }

  function flush() {
    return writeChain
  }

  function close() {
    closing = true
    closePromise ??= Promise.resolve().then(async () => {
      // Opening may already have claimed a host domain; let it finish before releasing it.
      await openPromise
      await flush()
      await domain?.close()
    })
    return closePromise
  }

  function enqueue(write) {
    if (closing || !openPromise) return Promise.resolve(false)
    const pending = writeChain.then(async () => {
      if (!opened) await openPromise
      return write()
    })
    // Observe failures on the tail without turning the caller's failed write into success.
    writeChain = pending.then(() => {}, () => {})
    return pending
  }

  function put(table, value) {
    if (closing || !openPromise) return Promise.resolve(false)
    let record
    try {
      // Capture the input before yielding to the queue; callers may reuse the original object.
      record = normalizeRecord(table, value)
    } catch (error) {
      return enqueue(() => { throw error })
    }
    const id = record[TABLES[table].key]
    return enqueue(async () => {
      await handles[table]?.put(encodeRecordKey(id), copyJson(record))
      records[table].set(id, record)
      return true
    })
  }

  async function remove(table, id) {
    if (!records[table].has(id)) return false
    await handles[table]?.delete(encodeRecordKey(id))
    return records[table].delete(id)
  }

  async function removeMany(table, ids) {
    const present = [...new Set(ids)].filter((id) => records[table].has(id))
    if (present.length === 0) return 0
    const handle = handles[table]
    if (typeof handle?.deleteMany === 'function') {
      await handle.deleteMany(present.map(encodeRecordKey))
      for (const id of present) records[table].delete(id)
    } else {
      for (const id of present) await remove(table, id)
    }
    return present.length
  }

  function deleteLeases(ids) {
    if (closing || !openPromise) return Promise.resolve(false)
    if (!isIdList(ids)) return enqueue(() => { throw new TypeError('lease IDs must be an array of strings') })
    const keys = [...ids]
    return enqueue(() => removeMany('leases', keys))
  }

  function get(table, id) {
    const record = records[table].get(id)
    return record === undefined ? undefined : copyJson(record)
  }

  function list(table) {
    return [...records[table].values()].map((record) => copyJson(record))
  }

  function pruneHistory(options = {}) {
    if (closing || !openPromise) return Promise.resolve(false)
    const settings = { ...limits, ...options }
    const forcePruneTombstones = options?.forcePruneTombstones === true &&
      process.env.NODE_TEST_CONTEXT !== undefined
    return enqueue(async () => {
      const at = settings.now ?? currentTime()
      if (!isTime(at)) throw new TypeError('invalid history pruning time')
      const resolved = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, initial]) => [
        key, isCount(settings[key]) ? settings[key] : initial,
      ]))
      const cutoff = at - resolved.terminalTtlMs
      const protectedChildren = new Set()
      for (const record of records.worktrees.values()) {
        if (!needsWorktreeReview(record)) continue
        if (record.childId) protectedChildren.add(record.childId)
        for (const childId of record.childIds ?? []) protectedChildren.add(childId)
      }
      const delegates = [...records.delegates].filter(([id, record]) => {
        const wakeup = record.wakeActionKey && records.actions.get(record.wakeActionKey)
        if (!TERMINAL_DISPATCH_STATES.has(record.dispatchState) || protectedChildren.has(id) ||
            record.pendingNextTurn || (record.wakeActionKey && wakeup?.phase !== 'done')) return false
        if (!record.worktreeId) return true
        const worktree = records.worktrees.get(record.worktreeId)
        return Boolean(worktree) && !needsWorktreeReview(worktree)
      })
      const worktrees = [...records.worktrees].filter(([, record]) => {
        if (OPEN_WORKTREE_STATES.has(record.state)) return false
        // Explicit escape hatch for unit tests only; never sourced from production limits.
        if (isTombstone(record)) return forcePruneTombstones
        return CLOSED_WORKTREE_STATES.has(record.state)
      })
      const leases = [...records.leases].filter(([, record]) => isTime(record.expiresAt) && record.expiresAt <= at)
      const actions = [...records.actions].filter(([, record]) => record.phase === 'done')

      return {
        worktrees: await removeMany('worktrees', historyKeys(worktrees, resolved.maxClosedWorktrees, cutoff)),
        delegates: await removeMany('delegates', historyKeys(delegates, resolved.maxTerminalDelegates, cutoff)),
        leases: await removeMany('leases', leases.map(([id]) => id)),
        actions: await removeMany('actions', historyKeys(actions, resolved.maxDoneActions, cutoff)),
      }
    })
  }

  const isPersistent = () => domain !== undefined
  const store = {
    open, close, flush, isPersistent, pruneHistory,
    hasUnsafeState: () => unsafeState,
    getSnapshot: () => ({
      generation, persistent: isPersistent(), corruptCount,
      worktrees: list('worktrees'), delegates: list('delegates'),
      leases: list('leases'), actions: list('actions'),
    }),
    putWorktree: (record) => put('worktrees', record),
    deleteWorktree: (id) => enqueue(() => remove('worktrees', id)),
    getWorktree: (id) => get('worktrees', id),
    listWorktrees: () => list('worktrees'),
    putDelegate: (record) => put('delegates', record),
    deleteDelegate: (id) => enqueue(() => remove('delegates', id)),
    getDelegate: (id) => get('delegates', id),
    listDelegates: (parentId) => parentId === undefined ? list('delegates')
      : [...records.delegates.values()].filter(row => row.parentId === parentId).map(row => copyJson(row)),
    putLease: (record) => put('leases', record),
    deleteLease: (id) => enqueue(() => remove('leases', id)),
    deleteLeases,
    getLease: (id) => get('leases', id),
    listLeases: () => list('leases'),
    putAction: (record) => put('actions', record),
    deleteAction: (id) => enqueue(() => remove('actions', id)),
    getAction: (id) => get('actions', id),
    listActions: () => list('actions'),
  }
  return store
}
