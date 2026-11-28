import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PEER_CONSULT_SOURCE_KIND } from '../lib/read-index.js'
import { SESSION_TOOLS_DOMAIN, SESSION_TOOLS_NAMESPACE } from '../lib/session-tools.js'
import { NATIVE_TEAM_TOOLS } from '../lib/tool-surface.js'

// Exercise the real plugin assembly; only the host-framework imports and services are fake.
const stubs = {
  '@deepseek-ai/schemastery': `
    const chain = () => Object.fromEntries(['default', 'volatile', 'description', 'min', 'max', 'step']
      .map((key) => [key, chain]))
    export default { object: chain, boolean: chain, string: chain, number: chain, array: chain }
  `,
  '@deepseek-ai/dsh-tools': 'export const defineTool = (spec) => spec',
  '@deepseek-ai/dsh-llm': `
    let next = 0
    export const createUserMessage = (input) => ({ id: String(++next), role: 'user', ...input })
  `,
}
const stubHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { apply, DEFAULT_ALLOWED_TOOLS, SUPERVISE_SOURCE_KIND } = await import('../lib/index.js')
test.after(() => stubHook.deregister())

const finished = { stopReason: 'completed', output: [{ type: 'text', text: '完成' }] }
const put = (cwd, name, text = name) => writeFileSync(path.join(cwd, name), text)
const drain = () => new Promise((resolve) => setImmediate(resolve))
const hasConflict = (owner) => (error) => error?.code === 'write-scope-conflict' &&
  error.details.some((row) => row.owner === owner)

function harness(t, { onStart, onPrompt, team = NATIVE_TEAM_TOOLS, host = {}, config: overrides = {} } = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'dsh-phase1-'))
  const names = [...DEFAULT_ALLOWED_TOOLS, ...team, 'subagent_fork', 'workflow']
  const subscriptions = new Map()
  const toolSpecs = new Map()
  const liveAgents = new Map()
  const notices = []
  const prompts = []
  const starts = []
  const disposers = []
  const config = { superviseIntervalSeconds: 10, ...overrides }
  const guards = new Map()
  const removed = []
  const replacements = []
  const makeRoot = (id, { model, announce = true } = {}) => {
    const nextTurn = []
    const inbox = {
      nextTurn,
      nextStep: [],
      remove(messageId) {
        removed.push(messageId)
        const index = nextTurn.findIndex(({ id }) => id === messageId)
        if (index === -1) return false
        nextTurn.splice(index, 1)
        return true
      },
      replace(messageId, message) {
        replacements.push(messageId)
        const index = nextTurn.findIndex(({ id }) => id === messageId)
        if (index === -1) return false
        nextTurn[index] = message
        return true
      },
    }
    const agent = {
      id,
      cwd,
      inbox,
      model,
      session: { id, header: { cwd } },
      followup(message) { notices.push(message); inbox.nextTurn.push(message) },
      ctx: { tools: { guard: (fn) => { guards.set(id, fn) } } },
    }
    liveAgents.set(id, agent)
    if (announce) subscriptions.get('agent/created')?.({ agent })
    return agent
  }
  const parent = makeRoot('root')
  const exec = { agent: parent, signal: new AbortController().signal }
  const ctx = {
    ...host,
    tools: {
      register: (spec) => { toolSpecs.set(spec.name, spec) },
      view: () => ({ knownNames: names }),
      definitions: () => names.map((name) => toolSpecs.get(name) ?? { name }),
    },
    agents: { get: (id) => liveAgents.get(id), list: () => [...liveAgents.values()] },
    sessions: { get: (id) => liveAgents.get(id)?.session, flush: async () => true },
    sessionProjections: { stateOf: () => ({ 'next-turn': [], 'next-step': [] }) },
    effect: (setup) => disposers.push(setup()),
    on: (event, listener) => subscriptions.set(event, listener),
    logger: { info() {}, warn() {} },
    subagents: {
      resolveMaxDepth: () => 2,
      async startActivation(spec) {
        const id = `worker-${starts.length + 1}`
        const parentId = spec.parent.id
        const agent = {
          id,
          options: { subagentDepth: 1 },
          session: { id, log: [], header: { cwd, parentSession: parentId, delegationDepth: 1 } },
        }
        starts.push({ spec, agent })
        liveAgents.set(id, agent)
        subscriptions.get('subagent/start')({ id, runId: `${id}-first`, parentSessionId: spec.parent.id })
        const result = onStart?.(spec, id) ?? finished
        return { childId: id, result: spec.delivery === 'caller' ? Promise.resolve(result) : undefined }
      },
      async prompt(request) {
        prompts.push(request)
        await onPrompt?.(request)
        return { messageId: 'queued' }
      },
    },
  }
  ctx.get ??= (name) => ctx[name]
  apply(ctx, config)
  t.after(async () => {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose()
    rmSync(cwd, { recursive: true, force: true })
  })
  const route = { provider: 'test', model: 'test' }
  return {
    cwd, config, ctx, parent, starts, notices, prompts, toolSpecs, makeRoot, removed, replacements,
    event: (name, ...args) => subscriptions.get(name)(...args),
    check: (name, agent = parent, args) => guards.get(parent.id)({ name, agent, arguments: args }),
    definitions: (agent = parent) => ctx.tools.definitions(agent).map(({ name }) => name),
    delegate: (options, agent = parent) => toolSpecs.get('delegate').execute({
      ...route, prompt: '执行', description: '测试', ...options,
    }, { ...exec, agent }),
    status: async (options = {}, agent = parent) => (await toolSpecs.get('delegate_status').execute(options, { agent })).details,
    batch: (options) => toolSpecs.get('orchestrate').execute({ ...route, items: [1], stages: [{ name: 'stage', prompt: '执行' }], ...options }, exec),
    start: (id, runId) => subscriptions.get('subagent/start')({ id, runId, parentSessionId: parent.id }),
    end: (id, stopReason = 'completed', runId = `${id}-first`) => subscriptions.get('subagent/end')({ id, runId, stopReason, parentSessionId: parent.id }),
    dispose(agent) {
      liveAgents.delete(agent.id)
      subscriptions.get('agent/disposed')({ agent })
    },
    claim(kind, turn, agent = parent) {
      const queue = agent.inbox.nextTurn
      const index = queue.findIndex((message) => message.source.kind === kind)
      assert.notEqual(index, -1, `no queued ${kind} message`)
      const [message] = queue.splice(index, 1)
      subscriptions.get('agent/inbox/claimed')({ agent, message, turn })
      return message
    },
    preStep(messages, { turn = 1, step = 1, agent = parent, signal, next } = {}) {
      const decision = { kind: 'enter', messages }
      return subscriptions.get('agent/pre-step')({ agent, messages, turn, step, signal }, next ?? (async () => decision))
    },
    turnEnd(turn, agent = parent) {
      subscriptions.get('session/event')(agent.session, { type: 'turn/end', data: { turn } })
    },
  }
}

test('phase 1: installed gate and definitions follow native Team catalog and live switches', (t) => {
  const available = NATIVE_TEAM_TOOLS.slice(0, -1)
  const h = harness(t, { team: available })
  for (const name of available) {
    assert.ok(h.definitions().includes(name), name)
    assert.equal(h.check(name), undefined)
  }
  const unavailable = NATIVE_TEAM_TOOLS.at(-1)
  assert.ok(!h.definitions().includes(unavailable))
  assert.match(h.check(unavailable), /not available/)
  for (const name of ['subagent_fork', 'workflow']) {
    assert.ok(!h.definitions().includes(name))
    assert.match(h.check(name), /ADR-0004 默认禁用/)
  }
  assert.match(h.ctx.tools.definitions(h.parent).find(({ name }) => name === 'delegate').description,
    /team_task_\* 仅用于共享任务板/)
  h.config.allowAgentTeam = false
  assert.ok(available.every((name) => !h.definitions().includes(name)))
  assert.match(h.check(available[0]), /allowAgentTeam: false/)
  h.config.allowedTools = [...available, 'workflow']
  assert.deepEqual(h.definitions(), ['workflow'])
  h.config.allowAgentTeam = true
  assert.deepEqual(h.definitions(), [...available, 'workflow'])
  h.config.allowedTools = []
  assert.deepEqual(h.definitions(), [])
})

function sessionStorage(rows = new Map()) {
  const domains = new Set()
  let remote
  const host = {
    provide(name, service) {
      assert.equal(name, SESSION_TOOLS_NAMESPACE)
      assert.equal(service.typertRemote.service, service)
      remote = service
      return () => { remote = undefined }
    },
    typert: { register: () => async () => {} },
    storageDomain: {
      async open(spec) {
        domains.add(spec.name)
        const tables = new Map(Object.keys(spec.tables).map((name) => [name,
          spec.name === SESSION_TOOLS_DOMAIN ? rows : new Map(),
        ]))
        let global = spec.global?.initial
        return {
          table(name) {
            const stored = tables.get(name)
            return {
              entries: () => stored.entries(),
              async put(key, value) { stored.set(key, value) },
              async delete(key) { return stored.delete(key) },
              async deleteMany(keys) { for (const key of keys) stored.delete(key) },
            }
          },
          global: {
            get: () => global,
            async set(value) { global = value },
          },
          async close() {},
        }
      },
    },
  }
  return { host, domains, rows, get remote() { return remote } }
}

test('one session override drives declarations, delegate descriptions and direct or PTC guards', async (t) => {
  const storage = sessionStorage()
  const h = harness(t, { host: storage.host })
  const { remote, domains, rows } = storage
  const a = h.parent
  const b = h.makeRoot('B')
  const worker = { id: 'child', session: { id: 'root', header: { delegationDepth: 1 } } }
  h.config.allowedTools = ['delegate', 'orchestrate']
  const shared = h.ctx.tools.definitions().find(({ name }) => name === 'delegate')
  const description = (agent) => h.ctx.tools.definitions(agent).find(({ name }) => name === 'delegate')?.description
  const base = await remote.get(a.session.id)
  assert.equal(base.storageReady, true)
  assert.deepEqual(base.allowedTools, ['delegate', 'orchestrate'])
  assert.deepEqual(domains, new Set(['dsh_orchestrator_state', SESSION_TOOLS_DOMAIN]))

  // Model-facing copies may differ even as the registry object and other sessions stay stable.
  const custom = await remote.set(a.session.id, ['delegate', 'workflow', NATIVE_TEAM_TOOLS[0]], base.revision)
  assert.deepEqual(h.definitions(a), ['delegate', NATIVE_TEAM_TOOLS[0], 'workflow'])
  assert.deepEqual(h.definitions(b), ['delegate', 'orchestrate'])
  assert.match(description(a), /: delegate, workflow, team_task_create。/)
  assert.match(description(b), /: delegate, orchestrate。/)
  assert.match(shared.description, /: delegate, orchestrate。/)
  assert.doesNotMatch(shared.description, /: delegate, workflow/)
  assert.equal(h.ctx.tools.definitions().find(({ name }) => name === 'delegate'), shared)
  assert.equal(h.check('workflow', a), undefined)
  assert.match(h.check('workflow', b), /默认禁用/)
  assert.match(h.check('orchestrate', a), /not available/)
  assert.equal(h.check('orchestrate', b), undefined)

  // Like the host PTC pipeline, admit the transport first, then guard the nested call
  // separately with the same executing agent (without executing a real user program).
  const ptc = (agent, name) => h.check('run_code', agent, { code: `await tools.${name}()` }) ?? h.check(name, agent)
  assert.equal(ptc(a, 'workflow'), undefined)
  assert.match(ptc(b, 'workflow'), /默认禁用/)
  assert.match(ptc(a, 'orchestrate'), /not available/)
  assert.equal(ptc(b, 'orchestrate'), undefined)
  h.config.allowAgentTeam = false
  assert.ok(!h.definitions(a).includes(NATIVE_TEAM_TOOLS[0]))
  assert.match(h.check(NATIVE_TEAM_TOOLS[0], a), /allowAgentTeam: false/)
  assert.doesNotMatch(description(a), /team_task_create/)
  assert.ok(h.definitions(worker).includes('workflow'))
  assert.ok(!h.definitions(worker).includes('delegate'))
  assert.equal(h.check('workflow', worker), undefined)

  const empty = await remote.set(a.session.id, [], custom.revision)
  assert.deepEqual(h.definitions(a), [])
  assert.equal(description(a), undefined)
  assert.match(ptc(a, 'delegate'), /not available/)
  assert.deepEqual(h.definitions(b), ['delegate', 'orchestrate'])
  const sameAsGlobal = await remote.set(a.session.id, ['delegate', 'orchestrate'], empty.revision)
  assert.equal(sameAsGlobal.enabled, true)
  h.config.allowedTools = ['delegate']
  assert.deepEqual(h.definitions(a), ['delegate', 'orchestrate'])
  assert.deepEqual(h.definitions(b), ['delegate'])
  const cleared = await remote.clear(a.session.id, sameAsGlobal.revision)
  assert.equal(cleared.enabled, false)
  assert.deepEqual(h.definitions(a), ['delegate'])
  assert.deepEqual(h.config.allowedTools, ['delegate'])
  assert.equal(rows.size, 0)
})

test('a confirmed local Dispatch switch controls native and PTC read guards for that root only', async (t) => {
  const storage = sessionStorage()
  const h = harness(t, { host: storage.host, team: ['working_directory'],
    config: { enabled: true, allowedTools: ['delegate'], superviseEnabled: false } })
  const remote = storage.remote
  const session = h.parent.session
  const other = h.makeRoot('other')
  const global = await remote.get(session.id)
  const snapshot = await remote.setConfig(session.id, global.config, global.revision)
  const local = await remote.setConfig(session.id, { enabled: false }, snapshot.revision)
  assert.equal(local.enabled, true, 'Only for this session is active')
  assert.equal(local.config.enabled, false, 'Dispatch is off')
  const checkScope = (agent, dispatch) => {
    const names = h.definitions(agent)
    assert.equal(names.includes('delegate'), dispatch)
    assert.equal(names.includes('working_directory'), !dispatch)
    const outer = h.check('run_code', agent, { code: 'return await tools.working_directory({})' })
    assert.equal(outer, undefined)
    const nested = h.check('working_directory', agent, {})
    if (dispatch) assert.match(nested, /main agent only plans/)
    else assert.equal(nested, undefined)
  }
  checkScope(h.parent, false)
  assert.equal((await remote.get(session.id)).config.enabled, false)
  assert.equal((await remote.get(other.session.id)).config.enabled, true)
  checkScope(other, true)
  await remote.clear(session.id, local.revision)
  checkScope(h.parent, true)
})

test('Team-off dispatch accepts the same optional fields with global and session settings', async (t) => {
  const storage = sessionStorage()
  const h = harness(t, { host: { ...storage.host, agentTeams: { isEnabled: () => false } },
    config: { enabled: true, readOnlyEnabled: true, superviseEnabled: false, workerProvider: 'test', workerModel: 'panel' } })
  const remote = storage.remote
  const root = h.parent.session.id
  const initial = await remote.get(root)
  const specs = () => h.ctx.tools.definitions(h.parent).filter(({ name }) => ['delegate', 'orchestrate'].includes(name))
  const baseline = specs().map(({ parameters }) => parameters)
  for (const local of [false, true]) {
    if (local) await remote.setConfig(root, initial.config, initial.revision)
    const state = await remote.get(root)
    assert.equal(state.enabled, local)
    assert.equal(state.config.enabled, true)
    const projected = specs()
    assert.deepEqual(projected.map(({ name }) => name).sort(), ['delegate', 'orchestrate'])
    assert.deepEqual(projected.map(({ parameters }) => parameters), baseline)
    for (const { name, parameters, description } of projected) {
      assert.equal(parameters.team_task_id.type, 'string')
      assert.notEqual(parameters.team_task_id.required, true)
      const required = Object.keys(parameters).filter((key) => parameters[key].required === true).sort()
      assert.deepEqual(required, name === 'delegate' ? ['description', 'prompt'] : ['items', 'stages'])
      assert.doesNotMatch(description, /先用 team_task_create 建立共享目标/)
    }
    for (const options of [{}, { team_task_id: '' }]) {
      const args = { readOnly: true, provider: '', model: '', reasoning_effort: '', ...options }
      const start = h.starts.length
      await h.delegate(args)
      await h.batch(args)
      const launched = h.starts.slice(start)
      assert.equal(launched.length, 2)
      for (const { spec } of launched) {
        assert.deepEqual(spec.agentOptions, { provider: 'test', model: 'panel' })
        assert.doesNotMatch(spec.prompt[0].text, /team_task_id|team_task_get/)
      }
    }
  }
})

test('main model routing applies live session overrides and restores persisted routes on cold creation', async (t) => {
  const storage = sessionStorage()
  const initial = { provider: 'global', model: 'first' }
  const updated = { provider: 'global', model: 'second' }
  const pinned = { provider: 'session', model: 'pinned', reasoningEffort: 'high' }
  let globalRoute = initial
  const globalsWritten = []
  const hostModel = {
    currentSelection: () => globalRoute,
    mutate: (route) => globalsWritten.push(route),
  }
  const hostModelFor = (root, h) => {
    const select = t.mock.fn((route) => { root.route = route })
    return {
      select,
      model: { select },
      routes: () => select.mock.calls.map(({ arguments: [route] }) => route),
      async preparedRoute(agent) {
        await h.preStep([], {
          agent,
          next: async () => {
            root.prepared = root.route
            return { kind: 'enter', messages: [] }
          },
        })
        return root.prepared
      },
    }
  }
  const h = harness(t, { host: { ...storage.host, agentDefaultModel: hostModel } })
  const active = hostModelFor({ route: initial }, h)
  const inherited = hostModelFor({ route: initial }, h)
  const a = h.makeRoot('active', { model: active.model })
  const b = h.makeRoot('inherited', { model: inherited.model })
  const before = await storage.remote.get(a.id)
  await drain()
  assert.equal(await active.preparedRoute(a), initial)
  const changed = await storage.remote.setConfig(a.id, { mainRoute: pinned }, before.revision)
  assert.deepEqual(changed.config.mainRoute, pinned)
  assert.deepEqual(await active.preparedRoute(a), pinned)
  assert.deepEqual(active.routes(), [pinned])
  assert.deepEqual(inherited.routes(), [])
  assert.equal(hostModel.currentSelection(), initial)

  globalRoute = updated
  h.event('settings/document-updated')
  h.event('settings/document-updated')
  assert.deepEqual(active.routes(), [pinned])
  assert.deepEqual(inherited.routes(), [updated])
  assert.deepEqual(await inherited.preparedRoute(b), updated)

  const coldStorage = sessionStorage(storage.rows)
  const cold = harness(t, { host: { ...coldStorage.host, agentDefaultModel: hostModel } })
  await coldStorage.remote.get(cold.parent.id)
  await drain()
  const restored = hostModelFor({ route: updated }, cold)
  const resumed = cold.makeRoot(a.id, { model: restored.model, announce: false })
  assert.deepEqual(restored.routes(), [])
  await cold.event('agent/created', { agent: resumed, source: 'resume' })
  assert.deepEqual(restored.routes(), [pinned])
  assert.deepEqual(await restored.preparedRoute(resumed), pinned)

  const cleared = await storage.remote.clear(a.id, changed.revision)
  assert.equal(cleared.enabled, false)
  assert.deepEqual(cleared.config.mainRoute, updated)
  assert.deepEqual(active.routes(), [pinned, updated])
  assert.deepEqual(await active.preparedRoute(a), updated)
  assert.deepEqual(inherited.routes(), [updated])
  assert.deepEqual(globalsWritten, [])
  assert.equal(hostModel.currentSelection(), updated)
})

test('read-only dispatch is opt-in for the model schema, execution and guidance', async (t) => {
  const h = harness(t)
  const declarations = () => h.ctx.tools.definitions(h.parent)
    .filter(({ name }) => name === 'delegate' || name === 'orchestrate')
  const assertSchema = (enabled) => {
    const definitions = declarations()
    assert.deepEqual(definitions.map(({ name }) => name).sort(), ['delegate', 'orchestrate'])
    for (const { name, parameters, description } of definitions) {
      assert.equal(Object.hasOwn(parameters.properties ?? parameters, 'readOnly'), enabled, name)
      if (name === 'delegate') {
        const sharedGuidance = /只读调研.*isolation: "shared".*不得修改文件/
        if (enabled) assert.doesNotMatch(description, sharedGuidance)
        else assert.match(description, sharedGuidance)
      } else {
        assert.match(description, /主代理规则同 delegate/)
      }
    }
  }
  assertSchema(false)
  for (const invoke of [h.delegate, h.batch]) {
    await assert.rejects(invoke({ readOnly: true }), /readOnly 参数当前未启用.*isolation: "shared"/)
  }
  assert.equal(h.starts.length, 0)

  h.config.readOnlyEnabled = true
  assertSchema(true)
  const delegated = await h.delegate({ readOnly: true })
  assert.equal(delegated.subagentId, h.starts[0].agent.id)
  h.end(delegated.subagentId)
  await h.batch({ readOnly: true })
  assert.equal(h.starts[1].spec.delivery, 'caller')
})

test('phase 1: read-only delegate and batch leave the active writer lease untouched', async (t) => {
  const h = harness(t, { config: { readOnlyEnabled: true } })
  const writer = await h.delegate({ writeScope: ['allowed.txt'] })
  const reader = await h.delegate({ readOnly: true })
  assert.equal(reader.readOnly, true)
  assert.equal((await statusOf(h, reader.subagentId)).leaseState, 'none')
  assert.match(h.starts[1].spec.prompt[0].text, /不占写租约/)
  await assert.rejects(h.delegate({ readOnly: true, writeScope: ['allowed.txt'] }), /互斥/)
  await assert.rejects(h.batch({ readOnly: true, writeScope: ['allowed.txt'] }), /互斥/)
  await assert.rejects(h.delegate({ readOnly: 'true' }), /必须是布尔值/)
  assert.equal((await h.batch({ readOnly: true })).agentsStarted, 1)
  await assert.rejects(h.delegate({ writeScope: ['allowed.txt'] }), hasConflict(writer.subagentId))
  assert.equal((await h.delegate({ readOnly: true, writeScope: [] })).readOnly, true)
})

test('phase 1: retry reacquires before queueing and ignores stale lifecycle events', async (t) => {
  const h = harness(t)
  put(h.cwd, 'target.txt', 'before')
  const child = await h.delegate({ writeScope: ['target.txt'] })
  put(h.cwd, 'target.txt', 'first attempt')
  put(h.cwd, 'already-present.txt')
  h.end(child.subagentId, 'error')
  await drain()
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0].childSessionId, child.subagentId)
  const retryAttempt = await statusOf(h, child.subagentId)
  assert.equal(retryAttempt.attemptSeq, 2)
  assert.equal(retryAttempt.runId, null)
  assert.equal(retryAttempt.dispatchState, 'running')
  assert.equal(retryAttempt.leaseState, 'held')
  assert.notEqual(retryAttempt.leaseId, child.writeScope.leaseId)
  h.start(child.subagentId, 'second-run')
  h.end(child.subagentId, 'error')
  // The exact old run id is already closed; delivery of the duplicate cannot touch the new lease.
  assert.equal(h.prompts.length, 1)
  await assert.rejects(h.delegate({ writeScope: ['target.txt'] }), hasConflict(child.subagentId))
  put(h.cwd, 'target.txt', 'second attempt')
  h.end(child.subagentId, 'completed', 'second-run')
  const retryResult = await statusOf(h, child.subagentId)
  assert.equal(retryResult.attemptSeq, 2)
  assert.equal(retryResult.runId, 'second-run')
  assert.equal(retryResult.leaseState, 'released')
  await h.delegate({ writeScope: ['target.txt'], allowNewReason: '验证结算后同一作用域可重新获取' })
})

test('phase 1: disposal before settlement allows a new writer, then retry conflict refuses to queue', async (t) => {
  const h = harness(t)
  const old = await h.delegate({ writeScope: ['target.txt'] })
  h.dispose(h.starts[0].agent)
  const current = await h.delegate({ writeScope: ['target.txt'] })
  h.end(old.subagentId, 'error')
  await drain()
  assert.equal(h.prompts.length, 0)
  const [notice] = h.notices.filter((message) => message.source.kind === 'orchestrator-retry')
  assert.match(notice.content[0].text, /无法把重试提示送到它：写作用域冲突/)
  assert.match(notice.content[0].text, /target\.txt/)
  assert.ok(notice.content[0].text.includes(current.subagentId))
  await assert.rejects(h.delegate({
    writeScope: ['target.txt'], allowNewReason: '验证独立新建仍受现有写租约约束',
  }), hasConflict(current.subagentId))
})

test('phase 1: unknown retry delivery retains protection and blocks duplicate delivery', async (t) => {
  const h = harness(t, { onPrompt() { throw new Error('host queue rejected') } })
  const original = await h.delegate({ writeScope: ['target.txt'] })
  h.end(original.subagentId, 'error')
  await drain()
  assert.equal(h.prompts.length, 1)
  assert.match(h.notices.find(({ source }) => source.kind === 'orchestrator-retry').content[0].text, /host queue rejected/)
  h.end(original.subagentId, 'error')
  await drain()
  assert.equal(h.prompts.length, 1)
  await assert.rejects(h.delegate({ writeScope: ['target.txt'] }), hasConflict(original.subagentId))
})

test('phase 1: a read-only retry remains lease-free even with a live writer', async (t) => {
  const h = harness(t, { config: { readOnlyEnabled: true } })
  const writer = await h.delegate({ writeScope: ['target.txt'] })
  const reader = await h.delegate({ readOnly: true })
  h.end(reader.subagentId, 'error')
  await drain()
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0].childSessionId, reader.subagentId)
  assert.match(h.prompts[0].content[0].text, /不占写租约.*未提供逐子代理物理只读隔离/)
  await assert.rejects(h.delegate({ writeScope: ['target.txt'] }), hasConflict(writer.subagentId))
})

test('phase 1: the installed supervisor diagnoses a logged write outside the delegated scope', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const h = harness(t)
  await h.delegate({ writeScope: ['allowed.txt'] })
  h.starts[0].agent.session.log.push({
    seq: 1, time: Date.now(), type: 'tool/call',
    data: { name: 'write', arguments: { path: 'outside.txt', content: 'test' } },
  })
  t.mock.timers.tick(10_001)
  await drain()
  const [notice] = h.notices
  assert.equal(notice?.source.kind, 'orchestrator-supervision')
  assert.match(notice.content[0].text, /越界漂移.*outside\.txt/)
})

const settled = (childId, id = `settled-${childId}`) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text: `原生结算：${childId}` }],
  source: { kind: 'subagent-settled', senderSessionId: childId },
})
const rowsFor = (messages, kind) => messages.filter((message) => message.source.kind === kind)
const supervisionFor = (h) => rowsFor(h.parent.inbox.nextTurn, SUPERVISE_SOURCE_KIND)
const statusOf = async (h, childId) => (await h.status({ childId })).items[0]

test('phase 1 T1: delegate_status isolates parent sessions and discloses the exact dispatch and lease state', async (t) => {
  const h = harness(t, { config: { readOnlyEnabled: true } })
  const other = h.makeRoot('another-root')
  const running = await h.delegate({ description: '根会话写入', writeScope: ['output.txt'] })
  const reader = await h.delegate({ readOnly: true })
  const foreign = await h.delegate({ description: '另一根会话私有任务', readOnly: true }, other)
  const child = h.starts[0].agent

  const active = await statusOf(h, running.subagentId)
  assert.equal(active.dispatchState, 'running')
  assert.equal(active.runId, `${child.id}-first`)
  assert.equal(active.leaseState, 'held')
  assert.equal(active.leaseId, running.writeScope.leaseId)
  assert.deepEqual(active.writeScope, ['output.txt'])
  const readOnly = await statusOf(h, reader.subagentId)
  assert.equal(readOnly.leaseState, 'none')
  assert.equal(readOnly.leaseId, null)

  h.end(child.id)
  const ended = await statusOf(h, child.id)
  assert.equal(ended.dispatchState, 'ended')
  assert.equal(ended.leaseState, 'released')
  assert.equal(ended.stopReason, 'completed')
  h.end(reader.subagentId)
  assert.equal((await statusOf(h, reader.subagentId)).leaseState, 'none')

  assert.ok(h.definitions().includes('delegate_status'))
  assert.equal(h.check('delegate_status'), undefined)
  assert.ok(!h.definitions(child).includes('delegate_status'))
  await assert.rejects(h.status({}, child), /仅限根代理调用/)
  assert.deepEqual((await h.status()).items.map(({ childId }) => childId).sort(), [child.id, reader.subagentId].sort())
  assert.equal((await h.status({ childId: foreign.subagentId })).total, 0)
  assert.equal((await h.status({ childId: child.id }, other)).total, 0)
  const otherStatus = await h.status({}, other)
  assert.equal(otherStatus.parentId, other.id)
  assert.deepEqual(otherStatus.items.map(({ childId }) => childId), [foreign.subagentId])
  await assert.rejects(h.status({ parentId: h.parent.id }, other), /不接受 parentId/)

  h.config.enabled = false
  for (const root of [h.parent, other]) {
    assert.ok(!h.definitions(root).includes('delegate_status'))
    assert.ok(h.check('delegate_status', root))
    await assert.rejects(h.status({}, root), /"delegate_status" is disabled while dispatch mode is off/)
  }
})

test('phase 1: native settlement is not rewritten and does not trigger another turn', async (t) => {
  const h = harness(t)
  const child = await h.delegate({ writeScope: ['result.txt'] })
  const native = settled(child.subagentId)
  h.end(child.subagentId)
  assert.deepEqual((await h.preStep([native])).messages, [native])
  assert.deepEqual(h.notices, [])
})

test('peer consultation follows session scope from tool results through child and root pre-step', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const storage = sessionStorage()
  const h = harness(t, { host: storage.host, config: { readOnlyEnabled: true } })
  const other = h.makeRoot('other-consult-parent')
  await h.delegate({ readOnly: true, isolation: 'shared' })
  await h.delegate({ readOnly: true, isolation: 'shared' })
  await h.delegate({ readOnly: true, isolation: 'shared' }, other)
  const [reader, peer, foreign] = h.starts.map(({ agent }) => agent)
  const user = { id: 'user-question', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续检查' }] }
  const observe = (agent, name, callId, args, value) =>
    h.event('tools/result', { agent, name, callId, arguments: args }, { value })
  const readFile = (agent, callId, path) => observe(agent, 'read', callId, { file_path: path, offset: 12 }, {
    lines: [{ number: 12, text: 'raw file text' }, { number: 13, text: 'more raw text' }],
  })
  const relay = (id, sender, text = '请概括已经读过的文件') => ({
    id,
    role: 'user',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: sender.id },
    content: [{ type: 'text', text: `来自 ${sender.id}` }, { type: 'text', text }],
  })
  const recordRelay = (message, sender, target) => observe(sender, 'send_message', `send-${message.id}`, {
    agent: target.id,
  }, { messageId: message.id })
  const setConsult = async (agent, enabled) => {
    const current = await storage.remote.get(agent.id)
    const saved = await storage.remote.setConfig(agent.id, { peerReadOnlyConsultEnabled: enabled }, current.revision)
    assert.equal(saved.config.peerReadOnlyConsultEnabled, enabled)
  }

  const disabledRelay = relay('disabled-relay', peer)
  readFile(reader, 'read-while-disabled', 'notes/disabled.txt')
  recordRelay(disabledRelay, peer, reader)
  await drain()
  assert.deepEqual((await h.preStep([disabledRelay], { agent: reader })).messages, [disabledRelay])
  assert.deepEqual((await h.preStep([user, disabledRelay])).messages, [user, disabledRelay])

  await setConsult(h.parent, true)
  await setConsult(other, true)
  assert.deepEqual((await h.preStep([user], { agent: peer })).messages, [user], 'disabled reads were never collected')
  assert.deepEqual((await h.preStep([user, disabledRelay])).messages, [user, disabledRelay], 'disabled relays were never recorded')
  readFile(reader, 'read-highlight', 'docs/overview.md')
  readFile(reader, 'read-highlight', 'docs/duplicate.md')
  readFile(foreign, 'read-foreign', 'docs/foreign.md')
  observe(reader, 'glob', 'paths', { pattern: 'docs/*.md' }, { paths: ['docs/guide.md'] })
  observe(reader, 'grep', 'hits', { pattern: 'section' }, {
    matches: [{ path: 'docs/index.md', line: 27, text: 'raw grep excerpt' }],
  })
  const [original, summary] = (await h.preStep([user], { agent: peer })).messages
  assert.equal(original, user)
  assert.equal(summary.source.kind, PEER_CONSULT_SOURCE_KIND)
  const summaryText = summary.content[0].text
  assert.match(summaryText, /【平级已读索引】/)
  assert.ok(summaryText.includes(`ID "${reader.id}"，只读任务`))
  assert.match(summaryText, /"docs\/overview\.md"（已读第 12–13 行）/)
  assert.match(summaryText, /"docs\/guide\.md"（路径匹配）/)
  assert.match(summaryText, /"docs\/index\.md"（第 27 行命中）/)
  assert.doesNotMatch(summaryText, /duplicate|foreign|disabled|raw file text|raw grep excerpt/)
  assert.deepEqual((await h.preStep([user], { agent: peer })).messages, [user], 'unchanged summaries are injected once')

  const question = relay('consult-question', peer)
  recordRelay(question, peer, reader)
  const [request, reminder] = (await h.preStep([question], { agent: reader })).messages
  assert.equal(request, question)
  assert.equal(reminder.source.kind, PEER_CONSULT_SOURCE_KIND)
  assert.ok(reminder.content[0].text.includes(`用 send_message 向 "${peer.id}" 回复`))
  assert.match(reminder.content[0].text, /【平级只读咨询答复】/)
  const answer = relay('consult-answer', reader, '【平级只读咨询答复】已读第 12–13 行')
  recordRelay(answer, reader, peer)
  await drain()

  peer.session.log.push({ seq: 1, time: Date.now(), type: 'turn/start', data: {} })
  t.mock.timers.tick(10_001)
  await drain()
  const patrol = h.claim(SUPERVISE_SOURCE_KIND, 1)
  const nativeSettlement = settled('native-child')
  const normalMessages = [nativeSettlement, patrol, user]
  const decision = await h.preStep([answer, nativeSettlement, question, patrol, user])
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages, normalMessages)
  assert.deepEqual(await h.preStep([answer], { turn: 2 }), { kind: 'reject' })
  assert.deepEqual((await h.preStep([user, answer], { agent: other })).messages, [user, answer])

  await setConsult(h.parent, false)
  assert.deepEqual((await h.preStep([user, answer], { turn: 3 })).messages, [user, answer])
  assert.deepEqual((await h.preStep([question], { agent: reader })).messages, [question])
})

test('session patrol intervals, limits and unlimited mode update already running workers per parent', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const storage = sessionStorage()
  const h = harness(t, { host: storage.host, config: { superviseNotifyOnNoProgress: true } })
  const a = h.parent
  const b = h.makeRoot('other-patrol-parent')
  const savePatrol = async (agent, patch) => {
    const current = await storage.remote.get(agent.id)
    const saved = await storage.remote.setConfig(agent.id, patch, current.revision)
    assert.equal(saved.enabled, true)
    for (const [field, value] of Object.entries(patch)) assert.equal(saved.config[field], value, field)
  }
  await savePatrol(a, { superviseIntervalSeconds: 30, superviseMaxNoticesPerChild: 1 })
  await savePatrol(b, { superviseIntervalSeconds: 20, superviseMaxNoticesPerChild: 0, superviseUnlimited: true })
  const first = await h.delegate({ isolation: 'shared', writeScope: ['first.txt'] }, a)
  const second = await h.delegate({ isolation: 'shared', writeScope: ['second.txt'] }, b)
  await savePatrol(a, { superviseIntervalSeconds: 10 })

  const advance = async (seconds) => {
    for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
      t.mock.timers.tick(5_000)
      await drain()
    }
  }
  const claimPatrol = (agent, turn, childId, expectedCount) => {
    const notice = h.claim(SUPERVISE_SOURCE_KIND, turn, agent)
    assert.deepEqual(notice.source.childIds, [childId])
    assert.ok(notice.content[0].text.startsWith(`【插件巡检｜第 ${expectedCount} 次】`))
    h.turnEnd(turn, agent)
  }
  await advance(5)
  assert.deepEqual(h.notices, [])
  await advance(5)
  claimPatrol(a, 1, first.subagentId, '1/1')
  assert.equal(h.notices.length, 1)
  assert.deepEqual(b.inbox.nextTurn, [])

  await advance(10)
  claimPatrol(b, 1, second.subagentId, '1')
  await advance(20)
  claimPatrol(b, 2, second.subagentId, '2')
  assert.equal(h.notices.length, 3)
  assert.deepEqual(a.inbox.nextTurn, [], 'the finite budget is exhausted')

  await savePatrol(a, { superviseUnlimited: true })
  await advance(5)
  claimPatrol(a, 2, first.subagentId, '2')
  assert.equal(h.notices.length, 4)
  assert.deepEqual(b.inbox.nextTurn, [])
  assert.equal(h.starts.length, 2, 'only the original workers ran')
})

test('phase 1: claimed patrols suppress the next tick and recompile without settled siblings', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const h = harness(t, { config: { readOnlyEnabled: true } })
  const runner = await h.delegate({ readOnly: true, description: '巡检触发项' })
  const sibling = await h.delegate({ readOnly: true, description: '同父安静项' })
  const tick = async () => { t.mock.timers.tick(10_001); await drain() }
  h.starts[0].agent.session.log.push({ seq: 1, time: Date.now(), type: 'turn/start', data: {} })
  await tick()
  const [initial] = supervisionFor(h)
  assert.deepEqual(initial.source.childIds, [runner.subagentId, sibling.subagentId])
  h.end(sibling.subagentId)
  await drain()
  const [updated] = supervisionFor(h)
  assert.equal(updated.id, initial.id)
  assert.deepEqual(h.replacements, [initial.id])
  assert.deepEqual(updated.source.childIds, [runner.subagentId])

  const claim = h.claim(SUPERVISE_SOURCE_KIND, 20)
  h.config.superviseNotifyOnNoProgress = true
  await tick()
  assert.deepEqual(supervisionFor(h), [], 'the claim protects the gap before pre-step')
  const decision = await h.preStep([claim], { turn: 20 })
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages[0].source.childIds, [runner.subagentId])
  await tick()
  assert.deepEqual(supervisionFor(h), [])
  h.end(runner.subagentId)
  h.turnEnd(20)
  await tick()
  assert.deepEqual(supervisionFor(h), [])
})
