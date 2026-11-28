import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SESSION_TOOLS_DOMAIN,
  SESSION_TOOLS_NAMESPACE,
  SESSION_TOOLS_PACKAGE,
  SESSION_TOOLS_TABLE,
  createSessionTools,
  createSessionToolsDescriptors,
  mountSessionToolsRemote,
} from '../lib/session-tools.js'
import { NATIVE_TEAM_TOOLS } from '../lib/gate.js'
import { encodeRecordKey } from '../lib/state-store.js'

function defaultConfig(allowedTools = []) {
  return {
    enabled: true, worktreeIsolationEnabled: true, readOnlyEnabled: false,
    peerReadOnlyConsultEnabled: false, mainRoute: null, workerRoute: null,
    superviseIntervalSeconds: 600, superviseMaxNoticesPerChild: 3,
    superviseUnlimited: false, allowedTools,
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Host-compatible storage fixture; preserves disk state on reopen and enforces single ownership. */
function memoryFacility({ rows = new Map(), hooks = {} } = {}) {
  let held = false
  const events = []
  return {
    rows, events,
    async open(spec) {
      assert.equal(spec.name, SESSION_TOOLS_DOMAIN)
      assert.equal(spec.version, 1)
      assert.deepEqual(Object.keys(spec.tables), [SESSION_TOOLS_TABLE])
      assert.equal(held, false, 'opening an already-held domain')
      held = true
      events.push('open')
      const schema = spec.tables[SESSION_TOOLS_TABLE].valueSchema
      return {
        table(name) {
          assert.equal(name, SESSION_TOOLS_TABLE)
          return {
            entries: () => rows.entries(),
            async put(key, value) {
              const result = await hooks.put?.(key, value)
              if (result === false) return false
              rows.set(key, schema.parse(structuredClone(value)))
            },
            async delete(key) {
              const result = await hooks.delete?.(key)
              return result === false ? false : rows.delete(key)
            },
          }
        },
        async close() {
          await hooks.close?.()
          assert.equal(held, true)
          held = false
          events.push('close')
        },
      }
    },
  }
}

test('scoped records are durable and preserve explicit empty/default snapshots', async (t) => {
  const facility = memoryFacility()
  const original = ['delegate', 'orchestrate']
  let globalAllowed = original
  const create = () => createSessionTools({ facility, globalAllowedFor: () => globalAllowed })
  const first = create()
  t.after(() => first.close())
  const a = await first.get('会话:A')
  const b = await first.get('B')
  assert.deepEqual(a, { sessionId: '会话:A', enabled: false, allowedTools: original, config: defaultConfig(original), revision: a.revision, storageReady: true })
  const custom = await first.set(a.sessionId, ['delegate', 'read', 'delegate'], a.revision)
  assert.deepEqual(custom.allowedTools, ['delegate', 'read'])
  const key = encodeRecordKey(a.sessionId)
  assert.deepEqual(facility.rows.get(key), {
    sessionId: a.sessionId, config: { allowedTools: ['delegate', 'read'] }, revision: a.revision + 1,
    updatedAt: facility.rows.get(key).updatedAt,
  })
  const empty = await first.set(a.sessionId, [], custom.revision)
  assert.deepEqual(first.getSessionOverride(a.sessionId), { active: true, allowedTools: [], revision: empty.revision })
  assert.deepEqual(await first.get('B'), b)
  assert.deepEqual(await first.set('B', original, b.revision), {
    ...b, enabled: true, revision: b.revision + 1,
  })
  await first.close()

  const reopened = create()
  t.after(() => reopened.close())
  assert.deepEqual(await reopened.get(a.sessionId), empty)
  globalAllowed = ['glob']
  assert.deepEqual((await reopened.get('B')).allowedTools, original)
  const cleared = await reopened.clear(a.sessionId, empty.revision)
  assert.deepEqual(cleared, { ...empty, enabled: false, allowedTools: ['glob'], config: defaultConfig(['glob']), revision: empty.revision + 1 })
  assert.equal(facility.rows.has(key), false)
  assert.deepEqual(globalAllowed, ['glob'])
  const stale = await reopened.set(a.sessionId, ['read'], empty.revision)
  assert.equal(stale.error.code, 'REVISION_CONFLICT')
})

test('the synchronous resolver layers defaults, explicit arrays, Team priority and child exemption', async (t) => {
  const controller = createSessionTools({ facility: memoryFacility() })
  t.after(() => controller.close())
  const a = { session: { id: 'A' } }
  const b = { sessionId: 'B' }
  const child = { session: { id: 'A', header: { delegationDepth: 1 } } }
  const [team] = NATIVE_TEAM_TOOLS
  const options = { catalog: [team], defaultAllowed: ['delegate'], globalAllowed: undefined }
  assert.deepEqual(controller.resolveAllowedTools(a, options), ['delegate', team])
  assert.deepEqual(controller.resolveAllowedTools(a, { ...options, globalAllowed: [] }), [])
  const initial = await controller.get('A')
  await controller.set('A', ['read', ...NATIVE_TEAM_TOOLS], initial.revision)
  assert.deepEqual(controller.resolveAllowedTools(a, options), ['read', ...NATIVE_TEAM_TOOLS])
  assert.deepEqual(controller.resolveAllowedTools(a, { ...options, allowAgentTeam: false }), ['read'])
  assert.deepEqual(controller.resolveAllowedTools(b, options), ['delegate', team])
  assert.equal(controller.resolveAllowedTools(child, options), undefined)
})

test('a writing revision commits only after durability and concurrent CAS has one winner', async (t) => {
  const entered = deferred()
  const durable = deferred()
  let puts = 0
  const facility = memoryFacility({ hooks: { async put() {
    puts += 1
    entered.resolve()
    await durable.promise
  } } })
  const controller = createSessionTools({ facility })
  t.after(() => { durable.resolve(); return controller.close() })
  const initial = await controller.get('A')
  const names = ['first']
  const first = controller.set('A', names, initial.revision)
  names.push('mutated later')
  const second = controller.set('A', ['second'], initial.revision)
  await entered.promise
  assert.deepEqual(await controller.get('A'), initial)
  assert.equal(facility.rows.size, 0)
  durable.resolve()
  assert.deepEqual(await first, { ...initial, enabled: true, allowedTools: ['first'], config: defaultConfig(['first']), revision: initial.revision + 1 })
  assert.equal((await second).error.code, 'REVISION_CONFLICT')
  assert.equal(puts, 1)
})

// Simulate only the public idle-maintenance contract. A real driver also opens
// the turn and resolves its tool set when the queued wake is released.
function blankRoot(id) {
  let activity, abort
  return {
    id, session: { id },
    runMaintenance(job) {
      if (activity) throw new Error('already has active work')
      abort = new AbortController()
      activity = job(abort.signal).finally(() => { activity = undefined })
      return activity
    },
    cancel() { abort.abort() },
    async firstStep(read) { await activity; return read() },
  }
}

for (const succeeds of [true, false]) {
  test(`a blank root waits for its own ${succeeds ? 'confirmed' : 'failed'} Dispatch write before its first step`, async (t) => {
    const stored = deferred()
    const a = blankRoot('A'), b = blankRoot('B')
    const agents = new Map([[a.id, a], [b.id, b]])
    agents.turnBoundaryOf = () => ({ lastTurn: 0, openTurnStartSeq: null })
    const controller = createSessionTools({ ctx: { agents }, facility: memoryFacility({ hooks: { put: () => stored.promise } }) })
    t.after(() => { stored.resolve(false); return controller.close() })
    const before = await controller.get('A')
    const saving = controller.setConfig('A', { enabled: false }, before.revision)
    let started = false
    const prompt = a.firstStep(() => { started = true; return controller.resolveSessionConfig(a).enabled })
    assert.equal(await b.firstStep(() => controller.resolveSessionConfig(b).enabled), true)
    assert.equal(started, false, 'the same-root wake must wait before tool-set resolution')
    assert.equal(controller.resolveSessionConfig(a).enabled, true)
    stored.resolve(succeeds)
    const result = await saving
    assert.equal(succeeds ? result.config.enabled : result.error.code, succeeds ? false : 'STORAGE_WRITE_FAILED')
    assert.equal(await prompt, !succeeds)
  })
}

test('the reservation follows the last queued Dispatch write, including a clear', async (t) => {
  const deleting = deferred(), entered = deferred()
  const a = blankRoot('A')
  const agents = { get: () => a, turnBoundaryOf: () => ({ lastTurn: 0, openTurnStartSeq: null }) }
  const controller = createSessionTools({ ctx: { agents }, facility: memoryFacility({ hooks: {
    async delete() { entered.resolve(); return deleting.promise },
  } }) })
  t.after(() => { deleting.resolve(true); return controller.close() })
  const before = await controller.get('A')
  const first = controller.setConfig('A', { enabled: false }, before.revision)
  const second = controller.clear('A', before.revision + 1)
  let started = false
  const prompt = a.firstStep(() => { started = true; return controller.resolveSessionConfig(a).enabled })
  await entered.promise
  assert.equal((await first).config.enabled, false)
  assert.equal(started, false)
  deleting.resolve(true)
  assert.equal((await second).enabled, false)
  assert.equal(await prompt, true)
})

for (const release of ['cancel', 'deadline', 'already started', 'busy', 'unrelated setting']) {
  test(`a session write keeps the last confirmed policy on ${release}`, async (t) => {
    const stored = deferred()
    const a = blankRoot('A')
    const agents = { get: () => a, turnBoundaryOf: () => ({ lastTurn: release === 'already started' ? 1 : 0, openTurnStartSeq: null }) }
    if (release === 'busy') a.runMaintenance = () => { throw Error('already has active work') }
    const controller = createSessionTools({ ctx: { agents }, facility: memoryFacility({ hooks: { put: () => stored.promise } }) })
    t.after(() => { stored.resolve(false); return controller.close() })
    if (release === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] })
    const before = await controller.get('A')
    const patch = release === 'unrelated setting' ? { allowedTools: [] } : { enabled: false }
    const saving = controller.setConfig('A', patch, before.revision)
    if (release === 'cancel') a.cancel()
    if (release === 'deadline') t.mock.timers.tick(5000)
    assert.equal(await a.firstStep(() => controller.resolveSessionConfig(a).enabled), true)
    stored.resolve(true)
    assert.deepEqual((await saving).config, { ...before.config, ...patch })
  })
}

test('failed, corrupt or missing storage never acknowledges a volatile session write', async (t) => {
  const hooks = { put: async () => false }
  const controller = createSessionTools({ facility: memoryFacility({ hooks }) })
  t.after(() => controller.close())
  const initial = await controller.get('A')
  assert.equal((await controller.set('A', ['read'], initial.revision)).error.code, 'STORAGE_WRITE_FAILED')
  assert.deepEqual(await controller.get('A'), initial)
  delete hooks.put
  const saved = await controller.set('A', ['read'], initial.revision)
  hooks.delete = async () => { throw new Error('disk refused') }
  assert.equal((await controller.clear('A', saved.revision)).error.code, 'STORAGE_WRITE_FAILED')
  assert.deepEqual(await controller.get('A'), saved)
  delete hooks.delete
  assert.equal((await controller.clear('A', saved.revision)).enabled, false)

  const domains = [undefined, { open: async () => { throw new Error('open refused') } }, memoryFacility({
    rows: new Map([[encodeRecordKey('A'), { sessionId: 'B', allowedTools: [], revision: 1, updatedAt: 1 }]]),
  })]
  for (const facility of domains) {
    const unavailable = createSessionTools({ facility })
    t.after(() => unavailable.close())
    const state = await unavailable.get('A')
    assert.equal(state.storageReady, false)
    assert.equal((await unavailable.set('A', [], state.revision)).error.code, 'STORAGE_UNAVAILABLE')
    assert.equal((await unavailable.clear('A', state.revision)).error.code, 'STORAGE_UNAVAILABLE')
  }
})

test('replacement waits for the old domain close and sees its durable snapshot', async (t) => {
  const closing = deferred()
  const facility = memoryFacility({ hooks: { close: () => closing.promise } })
  const old = createSessionTools({ facility })
  t.after(() => { closing.resolve(); return old.close() })
  const initial = await old.get('A')
  const saved = await old.set('A', ['read'], initial.revision)
  // Simulate Cordis giving different context proxies for the same host facility.
  const wrap = () => ({ [Symbol.for('cordis.original')]: facility, open: facility.open })
  const replacement = createSessionTools({ facility: wrap() })
  t.after(() => replacement.close())
  const oldClosed = old.close()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(facility.events, ['open'])
  closing.resolve()
  await oldClosed
  assert.deepEqual(await replacement.get('A'), saved)
  assert.deepEqual(facility.events, ['open', 'close', 'open'])
})

test('validate live and cold sessions and distinguish missing from lookup errors', async (t) => {
  const inspected = []
  const controller = createSessionTools({ facility: memoryFacility(), ctx: {
    sessions: new Map([['live', {}]]),
    sessionQuery: { async inspectSession(id, callback) {
      inspected.push(id)
      if (id === 'cold') return callback({})
      if (id === 'missing') throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      throw new Error('disk offline')
    } },
  } })
  t.after(() => controller.close())
  const live = await controller.get('live')
  assert.equal((await controller.set('live', [], live.revision)).enabled, true)
  assert.deepEqual(inspected, [])
  const cold = await controller.get('cold')
  assert.equal((await controller.set('cold', [], cold.revision)).enabled, true)
  assert.equal((await controller.get('missing')).error.code, 'SESSION_NOT_FOUND')
  assert.equal((await controller.set('missing', [], live.revision)).error.code, 'SESSION_NOT_FOUND')
  assert.equal((await controller.clear('missing', live.revision)).error.code, 'SESSION_NOT_FOUND')
  assert.equal((await controller.get('broken')).error.code, 'SESSION_LOOKUP_FAILED')
  for (const id of ['', '   ', null]) {
    assert.equal((await controller.get(id)).error.code, 'INVALID_ARGUMENT')
    assert.equal((await controller.set(id, [], live.revision)).error.code, 'INVALID_ARGUMENT')
  }
  for (const names of ['read', [1], [' '], [undefined]]) {
    assert.equal((await controller.set('live', names, live.revision)).error.code, 'INVALID_ARGUMENT')
  }
  assert.equal((await controller.clear('live', undefined)).error.code, 'INVALID_ARGUMENT')
})

test('Typert binding exposes strict, top-level session resources and releases both registrations', async () => {
  const ctx = {}
  const services = new Map()
  const registered = new Map()
  ctx.get = (name) => name === 'typert' ? { register } : undefined
  ctx.provide = (name, service) => {
    services.set(name, service)
    return () => services.delete(name)
  }
  function register(contribution) {
    assert.equal(contribution.face, 'host')
    assert.equal(contribution.package, SESSION_TOOLS_PACKAGE)
    for (const descriptor of contribution.invocations) registered.set(descriptor.id, descriptor)
    return async () => registered.clear()
  }
  const controller = createSessionTools()
  const remote = mountSessionToolsRemote(ctx, controller)
  assert.equal(remote.available, true)
  const service = services.get(SESSION_TOOLS_NAMESPACE)
  assert.equal(Object.isFrozen(service.typertRemote), true)
  assert.deepEqual(service.typertRemote, { service, serviceKey: SESSION_TOOLS_NAMESPACE, namespace: SESSION_TOOLS_NAMESPACE })
  assert.deepEqual([...registered.keys()], createSessionToolsDescriptors().map(({ id }) => id))
  assert.deepEqual([...registered.values()].map(({ method, parameters }) => [method, parameters.map(({ name }) => name)]), [
    ['get', ['sessionId']], ['set', ['sessionId', 'allowedTools', 'expectedRevision']],
    ['setConfig', ['sessionId', 'config', 'expectedRevision']], ['clear', ['sessionId', 'expectedRevision']],
  ])
  for (const descriptor of registered.values()) {
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
    const [session] = descriptor.parameters
    assert.deepEqual({ name: session.name, wire: session.wire, source: session.source }, {
      name: 'sessionId', wire: 'sessionId', source: 'json',
    })
    assert.equal(session.codec.acceptsUndefined, undefined)
    const codecs = [...descriptor.parameters.map(({ codec }) => codec), descriptor.result]
    assert.ok(codecs.every(({ mode, typeSymbol, create }) => mode === 'strict' && typeSymbol && typeof create === 'function'))
    assert.throws(() => session.codec.create().parse(undefined), /sessionId/)
    assert.throws(() => session.codec.create().parse(' '), /sessionId/)
  }
  const state = await service.get('A')
  assert.equal(state.sessionId, 'A')
  const parse = [...registered.values()].find(({ method }) => method === 'get').result.create().parse
  assert.deepEqual(parse(state), state)
  assert.deepEqual(state.config, defaultConfig())
  assert.throws(() => parse({ ...state, allowedTools: ['read'] }), /must match config.allowedTools exactly/)
  assert.throws(() => parse({ ...state, config: { ...state.config, extra: true } }), TypeError)
  await remote.dispose()
  await remote.dispose()
  assert.equal(remote.available, false)
  assert.equal(services.size + registered.size, 0)
  const absent = mountSessionToolsRemote({}, controller)
  assert.equal(absent.available, false)
  assert.match(absent.error, /unavailable/)
  await absent.dispose()
  await controller.close()
})
