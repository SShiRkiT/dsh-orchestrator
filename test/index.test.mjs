import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { allowGuard } from '../lib/gate.js'

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
      node.default = (value) => Object.assign(chain(), { defaultValue: value })
      node.volatile = () => node
      node.min = () => chain()
      node.max = () => chain()
      node.step = () => chain()
      node.description = () => node
      node.describe = () => chain()
      return node
    }
    const z = {
      boolean: () => chain(),
      string: () => chain(),
      number: () => chain(),
      array: () => chain(),
      object: (fields) => Object.assign(chain(), { fields }),
    }
    export default z
  `,
  '@deepseek-ai/dsh-tools': `
    export function defineTool(spec) { return spec }
  `,
  '@deepseek-ai/dsh-llm': `
    let seq = 0
    export function createUserMessage(input) {
      seq += 1
      return { id: 'stub-user-msg-' + seq, role: 'user', ...input }
    }
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
 * Every tool a host could register: the file/search/shell/web tools a main agent must not
 * touch, the native delegation tools, an MCP tool, and the `run_code` transport. The gate
 * hides all of them except the ones the whitelist names (and never `run_code`, which
 * `tools.restrict` refuses).
 */
const HOST_TOOLS = [
  'apply_patch',
  'bash',
  'create_goal',
  'decompress',
  'edit',
  'glob',
  'grep',
  'list_agents',
  'mcp__demo__ping',
  'ops_bash',
  'ops_read_files',
  'pwsh',
  'ralph',
  'read',
  'read_image',
  'run_code',
  'schedule_create',
  'search_context',
  'subagent',
  'update_goal',
  'web_fetch',
  'web_search',
  'workflow',
  ...mod.DEFAULT_ALLOWED_TOOLS,
]

/**
 * What `tools.definitions(scope)` hands back before the plugin wraps it: every name the
 * scope can see, global and scope-local alike. `run_code` is left out on purpose — a host
 * in native mode never lists the PTC transport, so the default surface models that; a test
 * that needs the PTC shape adds it explicitly.
 */
const SURFACE_TOOLS = HOST_TOOLS.filter((name) => name !== 'run_code')
const DISPATCH_TOOLS = ['delegate', 'orchestrate', 'delegate_status', 'worktree_manage']

/** The names one `definitions()` result carries. */
const namesOf = (list) => list.map((definition) => definition.name)

/** A minimal ctx: only the members `apply` touches, each recording what it got.
 *  `enabled` and the live `allowedTools` are mutable so a test can flip the switch or the
 *  whitelist after installation, the way a panel write does.
 */
function fakeCtx({
  enabled = true,
  allowed,
  agents,
  sessions,
  subagents,
  stateOf,
  snapshot,
  catalogNames = HOST_TOOLS,
  surface = SURFACE_TOOLS,
} = {}) {
  const state = { enabled, allowed, worktreeIsolationEnabled: undefined, readOnlyEnabled: false }
  const tools = []
  const handlers = new Map()
  // The options each subscription was made with: a lifecycle edge of a child is dispatched
  // with the child's parent as carrier, so the retry listener has to be registered global.
  const handlerOptions = new Map()
  const effects = []
  const logs = { info: [], warn: [] }
  const emitted = []
  // The live tool catalog the plugin publishes, as a writable volatile reference.
  let catalog = []
  const catalogRef = {
    get: () => catalog,
    [Symbol.for('cosmokit.volatile.write')]: (next) => {
      catalog = next
    },
  }
  const ctx = {
    sessionProjections: { stateOf, snapshot },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
      // The context-global view the catalog reads: names plus an empty visible map.
      view: () => ({ knownNames: new Set(catalogNames), visible: new Map() }),
      // The one exit a model request is built from. `apply` wraps it, so a test reads back
      // exactly the declarations a main agent or a child would be offered.
      definitions: () => surface.map((name) => ({ name })),
    },
    subagents: subagents ?? {},
    agents: agents ?? { get: () => undefined },
    sessions: sessions ?? { get: () => undefined, flush: async () => true },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, handler, options) {
      handlers.set(event, handler)
      handlerOptions.set(event, options)
    },
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    emit: (event, ...args) => emitted.push([event, ...args]),
  }
  const config = {
    enabled: { get: () => state.enabled },
    worktreeIsolationEnabled: { get: () => state.worktreeIsolationEnabled },
    readOnlyEnabled: { get: () => state.readOnlyEnabled },
    allowedTools: { get: () => state.allowed },
    workerProvider: { get: () => '' },
    workerModel: { get: () => '' },
    workerReasoningEffort: { get: () => '' },
    superviseEnabled: { get: () => true },
    superviseIntervalSeconds: { get: () => 600 },
    superviseMaxNoticesPerChild: { get: () => 3 },
    superviseUnlimited: { get: () => false },
    superviseNotifyOnNoProgress: { get: () => false },
    toolCatalog: catalogRef,
  }
  return {
    ctx,
    config,
    state,
    tools,
    handlers,
    handlerOptions,
    effects,
    logs,
    emitted,
    catalogNames,
    catalog: () => catalog,
    // The Loader commits a volatile field from the profile's raw value on every settings
    // write, which for an unset key means the empty array. Tests replay that.
    resetCatalog: () => {
      catalog = []
    },
  }
}

/**
 * A stand-in agent with its own tool registry. `restrict` only records calls — the plugin
 * is expected never to make one, which is what keeps `tools/change` quiet — and `guard`
 * hands back a disposer so the agent/disposed path is observable.
 */
function fakeAgent({ id = 'agent-1', depth, header = {} } = {}) {
  const restricted = []
  const guards = []
  const registered = []
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
          let live = true
          return () => {
            if (!live) return
            live = false
            const at = guards.indexOf(fn)
            if (at !== -1) guards.splice(at, 1)
          }
        },
        register(tool) {
          registered.push(tool)
          return () => {}
        },
      },
    },
  }
  return { agent, restricted, guards, registered }
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
    fakeAgent({ header: {}, depth: 1 }),
  ]) {
    const { created, ctx } = start()
    created({ agent, source: 'resume' })
    assert.deepEqual(restricted, [], 'a child triggers no restriction at all')
    assert.equal(guards.length, 0, 'no guard may be registered for a child')
    assert.equal(namesOf(ctx.tools.definitions(agent)).includes('read'), true, 'the child keeps its working tools')
  }
})

test('a delegated child loses the delegation tools and keeps the native ones', () => {
  // Workers inherit the global table, so the surface drops the plugin's own pair — their
  // descriptions are written for a planner. The host's `subagent`, `workflow` and every
  // scope-local `ops_*` tool stay untouched: nothing is restricted.
  const { created, ctx } = start()
  const { agent, restricted, registered } = fakeAgent({ header: { delegationDepth: 1 } })
  created({ agent, source: 'resume' })
  const names = namesOf(ctx.tools.definitions(agent))
  assert.deepEqual(restricted, [], 'a child is masked by the surface, not by restrict')
  assert.deepEqual(registered, [], 'a child gets no scoped tool registration')
  assert.equal(names.includes('delegate'), false)
  assert.equal(names.includes('orchestrate'), false)
  for (const name of ['subagent', 'workflow', 'ops_bash', 'ops_read_files', 'read', 'edit']) {
    assert.equal(names.includes(name), true, name)
  }
})

test('a child is masked on its very first request, and no restriction is ever installed', () => {
  // The surface derives the deny list from the scope, so the first `preStep` assembly of a
  // new worker already lacks the pair: no window, no `tools/change`, no cache churn.
  const { created, ctx } = start()
  const { agent, restricted } = fakeAgent({ depth: 1 })
  created({ agent, source: 'create' })
  assert.equal(namesOf(ctx.tools.definitions(agent)).includes('delegate'), false)
  assert.equal(namesOf(ctx.tools.definitions(agent)).includes('orchestrate'), false)
  assert.deepEqual(restricted, [])
})

test('a main agent gets the full rule and no scoped registration', () => {
  const { created, tools } = start()
  const { agent, registered } = fakeAgent()
  created({ agent, source: 'create' })
  assert.deepEqual(registered, [], 'the global pair is enough for a main agent')
  const delegate = tools.find((tool) => tool.name === 'delegate')
  const orchestrate = tools.find((tool) => tool.name === 'orchestrate')
  assert.match(delegate.description, /主代理仅规划/)
  // The rule is rendered once: the batch brief only points back at it.
  assert.match(orchestrate.description, /^主代理规则同 delegate/)
  assert.equal(orchestrate.description.includes('主代理白名单:'), false)
  assert.equal(orchestrate.description.includes('子代理无收尾中断'), false)
})

test('a panel write reaches the next request without a re-mask or a new registration', () => {
  const { created, ctx, state, tools } = start()
  const delegated = tools.length
  const main = fakeAgent()
  created({ agent: main.agent, source: 'create' })
  assert.deepEqual(namesOf(ctx.tools.definitions(main.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.deepEqual(main.restricted, [], 'the surface needs no restriction')

  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), true)
  state.allowed = mod.DEFAULT_ALLOWED_TOOLS
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), false)
  assert.equal(tools.length, delegated, 'a whitelist change registers nothing')
  assert.deepEqual(main.restricted, [], 'and still restricts nothing')
})

test('a main agent is guarded, and the surface carries only the shipped whitelist', () => {
  const { created, ctx } = start()
  const { agent, restricted, guards } = fakeAgent()
  created({ agent, source: 'create' })
  // No mask any more: every name the whitelist leaves out is filtered at definitions(),
  // own-scope tools such as `ops_bash` and the native `subagent` included.
  assert.deepEqual(restricted, [])
  assert.equal(guards.length, 1)
  assert.deepEqual(namesOf(ctx.tools.definitions(agent)), mod.DEFAULT_ALLOWED_TOOLS)
  for (const name of ['read', 'edit', 'ops_bash', 'ops_read_files', 'subagent', 'workflow']) {
    assert.equal(namesOf(ctx.tools.definitions(agent)).includes(name), false, name)
  }
  for (const name of mod.DEFAULT_ALLOWED_TOOLS) assert.equal(guards[0]({ name }), undefined, name)
  assert.match(guards[0]({ name: 'edit' }), /"edit" is not available to the main agent/)
  assert.match(guards[0]({ name: 'subagent' }), /"subagent" is not available to the main agent/)
})

test('the shipped whitelist contains nine planning and acceptance tools, and every other name is refused', () => {
  const shipped = mod.DEFAULT_ALLOWED_TOOLS
  assert.equal(shipped.length, 9)
  for (const name of [
    'delegate',
    'delegate_status',
    'worktree_manage',
    'orchestrate',
    'send_message',
    'interrupt_agent',
    'todo_write',
    'ask_user_question',
    'compress',
  ]) {
    assert.equal(shipped.includes(name), true, name)
    assert.equal(allowGuard(shipped)({ name }), undefined, name)
  }
  for (const name of [
    'read',
    'edit',
    'write',
    'apply_patch',
    'grep',
    'glob',
    'bash',
    'pwsh',
    'ops_bash',
    'web_fetch',
    'web_search',
    'subagent',
    'workflow',
    'ralph',
    'decompress',
    'session_search',
    'session_trace',
    'session_event_search',
    'session_event_read',
    'session_event_trace',
    'search_context',
    'acp_status',
    'mcp_custom_tool',
    // `wait_agent` is a host tool the default whitelist deliberately leaves out: a main
    // agent must not block on a wait, it dispatches and is woken by the completion notice.
    'wait_agent',
  ]) {
    assert.equal(shipped.includes(name), false, name)
    assert.match(allowGuard(shipped)({ name }), /is not available to the main agent/, name)
  }
  assert.equal(shipped.includes('wait_agent'), false)

  const { created, ctx } = start()
  const { agent, guards } = fakeAgent()
  created({ agent, source: 'create' })
  const names = namesOf(ctx.tools.definitions(agent))
  assert.equal(names.includes('compress'), true, 'compress is whitelisted, so it stays declared')
  assert.equal(guards[0]({ name: 'compress' }), undefined, 'compress must pass the guard')
  for (const name of ['ops_bash', 'read', 'decompress']) {
    assert.match(guards[0]({ name }), /is not available to the main agent/, name)
  }
  assert.equal(guards[0]({ name: 'delegate' }), undefined)
})

test('a resumed agent with a parentSession but no depth is gated and warns', () => {
  const { created, ctx, logs } = start()
  const { agent, restricted, guards } = fakeAgent({ id: 'cold-child', header: { parentSession: 'root-session' } })
  created({ agent, source: 'resume' })
  assert.deepEqual(restricted, [], 'the surface replaces the old mask entirely')
  assert.deepEqual(namesOf(ctx.tools.definitions(agent)), mod.DEFAULT_ALLOWED_TOOLS)
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

test('the switch being off still installs the guard and restores host tools without dispatch or governance tools', () => {
  // The gate is installed even while dispatch mode is off, so flipping the switch on
  // in an open conversation takes effect without a restart; the info log follows the switch.
  const { created, ctx, state, logs, tools } = start({ enabled: false })
  const { agent, restricted, guards } = fakeAgent()
  const expectedOff = SURFACE_TOOLS.filter((name) => !DISPATCH_TOOLS.includes(name))
  const delegate = tools.find((tool) => tool.name === 'delegate')
  const orchestrate = tools.find((tool) => tool.name === 'orchestrate')
  created({ agent, source: 'create' })
  assert.deepEqual(restricted, [])
  assert.equal(guards.length, 1)
  assert.deepEqual(namesOf(ctx.tools.definitions(agent)), expectedOff, 'off restores host tools and hides dispatch and governance tools')
  assert.equal(delegate.description.includes('主代理仅规划'), false)
  assert.equal(orchestrate.description.includes('主代理规则同 delegate'), false)
  assert.equal(guards[0]({ name: 'edit' }), undefined)
  assert.match(guards[0]({ name: 'delegate' }), /"delegate" is disabled while dispatch mode is off/)
  assert.equal(logs.info.length, 0)
  assert.equal(logs.warn.length, 0)

  // Turning it on filters the next request even though nothing was re-installed.
  state.enabled = true
  assert.deepEqual(namesOf(ctx.tools.definitions(agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.match(delegate.description, /^主代理仅规划/)
  assert.match(orchestrate.description, /^主代理规则同 delegate/)
  assert.deepEqual(restricted, [], 'still no restriction')
})

test('a whitelist written in the panel reaches an open conversation, live', () => {
  // The whitelist is read per call, so a panel write lands in a conversation that was
  // already open: checking `read` lets it through at once, unchecking `delegate` blocks it.
  const { created, state } = start()
  const { agent, guards } = fakeAgent()
  created({ agent, source: 'create' })
  assert.match(guards[0]({ name: 'read' }), /not available to the main agent/)
  assert.equal(guards[0]({ name: 'delegate' }), undefined)

  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.equal(guards[0]({ name: 'read' }), undefined)

  state.allowed = mod.DEFAULT_ALLOWED_TOOLS.filter((name) => name !== 'delegate')
  assert.match(guards[0]({ name: 'delegate' }), /"delegate" is not available to the main agent/)
  assert.equal(guards[0]({ name: 'orchestrate' }), undefined)

  // Unchecking every box disables every tool: an empty whitelist is not "use the default".
  state.allowed = []
  for (const name of ['delegate', 'orchestrate', 'compress', 'read']) {
    assert.match(guards[0]({ name }), /is not available to the main agent/, name)
  }
})

test('the whitelist clause follows the live config without re-registering', () => {
  // The description is a getter, so the same registered tool renders the new list: a
  // settings change reaches the prompt without a restart or a new session. The clause is
  // rendered by `delegate` only — `orchestrate` points at it instead of repeating it.
  const { tools, state } = start()
  const delegate = tools.find((tool) => tool.name === 'delegate')
  const orchestrate = tools.find((tool) => tool.name === 'orchestrate')
  const allowedOf = (tool) =>
    /主代理白名单: ([^。]+)。/.exec(tool.description)?.[1]
  assert.equal(allowedOf(delegate), mod.DEFAULT_ALLOWED_TOOLS.join(', '))
  assert.equal(allowedOf(orchestrate), undefined)

  state.allowed = ['delegate', 'orchestrate', 'read']
  assert.equal(allowedOf(delegate), 'delegate, orchestrate, read')
  assert.equal(orchestrate.description.includes('delegate, orchestrate, read'), false)

  // The rule has a second sentence for the case where the panel unchecks everything.
  state.allowed = []
  assert.match(delegate.description, /当前主代理无可用工具（白名单为空）。/)
  assert.equal(allowedOf(delegate), undefined)
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

/** The supervisor surface the hooks touch, with real add/remove semantics. */
function recordingSupervisor() {
  const entries = new Map()
  const tracked = []
  return {
    entries,
    tracked,
    track: (entry) => {
      tracked.push(entry)
      entries.set(entry.childId, entry)
    },
    forget: (childId) => entries.delete(childId),
    has: (childId) => entries.has(childId),
  }
}

test('a cold-resumed worker is tracked again with the log head as its baseline', async () => {
  // Regression: interrupt settles the receipt, the receipt forgets the child, and the
  // send_message cold resume created it again without registering it — supervision was
  // silently lost for the rest of that worker's life.
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: (childId) => (childId === 'child-1' ? 42 : 0) })
  let settle
  const result = new Promise((resolve) => {
    settle = resolve
  })
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1', result }, { description: '慢活' })
  assert.equal(registry.entries.size, 1)

  settle('done')
  await result
  await Promise.resolve()
  assert.equal(registry.entries.size, 0, 'the settled receipt releases the child')

  hooks.onResumed({ id: 'child-1', session: { header: { parentSession: 'parent-1', delegationDepth: 1 } } })
  const entry = registry.entries.get('child-1')
  assert.ok(entry, 'the resumed worker must be supervised again')
  assert.equal(entry.parentId, 'parent-1', 'the dispatch record names the real parent')
  assert.equal(entry.label, '慢活', 'the task description survives the interrupt')
  assert.equal(entry.resumed, true)
  assert.equal(entry.sinceSeq, 42, 'pre-interrupt history is not reported as new')
  assert.ok(entry.startedAt > 0)
})

test('a resumed agent this plugin never dispatched stays unsupervised', () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: () => 7 })
  // The host's own subagent tool also creates delegated children; they never entered
  // supervision, so a resume of one must not start a notice timer on it.
  hooks.onResumed({ id: 'host-child', session: { header: { parentSession: 'parent-1', delegationDepth: 1 } } })
  assert.equal(registry.entries.size, 0)
  assert.equal(registry.tracked.length, 0)
})

test('a repeated resume event does not restart the clock', () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: () => 5 })
  hooks.onStarted({ id: 'p' }, { childId: 'c', result: null }, { description: 'job' })
  registry.forget('c')
  hooks.onResumed({ id: 'c' })
  const first = registry.entries.get('c')
  const count = registry.tracked.length

  hooks.onResumed({ id: 'c' })
  assert.equal(registry.tracked.length, count, 'no second registration')
  assert.equal(registry.entries.get('c'), first, 'the deadline and budget are untouched')
})

test('an unreadable log head falls back to the zero baseline and still tracks', () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, {
    headSeq: () => {
      throw new Error('session log unavailable')
    },
  })
  hooks.onStarted({ id: 'p' }, { childId: 'c', result: null }, { description: 'job' })
  registry.forget('c')
  assert.doesNotThrow(() => hooks.onResumed({ id: 'c' }))
  assert.equal(registry.entries.get('c').sinceSeq, 0)
})

test('the dispatch memory is bounded, so a very old worker is not re-armed', async () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: () => 0 })
  const total = 129
  for (let index = 0; index < total; index += 1) {
    hooks.onStarted({ id: 'p' }, { childId: `child-${index}`, result: null }, { description: 'job' })
  }
  // Every registration is released, as a batch of finished receipts would leave them.
  registry.entries.clear()
  // The oldest dispatch record is evicted; the newest is still remembered.
  hooks.onResumed({ id: 'child-0' })
  assert.equal(registry.entries.has('child-0'), false)
  hooks.onResumed({ id: `child-${total - 1}` })
  assert.equal(registry.entries.has(`child-${total - 1}`), true)
})

test('headSeq reads the highest seq in the child log, and 0 when it cannot', () => {
  const parent = { id: 'p', session: { id: 's' } }
  const child = { id: 'c', log: [{ seq: 3, type: 'x' }, { seq: 9, type: 'y' }, { type: 'no-seq' }] }
  const host = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    sessions: new Map([['c', child]]),
  })
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {} })
  assert.equal(supervision.headSeq('c'), 9)
  // The baseline is a cold-resume detail; an unreadable log must never throw into the hook.
  assert.equal(supervision.headSeq('gone'), 0)
  assert.doesNotThrow(() => supervision.headSeq(undefined))
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
  host.parents.set('child-1', {})
  host.parents.set('child-2', {})
  const { deliver, supervisor } = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => ({ createUserMessage: (input) => input }),
  })
  for (const childId of ['child-1', 'child-2']) supervisor.track({ childId, parentId: 'p' })
  assert.equal(await deliver('p', '巡检正文', ['child-1', 'child-2']), 'queued')
  assert.equal(calls.followup.length, 1)
  assert.equal(calls.steer, 0)
  assert.equal(calls.followup[0].content[0].text, '巡检正文')
  assert.deepEqual(calls.followup[0].source, {
    kind: mod.SUPERVISE_SOURCE_KIND,
    form: 'notice',
    senderSessionId: 'child-1',
    childIds: ['child-1', 'child-2'],
  })
  assert.equal(calls.flush.length, 1)
})

test('liveConfig reads superviseUnlimited on every tick, so the panel switch applies at once', async () => {
  const state = { unlimited: false, max: 0 }
  const config = {
    superviseEnabled: { get: () => true },
    superviseIntervalSeconds: { get: () => 600 },
    superviseMaxNoticesPerChild: { get: () => state.max },
    superviseNotifyOnNoProgress: { get: () => false },
    superviseUnlimited: { get: () => state.unlimited },
  }
  const queued = []
  const parent = { id: 'p', session: { id: 'parent-session' }, followup: (message) => queued.push(message) }
  const child = { id: 'child-1', log: [] }
  const host = fakeSupervisionHost({
    parents: new Map([
      ['p', parent],
      ['child-1', child],
    ]),
    sessions: new Map([['child-1', child]]),
  })
  const supervision = mod.createSupervision({
    ctx: host.ctx,
    config,
    loadLlm: async () => ({ createUserMessage: (input) => input }),
  })
  const base = Date.now()
  supervision.supervisor.track({
    childId: 'child-1',
    parentId: 'p',
    label: '慢活',
    startedAt: base - 11 * 60_000,
  })

  // A zero budget with the unlimited switch off is "supervision off": nothing is sent,
  // but the running child stays registered.
  await supervision.supervisor.tick(base)
  assert.equal(queued.length, 0)
  assert.equal(supervision.supervisor.size(), 1)

  // Flipping the switch on the live config is enough: no rebuild, no re-dispatch.
  state.unlimited = true
  await supervision.supervisor.tick(base + 600_000)
  assert.equal(queued.length, 1)
  assert.match(queued[0].content[0].text, /第 1 次/)
  assert.equal(queued[0].content[0].text.includes('/0'), false)

  // Turning it back off restores the numeric budget, which is already spent.
  state.unlimited = false
  state.max = 1
  await supervision.supervisor.tick(base + 1_200_000)
  assert.equal(queued.length, 1)
  assert.equal(supervision.supervisor.size(), 1)
})

test('a panel write reaches every live main agent on its next request, not by re-masking', () => {
  const main = fakeAgent()
  const child = fakeAgent({ id: 'child-1', depth: 1 })
  // `agents.list()` returns every live agent; the catalog keeps only the roots, so the
  // delegated child (depth 1) must be filtered out by `isDelegatedChild`.
  const { created, ctx, state } = start({
    agents: { get: () => undefined, list: () => [main.agent, child.agent] },
  })
  created({ agent: main.agent, source: 'create' })
  created({ agent: child.agent, source: 'create' })
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), false)
  assert.equal(
    namesOf(ctx.tools.definitions(child.agent)).includes('read'),
    true,
    'a child keeps its working tools',
  )

  // The panel checks `read`: allowedTools gains it and the next request sees it, live.
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), true)
  assert.equal(
    namesOf(ctx.tools.definitions(main.agent)).includes('ops_bash'),
    false,
    'every other name stays out',
  )
  assert.equal(
    namesOf(ctx.tools.definitions(child.agent)).includes('delegate'),
    false,
    'the child deny list never moves',
  )

  state.allowed = mod.DEFAULT_ALLOWED_TOOLS
  assert.equal(namesOf(ctx.tools.definitions(main.agent)).includes('read'), false)
  assert.deepEqual(main.restricted, [], 'no restriction was ever installed')
  assert.deepEqual(child.restricted, [])
})

test('the enable switch flips the surface and rules in the open session through the same live read', () => {
  const main = fakeAgent()
  const { created, ctx, handlers, state, tools } = start({
    agents: { get: () => undefined, list: () => [main.agent] },
  })
  const expectedOff = SURFACE_TOOLS.filter((name) => !DISPATCH_TOOLS.includes(name))
  const delegate = tools.find((tool) => tool.name === 'delegate')
  const orchestrate = tools.find((tool) => tool.name === 'orchestrate')
  created({ agent: main.agent, source: 'create' })
  const volatile = handlers.get('loader/volatile-update')
  assert.equal(typeof volatile, 'function', 'apply must subscribe to loader/volatile-update')
  assert.deepEqual(namesOf(ctx.tools.definitions(main.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.match(delegate.description, /^主代理仅规划/)
  assert.match(orchestrate.description, /^主代理规则同 delegate/)

  state.enabled = false
  volatile()
  assert.deepEqual(namesOf(ctx.tools.definitions(main.agent)), expectedOff, 'off restores host tools and hides dispatch and governance tools')
  assert.equal(delegate.description.includes('主代理仅规划'), false)
  assert.equal(orchestrate.description.includes('主代理规则同 delegate'), false)
  assert.equal(main.guards[0]({ name: 'edit' }), undefined, 'and lets regular host calls through')
  for (const name of DISPATCH_TOOLS) assert.match(main.guards[0]({ name }), /disabled while dispatch mode is off/, name)

  state.enabled = true
  volatile()
  assert.deepEqual(namesOf(ctx.tools.definitions(main.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  assert.match(delegate.description, /^主代理仅规划/)
  assert.match(orchestrate.description, /^主代理规则同 delegate/)
  assert.match(main.guards[0]({ name: 'edit' }), /not available to the main agent/)
  assert.equal(main.guards[0]({ name: 'delegate' }), undefined)
})

test('a disposed agent drops its guard, and a later write reinstalls nothing', () => {
  const main = fakeAgent()
  const live = [main.agent]
  const { created, handlers, state } = start({ agents: { get: () => undefined, list: () => live } })
  created({ agent: main.agent, source: 'create' })
  const volatile = handlers.get('loader/volatile-update')
  const disposed = handlers.get('agent/disposed')
  assert.equal(typeof disposed, 'function', 'apply must subscribe to agent/disposed')
  assert.equal(main.guards.length, 1)
  assert.deepEqual(main.restricted, [])

  disposed({ agent: main.agent })
  assert.equal(main.guards.length, 0, 'the guard is unregistered with the agent')

  // A later write with the agent gone has nothing to reinstall, and must not throw.
  live.length = 0
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.doesNotThrow(() => volatile())
  assert.deepEqual(main.restricted, [])
})

test('an agent created before the plugin mounted is already covered by the surface', () => {
  // The wrapper reads the scope, not a registry of hooked agents: a missed creation hook
  // only means no guard for that agent, never an unfiltered request.
  const preExisting = fakeAgent({ id: 'pre-existing' })
  const { ctx, state } = start()
  assert.deepEqual(namesOf(ctx.tools.definitions(preExisting.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.equal(namesOf(ctx.tools.definitions(preExisting.agent)).includes('read'), true)
})

test('a volatile write is never fatal, with or without a usable registry', () => {
  const { handlers } = start()
  const volatile = handlers.get('loader/volatile-update')
  assert.doesNotThrow(() => volatile())

  const broken = start({
    agents: {
      get: () => undefined,
      list: () => {
        throw new Error('registry gone')
      },
    },
  })
  assert.doesNotThrow(() => broken.handlers.get('loader/volatile-update')())
})

test('the surface is owned by one effect and hands the host method back on dispose', () => {
  const harness = start()
  const installed = harness.effects.find(({ label }) => label === 'orchestrator: tool surface')
  assert.equal(typeof installed?.dispose, 'function', 'apply must own the wrapper through an effect')
  const main = fakeAgent()
  assert.deepEqual(namesOf(harness.ctx.tools.definitions(main.agent)), mod.DEFAULT_ALLOWED_TOOLS)
  installed.dispose()
  assert.deepEqual(namesOf(harness.ctx.tools.definitions(main.agent)), SURFACE_TOOLS)
})

// ---- Automatic retry of a child that died without a closing message ---------------------

test('onStarted hands the dispatched child to the retry policy, and only for a real dispatch', () => {
  const tracked = []
  const retry = {
    track: (childId, record) => {
      tracked.push({ childId, ...record })
      return true
    },
  }
  const hooks = mod.createSupervisionHooks({ track() {}, forget() {} }, { retry })
  const result = Promise.resolve('done')
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1', result }, { description: '慢活' })
  assert.deepEqual(tracked, [{ childId: 'child-1', parentId: 'parent-1', label: '慢活' }])
  // An event without the two ids is not a dispatch: nothing can be retried later.
  hooks.onStarted({}, { childId: 'child-2', result })
  hooks.onStarted({ id: 'parent-1' }, { result })
  assert.equal(tracked.length, 1)
})

test('a retry bookkeeping failure never breaks the dispatch', () => {
  const tracked = []
  const hooks = mod.createSupervisionHooks(
    { track: (entry) => tracked.push(entry), forget() {} },
    {
      retry: {
        track: () => {
          throw new Error('the policy is broken')
        },
      },
    },
  )
  assert.doesNotThrow(() => hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1' }, {}))
  assert.equal(tracked.length, 1)
})

test('apply listens for the settlement edge globally, so a child-scoped emission reaches it', () => {
  const harness = start()
  const listener = harness.handlers.get('subagent/end')
  assert.equal(typeof listener, 'function', 'apply must subscribe to subagent/end')
  // The host dispatches this edge with the child's parent as carrier: a scoped listener is
  // filtered out, so the option is what makes the retry possible at all.
  assert.deepEqual(harness.handlerOptions.get('subagent/end'), { global: true })
  // A malformed event is ignored rather than thrown into the emitter.
  assert.doesNotThrow(() => listener(undefined))
  assert.doesNotThrow(() => listener({ id: '' }))
})

function gitFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phase2-integration-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const cwd = fs.realpathSync.native(temporary)
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Phase 2 Test')
  git('config', 'user.email', 'phase2-test@example.invalid')
  git('config', 'core.autocrlf', 'false')
  fs.mkdirSync(path.join(cwd, 'nested'))
  fs.writeFileSync(path.join(cwd, 'nested', 'result.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'Initial')
  return { cwd, git }
}

const isolatedClaim = { description: 'write', prompt: 'write result', provider: 'p', model: 'm' }

function phase2Exec(cwd) {
  const { agent } = fakeAgent({ id: 'root', header: { cwd } })
  return { agent, signal: new AbortController().signal }
}

function toolNamed(harness, name) {
  const tool = harness.tools.find((entry) => entry.name === name)
  assert.ok(tool, `${name} must be registered`)
  return tool
}

function beforeMessage(harness, exec, target) {
  assert.deepEqual(harness.handlerOptions.get('tools/pre-execute'), { global: true })
  return harness.handlers.get('tools/pre-execute')({ ...exec, name: 'send_message', arguments: { agent: target } }, async () => ({ kind: 'continue' }))
}

test('dispatch off hides and blocks all four tools, and descendants cannot govern worktrees', async () => {
  assert.equal(mod.Config.fields.worktreeIsolationEnabled.defaultValue, true)
  const harness = start({ enabled: false })
  const root = fakeAgent({ id: 'root' }).agent
  const child = fakeAgent({ id: 'child', depth: 1 }).agent
  for (const name of DISPATCH_TOOLS) {
    assert.equal(namesOf(harness.ctx.tools.definitions(root)).includes(name), false, name)
    assert.equal(namesOf(harness.ctx.tools.definitions(child)).includes(name), false, name)
    await assert.rejects(toolNamed(harness, name).execute({}, { agent: root }), /disabled while dispatch mode is off/, name)
  }
  harness.state.enabled = true
  const manage = toolNamed(harness, 'worktree_manage')
  assert.equal((await manage.execute({ action: 'list' }, { agent: root })).details.total, 0)
  await assert.rejects(manage.execute({ action: 'list' }, { agent: child }), /仅根代理/)
})

test('phase 2: a delegate closes its physical checkout for review and a reclaimed child cannot receive messages', async (t) => {
  const { cwd, git } = gitFixture(t)
  const exec = phase2Exec(cwd)
  const starts = []
  const harness = start({ subagents: {
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      starts.push(spec)
      fs.writeFileSync(path.join(spec.cwd, 'result.txt'), 'isolated\n')
      return { childId: `isolated-${starts.length}` }
    },
    async resolveName(agent, name, signal) {
      assert.equal(agent, exec.agent)
      assert.equal(signal, exec.signal)
      return name === 'worker-name' ? 'isolated-1' : name
    },
  } })
  const delegate = toolNamed(harness, 'delegate')
  const worktreeManage = toolNamed(harness, 'worktree_manage')
  const status = toolNamed(harness, 'delegate_status')
  const args = { ...isolatedClaim, cwd: 'nested', writeScope: [path.join(cwd, 'nested', 'result.txt')] }
  const first = await delegate.execute(args, exec)
  const second = await delegate.execute(args, exec)
  assert.deepEqual(first.worktree, first.details.worktree)
  assert.notEqual(first.worktree.path, second.worktree.path, 'the same relative scope may run in distinct trees')
  assert.equal(path.normalize(starts[0].cwd), path.join(first.worktree.path, 'nested'))
  assert.equal(path.normalize(first.writeScope.scope[0]), path.join(first.worktree.execCwd, 'result.txt'))
  assert.equal(git('status', '--porcelain'), '', 'the main workspace stays clean')
  const unsettled = await beforeMessage(harness, exec, 'worker-name')
  assert.equal(unsettled.kind, 'deny')
  assert.match(unsettled.reason, /原运行仍在结算/)

  harness.handlers.get('subagent/end')({ id: first.subagentId, stopReason: 'completed' })
  const entry = (await status.execute({ childId: first.subagentId }, exec)).details.items[0]
  assert.equal(entry.leaseState, 'released')
  assert.equal(entry.worktree.state, 'ready_for_review')
  const inspected = await worktreeManage.execute({ action: 'inspect', worktreeId: first.worktree.id }, exec)
  assert.equal(inspected.details.dirty, true)
  assert.equal(inspected.details.aheadCount, 0)

  const discarded = await worktreeManage.execute({ action: 'discard', worktreeId: first.worktree.id, force: true }, exec)
  assert.equal(discarded.details.ok, true)
  assert.equal(fs.existsSync(first.worktree.path), false)
  harness.state.enabled = false
  for (const target of [first.subagentId, 'worker-name']) {
    const decision = await beforeMessage(harness, exec, target)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /worktree-child-locked/)
  }
  for (const { dispose } of harness.effects.toReversed()) dispose?.()
  assert.equal(fs.existsSync(second.worktree.path), true, 'plugin disposal preserves the pending delivery')
})

test('phase 2: items reuse their own checkout, retain failed-stage evidence, and lock every reclaimed stage', async (t) => {
  const { cwd, git } = gitFixture(t)
  const exec = phase2Exec(cwd)
  const stageIds = new Map()
  const harness = start({ subagents: {
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      const item = /item (\d+)/.exec(spec.label)[1]
      const stage = /stage (\d+)/.exec(spec.label)[1]
      const childId = `item-${item}-stage-${stage}`
      stageIds.set(childId, spec.cwd)
      fs.writeFileSync(path.join(spec.cwd, item === '2' ? 'unexpected.txt' : 'result.txt'), `stage ${stage}\n`)
      const failed = item === '2' && stage === '2'
      return {
        childId,
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: failed ? 'error' : 'completed' }),
        dispose: async () => {},
      }
    },
  } })
  const batch = toolNamed(harness, 'orchestrate')
  const manage = toolNamed(harness, 'worktree_manage')
  const result = await batch.execute({
    cwd: 'nested', writeScope: ['result.txt'], items: [1, 2], maxConcurrency: 2,
    stages: [{ name: 'first', prompt: 'write' }, { name: 'second', prompt: 'verify' }], provider: 'p', model: 'm',
  }, exec)
  assert.equal(result.agentsStarted, 4)
  assert.equal(result.results[1], null)
  assert.equal(stageIds.get('item-1-stage-1'), stageIds.get('item-1-stage-2'))
  assert.equal(stageIds.get('item-2-stage-1'), stageIds.get('item-2-stage-2'))
  assert.notEqual(stageIds.get('item-1-stage-1'), stageIds.get('item-2-stage-1'))
  assert.equal(result.errors[0].index, 1)
  assert.match(batch.output.render({}, result)[0].text, /worktree_manage .*inspect \/ merge \/ discard/)
  const rows = (await manage.execute({ action: 'list' }, exec)).details.worktrees
  assert.equal(rows.length, 2)
  assert.ok(rows.every(({ state }) => state === 'ready_for_review'))
  assert.equal(git('status', '--porcelain'), '')
  const discard = await manage.execute({ action: 'discard', worktreeId: result.details.worktrees[0].worktreeId, force: true }, exec)
  assert.equal(discard.details.ok, true)
  for (const childId of ['item-1-stage-1', 'item-1-stage-2']) {
    assert.match((await beforeMessage(harness, exec, childId)).reason, /worktree-child-locked/)
  }
  const remaining = await beforeMessage(harness, exec, 'item-2-stage-1')
  assert.equal(remaining.kind, 'deny')
  assert.match(remaining.reason, /编排阶段不能单独恢复/)
})

test('phase 2: per-call isolation takes precedence over live configuration and rolls back failed launches', async (t) => {
  const { cwd, git } = gitFixture(t)
  const exec = phase2Exec(cwd)
  let launch = 'ok'
  let sequence = 0
  const harness = start({ subagents: {
    resolveMaxDepth: () => 1,
    async startActivation() {
      if (launch === 'throw') throw new Error('launch failed')
      if (launch === 'empty') return {}
      return {
        childId: `worker-${++sequence}`,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }),
      }
    },
  } })
  const delegate = toolNamed(harness, 'delegate')
  const batch = toolNamed(harness, 'orchestrate')
  const args = { ...isolatedClaim, cwd: 'nested', writeScope: ['result.txt'] }
  const batchArgs = { cwd: 'nested', writeScope: args.writeScope, items: [1], stages: [{ name: 'first', prompt: 'write' }], provider: 'p', model: 'm' }
  harness.state.worktreeIsolationEnabled = false
  const shared = await delegate.execute(args, exec)
  assert.equal(shared.worktree, undefined)
  harness.handlers.get('subagent/end')({ id: shared.subagentId, stopReason: 'completed' })
  assert.equal((await batch.execute(batchArgs, exec)).details?.worktrees, undefined)
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1)
  harness.state.readOnlyEnabled = true
  await assert.rejects(delegate.execute({ ...isolatedClaim, readOnly: true, isolation: 'worktree' }, exec), /只读任务/)
  await assert.rejects(batch.execute({ ...batchArgs, isolation: 'unsupported' }, exec), /isolation/)
  launch = 'throw'
  await assert.rejects(delegate.execute({ ...args, isolation: 'worktree', allowNewReason: '验证独立启动回滚' }, exec), /launch failed/)
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1)
  launch = 'empty'
  const failedBatch = await batch.execute({ ...batchArgs, isolation: 'worktree' }, exec)
  assert.equal(failedBatch.agentsStarted, 0)
  assert.match(failedBatch.errors[0].message, /did not return a result promise/)
  assert.deepEqual(failedBatch.details.worktrees, [])
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1)
  launch = 'ok'
  harness.state.worktreeIsolationEnabled = true
  assert.ok((await delegate.execute({ ...args, allowNewReason: '验证默认独立模式' }, exec)).worktree)
})

test('phase 2: a missing checkout blocks both manual delivery and automatic retry', async (t) => {
  const { cwd, git } = gitFixture(t)
  const exec = phase2Exec(cwd)
  const prompts = []
  const harness = start({ subagents: {
    resolveMaxDepth: () => 1,
    startActivation: async () => ({ childId: 'worker-missing' }),
    async prompt(request) { prompts.push(request) },
  } })
  const child = await toolNamed(harness, 'delegate').execute({ ...isolatedClaim, writeScope: ['nested/result.txt'] }, exec)
  assert.ok(child.worktree)
  // Simulate an external operator removing the registered worktree while its child is still active.
  git('worktree', 'remove', '--force', child.worktree.path)
  assert.equal(fs.existsSync(child.worktree.path), false)
  const decision = await beforeMessage(harness, exec, child.subagentId)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /执行目录已缺失/)
  harness.handlers.get('subagent/end')({ id: child.subagentId, stopReason: 'error' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(prompts, [])
  assert.ok(harness.logs.warn.some((line) => /retry: cannot wake subagent worker-missing.*worktree-child-locked/.test(line)))
})

test('a delegate write lease blocks a second writer until the child settles', async () => {
  const started = []
  const harness = start({
    subagents: {
      resolveMaxDepth: () => 1,
      startActivation: async () => {
        const childId = `child-${started.length + 1}`
        started.push(childId)
        return { childId }
      },
    },
  })
  const tool = harness.tools.find(({ name }) => name === 'delegate')
  assert.equal(typeof tool?.execute, 'function', 'apply must register the delegate tool')
  const exec = { agent: { id: 'main-1' }, signal: new AbortController().signal }
  const claim = {
    description: 'edit',
    prompt: 'edit src/a.js',
    cwd: 'C:/repo',
    writeScope: ['src/a.js'],
    provider: 'p',
    model: 'm',
  }

  const first = await tool.execute(claim, exec)
  assert.equal(first.subagentId, 'child-1')
  assert.deepEqual(first.writeScope.scope, ['C:/repo/src/a.js'])
  await assert.rejects(
    () => tool.execute({ ...claim, description: 'overlap' }, exec),
    (error) => error?.code === 'write-scope-conflict',
  )
  assert.equal(started.length, 1, 'the overlapping dispatch never reached the host')

  harness.handlers.get('subagent/end')({ id: 'child-1', stopReason: 'completed' })
  const third = await tool.execute({ ...claim, description: 'after settle' }, exec)
  assert.equal(third.subagentId, 'child-2', 'settlement released the lease')
})

test('a disposed worker releases its write lease without a settlement edge', async () => {
  const started = []
  const harness = start({
    subagents: {
      resolveMaxDepth: () => 1,
      startActivation: async () => {
        const childId = `child-${started.length + 1}`
        started.push(childId)
        return { childId }
      },
    },
  })
  const tool = harness.tools.find(({ name }) => name === 'delegate')
  const exec = { agent: { id: 'main-1' }, signal: new AbortController().signal }
  const claim = {
    description: 'edit',
    prompt: 'edit src/a.js',
    cwd: 'C:/repo',
    writeScope: ['src/a.js'],
    provider: 'p',
    model: 'm',
  }

  const first = await tool.execute(claim, exec)
  const child = fakeAgent({ id: first.subagentId, depth: 1 })
  harness.handlers.get('agent/disposed')({ agent: child.agent })
  const next = await tool.execute({ ...claim, description: 'after dispose' }, exec)
  assert.equal(next.subagentId, 'child-2', 'disposal released the lease')
})

test('apply injects the one lease table into both tools, so delegate and orchestrate exclude each other', async () => {
  const started = []
  const harness = start({
    subagents: {
      resolveMaxDepth: () => 1,
      // `delegate` reads only the child id; a batch also reads the worker's result.
      startActivation: async (spec) => {
        const index = started.length
        started.push(spec)
        return {
          childId: `child-${index + 1}`,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
  })
  const delegate = harness.tools.find(({ name }) => name === 'delegate')
  const orchestrate = harness.tools.find(({ name }) => name === 'orchestrate')
  assert.equal(typeof orchestrate?.execute, 'function', 'apply must register the orchestrate tool')
  const exec = { agent: { id: 'main-1' }, signal: new AbortController().signal }
  const claim = {
    description: 'edit',
    prompt: 'edit src/a.js',
    cwd: 'C:/repo',
    writeScope: ['src/a.js'],
    provider: 'p',
    model: 'm',
  }
  const batch = {
    cwd: 'C:/repo',
    writeScope: ['src/a.js'],
    items: [1],
    stages: [{ name: 's', prompt: 'p' }],
    provider: 'p',
    model: 'm',
  }

  const held = await delegate.execute(claim, exec)
  assert.equal(held.subagentId, 'child-1')
  await assert.rejects(
    () => orchestrate.execute(batch, exec),
    (error) =>
      error?.code === 'write-scope-conflict' &&
      error.details[0].path === 'C:/repo/src/a.js' &&
      error.details[0].owner === 'child-1',
  )
  assert.equal(started.length, 1, 'the refused batch never reached the host')

  harness.handlers.get('subagent/end')({ id: 'child-1', stopReason: 'completed' })
  const result = await orchestrate.execute(batch, exec)
  assert.equal(result.agentsStarted, 1, 'settlement released the delegate lease for the batch')
})

test('disposing the plugin clears the lease table', async () => {
  const started = []
  const harness = start({
    subagents: {
      resolveMaxDepth: () => 1,
      startActivation: async () => {
        const childId = `child-${started.length + 1}`
        started.push(childId)
        return { childId }
      },
    },
  })
  const tool = harness.tools.find(({ name }) => name === 'delegate')
  const exec = { agent: { id: 'main-1' }, signal: new AbortController().signal }
  const claim = {
    description: 'edit',
    prompt: 'edit src/a.js',
    cwd: 'C:/repo',
    writeScope: ['src/a.js'],
    provider: 'p',
    model: 'm',
  }

  await tool.execute(claim, exec)
  const installed = harness.effects.find(({ label }) => label === 'orchestrator: write leases')
  assert.equal(typeof installed?.dispose, 'function', 'apply must own the lease table through an effect')
  installed.dispose()
  const next = await tool.execute({ ...claim, description: 'after reload' }, exec)
  assert.equal(next.subagentId, 'child-2', 'a plugin reload drops the old table')
})

test('the retry prompt goes through subagents.prompt, as a queued turn of the child', async () => {
  const calls = []
  const deliverPrompt = mod.deliverRetryPrompt
  const host = {
    subagents: {
      prompt: async (request, signal) => {
        calls.push({ request, signal })
        return { messageId: 'msg-1' }
      },
    },
  }
  assert.equal(await deliverPrompt(host, 'parent-1', 'child-1', '继续'), 'msg-1')
  assert.equal(calls.length, 1)
  const { request, signal } = calls[0]
  // The host hard-codes `source.kind = 'user'` on this path, so the request carries no
  // source at all; `requestId` is what ends up in `source.rpcId` for tracing.
  assert.equal(typeof request.requestId, 'string')
  assert.match(request.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(request.childSessionId, 'child-1')
  assert.equal(request.delivery, 'queue', 'a retry is a new turn, not a steer into a dead one')
  assert.deepEqual(request.content, [{ type: 'text', text: '继续' }])
  assert.equal(typeof signal?.aborted, 'boolean')
  // The parent is no longer part of the request: `prompt()` takes the child session only.
  assert.equal('parentSessionId' in request, false)
  assert.equal('source' in request, false)
})

test('the retry prompt refuses a host without subagents.prompt', async () => {
  await assert.rejects(
    mod.deliverRetryPrompt({ subagents: {} }, 'parent-1', 'child-1', '继续'),
    /does not expose subagents\.prompt/,
  )
  await assert.rejects(mod.deliverRetryPrompt({}, 'parent-1', 'child-1', '继续'), /does not expose subagents\.prompt/)
})

test('the retry notice has its own source kind, so it cannot mask a supervision notice', async () => {
  const queued = []
  const parent = { id: 'p', session: { id: 'parent-session' }, followup: (message) => queued.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent]]) })
  const supervision = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => ({ createUserMessage: (input) => input }),
  })
  assert.equal(await supervision.deliverRetry('p', '重试正文', ['child-1']), 'queued')
  assert.equal(queued.length, 1)
  assert.equal(queued[0].content[0].text, '重试正文')
  assert.deepEqual(queued[0].source, { kind: 'orchestrator-retry', form: 'notice', senderSessionId: 'child-1' })
  // The supervision notice keeps the kind `hasPendingNotice` looks for.
  host.parents.set('child-1', {})
  supervision.supervisor.track({ childId: 'child-1', parentId: 'p' })
  assert.equal(await supervision.deliver('p', '巡检正文', ['child-1']), 'queued')
  assert.deepEqual(queued[1].source, {
    kind: mod.SUPERVISE_SOURCE_KIND, form: 'notice', senderSessionId: 'child-1', childIds: ['child-1'],
  })
})

// ---- Live tool catalog -----------------------------------------------------------------

test('the plugin publishes the tool catalog at start and refreshes it on tools/change', async () => {
  const harness = start({ catalogNames: ['read', 'delegate'] })
  const change = harness.handlers.get('tools/change')
  assert.equal(typeof change, 'function', 'apply must subscribe to tools/change')
  // The first read runs during apply, so a panel opened before any change has a catalog.
  assert.deepEqual(harness.catalog(), ['delegate', 'read'])
  assert.deepEqual(harness.emitted[0], ['settings/document-updated', 'orchestrator', 1])
  assert.equal(harness.logs.warn.length, 0)

  // An unchanged burst publishes nothing: no write, no announcement and no gate refresh.
  change()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(harness.emitted.length, 1)

  // A plugin registering a tool moves the catalog, with no plugin reload and no restart.
  harness.catalogNames.push('mcp__demo__ping')
  change()
  change()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepEqual(harness.catalog(), ['delegate', 'mcp__demo__ping', 'read'])
  assert.equal(harness.emitted.length, 2)
  assert.deepEqual(harness.emitted[1], ['settings/document-updated', 'orchestrator', 2])
})

test('the write that empties the published catalog repairs it in the same event', () => {
  // A volatile field is re-committed from the profile's raw value on every settings write,
  // so a panel write lands with toolCatalog already empty. The write has announced
  // loader/volatile-update by then, so the repair rides that event: no timer, no polling.
  const harness = start({ catalogNames: ['read', 'delegate'] })
  assert.deepEqual(harness.catalog(), ['delegate', 'read'])

  harness.resetCatalog()
  assert.deepEqual(harness.catalog(), [], 'the loader wiped the field')
  harness.handlers.get('loader/volatile-update')()
  assert.deepEqual(harness.catalog(), ['delegate', 'read'], 'the catalog is back before the write returns')

  // The repair is not a one-off: every write repeats the same commit.
  harness.resetCatalog()
  harness.handlers.get('loader/volatile-update')()
  assert.deepEqual(harness.catalog(), ['delegate', 'read'])
  // And the panel is told to re-read, so its rows do not stay on the empty snapshot.
  assert.deepEqual(harness.emitted.at(-1), ['settings/document-updated', 'orchestrator', 3])
})

test('the published catalog includes tools a scope registers for a root agent', async () => {
  const scoped = {
    id: 'root',
    ctx: { tools: { view: () => ({ knownNames: new Set(['subagent']), visible: new Map() }) } },
  }
  const harness = start({
    catalogNames: ['read'],
    agents: { get: () => undefined, list: () => [scoped] },
  })
  assert.deepEqual(harness.catalog(), ['read', 'subagent'])
})

test('deferred switch notice: volatile flip records per main agent and appends once on the next pre-step', async () => {
  const main = fakeAgent({ id: 'main-1' })
  const child = fakeAgent({ id: 'child-1', depth: 1, header: { delegationDepth: 1 } })
  const { created, handlers, handlerOptions, state } = start({ enabled: true })

  const preStep = handlers.get('agent/pre-step')
  assert.equal(typeof preStep, 'function', 'apply must subscribe to agent/pre-step')
  assert.deepEqual(handlerOptions.get('agent/pre-step'), { global: true })

  created({ agent: main.agent, source: 'create' })
  created({ agent: child.agent, source: 'create' })
  const volatile = handlers.get('loader/volatile-update')

  // Baseline only: no change was made, so the first step carries only the user prompt.
  const userMsg1 = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }
  const d1 = await preStep(
    { agent: main.agent, messages: [userMsg1], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg1] }),
  )
  assert.deepEqual(d1.messages, [userMsg1])

  // Flip dispatch mode off: nothing is pushed immediately; the notice rides with the next step.
  state.enabled = false
  volatile()

  const userMsg2 = { id: 'u2', role: 'user', content: [{ type: 'text', text: 'read file' }], source: { kind: 'user' } }
  const d2 = await preStep(
    { agent: main.agent, messages: [userMsg2], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg2] }),
  )
  assert.equal(d2.messages.length, 2)
  assert.equal(d2.messages[0], userMsg2)
  assert.equal(d2.messages[1].role, 'user')
  assert.equal(d2.messages[1].source.kind, mod.SWITCH_SOURCE_KIND)
  assert.equal(d2.messages[1].source.form, 'notice')
  assert.match(d2.messages[1].content[0].text, /关闭/)

  // Consumed once: the following step must not repeat the notice.
  const userMsg3 = { id: 'u3', role: 'user', content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }
  const d3 = await preStep(
    { agent: main.agent, messages: [userMsg3], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg3] }),
  )
  assert.deepEqual(d3.messages, [userMsg3])

  // Flip back on, then round-trip before the next turn: no notice is emitted.
  state.enabled = true
  volatile()
  state.enabled = false
  volatile()
  const d4 = await preStep(
    { agent: main.agent, messages: [userMsg3], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg3] }),
  )
  assert.deepEqual(d4.messages, [userMsg3])

  // Children never receive switch notices.
  state.enabled = true
  volatile()
  const dChild = await preStep(
    { agent: child.agent, messages: [userMsg3], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg3] }),
  )
  assert.deepEqual(dChild.messages, [userMsg3])
})

test('deferred switch notice survives rejected, aborted, and empty steps, and clears on dispose', async () => {
  const main = fakeAgent({ id: 'main-2' })
  const { created, handlers, state } = start({ enabled: true })
  const preStep = handlers.get('agent/pre-step')
  const volatile = handlers.get('loader/volatile-update')
  const disposed = handlers.get('agent/disposed')

  created({ agent: main.agent, source: 'create' })
  state.enabled = false
  volatile()

  const userMsg = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }

  // Rejected step leaves the pending notice intact.
  const rejected = await preStep(
    { agent: main.agent, messages: [userMsg], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'reject', reason: 'blocked' }),
  )
  assert.deepEqual(rejected, { kind: 'reject', reason: 'blocked' })

  // Aborted step leaves the pending notice intact.
  const abortedController = new AbortController()
  abortedController.abort()
  const aborted = await preStep(
    { agent: main.agent, messages: [userMsg], step: 1, signal: abortedController.signal },
    async () => ({ kind: 'enter', messages: [userMsg] }),
  )
  assert.deepEqual(aborted.messages, [userMsg])

  // Step 1 with zero messages (no-op turn) leaves the pending notice intact.
  const emptyStep1 = await preStep(
    { agent: main.agent, messages: [], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(emptyStep1.messages, [])

  // Now a real step runs and receives the notice.
  const delivered = await preStep(
    { agent: main.agent, messages: [userMsg], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg] }),
  )
  assert.equal(delivered.messages.length, 2)
  assert.match(delivered.messages[1].content[0].text, /关闭/)

  // Flip again, then dispose: recreating the same id must start from a fresh baseline.
  state.enabled = true
  volatile()
  disposed({ agent: main.agent })
  created({ agent: main.agent, source: 'create' })
  const afterRecreate = await preStep(
    { agent: main.agent, messages: [userMsg], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg] }),
  )
  assert.deepEqual(afterRecreate.messages, [userMsg])
})

test('createSwitchPreStep degrades gracefully without dropping the notice when dsh-llm fails to load', async () => {
  const { createSwitchNotices } = await import('../lib/switch-notice.js')
  let enabled = true
  const notices = createSwitchNotices({ readEnabled: () => enabled })
  notices.observe('main-x')
  enabled = false
  notices.observe('main-x')

  const warnings = []
  let loads = 0
  const preStep = mod.createSwitchPreStep({
    switchNotices: notices,
    loadLlm: async () => {
      loads += 1
      throw new Error('llm missing')
    },
    logger: { warn: (msg) => warnings.push(msg) },
  })

  const agent = fakeAgent({ id: 'main-x' }).agent
  const userMsg = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
  const first = await preStep(
    { agent, messages: [userMsg], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg] }),
  )
  const second = await preStep(
    { agent, messages: [userMsg], step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMsg] }),
  )
  assert.deepEqual(first.messages, [userMsg])
  assert.deepEqual(second.messages, [userMsg])
  assert.equal(loads, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /cannot load @deepseek-ai\/dsh-llm/)
  assert.equal(notices.hasPending('main-x'), true)
})

/** A real inbox facade: mutations throw if called on the synchronous publish stack. */
function recordingInbox() {
  const removed = []
  const replaced = []
  const inbox = {
    nextTurn: [],
    nextStep: [],
    publishing: false,
    remove(id) {
      assert.equal(inbox.publishing, false)
      removed.push(id)
      for (const key of ['nextTurn', 'nextStep']) inbox[key] = inbox[key].filter((message) => message.id !== id)
    },
    replace(id, message) {
      assert.equal(inbox.publishing, false)
      replaced.push({ id, message })
      for (const key of ['nextTurn', 'nextStep']) {
        inbox[key] = inbox[key].map((current) => current.id === id ? message : current)
      }
    },
  }
  return { inbox, removed, replaced }
}

const supervisionMessage = (id, childIds) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: '巡检' }],
  source: { kind: mod.SUPERVISE_SOURCE_KIND, senderSessionId: childIds[0], childIds },
})

async function supervisionTurnHarness({ todos = [{ content: '任务', status: 'in_progress' }], enabled = true, copyEvents = false } = {}) {
  const main = fakeAgent({ id: 'main-supervision' })
  const live = new Map([[main.agent.id, main.agent]])
  const projection = { todos }
  const writes = []
  const boundary = { lastTurn: 1 }
  main.agent.session.id = main.agent.id
  main.agent.session.append = async (type, data) => {
    const event = { type, data: copyEvents ? structuredClone(data) : data }
    writes.push(event)
    projection.todos = event.data.todos
    harness.handlers.get('session/event')(main.agent.session, event)
    return event
  }
  const harness = start({
    enabled,
    allowed: [...mod.DEFAULT_ALLOWED_TOOLS, 'read', 'run_code'],
    agents: { get: (id) => live.get(id), turnBoundaryOf: () => boundary },
    snapshot: () => ({ values: { todos: projection.todos } }),
    subagents: {
      resolveMaxDepth: () => 1,
      startActivation: async () => {
        const childId = `worker-${live.size}`
        live.set(childId, fakeAgent({ id: childId, depth: 1 }).agent)
        return { childId }
      },
    },
  })
  harness.created({ agent: main.agent, source: 'create' })
  const delegate = harness.tools.find(({ name }) => name === 'delegate')
  const started = await delegate.execute({
    description: '任务', prompt: '执行', writeScope: ['C:/repo/task.js'], provider: 'p', model: 'm',
  }, { agent: main.agent, signal: new AbortController().signal })
  const message = supervisionMessage('notice-1', [started.subagentId])
  const preStep = (messages = [message], extra = {}, next) => harness.handlers.get('agent/pre-step')({
    agent: main.agent, turn: boundary.lastTurn, step: 1, messages,
    signal: new AbortController().signal, ...extra,
  }, next ?? (async () => ({ kind: 'enter', messages })))
  const event = (type, data) => harness.handlers.get('session/event')(main.agent.session, { type, data })
  return { ...harness, main, live, projection, writes, boundary, message, preStep, event, childId: started.subagentId }
}

test('public inbox buckets take precedence over deprecated projection access', () => {
  const parent = { id: 'p', session: {}, inbox: { nextTurn: [], nextStep: [supervisionMessage('n', ['c'])] } }
  const host = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    stateOf: () => { throw new Error('deprecated accessor must not run') },
  })
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {} })
  assert.equal(supervision.hasPendingNotice('p'), true)
  parent.inbox.nextStep = []
  assert.equal(supervision.hasPendingNotice('p'), false)
  assert.deepEqual(host.logs, [])
})

test('delivery atomically drops a notice whose workers settle during the lazy import', async () => {
  const queued = []
  const parent = { id: 'p', session: {}, followup: (message) => queued.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c', {}]]) })
  let release
  const loaded = new Promise((resolve) => { release = resolve })
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {}, loadLlm: () => loaded })
  supervision.supervisor.track({ childId: 'c', parentId: 'p' })
  const delivery = supervision.deliver('p', '旧正文', ['c'])
  supervision.supervisor.forget('c')
  release({ createUserMessage: (input) => ({ id: 'notice', ...input }) })
  assert.equal(await delivery, 'stale')
  assert.deepEqual(queued, [])
})

test('delivery recompiles a partial batch from saved rows and retains complete live ids', async () => {
  const queued = []
  const parent = { id: 'p', session: {}, followup: (message) => queued.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c1', {}], ['c2', {}]]) })
  const supervision = mod.createSupervision({
    ctx: host.ctx, config: {}, loadLlm: async () => ({ createUserMessage: (input) => ({ id: 'n', ...input }) }),
  })
  supervision.supervisor.track({ childId: 'c2', parentId: 'p' })
  const rows = [{ childId: 'c1', label: '已结算任务' }, { childId: 'c2', label: '剩余任务', lastText: '执行中' }]
  assert.equal(await supervision.deliver('p', '旧正文含c1', ['c1', 'c2'], { rows, composeMeta: { index: 2, max: 3 } }), 'queued')
  assert.deepEqual(queued[0].source.childIds, ['c2'])
  assert.match(queued[0].content[0].text, /剩余任务/)
  assert.equal(queued[0].content[0].text.includes('已结算任务'), false)
  assert.equal(supervision.pendingNoticeMeta.size, 1)
})

test('reconciliation is microtask deduplicated and replaces then removes notices across both inbox buckets', async () => {
  const { inbox, removed, replaced } = recordingInbox()
  const parent = { id: 'p', session: {}, inbox, followup: (message) => inbox.nextTurn.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c1', {}], ['c2', {}]]) })
  let seq = 0
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {}, loadLlm: async () => ({
    createUserMessage: (input) => ({ id: `reconcile-${++seq}`, ...input }),
  }) })
  const hooks = mod.createSupervisionHooks(supervision.supervisor, { scheduleReconcileInbox: supervision.scheduleReconcileInbox })
  for (const childId of ['c1', 'c2']) hooks.onStarted(parent, { childId }, { description: `任务${childId}` })
  await supervision.deliver('p', '旧正文', ['c1', 'c2'], {
    rows: [{ childId: 'c1', label: '任务c1' }, { childId: 'c2', label: '任务c2' }], composeMeta: { index: 1, max: 3 },
  })
  inbox.nextStep.push(supervisionMessage('legacy', ['c1']))
  inbox.publishing = true
  hooks.forget('c1')
  hooks.forget('c1')
  assert.equal(replaced.length, 0)
  inbox.publishing = false
  await Promise.resolve()
  assert.equal(replaced.length, 1)
  assert.deepEqual(inbox.nextTurn[0].source.childIds, ['c2'])
  assert.match(inbox.nextTurn[0].content[0].text, /任务c2/)
  assert.equal(inbox.nextTurn[0].content[0].text.includes('任务c1'), false)
  assert.deepEqual(removed, ['legacy'])
  hooks.forget('c2')
  await Promise.resolve()
  assert.equal(inbox.nextTurn.length, 0)
  assert.equal(supervision.pendingNoticeMeta.size, 0)
})

test('reconciliation tolerates missing replace and purges metadata after inbox consumption', async () => {
  const { inbox } = recordingInbox()
  delete inbox.replace
  const parent = { id: 'p', session: {}, inbox, followup: (message) => inbox.nextTurn.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c1', {}], ['c2', {}]]) })
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {} })
  for (const childId of ['c1', 'c2']) supervision.supervisor.track({ childId, parentId: 'p' })
  await supervision.deliver('p', '正文', ['c1', 'c2'])
  supervision.supervisor.forget('c1')
  supervision.scheduleReconcileInbox('p')
  await Promise.resolve()
  assert.equal(inbox.nextTurn.length, 1)
  inbox.nextTurn.length = 0
  supervision.scheduleReconcileInbox('p')
  await Promise.resolve()
  assert.equal(supervision.pendingNoticeMeta.size, 0)
})

test('a pure supervision turn blocks todo and locks every subsequent tool on the same assistant response', async () => {
  const h = await supervisionTurnHarness()
  await h.preStep()
  assert.match(h.main.guards[0]({ name: 'todo_write' }), /定时巡检回合/)
  for (const name of ['delegate', 'orchestrate', 'read', 'send_message', 'interrupt_agent']) {
    assert.equal(h.main.guards[0]({ name }), undefined, name)
  }
  h.event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '**巡检：正常**。' }, { type: 'tool_use' }] } })
  for (const name of ['read', 'run_code', 'send_message']) assert.match(h.main.guards[0]({ name }), /锁定后续工具调用/)
  h.event('turn/end', { turn: 1 })
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
})

test('installed supervision gates forward whitelist misses and restore ordinary refusal after turn end', async () => {
  const h = await supervisionTurnHarness()
  h.state.allowed = mod.DEFAULT_ALLOWED_TOOLS
  await h.preStep()
  const guard = h.main.guards[0]
  assert.match(guard({ name: 'read' }), /current supervision turn/)
  assert.doesNotMatch(guard({ name: 'read' }), /delegate|orchestrate/)
  h.event('turn/end', { turn: 1 })
  assert.equal(guard({ name: 'read' }), allowGuard(mod.DEFAULT_ALLOWED_TOOLS)({ name: 'read' }))
})

test('long normal-report discussion and unrelated turn events never lock tools', async () => {
  const h = await supervisionTurnHarness()
  await h.preStep()
  h.event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '本次巡检：正常，但还需调查' }] } })
  h.event('assistant/message', { turn: 0, message: { content: [{ type: 'text', text: '巡检：正常' }] } })
  h.event('turn/end', { turn: 0 })
  assert.equal(h.main.guards[0]({ name: 'read' }), undefined)
  assert.match(h.main.guards[0]({ name: 'todo_write' }), /定时巡检回合/)
  h.boundary.lastTurn = 2
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
})

test('mixed user, settlement and retry turns clear prior supervision bindings', async () => {
  for (const kind of ['user', 'subagent-settled', 'orchestrator-retry']) {
    const h = await supervisionTurnHarness()
    await h.preStep()
    h.boundary.lastTurn = 2
    const other = { id: kind, source: { kind } }
    await h.preStep([h.message, other])
    assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined, kind)
    h.event('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: '巡检：正常' }] } })
    assert.equal(h.main.guards[0]({ name: 'read' }), undefined, kind)
  }
})

test('an entirely stale supervision batch restores UI todos and rejects before next or model entry', async () => {
  const h = await supervisionTurnHarness()
  h.handlers.get('subagent/end')({ id: h.childId, stopReason: 'completed' })
  h.projection.todos = null
  let entered = false
  const decision = await h.preStep(undefined, {}, async () => { entered = true; return { kind: 'enter', messages: [] } })
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(entered, false)
  assert.equal(h.writes.length, 1)
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
})

test('stale notices are removed after downstream entry while effective pure notices still bind', async () => {
  const h = await supervisionTurnHarness()
  const stale = supervisionMessage('stale', ['gone'])
  const decision = await h.preStep([stale, h.message])
  assert.deepEqual(decision.messages, [h.message])
  assert.match(h.main.guards[0]({ name: 'todo_write' }), /定时巡检回合/)
  h.boundary.lastTurn = 2
  const settled = { id: 'settled', source: { kind: 'subagent-settled' } }
  const mixed = await h.preStep([stale, settled])
  assert.deepEqual(mixed.messages, [settled])
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
})

test('rejected or aborted supervision does not leave a gate binding or restore todos', async () => {
  const h = await supervisionTurnHarness()
  h.projection.todos = null
  const rejected = await h.preStep(undefined, {}, async () => ({ kind: 'reject', reason: 'outer hook' }))
  assert.deepEqual(rejected, { kind: 'reject', reason: 'outer hook' })
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
  const controller = new AbortController()
  controller.abort()
  await h.preStep(undefined, { signal: controller.signal })
  assert.deepEqual(h.writes, [])
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
})

test('pending switch notices survive supervision and appear on the next normal turn', async () => {
  const h = await supervisionTurnHarness()
  h.state.enabled = false
  h.handlers.get('loader/volatile-update')()
  const decision = await h.preStep()
  assert.deepEqual(decision.messages, [h.message])
  assert.match(h.main.guards[0]({ name: 'todo_write' }), /定时巡检回合/)
  h.boundary.lastTurn = 2
  const normal = { id: 'user', source: { kind: 'user' } }
  const next = await h.preStep([normal])
  assert.equal(next.messages.length, 2)
  assert.equal(next.messages[1].source.kind, mod.SWITCH_SOURCE_KIND)
})

test('todo snapshots are deeply cloned and restored once only as UI state events', async () => {
  const todos = [{ content: '任务', status: 'in_progress', metadata: { value: 1 } }]
  const h = await supervisionTurnHarness({ todos })
  todos[0].metadata.value = 9
  h.projection.todos = null
  await h.preStep()
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0].type, 'todo/write')
  assert.deepEqual(h.writes[0].data.todos, [{ content: '任务', status: 'in_progress', metadata: { value: 1 } }])
  assert.equal(h.writes[0].data.source.kind, 'orchestrator-todo-restoration')
  assert.equal(typeof h.writes[0].data.source.token, 'string')
  await h.preStep(undefined, { step: 2 })
  assert.equal(h.writes.length, 1)
})

test('empty todo writes and real new user input invalidate restoration eligibility', async () => {
  for (const mode of ['empty', 'user', 'initial-empty']) {
    const h = await supervisionTurnHarness(mode === 'initial-empty' ? { todos: [] } : {})
    if (mode === 'empty') h.event('todo/write', { todos: [] })
    if (mode === 'user') await h.preStep([{ id: 'user', source: { kind: 'user' } }, h.message])
    h.projection.todos = null
    h.boundary.lastTurn = 2
    await h.preStep()
    assert.deepEqual(h.writes, [], mode)
  }
})

test('todo writes refresh snapshots, while disabled restoration, newer boundaries and append errors remain safe', async () => {
  for (const mode of ['disabled', 'newer-turn', 'throw', 'already-present', 'missing-append']) {
    const h = await supervisionTurnHarness()
    h.event('todo/write', { todos: [{ content: '新任务', status: 'pending' }] })
    h.projection.todos = mode === 'already-present' ? [] : null
    if (mode === 'disabled') h.config.restoreTodoOnSupervision = false
    if (mode === 'missing-append') delete h.main.agent.session.append
    if (mode === 'throw') h.main.agent.session.append = async () => { throw new Error('append failed') }
    await assert.doesNotReject(h.preStep(undefined, mode === 'newer-turn' ? { turn: 0 } : {}))
    assert.deepEqual(h.writes, [], mode)
  }
  const h = await supervisionTurnHarness({ todos: [] })
  h.event('todo/write', { todos: [{ content: '新任务', status: 'pending' }] })
  h.projection.todos = null
  await h.preStep()
  assert.equal(h.writes[0].data.todos[0].content, '新任务')
})

test('disposal clears supervision binding and todo snapshots before recreating an agent', async () => {
  const h = await supervisionTurnHarness()
  await h.preStep()
  h.event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '巡检：正常' }] } })
  h.handlers.get('agent/disposed')({ agent: h.main.agent })
  h.projection.todos = null
  h.created({ agent: h.main.agent, source: 'create' })
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
  await h.preStep()
  assert.deepEqual(h.writes, [])
})

test('a disposed worker makes consumed notices stale even if its agent is still in the registry', async () => {
  const h = await supervisionTurnHarness()
  h.handlers.get('agent/disposed')({ agent: h.live.get(h.childId) })
  assert.deepEqual(await h.preStep(), { kind: 'reject' })
})

test('a user turn invalidates an uninitialised tracker before a later supervision bind', () => {
  const session = {}
  const tracker = mod.createTodoSnapshotTracker({ sessionProjections: { snapshot: () => ({ values: { todos: [{ content: '旧任务' }] } }) } })
  tracker.invalidate(session)
  tracker.bind({ session })
  assert.equal(tracker.canRestore(session), false)
})

test('downstream failure releases the supervision binding and keeps todo UI untouched', async () => {
  const h = await supervisionTurnHarness()
  h.projection.todos = null
  await assert.rejects(h.preStep(undefined, {}, async () => { throw new Error('downstream failed') }), /downstream failed/)
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
  assert.deepEqual(h.writes, [])
})

test('partial notices are recreated with the host message factory and retain the original render timestamp', async () => {
  const { inbox } = recordingInbox()
  const parent = { id: 'p', session: {}, inbox, followup: (message) => inbox.nextTurn.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c1', {}], ['c2', {}]]) })
  let created = 0
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {}, loadLlm: async () => ({
    createUserMessage: (input) => ({ id: `factory-${++created}`, role: 'user', hostField: true, ...input }),
  }) })
  for (const childId of ['c1', 'c2']) supervision.supervisor.track({ childId, parentId: 'p' })
  await supervision.deliver('p', '正文', ['c1', 'c2'], {
    rows: [{ childId: 'c1' }, { childId: 'c2', startedAt: 1_000, label: '保留' }],
    composeMeta: { now: 61_000, index: 2, max: 3 },
  })
  supervision.supervisor.forget('c1')
  supervision.scheduleReconcileInbox('p')
  await Promise.resolve()
  assert.equal(created, 2)
  assert.equal(inbox.nextTurn[0].hostField, true)
  assert.match(inbox.nextTurn[0].content[0].text, /第 2\/3 次/)
  assert.match(inbox.nextTurn[0].content[0].text, /已运行 1m00s/)
})

test('settling an old active worker still reconciles its parent after dispatch history eviction', () => {
  const parents = []
  const hooks = mod.createSupervisionHooks(recordingSupervisor(), {
    scheduleReconcileInbox: (parentId) => parents.push(parentId),
  })
  for (let i = 0; i < 129; i += 1) hooks.onStarted({ id: 'parent' }, { childId: `worker-${i}` }, {})
  hooks.forget('worker-0')
  assert.deepEqual(parents, ['parent'])
})

test('failed inbox replacement retains the original metadata and retries on the next reconciliation', async () => {
  const { inbox } = recordingInbox()
  const replace = inbox.replace
  inbox.replace = () => false
  const parent = { id: 'p', session: {}, inbox, followup: (message) => inbox.nextTurn.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c1', {}], ['c2', {}]]) })
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {} })
  for (const childId of ['c1', 'c2']) supervision.supervisor.track({ childId, parentId: 'p' })
  await supervision.deliver('p', '正文', ['c1', 'c2'], {
    rows: [{ childId: 'c1' }, { childId: 'c2', label: '必须保留的任务名' }],
  })
  const originalId = inbox.nextTurn[0].id
  supervision.supervisor.forget('c1')
  supervision.scheduleReconcileInbox('p')
  await Promise.resolve()
  assert.equal(supervision.pendingNoticeMeta.has(originalId), true)
  inbox.replace = replace
  supervision.scheduleReconcileInbox('p')
  await Promise.resolve()
  assert.match(inbox.nextTurn[0].content[0].text, /必须保留的任务名/)
})

test('later supervision steps with no new inbox input continue and retain the same-turn gate', async () => {
  const h = await supervisionTurnHarness()
  await h.preStep()
  assert.deepEqual(await h.preStep([], { step: 2 }), { kind: 'enter', messages: [] })
  assert.match(h.main.guards[0]({ name: 'todo_write' }), /定时巡检回合/)
})

test('a surviving ordinary message keeps model entry when supervision settles downstream', async () => {
  const h = await supervisionTurnHarness()
  h.projection.todos = null
  const user = { id: 'real-user', source: { kind: 'user' } }
  const decision = await h.preStep(undefined, {}, async () => {
    h.handlers.get('subagent/end')({ id: h.childId, stopReason: 'completed' })
    return { kind: 'enter', messages: [h.message, user] }
  })
  assert.deepEqual(decision.messages, [user])
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
  assert.deepEqual(h.writes, [])
})

test('step-two user steering immediately releases supervision locks and invalidates old todo restoration', async () => {
  const h = await supervisionTurnHarness()
  await h.preStep()
  h.event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '巡检：正常' }] } })
  const user = { id: 'steer', source: { kind: 'user' } }
  await h.preStep([user], { step: 2 })
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
  assert.equal(h.main.guards[0]({ name: 'read' }), undefined)
  h.projection.todos = null
  h.boundary.lastTurn = 2
  await h.preStep()
  assert.deepEqual(h.writes, [])
})

test('later-step settlement input releases a supervision binding without pretending to be user input', async () => {
  const h = await supervisionTurnHarness()
  await h.preStep()
  await h.preStep([{ id: 'settled', source: { kind: 'subagent-settled' } }], { step: 3 })
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
})

test('workers settling while downstream awaits reject the empty step and clear its binding', async () => {
  const h = await supervisionTurnHarness()
  h.projection.todos = null
  let release
  const downstream = new Promise((resolve) => { release = resolve })
  const pending = h.preStep(undefined, {}, () => downstream)
  await Promise.resolve()
  h.handlers.get('subagent/end')({ id: h.childId, stopReason: 'completed' })
  release({ kind: 'enter', messages: [h.message] })
  assert.deepEqual(await pending, { kind: 'reject' })
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
  assert.equal(h.writes.length, 1)
})

test('downstream retaining only runtime context after stale notice removal rejects without a model request', async () => {
  const h = await supervisionTurnHarness()
  const stale = supervisionMessage('stale', ['gone'])
  const user = { id: 'user', source: { kind: 'user' } }
  const time = { id: 'clock', source: { kind: 'runtime-context', form: 'time-context' } }
  h.projection.todos = null
  const decision = await h.preStep([stale, user], {}, async () => ({ kind: 'enter', messages: [stale, time] }))
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
  assert.deepEqual(h.writes, [], 'real input already invalidated the old snapshot')
})

test('runtime context alone after downstream settlement restores eligible todos then rejects', async () => {
  const h = await supervisionTurnHarness()
  h.projection.todos = null
  const time = { id: 'clock', source: { kind: 'time-context' } }
  const decision = await h.preStep(undefined, {}, async () => {
    h.handlers.get('subagent/end')({ id: h.childId, stopReason: 'completed' })
    return { kind: 'enter', messages: [h.message, time] }
  })
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
  assert.equal(h.writes.length, 1)
})

test('pre-existing roots receive one guard, initial todo snapshot and exact session event tracking', async () => {
  const main = fakeAgent({ id: 'existing-root' })
  const child = fakeAgent({ id: 'existing-child', depth: 1 })
  const live = new Map([[main.agent.id, main.agent], [child.agent.id, child.agent]])
  let todos = [{ content: '挂载前任务' }]
  let reads = 0
  const writes = []
  main.agent.session.append = async (type, data) => { writes.push({ type, data }); todos = data.todos }
  const h = start({
    agents: { get: (id) => live.get(id), list: () => [...live.values()], turnBoundaryOf: () => ({ lastTurn: 1 }) },
    snapshot: () => { reads += 1; return { values: { todos } } },
    subagents: { resolveMaxDepth: () => 1, startActivation: async () => ({ childId: child.agent.id }) },
  })
  assert.equal(main.guards.length, 1)
  assert.equal(child.guards.length, 0)
  assert.equal(reads, 1)
  h.created({ agent: main.agent })
  assert.equal(main.guards.length, 1, 'repeated registration is idempotent')
  assert.equal(reads, 1)
  const event = h.handlers.get('session/event')
  event(main.agent.session, { type: 'todo/write', data: { todos: [{ content: '根代理更新' }] } })
  event(child.agent.session, { type: 'todo/write', data: { todos: [{ content: '子代理清单' }] } })
  todos = null
  const message = supervisionMessage('stale-existing', ['gone'])
  assert.deepEqual(await h.handlers.get('agent/pre-step')({ agent: main.agent, turn: 1, step: 1, messages: [message] }, async () => ({ kind: 'enter', messages: [message] })), { kind: 'reject' })
  assert.equal(writes[0].data.todos[0].content, '根代理更新')
  const delegate = h.tools.find(({ name }) => name === 'delegate')
  await delegate.execute({
    description: '已有代理任务', prompt: '执行', writeScope: ['C:/repo/existing.js'], provider: 'p', model: 'm',
  }, { agent: main.agent, signal: new AbortController().signal })
  const liveMessage = supervisionMessage('live-existing', [child.agent.id])
  await h.handlers.get('agent/pre-step')({ agent: main.agent, turn: 1, step: 1, messages: [liveMessage] }, async () => ({ kind: 'enter', messages: [liveMessage] }))
  assert.match(main.guards[0]({ name: 'todo_write' }), /定时巡检回合/)
  event(main.agent.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '巡检：正常' }] } } })
  assert.match(main.guards[0]({ name: 'send_message' }), /锁定后续工具调用/)
})

test('failed inbox mutations automatically retry and stop after two rechecks', async () => {
  for (const operation of ['replace', 'remove']) {
    for (const permanent of [false, true]) {
      const { inbox } = recordingInbox()
      const original = inbox[operation]
      let attempts = 0
      inbox[operation] = (...args) => {
        attempts += 1
        if (permanent || attempts === 1) return false
        return original(...args)
      }
      const parent = { id: 'p', session: {}, inbox, followup: (message) => inbox.nextTurn.push(message) }
      const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c1', {}], ['c2', {}]]) })
      const s = mod.createSupervision({ ctx: host.ctx, config: {} })
      for (const childId of ['c1', 'c2']) s.supervisor.track({ childId, parentId: 'p' })
      await s.deliver('p', '旧正文', ['c1', 'c2'], { rows: [{ childId: 'c1' }, { childId: 'c2', label: '保留任务' }] })
      s.supervisor.forget('c1')
      if (operation === 'remove') s.supervisor.forget('c2')
      s.scheduleReconcileInbox('p')
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(attempts, permanent ? 3 : 2, `${operation}/${permanent}`)
      if (permanent) assert.equal(s.pendingNoticeMeta.size, 1)
      else if (operation === 'remove') assert.equal(inbox.nextTurn.length, 0)
      else assert.match(inbox.nextTurn[0].content[0].text, /保留任务/)
    }
  }
})

test('a failed inbox replacement rechecks the other bucket after a concurrent queue switch', async () => {
  const { inbox } = recordingInbox()
  const replace = inbox.replace
  let attempts = 0
  inbox.replace = (...args) => {
    attempts += 1
    if (attempts === 1) {
      inbox.nextStep.push(inbox.nextTurn.shift())
      return false
    }
    return replace(...args)
  }
  const parent = { id: 'p', session: {}, inbox, followup: (message) => inbox.nextTurn.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c1', {}], ['c2', {}]]) })
  const s = mod.createSupervision({ ctx: host.ctx, config: {} })
  for (const childId of ['c1', 'c2']) s.supervisor.track({ childId, parentId: 'p' })
  await s.deliver('p', '旧正文', ['c1', 'c2'], { rows: [{ childId: 'c1' }, { childId: 'c2', label: '保留任务' }] })
  s.supervisor.forget('c1')
  s.scheduleReconcileInbox('p')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(attempts, 2)
  assert.deepEqual(inbox.nextStep[0].source.childIds, ['c2'])
  assert.match(inbox.nextStep[0].content[0].text, /保留任务/)
})

test('a failed mutation racing inbox consumption safely drops metadata after bounded rechecks', async () => {
  const { inbox } = recordingInbox()
  const parent = { id: 'p', session: {}, inbox, followup: (message) => inbox.nextTurn.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c1', {}], ['c2', {}]]) })
  const s = mod.createSupervision({ ctx: host.ctx, config: {} })
  for (const childId of ['c1', 'c2']) s.supervisor.track({ childId, parentId: 'p' })
  await s.deliver('p', '旧正文', ['c1', 'c2'])
  inbox.replace = () => { inbox.nextTurn = []; return false }
  s.supervisor.forget('c1')
  s.scheduleReconcileInbox('p')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(s.pendingNoticeMeta.size, 0)
})

test('pre-step recompiles partially stale claimed notices before and after downstream waiting', async () => {
  for (const duringNext of [false, true]) {
    const h = await supervisionTurnHarness()
    h.live.set('other-worker', fakeAgent({ id: 'other-worker', depth: 1 }).agent)
    const { createSupervisionTurnState } = await import('../lib/gate.js')
    const s = mod.createSupervision({ ctx: h.ctx, config: h.config })
    for (const childId of [h.childId, 'other-worker']) s.supervisor.track({ childId, parentId: h.main.agent.id })
    const { inbox } = recordingInbox()
    h.main.agent.inbox = inbox
    h.main.agent.followup = (message) => inbox.nextTurn.push(message)
    await s.deliver(h.main.agent.id, '旧正文包含已结束任务', [h.childId, 'other-worker'], {
      rows: [{ childId: h.childId, label: '已结束任务' }, { childId: 'other-worker', label: '仍运行任务', startedAt: 1_000 }],
      composeMeta: { now: 61_000, index: 2, max: 3 },
    })
    const original = inbox.nextTurn.shift()
    const turnState = createSupervisionTurnState()
    const preStep = mod.createSupervisionPreStep({
      ctx: h.ctx, config: h.config, supervisor: s.supervisor, supervisionTurnState: turnState,
      todoTracker: mod.createTodoSnapshotTracker(h.ctx), rebuildNotice: s.rebuildNotice,
      nextStep: async (payload, next) => next(),
    })
    if (!duringNext) s.supervisor.forget(h.childId)
    const decision = await preStep({ agent: h.main.agent, step: 1, turn: 1, messages: [original] }, async () => {
      if (duringNext) s.supervisor.forget(h.childId)
      return { kind: 'enter', messages: [original] }
    })
    assert.deepEqual(decision.messages[0].source.childIds, ['other-worker'])
    assert.equal(decision.messages[0].content[0].text.includes('已结束任务'), false)
    assert.match(decision.messages[0].content[0].text, /仍运行任务/)
    assert.match(decision.messages[0].content[0].text, /已运行 1m00s/)
    assert.match(decision.messages[0].content[0].text, /第 2\/3 次/)
    assert.equal(decision.messages[0].id, original.id)
  }
})

/** Link real receipt settlement, inbox cleanup and pre-step metadata ownership. */
async function claimedNoticeHarness() {
  const { createSupervisionTurnState } = await import('../lib/gate.js')
  const { inbox } = recordingInbox()
  const parent = { id: 'p', session: {}, inbox, followup: (message) => inbox.nextTurn.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent], ['c1', {}], ['c2', {}]]) })
  const projection = { todos: [{ content: '原任务', status: 'in_progress' }] }
  const writes = []
  host.ctx.sessionProjections.snapshot = () => ({ values: { todos: projection.todos } })
  parent.session.append = async (type, data) => { writes.push({ type, data }); projection.todos = data.todos }
  const tracker = mod.createTodoSnapshotTracker(host.ctx)
  tracker.bind(parent)
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {} })
  const hooks = mod.createSupervisionHooks(supervision.supervisor, {
    scheduleReconcileInbox: supervision.scheduleReconcileInbox,
  })
  let settle
  const receipt = new Promise((resolve) => { settle = resolve })
  hooks.onStarted(parent, { childId: 'c1', result: receipt }, { description: '已结束任务' })
  hooks.onStarted(parent, { childId: 'c2' }, { description: '仍运行任务' })
  await supervision.deliver('p', '旧正文包含已结束任务', ['c1', 'c2'], {
    rows: [{ childId: 'c1', label: '已结束任务' }, { childId: 'c2', label: '仍运行任务', startedAt: 1_000 }],
    composeMeta: { now: 61_000, index: 2, max: 3 },
  })
  const message = inbox.nextTurn.shift()
  const payload = { agent: parent, step: 1, turn: 1, messages: [message] }
  const run = ({ nextStep = async (input, next) => next(), restore = (...args) => tracker.restore(...args), extra = {} } = {}) =>
    mod.createSupervisionPreStep({
      ctx: host.ctx, config: {}, supervisor: supervision.supervisor,
      supervisionTurnState: createSupervisionTurnState(),
      todoTracker: { bind() {}, invalidate() {}, restore },
      rebuildNotice: supervision.rebuildNotice,
      retainNotices: supervision.retainNotices,
      nextStep,
    })({ ...payload, ...extra }, async () => ({ kind: 'enter', messages: [message] }))
  const settleAndClean = async () => {
    settle()
    await receipt
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(supervision.supervisor.has('c1'), false)
    assert.deepEqual(inbox.nextTurn, [])
  }
  return { ...supervision, host, hooks, parent, message, payload, run, settleAndClean, tracker, projection, writes }
}

function assertOriginalNotice(decision, message) {
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages[0].id, message.id)
  assert.deepEqual(decision.messages[0].source.childIds, ['c2'])
  assert.doesNotMatch(decision.messages[0].content[0].text, /已结束任务/)
  assert.match(decision.messages[0].content[0].text, /仍运行任务/)
  assert.match(decision.messages[0].content[0].text, /已运行 1m00s/)
  assert.match(decision.messages[0].content[0].text, /第 2\/3 次/)
}

test('claimed notice metadata survives receipt cleanup during downstream and todo awaits then releases', async () => {
  for (const phase of ['downstream', 'todo']) {
    const h = await claimedNoticeHarness()
    let entered
    let release
    const waiting = new Promise((resolve) => { entered = resolve })
    const blocked = new Promise((resolve) => { release = resolve })
    const pause = async () => { entered(); await blocked }
    if (phase === 'todo') {
      h.projection.todos = null
      const append = h.parent.session.append
      h.parent.session.append = async (...args) => { await pause(); return append(...args) }
    }
    const pending = h.run(phase === 'downstream' ? {
      nextStep: async (payload) => { await pause(); return { kind: 'enter', messages: payload.messages } },
    } : {})
    await waiting
    await h.settleAndClean()
    const retained = h.pendingNoticeMeta.has(h.message.id)
    release()
    const decision = await pending
    assert.equal(retained, true, phase)
    assertOriginalNotice(decision, h.message)
    assert.equal(h.pendingNoticeMeta.size, 0, `${phase}: finally releases consumed metadata`)
    assert.equal(h.writes.length, phase === 'todo' ? 1 : 0)
  }
})

test('claimed notice metadata releases on exception, rejection, abort and missing decision messages', async () => {
  for (const mode of ['throw', 'restore-throw', 'reject', 'abort', 'no-messages', 'stale']) {
    const h = await claimedNoticeHarness()
    const controller = new AbortController()
    const result = { kind: mode === 'reject' ? 'reject' : 'enter' }
    let retained
    const nextStep = async () => {
      await h.settleAndClean()
      retained = h.pendingNoticeMeta.has(h.message.id)
      if (mode === 'throw') throw new Error('metadata downstream failed')
      if (mode === 'abort') controller.abort()
      return mode === 'restore-throw' ? { kind: 'enter', messages: [h.message] } : result
    }
    if (mode === 'stale') {
      h.hooks.forget('c1')
      h.hooks.forget('c2')
    }
    const pending = h.run({
      nextStep, extra: { signal: controller.signal },
      restore: async () => { if (mode === 'restore-throw') throw new Error('metadata restoration failed') },
    })
    if (mode === 'throw') await assert.rejects(pending, /metadata downstream failed/)
    else if (mode === 'restore-throw') await assert.rejects(pending, /metadata restoration failed/)
    else assert.deepEqual(await pending, mode === 'stale' ? { kind: 'reject' } : result)
    if (mode !== 'stale') assert.equal(retained, true, mode)
    assert.equal(h.pendingNoticeMeta.size, 0, mode)
  }
})

test('reentrant pre-steps count metadata owners until the last downstream waiter finishes', async () => {
  const h = await claimedNoticeHarness()
  const releases = []
  const nextStep = async (payload) => {
    await new Promise((resolve) => { releases.push(resolve) })
    return { kind: 'enter', messages: payload.messages }
  }
  const first = h.run({ nextStep })
  const second = h.run({ nextStep })
  assert.equal(releases.length, 2)
  await h.settleAndClean()
  const retained = h.pendingNoticeMeta.has(h.message.id)
  releases[0]()
  const firstDecision = await first
  const afterFirst = h.pendingNoticeMeta.has(h.message.id)
  releases[1]()
  const secondDecision = await second
  assert.equal(retained, true)
  assert.equal(afterFirst, true, 'one completion must not release another in-flight owner')
  assertOriginalNotice(firstDecision, h.message)
  assertOriginalNotice(secondDecision, h.message)
  assert.equal(h.pendingNoticeMeta.size, 0)
})

test('claimed notice events bridge the pre-step window and release abandoned or duplicate claims', async () => {
  for (const mode of ['pre-step', 'turn-end', 'dispose']) {
    const h = await claimedNoticeHarness()
    const claim = { agent: h.parent, message: h.message, turn: 1 }
    h.claimNotice(claim)
    h.claimNotice(claim)
    await h.settleAndClean()
    assert.equal(h.pendingNoticeMeta.has(h.message.id), true, mode)
    if (mode === 'pre-step') assertOriginalNotice(await h.run(), h.message)
    else {
      h.releaseClaimedNotices(h.parent, mode === 'turn-end' ? 2 : undefined)
      if (mode === 'turn-end') {
        assert.equal(h.pendingNoticeMeta.has(h.message.id), true, 'another turn cannot release the claim')
        h.releaseClaimedNotices(h.parent, 1)
      }
    }
    assert.equal(h.pendingNoticeMeta.size, 0, mode)
  }
})

test('metadata cap preserves active notices and independent same-turn claim batches', async () => {
  const h = await claimedNoticeHarness()
  await h.deliver('p', '第二批通知', ['c2'], {
    rows: [{ childId: 'c2', label: '第二批任务' }], composeMeta: { now: 61_000, index: 3, max: 3 },
  })
  const second = h.parent.inbox.nextTurn.shift()
  h.claimNotice({ agent: h.parent, message: h.message, turn: 1 })
  h.claimNotice({ agent: h.parent, message: second, turn: 1 })
  const release = h.retainNotices(h.payload)
  release()
  assert.equal(h.pendingNoticeMeta.has(h.message.id), false)
  assert.equal(h.pendingNoticeMeta.has(second.id), true, 'a distinct claimed batch keeps its own owner')
  h.parent.inbox = undefined
  for (let index = 0; index < 257; index += 1) await h.deliver('p', '有界旧宿主通知', ['c2'])
  assert.equal(h.pendingNoticeMeta.size, 256)
  assert.equal(h.pendingNoticeMeta.has(second.id), true, 'the metadata cap cannot evict an active claim')
  h.releaseClaimedNotices(h.parent, 1)
  h.parent.inbox = { nextTurn: [], nextStep: [] }
  h.scheduleReconcileInbox('p')
  await Promise.resolve()
  assert.equal(h.pendingNoticeMeta.size, 0)
})

test('apply wires synchronous claimed notice protection before hooks cleanup and pre-step rebuilding', async () => {
  let scan
  const realSet = globalThis.setInterval
  globalThis.setInterval = (fn) => { scan = fn; return { unref() {} } }
  const main = fakeAgent({ id: 'claim-root' })
  const { inbox } = recordingInbox()
  main.agent.inbox = inbox
  main.agent.followup = (message) => inbox.nextTurn.push(message)
  const live = new Map([[main.agent.id, main.agent], ['c1', {}], ['c2', {}]])
  let settle
  const receipt = new Promise((resolve) => { settle = resolve })
  let nextChild = 0
  let harness
  try {
    harness = start({
      agents: { get: (id) => live.get(id) },
      sessions: { get: () => ({ log: [] }), flush: async () => true },
      subagents: {
        resolveMaxDepth: () => 1,
        startActivation: async () => ({ childId: `c${++nextChild}`, result: nextChild === 1 ? receipt : undefined }),
      },
    })
  } finally {
    globalThis.setInterval = realSet
  }
  harness.created({ agent: main.agent })
  harness.config.superviseNotifyOnNoProgress = true
  const realNow = Date.now
  try {
    Date.now = () => 1_000
    const delegate = harness.tools.find(({ name }) => name === 'delegate')
    for (const index of [1, 2]) await delegate.execute({
      description: `领取窗口任务${index}`, prompt: '执行', writeScope: [`C:/repo/claim${index}.js`], provider: 'p', model: 'm',
    }, { agent: main.agent, signal: new AbortController().signal })
    Date.now = () => 601_000
    scan()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(inbox.nextTurn.length, 1)
    const message = inbox.nextTurn.shift()
    const claimed = harness.handlers.get('agent/inbox/claimed')
    assert.equal(typeof claimed, 'function')
    assert.equal(harness.handlerOptions.get('agent/inbox/claimed')?.global, true)
    claimed({ agent: main.agent, message, turn: 1 })
    settle()
    await receipt
    await new Promise((resolve) => setImmediate(resolve))
    Date.now = () => 9_000_000
    const decision = await harness.handlers.get('agent/pre-step')({
      agent: main.agent, turn: 1, step: 1, messages: [message],
    }, async () => ({ kind: 'enter', messages: [message] }))
    assert.deepEqual(decision.messages[0].source.childIds, ['c2'])
    assert.match(decision.messages[0].content[0].text, /领取窗口任务2/)
    assert.match(decision.messages[0].content[0].text, /已运行 10m00s/)
    assert.match(decision.messages[0].content[0].text, /第 1\/3 次/)
  } finally {
    Date.now = realNow
  }
})

/** Hold the actual Todo append open so liveness changes happen after restoration starts. */
function blockTodoAppend(harness) {
  const append = harness.main.agent.session.append
  let started
  let release
  const entered = new Promise((resolve) => { started = resolve })
  const blocked = new Promise((resolve) => { release = resolve })
  harness.main.agent.session.append = async (...args) => {
    started()
    await blocked
    return append(...args)
  }
  return { entered, release }
}

/** Exercise the early stale branch while recording the exact downstream batch and restore calls. */
async function initialStaleRestorationHarness() {
  const h = await supervisionTurnHarness()
  const { createSupervisionTurnState } = await import('../lib/gate.js')
  const turnState = createSupervisionTurnState()
  const tracker = mod.createTodoSnapshotTracker(h.ctx)
  tracker.bind(h.main.agent)
  turnState.bindTurn(h.main.agent.id, 1)
  h.projection.todos = null
  const append = blockTodoAppend(h)
  const supervisor = mod.createSupervision({ ctx: h.ctx, config: h.config }).supervisor
  const messages = [h.message]
  const nextInputs = []
  let restoreCalls = 0
  const preStep = mod.createSupervisionPreStep({
    ctx: h.ctx, config: h.config, supervisor, supervisionTurnState: turnState,
    todoTracker: {
      ...tracker,
      restore: (...args) => { restoreCalls += 1; return tracker.restore(...args) },
    },
    nextStep: async (payload, next) => { nextInputs.push(payload.messages); return next() },
  })
  const run = (next = async () => ({ kind: 'enter', messages: nextInputs.at(-1) })) => preStep({
    agent: h.main.agent, step: 1, turn: 1, messages,
  }, next)
  return { ...h, append, supervisor, tracker, turnState, messages, nextInputs, run, restoreCalls: () => restoreCalls }
}

for (const kind of ['user', 'subagent-settled']) {
  test(`initially stale supervision preserves ${kind} arriving during todo restoration before next`, async () => {
    for (const invalidateDuringAppend of kind === 'user' ? [false, true] : [false]) {
      const h = await initialStaleRestorationHarness()
      const pending = h.run()
      await h.append.entered
      const ordinary = { id: `early-append-${kind}`, source: { kind } }
      h.messages.push(ordinary)
      if (invalidateDuringAppend) h.tracker.invalidate(h.main.agent.session)
      h.append.release()
      assert.deepEqual(await pending, { kind: 'enter', messages: [ordinary] })
      assert.deepEqual(h.nextInputs, [[ordinary]], 'next receives only the surviving ordinary input')
      assert.equal(h.turnState.isTurnActive(h.main.agent.id, 1), false)
      assert.equal(h.tracker.canRestore(h.main.agent.session), kind !== 'user')
      assert.equal(h.restoreCalls(), 1)
      assert.equal(h.writes.length, 1)
    }
  })
}

test('initially stale supervision rejects absent or auxiliary-only input after one restoration without next', async () => {
  for (const kind of [undefined, 'runtime-context', 'time-context']) {
    const h = await initialStaleRestorationHarness()
    const pending = h.run()
    await h.append.entered
    if (kind !== undefined) h.messages.push({ id: `early-append-${kind}`, source: { kind } })
    h.append.release()
    assert.deepEqual(await pending, { kind: 'reject' }, kind)
    assert.deepEqual(h.nextInputs, [], kind)
    assert.equal(h.turnState.isTurnActive(h.main.agent.id, 1), false, kind)
    assert.equal(h.restoreCalls(), 1, kind)
    assert.equal(h.writes.length, 1, kind)
  }
})

test('initially stale supervision reclassifies new live notices and restores only once across next', async () => {
  for (const mixed of [false, true]) {
    const h = await initialStaleRestorationHarness()
    const pending = h.run()
    await h.append.entered
    h.supervisor.track({ childId: h.childId, parentId: h.main.agent.id })
    const notice = supervisionMessage('new-live-notice', [h.childId])
    const ordinary = { id: 'new-settlement', source: { kind: 'subagent-settled' } }
    const expected = mixed ? [notice, ordinary] : [notice]
    h.messages.push(...expected)
    h.append.release()
    assert.deepEqual(await pending, { kind: 'enter', messages: expected })
    assert.deepEqual(h.nextInputs, [expected])
    assert.equal(h.turnState.isTurnActive(h.main.agent.id, 1), !mixed)
    assert.equal(h.restoreCalls(), 1, 'entry and downstream share a single restoration budget')
    assert.equal(h.writes.length, 1)
  }
})

test('ordinary input rescued before next preserves downstream continue and reject decisions', async () => {
  for (const kind of ['continue', 'reject']) {
    const h = await initialStaleRestorationHarness()
    const downstream = { kind, reason: 'downstream decision' }
    const pending = h.run(async () => downstream)
    await h.append.entered
    const user = { id: 'rescued-user', source: { kind: 'user' } }
    h.messages.push(user)
    h.append.release()
    assert.deepEqual(await pending, downstream)
    assert.deepEqual(h.nextInputs, [[user]])
    assert.equal(h.turnState.isTurnActive(h.main.agent.id, 1), false)
    assert.equal(h.tracker.canRestore(h.main.agent.session), false)
    assert.equal(h.restoreCalls(), 1)
  }
})

test('a concurrent user step keeps old todo eligibility invalid after an in-flight restoration', async () => {
  const h = await supervisionTurnHarness()
  h.projection.todos = null
  const append = blockTodoAppend(h)
  const pending = h.preStep()
  await append.entered
  const user = { id: 'concurrent-user', source: { kind: 'user' } }
  assert.deepEqual(await h.preStep([user], { step: 2 }), { kind: 'enter', messages: [user] })
  append.release()
  await pending
  assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined)
  h.projection.todos = null
  h.boundary.lastTurn = 2
  await h.preStep()
  assert.equal(h.writes.length, 1, 'the old restoration event must not requalify the invalidated snapshot')
})

test('deep-copied restoration events cannot requalify todos invalidated by a concurrent user step', async () => {
  const h = await supervisionTurnHarness({ copyEvents: true })
  h.projection.todos = null
  const append = blockTodoAppend(h)
  const pending = h.preStep()
  await append.entered
  const user = { id: 'copied-restoration-user', source: { kind: 'user' } }
  await h.preStep([user], { step: 2 })
  append.release()
  await pending
  assert.equal(h.writes.length, 1)
  h.projection.todos = null
  h.boundary.lastTurn = 2
  await h.preStep()
  assert.equal(h.writes.length, 1, 'the copied self event must not restore old task eligibility')
})

test('a legitimate same-content todo write during a pending restoration retains new eligibility', async () => {
  const todos = [{ content: '同样任务', status: 'in_progress' }]
  const h = await supervisionTurnHarness({ todos, copyEvents: true })
  h.projection.todos = null
  const append = blockTodoAppend(h)
  const pending = h.preStep()
  await append.entered
  await h.preStep([{ id: 'same-content-user', source: { kind: 'user' } }], { step: 2 })
  h.event('todo/write', { todos: structuredClone(todos) })
  append.release()
  await pending
  h.projection.todos = null
  h.boundary.lastTurn = 2
  await h.preStep()
  assert.equal(h.writes.length, 2, 'same content does not identify a self restoration event')
  assert.deepEqual(h.writes[1].data.todos, todos)
})

test('concurrent deep-copied restorations retain distinct origin tokens until each append settles', async () => {
  const h = await supervisionTurnHarness({ copyEvents: true })
  h.projection.todos = null
  const append = h.main.agent.session.append
  const releases = []
  let entered
  const waiting = new Promise((resolve) => { entered = resolve })
  h.main.agent.session.append = async (...args) => {
    await new Promise((resolve) => {
      releases.push(resolve)
      if (releases.length === 2) entered()
    })
    return append(...args)
  }
  const first = h.preStep()
  const second = h.preStep()
  await waiting
  await h.preStep([{ id: 'concurrent-copied-user', source: { kind: 'user' } }], { step: 2 })
  releases[0]()
  await first
  releases[1]()
  await second
  assert.equal(h.writes.length, 2)
  assert.notEqual(h.writes[0].data.source.token, h.writes[1].data.source.token)
  h.projection.todos = null
  h.boundary.lastTurn = 2
  await h.preStep()
  assert.equal(h.writes.length, 2, 'one settled append cannot release the other append origin')
})

test('unowned and already released restoration origins do not suppress legitimate todo writes', async () => {
  for (const mode of ['unknown', 'released']) {
    const h = await supervisionTurnHarness({ copyEvents: true })
    h.projection.todos = null
    await h.preStep()
    await h.preStep([{ id: `unowned-origin-${mode}`, source: { kind: 'user' } }], { step: 2 })
    const data = structuredClone(h.writes[0].data)
    if (mode === 'unknown') data.source.token = 'unowned-token'
    h.event('todo/write', data)
    h.projection.todos = null
    h.boundary.lastTurn = 2
    await h.preStep()
    assert.equal(h.writes.length, 2, mode)
  }
})

test('failed restoration releases its origin token before a later genuine todo write', async () => {
  for (const mode of ['throw', 'reject']) {
    const h = await supervisionTurnHarness({ copyEvents: true })
    let failedData
    h.projection.todos = null
    const append = h.main.agent.session.append
    h.main.agent.session.append = (type, data) => {
      failedData = structuredClone(data)
      if (mode === 'throw') throw new Error('pre-commit validation failed')
      return Promise.reject(new Error('append rejected'))
    }
    await h.preStep()
    assert.equal(h.writes.length, 0)
    await h.preStep([{ id: `failed-origin-${mode}`, source: { kind: 'user' } }], { step: 2 })
    h.event('todo/write', failedData)
    h.main.agent.session.append = append
    h.projection.todos = null
    h.boundary.lastTurn = 2
    await h.preStep()
    assert.equal(h.writes.length, 1, `${mode}: failed append must not leave its origin token owned`)
  }
})

test('workers settling while todo restoration awaits append reject and clear the supervision binding', async () => {
  for (const mode of ['settled', 'missing', 'runtime-context']) {
    const h = await supervisionTurnHarness()
    h.projection.todos = null
    const append = blockTodoAppend(h)
    const messages = [h.message]
    if (mode === 'runtime-context') messages.push({ id: 'clock', source: { kind: 'runtime-context' } })
    const pending = h.preStep(messages)
    await append.entered
    assert.match(h.main.guards[0]({ name: 'todo_write' }), /定时巡检回合/, mode)
    if (mode === 'missing') h.live.delete(h.childId)
    else h.handlers.get('subagent/end')({ id: h.childId, stopReason: 'completed' })
    append.release()
    assert.deepEqual(await pending, { kind: 'reject' }, mode)
    assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined, mode)
    assert.equal(h.writes.length, 1, 'the same step restores only once')
  }
})

test('ordinary messages arriving while todo restoration awaits append survive stale notice removal', async () => {
  for (const kind of ['user', 'subagent-settled']) {
    const h = await supervisionTurnHarness()
    h.projection.todos = null
    const messages = [h.message]
    const append = blockTodoAppend(h)
    const pending = h.preStep(undefined, {}, async () => ({ kind: 'enter', messages }))
    await append.entered
    const ordinary = { id: `during-append-${kind}`, source: { kind } }
    messages.push(ordinary)
    h.handlers.get('subagent/end')({ id: h.childId, stopReason: 'completed' })
    append.release()
    assert.deepEqual(await pending, { kind: 'enter', messages: [ordinary] }, kind)
    assert.equal(h.main.guards[0]({ name: 'todo_write' }), undefined, kind)
    assert.equal(h.writes.length, 1, kind)
  }
})

test('partial settlement while todo restoration awaits append recompiles live ids and saved rows', async () => {
  const h = await supervisionTurnHarness()
  h.live.set('other-worker', fakeAgent({ id: 'other-worker', depth: 1 }).agent)
  const { createSupervisionTurnState } = await import('../lib/gate.js')
  const s = mod.createSupervision({ ctx: h.ctx, config: h.config })
  for (const childId of [h.childId, 'other-worker']) s.supervisor.track({ childId, parentId: h.main.agent.id })
  const queued = []
  h.main.agent.followup = (message) => queued.push(message)
  await s.deliver(h.main.agent.id, '旧正文包含已结束任务', [h.childId, 'other-worker'], {
    rows: [{ childId: h.childId, label: '已结束任务' }, { childId: 'other-worker', label: '仍运行任务', startedAt: 1_000 }],
    composeMeta: { now: 61_000, index: 2, max: 3 },
  })
  const original = queued[0]
  const turnState = createSupervisionTurnState()
  const tracker = mod.createTodoSnapshotTracker(h.ctx)
  tracker.bind(h.main.agent)
  h.projection.todos = null
  const append = blockTodoAppend(h)
  const preStep = mod.createSupervisionPreStep({
    ctx: h.ctx, config: h.config, supervisor: s.supervisor, supervisionTurnState: turnState,
    todoTracker: tracker, rebuildNotice: s.rebuildNotice, nextStep: async (payload, next) => next(),
  })
  const pending = preStep({ agent: h.main.agent, step: 1, turn: 1, messages: [original] }, async () => ({
    kind: 'enter', messages: [original],
  }))
  await append.entered
  s.supervisor.forget(h.childId)
  append.release()
  const decision = await pending
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  assert.deepEqual(decision.messages[0].source.childIds, ['other-worker'])
  assert.equal(decision.messages[0].source.senderSessionId, 'other-worker')
  assert.equal(decision.messages[0].content[0].text.includes('已结束任务'), false)
  assert.match(decision.messages[0].content[0].text, /仍运行任务/)
  assert.match(decision.messages[0].content[0].text, /已运行 1m00s/)
  assert.match(decision.messages[0].content[0].text, /第 2\/3 次/)
  assert.equal(decision.messages[0].id, original.id)
  assert.equal(turnState.isTurnActive(h.main.agent.id, 1), true)
  assert.equal(h.writes.length, 1)
})

test('todo restoration refuses detached or replaced root instances while downstream waits', async () => {
  for (const mode of ['disposed', 'missing', 'replaced']) {
    const h = await supervisionTurnHarness()
    h.projection.todos = null
    await h.preStep(undefined, {}, async () => {
      if (mode === 'disposed') h.handlers.get('agent/disposed')({ agent: h.main.agent })
      if (mode === 'missing') h.live.delete(h.main.agent.id)
      if (mode === 'replaced') h.live.set(h.main.agent.id, { id: h.main.agent.id })
      return { kind: 'enter', messages: [h.message] }
    })
    assert.deepEqual(h.writes, [], mode)
  }
})

test('session event routing ignores child and foreign sessions and cleans roots on plugin disposal', async () => {
  const h = await supervisionTurnHarness()
  await h.preStep()
  const event = h.handlers.get('session/event')
  const normal = { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '巡检：正常' }] } } }
  event(h.live.get(h.childId).session, normal)
  event({ id: h.main.agent.id }, normal)
  assert.equal(h.main.guards[0]({ name: 'read' }), undefined)
  const cleanup = h.effects.find(({ label }) => label === 'orchestrator: root agents')
  assert.equal(typeof cleanup?.dispose, 'function')
  cleanup.dispose()
  assert.equal(h.main.guards.length, 0)
  h.event('todo/write', { todos: [{ content: '卸载后事件' }] })
  h.projection.todos = null
  await h.preStep()
  assert.deepEqual(h.writes, [])
})

test('todo tracker refuses unregistered roots even when the host has no agents.get method', async () => {
  const writes = []
  const agent = { id: 'root', session: { append: async (type, data) => writes.push({ type, data }) } }
  let registered = false
  const tracker = mod.createTodoSnapshotTracker({
    sessionProjections: { snapshot: () => ({ values: { todos: null } }) },
  }, { isRegistered: () => registered })
  tracker.record(agent.session, [{ content: '有效快照' }])
  await tracker.restore(agent, { turn: 1 }, {})
  assert.deepEqual(writes, [])
  registered = true
  await tracker.restore(agent, { turn: 1 }, {})
  assert.equal(writes.length, 1)
})

test('late disposal of a replaced root does not remove the new instance gate or session route', async () => {
  const h = await supervisionTurnHarness()
  const replacement = fakeAgent({ id: h.main.agent.id })
  h.live.set(replacement.agent.id, replacement.agent)
  h.created({ agent: replacement.agent })
  assert.equal(h.main.guards.length, 0)
  assert.equal(replacement.guards.length, 1)
  h.handlers.get('agent/disposed')({ agent: h.main.agent })
  assert.equal(replacement.guards.length, 1)
  h.handlers.get('session/event')(replacement.agent.session, { type: 'todo/write', data: { todos: [{ content: '新实例快照' }] } })
  h.handlers.get('session/event')(h.main.agent.session, { type: 'todo/write', data: { todos: [{ content: '旧实例事件' }] } })
  h.projection.todos = null
  const writes = []
  replacement.agent.session.append = async (type, data) => writes.push({ type, data })
  const stale = supervisionMessage('stale-after-replacement', ['gone'])
  await h.handlers.get('agent/pre-step')({ agent: replacement.agent, turn: 1, step: 1, messages: [stale] }, async () => ({ kind: 'enter', messages: [stale] }))
  assert.equal(writes[0].data.todos[0].content, '新实例快照')
})

test('todo tracker exposes explicit invalidate and forget without resurrecting empty lists', () => {
  const tracker = mod.createTodoSnapshotTracker({ sessionProjections: { snapshot: () => ({ values: { todos: [{ content: 'a' }] } }) } })
  const session = {}
  tracker.bind({ session })
  assert.equal(tracker.canRestore(session), true)
  tracker.invalidate(session)
  assert.equal(tracker.canRestore(session), false)
  tracker.record(session, [{ content: 'b' }])
  assert.equal(tracker.canRestore(session), true)
  tracker.record(session, [])
  assert.equal(tracker.canRestore(session), false)
  tracker.forget(session)
  assert.equal(tracker.canRestore(session), false)
})
