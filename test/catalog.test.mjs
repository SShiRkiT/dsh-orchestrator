import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CATALOG_KEY,
  catalogOf,
  collectCatalog,
  createCatalogPublisher,
  isVolatileRef,
  viewNames,
} from '../lib/catalog.js'

/** The shared protocol a schemastery `.volatile()` field implements (cosmokit). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** A stand-in for a live volatile config reference. */
function volatileRef(value) {
  let current = value
  return {
    get: () => current,
    [VOLATILE_WRITE]: (next) => {
      current = next
    },
  }
}

/** A registry view shaped like `ctx.tools.view()`: hidden names plus the visible map. */
function view(known, visible) {
  return { knownNames: new Set(known), visible: new Map((visible ?? known).map((name) => [name, { name }])) }
}

test('a view contributes the names it knows, hidden ones included, and its own visible ones', () => {
  const names = viewNames(view(['read', 'edit'], ['edit', 'subagent']))
  // `knownNames` keeps a name a restriction hid, so a denied tool can still be unchecked.
  assert.deepEqual(names.sort(), ['edit', 'read', 'subagent'])
  assert.deepEqual(viewNames(undefined), [])
  assert.deepEqual(viewNames(null), [])
  assert.deepEqual(viewNames({}), [])
})

test('the catalog merges every view into one sorted, de-duplicated list', () => {
  const merged = catalogOf([
    view(['read', 'edit']),
    view(['edit', 'mcp__github__ping'], ['edit', 'mcp__github__ping', 'subagent']),
    view(['read', '', 7]),
  ])
  assert.deepEqual(merged, ['edit', 'mcp__github__ping', 'read', 'subagent'])
  assert.deepEqual(catalogOf([]), [])
  assert.deepEqual(catalogOf(undefined), [])
})

test('collectCatalog unions the global view with every live root agent scope', () => {
  const seen = []
  const rootA = { id: 'a', ctx: { tools: { view: (scope) => { seen.push(scope); return view(['subagent'], ['subagent']) } } } }
  const rootB = { id: 'b', ctx: { tools: { view: () => view(['ask_user_question'], ['ask_user_question']) } } }
  const ctx = {
    tools: { view: () => view(['read', 'edit'], ['read', 'edit']) },
    agents: { roots: () => [rootA, rootB] },
  }
  assert.deepEqual(collectCatalog(ctx), ['ask_user_question', 'edit', 'read', 'subagent'])
  // The scope is the agent itself, which is what the registry's per-scope view expects.
  assert.deepEqual(seen, [rootA])
})

test('collectCatalog survives a missing or throwing registry, scope or root list', () => {
  assert.deepEqual(collectCatalog(undefined), [])
  assert.deepEqual(collectCatalog({}), [])
  const throwing = {
    tools: { view: () => { throw new Error('no view') } },
    agents: { roots: () => { throw new Error('no roots') } },
  }
  assert.deepEqual(collectCatalog(throwing), [])
  const brokenRoot = {
    tools: { view: () => view(['read']) },
    agents: { roots: () => [{ id: 'broken', ctx: { tools: { view: () => { throw new Error('gone') } } } }] },
  }
  assert.deepEqual(collectCatalog(brokenRoot), ['read'])
})

test('only a real volatile reference is writable', () => {
  assert.equal(isVolatileRef(volatileRef([])), true)
  assert.equal(isVolatileRef({ get: () => [] }), false)
  assert.equal(isVolatileRef(undefined), false)
  assert.equal(isVolatileRef('toolCatalog'), false)
})

/** A host-shaped ctx that records what the publisher announces. */
function fakeHost({ entry = 'orchestrator', names = ['read', 'delegate'] } = {}) {
  const events = []
  const ctx = {
    fiber: { entry: { id: entry } },
    emit: (event, ...args) => events.push([event, ...args]),
    logger: { warn: (message) => events.push(['warn', message]) },
  }
  const config = { [CATALOG_KEY]: volatileRef([]) }
  return { ctx, config, events, names, set: (next) => { names.splice(0, names.length, ...next) } }
}

test('publishing commits the catalog and announces the settings document once', () => {
  const host = fakeHost()
  const publisher = createCatalogPublisher({ ctx: host.ctx, config: host.config, collect: () => [...host.names].sort() })
  const first = publisher.publish()
  assert.deepEqual(first, { changed: true, names: ['delegate', 'read'] })
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['delegate', 'read'])
  assert.deepEqual(host.events, [['settings/document-updated', 'orchestrator', 1]])
  assert.deepEqual(publisher.published(), ['delegate', 'read'])

  // The unchanged set publishes nothing at all: no write, no announcement, no gate refresh.
  assert.deepEqual(publisher.publish(), { changed: false, names: ['delegate', 'read'] })
  assert.deepEqual(host.events, [['settings/document-updated', 'orchestrator', 1]])

  host.set(['read', 'mcp__demo__ping'])
  assert.deepEqual(publisher.publish(), { changed: true, names: ['mcp__demo__ping', 'read'] })
  assert.equal(host.events.length, 2)
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['mcp__demo__ping', 'read'])
})

test('the announced namespace is the plugin entry id, with a safe fallback', () => {
  const host = fakeHost({ entry: 'orchestrator-video' })
  const publisher = createCatalogPublisher({ ctx: host.ctx, config: host.config, collect: () => ['read'] })
  publisher.publish()
  assert.deepEqual(host.events[0], ['settings/document-updated', 'orchestrator-video', 1])

  const bare = fakeHost()
  bare.ctx.fiber = undefined
  const fallback = createCatalogPublisher({ ctx: bare.ctx, config: bare.config, collect: () => ['read'] })
  fallback.publish()
  assert.deepEqual(bare.events[0], ['settings/document-updated', 'orchestrator', 1])
})

test('a settings write that resets the field is restored, and announced', () => {
  const host = fakeHost()
  const publisher = createCatalogPublisher({ ctx: host.ctx, config: host.config, collect: () => ['delegate', 'read'] })
  assert.equal(publisher.publish().changed, true)
  assert.equal(host.events.length, 1)
  // A Loader volatile commit puts the profile's stored value back into every reference it
  // was handed, which is exactly what a panel write does to an unchanged catalog.
  host.config[CATALOG_KEY][VOLATILE_WRITE]([])
  assert.deepEqual(host.config[CATALOG_KEY].get(), [])
  assert.deepEqual(publisher.publish(), { changed: false, names: ['delegate', 'read'] })
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['delegate', 'read'])
  assert.equal(host.events.length, 2)
  // With the reference holding the catalog again, another read is free.
  publisher.publish()
  assert.equal(host.events.length, 2)
})

test('an empty read is treated as a failed read, so the last catalog stays', () => {
  const host = fakeHost()
  let names = ['read']
  const publisher = createCatalogPublisher({ ctx: host.ctx, config: host.config, collect: () => names })
  assert.equal(publisher.publish().changed, true)
  names = []
  assert.deepEqual(publisher.publish(), { changed: false, names: ['read'] })
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['read'])
  assert.equal(host.events.length, 1)
})

test('a throwing read is reported, never thrown', () => {
  const host = fakeHost()
  const publisher = createCatalogPublisher({
    ctx: host.ctx,
    config: host.config,
    collect: () => {
      throw new Error('registry exploded')
    },
  })
  assert.deepEqual(publisher.publish(), { changed: false, names: [] })
  assert.equal(host.events.length, 1)
  assert.match(host.events[0][1], /registry exploded/)
})

test('a host without a writable field is warned about once and otherwise ignored', () => {
  const host = fakeHost()
  const config = { [CATALOG_KEY]: [] }
  const publisher = createCatalogPublisher({ ctx: host.ctx, config, collect: () => ['read'] })
  assert.equal(publisher.writable, false)
  assert.equal(publisher.publish().changed, true)
  publisher.publish()
  host.set(['write'])
  publisher.publish()
  const warnings = host.events.filter(([kind]) => kind === 'warn')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][1], /not a volatile reference/)
})

test('a burst of changes is one debounced publish', async () => {
  const host = fakeHost()
  let reads = 0
  const publisher = createCatalogPublisher({
    ctx: host.ctx,
    config: host.config,
    debounceMs: 5,
    collect: () => {
      reads += 1
      return [...host.names].sort()
    },
  })
  publisher.schedule()
  publisher.schedule()
  publisher.schedule()
  assert.equal(reads, 0)
  assert.equal(host.events.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(reads, 1)
  assert.equal(host.events.length, 1)
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['delegate', 'read'])
  publisher.dispose()
})

test('dispose drops a pending read and a disposed publisher does nothing', async () => {
  const host = fakeHost()
  let reads = 0
  const publisher = createCatalogPublisher({
    ctx: host.ctx,
    config: host.config,
    debounceMs: 5,
    collect: () => {
      reads += 1
      return ['read']
    },
  })
  publisher.schedule()
  publisher.dispose()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(reads, 0)
  assert.equal(host.events.length, 0)
  assert.deepEqual(publisher.publish(), { changed: false, names: [] })
})
