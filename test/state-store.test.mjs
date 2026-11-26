import assert from 'node:assert/strict'
import test from 'node:test'
import { createStateStore, decodeRecordKey, encodeRecordKey } from '../lib/state-store.js'

const DOMAIN = 'dsh_orchestrator_state'
const TABLES = ['worktrees', 'delegates', 'leases', 'actions']
const SAFE_KEY = /^[a-zA-Z0-9_-]+$/
const clone = (value) => JSON.parse(JSON.stringify(value))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function createMockFacility({ beforeOpen, beforeMutation } = {}) {
  const disk = new Map()
  const active = new Set()
  const operations = []
  const specs = []

  function documentFor(name) {
    if (!disk.has(name)) {
      disk.set(name, { global: null, tables: Object.fromEntries(TABLES.map((name) => [name, new Map()])) })
    }
    return disk.get(name)
  }

  return {
    operations, specs, active,
    document: (name = DOMAIN) => documentFor(name),
    async open(spec) {
      const { name, version, layout, tables, global } = spec
      assert.match(name, /^[a-z][a-z0-9_]*$/)
      assert.equal(version, 1)
      assert.equal(layout, 'single')
      assert.notEqual(spec.invalidRecords, 'backup-and-skip')
      assert.deepEqual(Object.keys(tables), TABLES)
      assert.deepEqual(global.initial, { schemaVersion: 1, generation: 0, updatedAt: 0 })
      const nullCheck = global.schema.safeParse(null)
      assert.equal(nullCheck.success, false)
      assert.equal(nullCheck.error.message, 'global cannot be null')
      if (active.has(name)) throw new Error(`already-open: ${name}`)
      active.add(name)
      specs.push(spec)
      try {
        await beforeOpen?.()
        const document = documentFor(name)
        let current = document.global === null ? global.initial : global.schema.parse(clone(document.global))
        let closed = false
        const assertOpen = () => assert.equal(closed, false, 'domain used after close')
        const mutate = async (operation) => {
          assertOpen()
          operations.push(operation)
          await beforeMutation?.(operation)
          assertOpen()
        }
        const handles = Object.fromEntries(Object.entries(tables).map(([table, { valueSchema }]) => {
          const raw = document.tables[table]
          const values = new Map([...raw].map(([key, value]) => {
            assert.match(key, SAFE_KEY)
            return [key, valueSchema.parse(clone(value))]
          }))
          async function remove(keys, kind) {
            keys.forEach((key) => assert.match(key, SAFE_KEY))
            await mutate({ kind, table, keys })
            let removed = 0
            for (const key of keys) {
              raw.delete(key)
              if (values.delete(key)) removed += 1
            }
            return removed
          }
          return [table, {
            entries() {
              assertOpen()
              return [...values].values()
            },
            async put(key, value) {
              assert.match(key, SAFE_KEY)
              await mutate({ kind: 'put', table, key })
              raw.set(key, clone(value))
              values.set(key, value)
            },
            async delete(key) {
              return await remove([key], 'delete') > 0
            },
            deleteMany: (keys) => remove(keys, 'deleteMany'),
          }]
        }))
        return {
          global: {
            get() {
              assertOpen()
              return current
            },
            async set(value) {
              await mutate({ kind: 'global', generation: value.generation })
              document.global = clone(value)
              current = value
            },
          },
          table(table) {
            return handles[table]
          },
          async close() {
            assertOpen()
            operations.push({ kind: 'close', name })
            closed = true
            active.delete(name)
          },
        }
      } catch (error) {
        active.delete(name)
        throw error
      }
    },
  }
}

const worktree = { id: 'tree/1', childIds: ['child/1', 'stage/2'], state: 'merged', mergeCommit: 'abc', cleaned: true }
const delegate = { childId: 'child/1', writeScope: ['src/'], dispatchState: 'ended' }
const lease = {
  leaseId: 'lease:1', ownerKind: 'delegate', ownerId: 'child/1', expiresAt: 200,
  entries: [{ kind: 'dir', path: '/repo/src', key: '/repo/src' }],
}
const action = {
  key: 'settle:root1:child1:run:1', kind: 'settle', phase: 'done', detail: { delivered: ['native'] },
}

function logCollector() {
  const warnings = []
  return { warnings, logger: { warn: (message) => warnings.push(message) } }
}

test('record key encoding is canonical, reversible and collision-free for both Unicode forms', () => {
  const originals = [
    '', 'settle:root1:child1:run:1', 'batch-1:item:0', 'batch-1/item.0', 'batch-1 item 0',
    'a:b', 'a/b', 'a_b', 'k_YTpi', '__proto__', '工作/🧪:1', 'é', 'e\u0301', '\uD800', '\uDC00', '�',
  ]
  const encoded = originals.map(encodeRecordKey)
  assert.equal(new Set(encoded).size, originals.length)
  encoded.forEach((key) => assert.match(key, SAFE_KEY))
  assert.deepEqual(encoded.map(decodeRecordKey), originals)
  for (const invalid of [null, 'foo', 'k_YTpi=', 'k_A', 'k__w', 'k_YTpi\n', 'u_YQA']) {
    assert.throws(() => decodeRecordKey(invalid), TypeError)
  }
  assert.throws(() => encodeRecordKey(1), TypeError)
})

test('missing or throwing optional Cordis service falls back without reading ctx.storage', async () => {
  const { warnings, logger } = logCollector()
  const lookups = []
  const ctx = {
    get(name) {
      lookups.push(name)
      return {}
    },
    get storage() { assert.fail('ctx.storage must never be accessed') },
  }
  const store = createStateStore({ ctx })
  assert.equal(await store.open(), store)
  assert.equal(await store.open(), store)
  assert.equal(store.isPersistent(), false)
  assert.deepEqual(lookups, ['storageDomain'])
  assert.equal(await store.putAction(action), true)
  assert.deepEqual(store.getAction(action.key), action)
  assert.equal(await store.deleteAction(action.key), true)
  assert.equal(await store.deleteAction(action.key), false)
  assert.deepEqual(store.getSnapshot(), {
    generation: 1, persistent: false, corruptCount: 0, worktrees: [], delegates: [], leases: [], actions: [],
  })
  await store.close()

  const older = createStateStore({ ctx: { get() { throw new Error('unavailable') } }, logger })
  await older.open()
  assert.equal(older.isPersistent(), false)
  assert.match(warnings[0], /using memory: unavailable/)
  await older.close()
})

test('explicit facility wins; domain snapshots and all tables survive close and reopen', async () => {
  const facility = createMockFacility()
  const store = createStateStore({ facility, ctx: { get() { assert.fail('unneeded lookup') } }, now: () => 100 })
  assert.equal(store.open(), store.open())
  await store.open()
  await Promise.all([
    store.putWorktree({ ...worktree, unlisted: 'not persisted' }), store.putDelegate(delegate),
    store.putLease(lease), store.putAction(action),
  ])
  await store.flush()
  const first = {
    persistent: true, generation: 1, corruptCount: 0,
    worktrees: [worktree], delegates: [delegate], leases: [lease], actions: [action],
  }
  assert.deepEqual(store.getSnapshot(), first)
  assert.deepEqual(facility.document().global, { schemaVersion: 1, generation: 1, updatedAt: 100 })
  assert.equal(store.close(), store.close())
  await store.close()
  assert.equal(await store.open(), false, 'closed store is not reused by another generation')
  assert.deepEqual(facility.operations.filter(({ kind }) => kind === 'close'), [{ kind: 'close', name: DOMAIN }])
  assert.equal(facility.active.size, 0)
  for (const table of TABLES) assert.equal(facility.document().tables[table].size, 1)
  const peek = { get: (name) => name === 'storageDomain' ? facility : undefined }
  const reopened = createStateStore({ ctx: peek, now: () => 150 })
  await reopened.open()
  assert.deepEqual(reopened.getSnapshot(), { ...first, generation: 2 })
  assert.deepEqual(facility.document().global, { schemaVersion: 1, generation: 2, updatedAt: 150 })
  assert.deepEqual(reopened.getWorktree(worktree.id), worktree)
  assert.deepEqual(reopened.getDelegate(delegate.childId), delegate)
  assert.deepEqual(reopened.getLease(lease.leaseId), lease)
  assert.deepEqual(reopened.listActions(), [action])
  assert.equal(await reopened.deleteWorktree(worktree.id), true)
  assert.equal(await reopened.deleteDelegate(delegate.childId), true)
  assert.equal(await reopened.deleteLease(lease.leaseId), true)
  assert.equal(await reopened.deleteAction(action.key), true)
  await reopened.close()
  for (const table of TABLES) assert.equal(facility.document().tables[table].size, 0)
})

test('an already-open domain and initialization I/O errors fall back without touching stored records', async () => {
  const { warnings, logger } = logCollector()
  let failGlobal = false
  const facility = createMockFacility({ beforeMutation({ kind }) {
    if (failGlobal && kind === 'global') throw new Error('I/O denied')
  } })
  const original = createStateStore({ facility })
  await original.open()
  await original.putWorktree(worktree)
  const duplicate = createStateStore({ facility, logger })
  await duplicate.open()
  assert.equal(duplicate.isPersistent(), false)
  await duplicate.putWorktree({ ...worktree, state: 'active' })
  await duplicate.close()
  assert.equal(facility.active.has(DOMAIN), true)
  assert.equal(facility.document().tables.worktrees.get(encodeRecordKey(worktree.id)).state, 'merged')
  await original.close()

  failGlobal = true
  const failed = createStateStore({ facility, logger })
  await failed.open()
  assert.equal(failed.isPersistent(), false)
  assert.equal(facility.active.size, 0, 'failed initialization releases the claimed domain')
  assert.equal(facility.document().global.generation, 1)
  assert.match(warnings[0], /already-open/)
  assert.match(warnings[1], /I\/O denied/)
  await failed.close()
  failGlobal = false
  const next = createStateStore({ facility })
  await next.open()
  assert.equal(next.getSnapshot().generation, 2)
  assert.deepEqual(next.getWorktree(worktree.id), worktree)
  await next.close()
})

test('corrupt values, key mismatches and invalid global metadata are reported while good data hydrates', async () => {
  const { warnings, logger } = logCollector()
  const facility = createMockFacility()
  const { tables } = facility.document()
  facility.document().global = { schemaVersion: 1, generation: 'bad', updatedAt: 5 }
  tables.worktrees.set(encodeRecordKey(worktree.id), worktree)
  tables.worktrees.set(encodeRecordKey('broken'), { id: 'broken', cleaned: 'yes' })
  tables.leases.set(encodeRecordKey('scalar'), 4)
  tables.delegates.set(encodeRecordKey('null'), null)
  tables.actions.set(encodeRecordKey('mismatch'), { ...action })
  tables.actions.set('legacy_plain_key', { key: 'legacy_plain_key', phase: 'unknown' })
  const store = createStateStore({ facility, logger, now: () => 10 })
  await store.open()
  assert.deepEqual(store.getSnapshot(), {
    generation: 1, persistent: true, corruptCount: 5, worktrees: [worktree], delegates: [], leases: [], actions: [],
  })
  assert.deepEqual(facility.specs[0].tables.worktrees.valueSchema.parse(['raw']), {
    __corrupt: true, rawType: 'object',
  })
  assert.deepEqual(facility.specs[0].tables.worktrees.valueSchema.parse(4), {
    __corrupt: true, rawType: 'number',
  })
  assert.match(warnings[0], /invalid global/)
  assert.match(warnings[1], /skipped 5 corrupt record/)
  await store.pruneHistory({ now: 100, terminalTtlMs: 0 })
  await store.close()
  assert.equal(tables.leases.get(encodeRecordKey('scalar')), 4, 'corrupt media is retained for inspection')
  assert.equal(tables.worktrees.get(encodeRecordKey('broken')).cleaned, 'yes')
})

test('writes capture JSON inputs immediately; rejection does not poison later work or flush', async () => {
  const entered = deferred()
  const blocked = deferred()
  const facility = createMockFacility({ async beforeMutation({ kind, key }) {
    if (key === encodeRecordKey('block')) {
      entered.resolve()
      await blocked.promise
    }
    if (kind === 'put' && key === encodeRecordKey('failure')) throw new Error('write I/O failed')
  } })
  const store = createStateStore({ facility })
  await store.open()
  const first = store.putAction({ key: 'block', phase: 'prepared' })
  await entered.promise
  const failed = assert.rejects(store.putAction({ key: 'failure', phase: 'done' }), /write I\/O failed/)
  const detail = { nested: ['at submission'] }
  const good = store.putAction({ key: 'isolate', phase: 'done', detail })
  detail.nested[0] = 'after submission'
  const badFields = assert.rejects(store.putDelegate({ childId: 'bad', writeScope: [4] }), /delegates.writeScope/)
  const cyclic = {}
  cyclic.cycle = cyclic
  const badJson = assert.rejects(store.putAction({ key: 'cycle', detail: cyclic }), /plain JSON/)
  const badId = assert.rejects(store.putWorktree({ state: 'active' }), /worktrees.id/)
  const flush = store.flush()
  assert.equal(store.getAction('isolate'), undefined)
  blocked.resolve()
  await Promise.all([first, failed, good, badFields, badJson, badId, flush])
  assert.equal(store.getAction('failure'), undefined)
  assert.deepEqual(store.getAction('isolate').detail.nested, ['at submission'])
  store.getSnapshot().actions[1].detail.nested.push('snapshot mutation')
  store.listActions()[1].detail.nested.push('list mutation')
  store.getAction('isolate').detail.nested.push('get mutation')
  assert.deepEqual(store.getAction('isolate').detail.nested, ['at submission'])
  assert.deepEqual(facility.document().tables.actions.get(encodeRecordKey('isolate')).detail.nested, ['at submission'])
  await store.close()
})

test('close drains earlier writes and prevents old closures from overwriting the next generation', async () => {
  const entered = deferred()
  const blocked = deferred()
  const facility = createMockFacility({ async beforeMutation({ kind, key }) {
    if (kind === 'put' && key === encodeRecordKey('blocked')) {
      entered.resolve()
      await blocked.promise
    }
  } })
  const old = createStateStore({ facility })
  await old.open()
  const lateWrite = old.putAction
  const first = old.putAction({ key: 'blocked', phase: 'prepared' })
  await entered.promise
  const second = old.putAction({ key: 'next', phase: 'accepted' })
  const closing = old.close()
  assert.equal(closing, old.close())
  assert.equal(await lateWrite(null), false)
  assert.equal(await old.deleteAction('blocked'), false)
  assert.equal(await old.deleteLeases(null), false)
  assert.equal(await old.pruneHistory(), false)
  assert.equal(facility.active.has(DOMAIN), true)
  blocked.resolve()
  await Promise.all([first, second, closing])
  const next = createStateStore({ facility })
  await next.open()
  assert.equal(next.getSnapshot().generation, 2)
  assert.deepEqual(next.listActions().map(({ key }) => key), ['blocked', 'next'])
  await next.putAction({ key: 'next', phase: 'done' })
  assert.equal(await lateWrite({ key: 'next', phase: 'unknown' }), false)
  assert.equal(next.getAction('next').phase, 'done')
  assert.equal(facility.document().tables.actions.get(encodeRecordKey('next')).phase, 'done')
  await next.close()
})

test('close during in-flight open still releases the host domain once', async () => {
  const blocked = deferred()
  const facility = createMockFacility({ beforeOpen: () => blocked.promise })
  const store = createStateStore({ facility })
  const opening = store.open()
  const queued = store.putAction(action)
  const closing = store.close()
  assert.equal(await store.putAction(action), false)
  blocked.resolve()
  await Promise.all([opening, queued, closing])
  assert.deepEqual(facility.operations.map(({ kind }) => kind), ['global', 'put', 'close'])
  assert.equal(facility.active.size, 0)
})

test('bulk lease deletion deduplicates IDs and does not interleave with other queued operations', async () => {
  const facility = createMockFacility()
  const store = createStateStore({ facility })
  await store.open()
  const other = { ...lease, leaseId: 'other/lease' }
  const ids = [lease.leaseId, lease.leaseId, 'missing', other.leaseId]
  const deletes = store.putLease(lease).then(() => assert.equal(store.getLease(lease.leaseId).leaseId, lease.leaseId))
  const put = store.putLease(other)
  const remove = store.deleteLeases(ids)
  ids.length = 0
  assert.equal(await remove, 2)
  await Promise.all([deletes, put])
  assert.deepEqual(store.listLeases(), [])
  assert.deepEqual(facility.operations.filter(({ kind }) => kind === 'deleteMany'), [{
    kind: 'deleteMany', table: 'leases', keys: [lease.leaseId, other.leaseId].map(encodeRecordKey),
  }])
  assert.equal(await store.deleteLeases(['missing']), 0)
  await store.close()
})

test('history pruning cannot evict protected trees, delegates, leases, or actions even at zero capacity', async () => {
  const facility = createMockFacility()
  const limits = { maxClosedWorktrees: 0, maxTerminalDelegates: 0, maxDoneActions: 0, terminalTtlMs: 0 }
  const store = createStateStore({ facility, limits, now: () => 100 })
  await store.open()
  const protectedTrees = [
    { id: 'locked', state: 'closed', locked: true, childIds: ['stage:0', 'stage:1'] },
    { id: 'commit', state: 'closed', mergeCommit: 'c' },
    { id: 'cleaned', state: 'closed', cleaned: true },
    { id: 'merged', state: 'merged', cleaned: true, childIds: ['reviewed'] },
    { id: 'not-cleaned', state: 'merged', cleaned: false },
    { id: 'discarded', state: 'discarded' },
    { id: 'active', state: 'active', childId: 'active-child' },
    { id: 'ready', state: 'ready', childIds: ['ready-stage'] },
    { id: 'failed', state: 'cleanup-failed' },
    { id: 'host-ready', state: 'ready_for_review' },
    { id: 'host-failed', state: 'cleanup_failed' },
    { id: 'conflict', state: 'merge_conflict' },
  ]
  const protectedDelegates = [
    { childId: 'running', dispatchState: 'running' },
    { childId: 'future', dispatchState: 'unrecognized' },
    { childId: 'attached', worktreeId: 'failed' },
    { childId: 'active-child' },
    { childId: 'ready-stage' },
    { childId: 'stage:1' },
    { childId: 'unremoved-worktree', worktreeId: 'not-cleaned' },
    { childId: 'missing-tree-evidence', worktreeId: 'missing-tree' },
  ]
  const leaves = ['prepared', 'unknown', 'accepted']
  await Promise.all([
    ...protectedTrees.map((record) => store.putWorktree({ ...record, updatedAt: 1 })),
    store.putWorktree({ id: 'closed-no-tombstone', state: 'closed', updatedAt: 1 }),
    ...protectedDelegates.map((record) => store.putDelegate({ dispatchState: 'ended', updatedAt: 1, ...record })),
    store.putDelegate({ childId: 'old-terminal', dispatchState: 'ended', updatedAt: 1 }),
    store.putDelegate({ childId: 'reconciled-terminal', dispatchState: 'completed', updatedAt: 1 }),
    store.putDelegate({ childId: 'reviewed', dispatchState: 'ended', worktreeId: 'merged', updatedAt: 1 }),
    store.putDelegate({ childId: 'legacy-pending', dispatchState: 'ended', auditState: 'pending' }),
    store.putDelegate({ childId: 'legacy-failed', dispatchState: 'ended', auditState: 'failed', auditDeliveredVia: null }),
    store.putLease({ leaseId: 'live', expiresAt: 101 }), store.putLease({ leaseId: 'expired', expiresAt: 100 }),
    store.putLease({ leaseId: 'no-expiry-evidence' }),
    ...leaves.map((phase) => store.putAction({ key: phase, phase, updatedAt: 1 })),
    store.putAction({ key: 'done', phase: 'done', updatedAt: 1 }),
  ])
  assert.equal(Object.hasOwn(store.getDelegate('legacy-pending'), 'auditState'), false)
  assert.deepEqual(await store.pruneHistory(), { worktrees: 1, delegates: 5, leases: 1, actions: 1 })
  assert.deepEqual(store.listWorktrees().map(({ id }) => id), protectedTrees.map(({ id }) => id))
  assert.deepEqual(store.getWorktree('locked').childIds, ['stage:0', 'stage:1'])
  assert.deepEqual(store.listDelegates().map(({ childId }) => childId), protectedDelegates.map(({ childId }) => childId))
  assert.deepEqual(store.listLeases().map(({ leaseId }) => leaseId), ['live', 'no-expiry-evidence'])
  assert.deepEqual(store.listActions().map(({ phase }) => phase), leaves)

  const expected = { ...store.getSnapshot(), generation: 2 }
  await store.close()
  const reopened = createStateStore({ facility })
  await reopened.open()
  assert.deepEqual(reopened.getSnapshot(), expected)
  await reopened.close()
})

test('explicit test override can remove tombstones but cannot prune an open worktree', async () => {
  const store = createStateStore({ limits: { maxClosedWorktrees: 0, forcePruneTombstones: true } })
  await store.open()
  await store.putWorktree({ id: 'test-tombstone', locked: true })
  await store.putWorktree({ id: 'test-open', state: 'cleanup-failed', locked: true })
  assert.equal((await store.pruneHistory()).worktrees, 0, 'limits cannot enable the override')
  assert.equal((await store.pruneHistory({ forcePruneTombstones: true })).worktrees, 1)
  assert.equal(store.getWorktree('test-open').locked, true)
  await store.close()
})

test('history prunes expired records first, then the oldest eligible records to honour caps', async () => {
  const store = createStateStore({ limits: { terminalTtlMs: 30, maxDoneActions: 1 }, now: () => 100 })
  await store.open()
  await store.putAction({ key: 'latest', phase: 'done', createdAt: 99 })
  await store.putAction({ key: 'expired', phase: 'done', updatedAt: 70 })
  await store.putAction({ key: 'older', phase: 'done', updatedAt: 71 })
  await store.putAction({ key: 'pending', phase: 'prepared', updatedAt: 1 })
  assert.deepEqual(await store.pruneHistory(), { worktrees: 0, delegates: 0, leases: 0, actions: 2 })
  assert.deepEqual(store.listActions().map(({ key }) => key), ['latest', 'pending'])
  await store.close()
})
