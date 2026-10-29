import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * `lib/index.js` is the DSH plugin entry, and it imports three packages the host
 * supplies at runtime (this repo installs none of them). They play no part in the
 * `agent/created` hook under test, so stand-ins let the real `apply` run and the
 * real hook fire. The hook itself, `installGate` and `isDelegatedChild` are the
 * production code; only the outer framework objects are fake.
 */
const dataUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source)

const STUBS = {
  '@deepseek-ai/schemastery': `
    function chain() {
      const node = {}
      node.default = () => chain()
      node.volatile = () => chain()
      node.min = () => chain()
      node.max = () => chain()
      node.step = () => chain()
      return node
    }
    const z = {
      boolean: () => chain(),
      string: () => chain(),
      number: () => chain(),
      array: () => chain(),
      object: () => chain(),
    }
    export default z
  `,
  '@deepseek-ai/dsh-tools': `
    export function defineTool(spec) { return spec }
  `,
  zod: `
    const z = { object: () => ({ strict: () => ({}) }), enum: () => ({}), boolean: () => ({}) }
    export { z }
    export default z
  `,
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier]
    if (stub !== undefined) return { url: dataUrl(stub), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

/**
 * A minimal ctx: only the members `apply` touches, each recording what it got.
 * `enabled` is mutable so a test can flip the switch after installation.
 */
function fakeCtx({ enabled = true, denied = ['edit', 'read'], agents, sessions, stateOf } = {}) {
  const state = { enabled }
  const projections = []
  const tools = []
  const handlers = new Map()
  const effects = []
  const logs = { info: [], warn: [] }
  const ctx = {
    sessionProjections: {
      register: (projection) => projections.push(projection),
      stateOf,
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    subagents: {},
    agents: agents ?? { get: () => undefined },
    sessions: sessions ?? { get: () => undefined, flush: async () => true },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
  }
  const config = {
    enabled: { get: () => state.enabled },
    deniedTools: { get: () => denied },
    workerProvider: { get: () => '' },
    workerModel: { get: () => '' },
    workerReasoningEffort: { get: () => '' },
    superviseEnabled: { get: () => true },
    superviseIntervalSeconds: { get: () => 600 },
    superviseMaxNoticesPerChild: { get: () => 3 },
    superviseNotifyOnNoProgress: { get: () => false },
  }
  return { ctx, config, state, projections, tools, handlers, effects, logs }
}

/** A stand-in agent with its own tool registry, so gate side effects are observable. */
function fakeAgent({ id = 'agent-1', depth, header = {} } = {}) {
  const restricted = []
  const guards = []
  const agent = {
    id,
    options: { provider: 'p', model: 'm', ...(depth === undefined ? {} : { subagentDepth: depth }) },
    session: { header },
    ctx: {
      tools: {
        restrict({ deny }) {
          restricted.push(deny[0])
          return () => {}
        },
        guard(fn) {
          guards.push(fn)
        },
      },
    },
  }
  return { agent, restricted, guards }
}

/** Start the plugin and hand back its `agent/created` handler. */
function start(options) {
  const harness = fakeCtx(options)
  mod.apply(harness.ctx, harness.config)
  const created = harness.handlers.get('agent/created')
  assert.equal(typeof created, 'function', 'apply must subscribe to agent/created')
  return { ...harness, created }
}

test('a child with a persisted delegation depth is never gated', () => {
  // Regression: a cold-resumed child was gated as a main agent, losing every working
  // tool and keeping only delegate/orchestrate. Its depth lives in the session header.
  for (const { agent, restricted, guards } of [
    fakeAgent({ header: { delegationDepth: 1 } }),
    fakeAgent({ header: {} , depth: 1 }),
  ]) {
    const { created } = start()
    created({ agent, source: 'resume' })
    assert.deepEqual(restricted, [], 'restrict must not run for a child')
    assert.equal(guards.length, 0, 'no guard may be registered for a child')
  }
})

test('a main agent is restricted and guarded, and its guard refuses the denied list', () => {
  const { created } = start()
  const { agent, restricted, guards } = fakeAgent()
  created({ agent, source: 'create' })
  // `apply` always merges the shipped list in, so a profile can only extend it.
  assert.deepEqual(restricted, mod.DEFAULT_DENIED_TOOLS)
  assert.equal(guards.length, 1)
  assert.match(guards[0]({ name: 'edit' }), /"edit" is not available to the main agent/)
  assert.equal(guards[0]({ name: 'delegate' }), undefined)
})

test('a resumed agent with a parentSession but no depth is gated and warns', () => {
  const { created, logs } = start()
  const { agent, restricted, guards } = fakeAgent({ id: 'cold-child', header: { parentSession: 'root-session' } })
  created({ agent, source: 'resume' })
  assert.deepEqual(restricted, mod.DEFAULT_DENIED_TOOLS)
  assert.equal(guards.length, 1)
  assert.equal(logs.warn.length, 1)
  assert.match(logs.warn[0], /cold-child/)
  assert.match(logs.warn[0], /parentSession but no delegation depth/)
  // The warning must not leak the conversation itself.
  assert.equal(logs.warn[0].includes('root-session'), false)
})

test('the warning fires only for a resume that fell through the depth test', () => {
  // A normal creation is not a resume, and a resumed child does have a depth.
  const fresh = start()
  fresh.created({ agent: fakeAgent({ header: { parentSession: 'root' } }).agent, source: 'create' })
  assert.equal(fresh.logs.warn.length, 0)

  const resumedChild = start()
  resumedChild.created({ agent: fakeAgent({ header: { parentSession: 'root', delegationDepth: 1 } }).agent, source: 'resume' })
  assert.equal(resumedChild.logs.warn.length, 0)
})

test('the switch being off still installs the guard and stays quiet', () => {
  // The gate is installed even while dispatch mode is off, so flipping the switch on
  // in an open conversation takes effect without a restart; the info log follows the switch.
  const { created, logs } = start({ enabled: false })
  const { agent, restricted, guards } = fakeAgent()
  created({ agent, source: 'create' })
  assert.deepEqual(restricted, [])
  assert.equal(guards.length, 1)
  assert.equal(logs.info.length, 0)
  assert.equal(logs.warn.length, 0)
})

/** Only the members supervision adapters use, with recording friendly defaults. */
function fakeSupervisionHost({ parents = new Map(), sessions = new Map(), stateOf, flush } = {}) {
  const logs = []
  const ctx = {
    agents: { get: (id) => parents.get(id) },
    sessions: {
      get: (id) => sessions.get(id),
      flush: flush ?? (async () => true),
    },
    sessionProjections: { stateOf },
    logger: { warn: (message) => logs.push(message) },
  }
  return { ctx, logs, parents, sessions }
}

test('apply installs a 5000 ms supervision timer and clears it when the effect unloads', () => {
  const timers = []
  const cleared = []
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, unref() {} }
    timers.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => cleared.push(handle)
  try {
    const harness = start()
    // The scan period is fixed: a tick only compares clocks unless a child is due.
    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 5000)
    const timerEffect = harness.effects.find(({ label }) => label === 'orchestrator: supervision timer')
    assert.ok(timerEffect, 'the timer must be owned by an effect')
    timerEffect.dispose()
    assert.deepEqual(cleared, [timers[0]])
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
})

test('onStarted tracks the child and forgets it once the receipt settles', async () => {
  const tracked = []
  const forgotten = []
  const hooks = mod.createSupervisionHooks({
    track: (entry) => tracked.push(entry),
    forget: (childId) => forgotten.push(childId),
  })

  const result = Promise.resolve('done')
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1', result }, { description: '慢活' })
  assert.equal(tracked.length, 1)
  assert.equal(tracked[0].childId, 'child-1')
  assert.equal(tracked[0].parentId, 'parent-1')
  assert.equal(tracked[0].label, '慢活')
  assert.ok(tracked[0].startedAt > 0)
  await result
  await Promise.resolve()
  assert.deepEqual(forgotten, ['child-1'])

  // A rejected receipt is handled silently, never as an unhandled rejection.
  const failed = Promise.reject(new Error('boom'))
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-2', result: failed }, { description: '失败' })
  await failed.catch(() => {})
  await Promise.resolve()
  assert.deepEqual(forgotten, ['child-1', 'child-2'])
})

test('hasPendingNotice recognises its own source and tolerates a broken projection', () => {
  const parent = { id: 'p', session: { id: 's' } }
  const broken = fakeSupervisionHost({ parents: new Map([['p', parent]]) })
  const first = mod.createSupervision({ ctx: broken.ctx, config: {} })
  // The inbox state shape is not a public API: a failure is false, not a throw.
  assert.equal(first.hasPendingNotice('p'), false)
  assert.equal(first.hasPendingNotice('p'), false)
  assert.equal(broken.logs.filter((message) => /cannot read the parent inbox/.test(message)).length, 1)

  const good = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    stateOf: () => ({ 'next-turn': [{ source: { kind: mod.SUPERVISE_SOURCE_KIND } }], 'next-step': [] }),
  })
  const second = mod.createSupervision({ ctx: good.ctx, config: {} })
  assert.equal(second.hasPendingNotice('p'), true)

  const unrelated = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    stateOf: () => ({ 'next-turn': [{ source: { kind: 'schedule' } }], 'next-step': [] }),
  })
  assert.equal(mod.createSupervision({ ctx: unrelated.ctx, config: {} }).hasPendingNotice('p'), false)
})

test('deliver refuses an unknown parent and degrades safely when the llm import fails', async () => {
  const unknown = fakeSupervisionHost()
  const missing = mod.createSupervision({ ctx: unknown.ctx, config: {} })
  assert.equal(await missing.deliver('gone', 'text', ['child']), 'parent-gone')

  const parent = { id: 'p', session: {}, followup() {} }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent]]) })
  let loads = 0
  const broken = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => {
      loads += 1
      throw new Error('package unavailable')
    },
  })
  // A missing host package must not throw, must not be retried every tick, and must
  // not consume the child's notice budget (the supervisor warns and reschedules).
  assert.equal(await broken.deliver('p', 'text', ['child']), 'unavailable')
  assert.equal(await broken.deliver('p', 'text', ['child']), 'unavailable')
  assert.equal(loads, 1)
  assert.equal(host.logs.filter((message) => /cannot load @deepseek-ai\/dsh-llm/.test(message)).length, 1)
})

test('deliver queues exactly one notice with followup, never steer', async () => {
  const calls = { followup: [], steer: 0, flush: [] }
  const parent = {
    id: 'p',
    session: { id: 'parent-session' },
    followup: (message) => calls.followup.push(message),
    steer: () => {
      calls.steer += 1
    },
  }
  const host = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    flush: async (session) => {
      calls.flush.push(session)
      return true
    },
  })
  const { deliver } = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => ({ createUserMessage: (input) => input }),
  })
  assert.equal(await deliver('p', '巡检正文', ['child-1', 'child-2']), 'queued')
  assert.equal(calls.followup.length, 1)
  assert.equal(calls.steer, 0)
  assert.equal(calls.followup[0].content[0].text, '巡检正文')
  assert.deepEqual(calls.followup[0].source, {
    kind: mod.SUPERVISE_SOURCE_KIND,
    form: 'notice',
    senderSessionId: 'child-1',
  })
  assert.equal(calls.flush.length, 1)
})
