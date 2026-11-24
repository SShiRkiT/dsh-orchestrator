import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const hostModules = {
  '@deepseek-ai/schemastery': `
    const chain = () => Object.fromEntries(['default', 'volatile', 'description', 'min', 'max', 'step']
      .map((key) => [key, chain]))
    export default { object: chain, boolean: chain, string: chain, number: chain, array: chain }
  `,
  '@deepseek-ai/dsh-tools': 'export const defineTool = (definition) => definition',
  '@deepseek-ai/dsh-llm': `
    let next = 0
    export const createUserMessage = (input) => ({ id: 'message-' + (++next), role: 'user', ...input })
  `,
}
const importHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = hostModules[specifier]
    return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      : nextResolve(specifier, context)
  },
})
const { apply, DEFAULT_ALLOWED_TOOLS, inject } = await import('../lib/index.js')
test.after(() => importHook.deregister())

const target = 'result.txt'
const done = { stopReason: 'completed', output: [{ type: 'text', text: '已完成' }] }
const plan = { items: [{ id: 1 }], stages: [{ name: '准备', prompt: '准备' }, { name: '校验', prompt: '校验' }] }
const defaults = { provider: 'test', model: 'test', writeScope: [target] }
const drain = () => new Promise((resolve) => setImmediate(resolve))

function deferred() {
  let resolve
  const promise = new Promise((finish) => { resolve = finish })
  return { promise, resolve }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-phase3-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  git(cwd, 'init', '--initial-branch=main')
  git(cwd, 'config', 'user.name', 'Phase 3 Integration')
  git(cwd, 'config', 'user.email', 'phase3@example.invalid')
  git(cwd, 'config', 'core.hooksPath', '.git/hooks')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(cwd, target), '初始内容\n')
  git(cwd, 'add', '--', target)
  git(cwd, 'commit', '-m', 'Initial')
  return cwd
}

function persistentFacility() {
  const documents = new Map()
  const calls = []
  let closingGate
  let active = false
  function rows(name) {
    const table = documents.values().next().value?.tables[name]
    return [...(table?.values() ?? [])].map((value) => structuredClone(value))
  }
  return {
    rows, calls,
    holdClose() { closingGate = deferred(); return closingGate.resolve },
    async open(spec) {
      assert.equal(spec.name, 'dsh_orchestrator_state')
      assert.equal(spec.layout, 'single')
      assert.equal(active, false, '上一代域未关闭，禁止双开')
      active = true
      calls.push('open')
      if (!documents.has(spec.name)) {
        documents.set(spec.name, { global: null, tables: Object.fromEntries(Object.keys(spec.tables).map((name) => [name, new Map()])) })
      }
      const document = documents.get(spec.name)
      let closed = false
      const checkOpen = () => assert.equal(closed, false, '不能在旧代 close 后继续写入')
      return {
        table(name) {
          const table = document.tables[name]
          const parse = spec.tables[name].valueSchema.parse
          return {
            entries: () => [...table.entries()].map(([key, value]) => [key, parse(structuredClone(value))]),
            async put(key, value) { checkOpen(); table.set(key, structuredClone(value)) },
            async delete(key) { checkOpen(); table.delete(key) },
            async deleteMany(keys) { for (const key of keys) { checkOpen(); table.delete(key) } },
          }
        },
        global: {
          get: () => document.global ? spec.global.schema.parse(document.global) : structuredClone(spec.global.initial),
          async set(value) { checkOpen(); document.global = structuredClone(value) },
        },
        async close() {
          checkOpen()
          if (closingGate) await closingGate.promise
          closingGate = undefined
          calls.push('close')
          closed = true
          active = false
        },
      }
    },
  }
}

function host(t, cwd, { storageDomain, queryMode = 'available', config = {} } = {}) {
  const handlers = new Map()
  const agents = new Map()
  const known = new Map()
  const starts = []
  const prompts = []
  const audits = []
  const notices = []
  const warnings = []
  const observations = []
  const released = []
  let onLaunch
  let onPrompt
  const remove = (list, value) => list.splice(list.indexOf(value), 1)
  const publish = (event, data) => Promise.all((handlers.get(event) ?? []).map((handler) => handler(data)))
  const childInfo = (row, stopReason) => ({ id: row.id, parentSessionId: row.parent.id, runId: row.runId, stopReason })
  const makeChild = (row, status = 'running') => ({
    id: row.id, cwd: row.cwd, status, options: { subagentDepth: 1 }, session: row.session,
  })
  function root(id) {
    const agent = {
      id, cwd, session: { header: { cwd, rootSessionId: id }, log: [] }, inbox: { nextTurn: [], nextStep: [] },
      ctx: { tools: { guard: () => () => {} } },
      followup(message) { notices.push(message) },
    }
    agents.set(id, agent)
    known.set(id, agent.session)
    return agent
  }
  const parent = root('root-a')
  const service = {
    resolveMaxDepth: () => 2,
    resolveName: async (_parent, name) => starts.find((row) => row.name === name)?.id ?? name,
    async startActivation(spec) {
      const id = `child-${starts.length + 1}`
      const name = `agent-${starts.length + 1}`
      const row = { id, name, runId: `${id}-run-1`, parent: spec.parent, cwd: spec.cwd ?? cwd, label: spec.label }
      row.session = { header: { cwd: row.cwd, parentSession: row.parent.id, rootSessionId: row.parent.id }, log: [] }
      starts.push(row)
      known.set(id, row.session)
      agents.set(id, makeChild(row))
      await publish('subagent/start', childInfo(row))
      const result = spec.delivery === 'caller' ? onLaunch?.(row, spec) ?? Promise.resolve(done) : deferred().promise
      return { childId: id, name, runId: row.runId, result, dispose: async () => {} }
    },
    async prompt(request) {
      prompts.push(request)
      return onPrompt ? await onPrompt(request) : { messageId: 'accepted' }
    },
  }
  const sessionQuery = {
    async observeSession(id) {
      observations.push(id)
      if (queryMode === 'throws') throw new Error('离线日志不可读')
      const session = known.get(id)
      if (!session) throw Object.assign(new Error('无会话'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      return {
        header: session.header, events: session.log,
        [Symbol.dispose]() { released.push(id) },
      }
    },
  }
  const mount = () => {
    const tools = new Map()
    const installedHandlers = new Map()
    const disposers = []
    const ctx = {
      get(name) {
        if (name === 'storageDomain') return storageDomain
        if (name === 'sessionQuery' && queryMode !== 'missing') return sessionQuery
        return undefined
      },
      get storage() { assert.fail('禁止读取 ctx.storage') },
      effect(setup) { disposers.push(setup()) },
      logger: { info() {}, warn(message) { warnings.push(message) } },
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(handler)
        installedHandlers.set(event, handler)
        return () => remove(handlers.get(event), handler)
      },
      emit(event, value) { if (event === 'orchestrator/write-audit') audits.push(value) },
      tools: {
        register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) },
        definitions: () => DEFAULT_ALLOWED_TOOLS.map((name) => ({ name })),
        view: () => ({ knownNames: DEFAULT_ALLOWED_TOOLS }),
      },
      subagents: service,
      agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
      sessions: { get: (id) => agents.get(id)?.session, flush: async () => true },
      sessionProjections: { stateOf: () => ({ 'next-turn': [], 'next-step': [] }) },
    }
    apply(ctx, { superviseIntervalSeconds: 10, ...config })
    assert.equal(disposers.length, 1, 'Cordis 生命周期只注册一个 disposer')
    const dispose = disposers[0]
    t.after(dispose)
    const exec = (agent) => ({ agent, signal: new AbortController().signal })
    const execute = (name, args, agent = parent) => tools.get(name).execute(args, exec(agent))
    return {
      dispose, handler: (event) => installedHandlers.get(event),
      delegate: (args = {}, agent) => execute('delegate', { ...defaults, description: '完成写入', prompt: '执行任务', ...args }, agent),
      batch: (args = {}, agent) => execute('orchestrate', { ...defaults, ...plan, ...args }, agent),
      async manage(args) { return (await execute('worktree_manage', args)).details },
      async status(childId) { return (await execute('delegate_status', childId ? { childId } : {})).details },
      sendMessage(targetId, deliver) {
        return installedHandlers.get('tools/execute')(
          { ...exec(parent), name: 'send_message', arguments: { agent: targetId, message: '继续处理' } }, deliver,
        )
      },
      preMessage(targetId) {
        return installedHandlers.get('tools/pre-execute')({ ...exec(parent), name: 'send_message', arguments: { agent: targetId } },
          async () => ({ kind: 'continue' }))
      },
    }
  }
  return {
    mount, start: (index = 0) => starts[index], starts, prompts, audits, warnings, notices, observations, released, root,
    setQuery(mode) { queryMode = mode },
    onLaunch(fn) { onLaunch = fn },
    onPrompt(fn) { onPrompt = fn },
    coldStop(row, reason) {
      agents.delete(row.id)
      if (reason) row.session.log.push({ type: 'turn/end', data: { reason: { kind: reason } } })
    },
    pause(row) { agents.get(row.id).status = 'idle' },
    async end(row, stopReason = 'completed') {
      if (agents.has(row.id)) agents.get(row.id).status = 'idle'
      row.session.log.push({ type: 'turn/end', data: { reason: { kind: stopReason } } })
      await publish('subagent/end', childInfo(row, stopReason))
    },
    async resume(row) {
      const next = { ...row, runId: `${row.id}-run-2` }
      const agent = makeChild(next)
      agents.set(row.id, agent)
      await publish('agent/created', { agent, source: 'resume', runId: next.runId })
      await publish('subagent/start', childInfo(next))
      return next
    },
  }
}

const only = (rows) => { assert.equal(rows.length, 1); return rows[0] }
const statusRow = async (plugin, childId) => only((await plugin.status(childId)).items)


test('热重载等待旧域关闭，延续巡检，并且只结算同一在跑委派一次', async (t) => {
  const cwd = repository(t)
  const facility = persistentFacility()
  const runtime = host(t, cwd, { storageDomain: facility, config: { superviseNotifyOnNoProgress: true } })
  const timers = []
  const cleared = []
  let at = Date.now()
  t.mock.method(Date, 'now', () => at)
  t.mock.method(globalThis, 'setInterval', (tick) => { timers.push(tick); return tick })
  t.mock.method(globalThis, 'clearInterval', (tick) => cleared.push(tick))
  const old = runtime.mount()
  const active = await old.delegate({ isolation: 'worktree' })
  const row = runtime.start()
  fs.writeFileSync(path.join(active.worktree.execCwd, target), '派发之后的结果\n')
  row.session.log.push({ seq: 1, type: 'assistant/message', time: at, data: {} })
  at += 12_000
  await timers[0]()
  const previous = only(facility.rows('delegates')).watchCursor
  assert.equal(previous.runId, row.runId)
  assert.ok(previous.lastInspectionAt >= at)
  assert.equal(previous.noticesSent, 1)
  assert.equal(runtime.notices.length, 1)

  const allowClose = facility.holdClose()
  const closing = old.dispose()
  assert.deepEqual(cleared, [timers[0]])
  const current = runtime.mount()
  const listing = current.manage({ action: 'list' })
  try {
    await drain()
    assert.deepEqual(facility.calls, ['open'])
    assert.equal(fs.existsSync(active.worktree.path), true)
    assert.ok(git(cwd, 'branch', '--list', active.worktree.branch).includes(active.worktree.branch))
    await old.handler('subagent/end')({ id: row.id, runId: row.runId, stopReason: 'aborted' })
    await timers[0]()
  } finally {
    allowClose()
    await closing
  }
  assert.equal(only((await listing).worktrees).id, active.worktree.id)
  assert.deepEqual(facility.calls, ['open', 'close', 'open'])
  assert.equal(only(facility.rows('leases')).leaseId, active.writeScope.leaseId)
  const recovered = await statusRow(current, row.id)
  assert.equal(recovered.runId, row.runId)
  assert.equal(recovered.leaseState, 'held')
  assert.equal(recovered.dispatchState, 'running')
  assert.equal(recovered.worktree.state, 'active')
  assert.deepEqual(only(facility.rows('delegates')).watchCursor, previous)
  await timers[1]()
  assert.equal(runtime.notices.length, 1, '同一游标不能重复巡检')
  await runtime.end(row)
  await runtime.end(row)
  const settled = await statusRow(current, row.id)
  assert.equal(settled.leaseState, 'released')
  assert.equal(settled.auditState, 'passed')
  assert.equal(settled.baselineId, active.baselineId)
  assert.equal(settled.worktree.state, 'ready_for_review')
  assert.equal(runtime.audits.length, 1)
  assert.equal(facility.rows('leases').length, 0)
  assert.equal(only(facility.rows('actions')).phase, 'done')
  assert.deepEqual(only(facility.rows('delegates')).retry.seenRuns, [row.runId])
  assert.equal(runtime.starts.length, 1)
})

test('打开新域前到达的真实 end 事件在恢复完成后仍可结算 Git 基线', async (t) => {
  const cwd = repository(t)
  const facility = persistentFacility()
  const runtime = host(t, cwd, { storageDomain: facility, queryMode: 'missing' })
  const old = runtime.mount()
  const active = await old.delegate({ isolation: 'worktree' })
  const allowClose = facility.holdClose()
  const closing = old.dispose()
  const current = runtime.mount()
  const end = runtime.end(runtime.start())
  allowClose()
  await Promise.all([closing, end])
  assert.equal((await statusRow(current, active.subagentId)).auditState, 'passed')
  assert.equal(facility.rows('leases').length, 0)
  assert.equal(runtime.audits.length, 1)
})

test('两阶段编排合回后，重启即刻拒绝全部历史阶段的 send_message', async (t) => {
  const cwd = repository(t)
  const facility = persistentFacility()
  const runtime = host(t, cwd, { storageDomain: facility })
  const old = runtime.mount()
  runtime.onLaunch(async (row) => {
    fs.writeFileSync(path.join(row.cwd, target), `${row.id}\n`)
    git(row.cwd, 'add', '--', target)
    git(row.cwd, 'commit', '-m', row.id)
    return done
  })
  const batch = await old.batch({ isolation: 'worktree' })
  assert.equal(batch.agentsStarted, 2)
  const { worktreeId } = only(batch.details.worktrees)
  assert.equal((await old.manage({ action: 'merge', worktreeId, strategy: 'ff-only' })).ok, true)
  assert.equal(fs.readFileSync(path.join(cwd, target), 'utf8'), 'child-2\n')
  const tree = only(facility.rows('worktrees'))
  assert.equal(tree.locked, true)
  assert.deepEqual([...tree.childIds].sort(), ['child-1', 'child-2'])
  assert.ok(facility.rows('delegates').every((row) => !Object.hasOwn(row, 'items') && !Object.hasOwn(row, 'results')))
  await old.dispose()
  for (const row of runtime.starts) runtime.coldStop(row, 'completed')
  const current = runtime.mount()
  const results = await Promise.all(runtime.starts.map((row) => current.preMessage(row.id)))
  for (const refusal of results) {
    assert.equal(refusal.kind, 'deny')
    assert.match(refusal.reason, /worktree-child-locked/)
  }
  assert.equal(only((await current.manage({ action: 'list', includeClosed: true })).worktrees).state, 'merged')
  assert.equal(runtime.prompts.length, 0)
})

test('跨根共享路径互斥在重挂后立即生效；失去逻辑基线不冒充审计通过', async (t) => {
  const cwd = repository(t)
  const facility = persistentFacility()
  const runtime = host(t, cwd, { storageDomain: facility })
  const rootB = runtime.root('root-b')
  const old = runtime.mount()
  const active = await old.delegate({ isolation: 'shared' })
  await old.dispose()
  const plugin = runtime.mount()
  await assert.rejects(plugin.delegate({ isolation: 'shared' }, rootB), { code: 'write-scope-conflict' })
  assert.equal(runtime.starts.length, 1)
  await runtime.end(runtime.start())
  const settled = await statusRow(plugin, active.subagentId)
  assert.equal(settled.incomplete, true)
  assert.equal(settled.auditState, 'failed')
  assert.equal(only(settled.violations).code, 'audit-incomplete')
  await plugin.delegate({ isolation: 'shared' }, rootB)
  assert.equal(runtime.starts.length, 2)
})

test('共享编排活跃阶段接回原批次租约，旧实例不得自动续跑下一阶段', async (t) => {
  const cwd = repository(t)
  const facility = persistentFacility()
  const runtime = host(t, cwd, { storageDomain: facility })
  const rootB = runtime.root('root-b')
  const old = runtime.mount()
  const worker = deferred()
  const launched = deferred()
  runtime.onLaunch(() => { launched.resolve(); return worker.promise })
  const batch = old.batch({ isolation: 'shared' })
  await launched.promise
  const row = runtime.start()
  t.after(() => worker.resolve(done))
  // The stage receipt runs independently of its completion.
  await drain()
  const lease = only(facility.rows('leases'))
  assert.equal(lease.ownerKind, 'batch')
  assert.equal(only(facility.rows('delegates')).leaseId, lease.leaseId)
  await old.dispose()
  const current = runtime.mount()
  await assert.rejects(current.delegate({ isolation: 'shared' }, rootB), { code: 'write-scope-conflict' })
  assert.equal((await statusRow(current, row.id)).leaseState, 'held')
  await runtime.end(row)
  worker.resolve(done)
  await batch
  assert.equal(runtime.starts.length, 1)
  assert.equal(facility.rows('leases').length, 0)
  assert.equal((await statusRow(current, row.id)).incomplete, true)
})

test('冷重启确认 interrupted 后封口并释放租约，观察句柄成对释放且不唤醒', async (t) => {
  const cwd = repository(t)
  const facility = persistentFacility()
  const runtime = host(t, cwd, { storageDomain: facility })
  const old = runtime.mount()
  const active = await old.delegate({ isolation: 'shared' })
  await old.dispose()
  runtime.coldStop(runtime.start(), 'interrupted')
  const current = runtime.mount()
  const record = await statusRow(current, active.subagentId)
  assert.equal(record.dispatchState, 'ended')
  assert.equal(record.stopReason, 'interrupted')
  assert.equal(record.auditState, 'incomplete')
  assert.equal(record.incomplete, true)
  assert.equal(record.leaseState, 'released')
  assert.equal(facility.rows('leases').length, 0)
  assert.deepEqual(runtime.observations, [active.subagentId, 'root-a'])
  assert.deepEqual(runtime.released, runtime.observations)
  assert.equal(runtime.prompts.length, 0)
})

test('未知或矛盾归属保留活跃态及租约，不把查询失败当成冷停', async (t) => {
  const cwd = repository(t)
  const facility = persistentFacility()
  const runtime = host(t, cwd, { storageDomain: facility })
  const old = runtime.mount()
  const active = await old.delegate({ isolation: 'shared' })
  await old.dispose()
  runtime.coldStop(runtime.start(), 'interrupted')
  const rootB = runtime.root('root-b')
  for (const mode of ['missing', 'throws', 'available']) {
    runtime.setQuery(mode)
    if (mode === 'available') runtime.start().session.header.parentSession = 'foreign'
    const current = runtime.mount()
    const row = await statusRow(current, active.subagentId)
    assert.equal(row.dispatchState, 'running', mode)
    assert.equal(row.auditState, 'pending', mode)
    assert.equal(row.leaseState, 'held', mode)
    await assert.rejects(current.delegate({ isolation: 'shared' }, rootB), { code: 'write-scope-conflict' })
    await current.dispose()
  }
  assert.equal(runtime.prompts.length, 0)
})

test('原生恢复保持单一运行代次；不确定投递重挂后拒绝盲重发', async (t) => {
  const cwd = repository(t)
  const facility = persistentFacility()
  const runtime = host(t, cwd, { storageDomain: facility })
  const first = runtime.mount()
  const active = await first.delegate({ isolation: 'shared' })
  const row = runtime.start()
  await runtime.end(row)
  assert.equal((await first.preMessage(row.id)).kind, 'continue')
  assert.equal(facility.rows('actions').some((action) => action.kind === 'resume'), false)
  let resumed
  await first.sendMessage(row.name, async () => {
    assert.equal((await first.preMessage(row.id)).kind, 'deny')
    resumed = await runtime.resume(row)
    return { isError: false, value: { messageId: 'native-1' } }
  })
  assert.equal(runtime.prompts.length, 0)
  const native = facility.rows('actions').find((action) => action.kind === 'resume')
  assert.equal(native.phase, 'done')
  assert.equal(native.runId, row.runId)
  assert.equal((await statusRow(first, row.id)).runId, resumed.runId)

  runtime.onPrompt(() => { throw new Error('投递超时，无法确认是否送达') })
  await runtime.end(resumed, 'error')
  assert.equal(runtime.prompts.length, 1)
  const unknown = facility.rows('actions').find((action) => action.kind === 'retry')
  assert.equal(unknown.phase, 'unknown')
  assert.equal(runtime.prompts[0].requestId, unknown.requestId)
  await first.dispose()
  runtime.coldStop(row)
  const current = runtime.mount()
  const refusal = await current.preMessage(active.subagentId)
  assert.equal(refusal.kind, 'deny')
  await current.handler('subagent/end')({ id: row.id, parentSessionId: row.parent.id, runId: resumed.runId, stopReason: 'error' })
  assert.equal(runtime.prompts.length, 1)
})

for (const persistent of [false, true]) {
  test(`手工续跑在投递前重建共享写租约和基线（持久化 ${persistent}）`, async (t) => {
    const cwd = repository(t)
    const facility = persistent ? persistentFacility() : undefined
    const runtime = host(t, cwd, { storageDomain: facility })
    const current = runtime.mount()
    const first = await current.delegate({ isolation: 'shared' })
    const row = runtime.start()
    assert.equal(first.agentName, row.name)
    fs.writeFileSync(path.join(cwd, target), '首轮改动\n')
    await runtime.end(row)
    const settled = await statusRow(current, row.id)
    assert.equal(settled.agentName, row.name)
    assert.equal(settled.leaseState, 'released')

    const overlapping = await current.delegate({ isolation: 'shared' })
    const mustNotDeliver = async () => assert.fail('冲突时不应进入原生工具')
    assert.equal((await current.preMessage(row.name)).kind, 'continue')
    await assert.rejects(current.sendMessage(row.name, mustNotDeliver), /write-lease-conflict/)
    assert.equal((await statusRow(current, row.id)).baselineId, first.baselineId)
    assert.notEqual(overlapping.subagentId, row.id)
    await runtime.end(runtime.start(1))

    const deliveryError = { isError: true, error: { message: '宿主明确拒绝投递' } }
    assert.equal(await current.sendMessage(row.id, async () => deliveryError), deliveryError)
    const rolledBack = await statusRow(current, row.id)
    assert.equal(rolledBack.baselineId, first.baselineId)
    assert.equal(rolledBack.leaseState, 'released')
    assert.equal(rolledBack.attemptSeq, 1)
    if (facility) {
      assert.equal(facility.rows('leases').length, 0)
      assert.equal(facility.rows('actions').some((action) => action.kind === 'resume'), false)
    }

    let resumed
    await current.sendMessage(row.name, async () => {
      const currentAttempt = await statusRow(current, row.id)
      assert.notEqual(currentAttempt.baselineId, first.baselineId)
      assert.equal(currentAttempt.leaseState, 'held')
      assert.equal(currentAttempt.attemptSeq, 2)
      await assert.rejects(current.sendMessage(row.id, mustNotDeliver), /in-flight/)
      await assert.rejects(current.delegate({ isolation: 'shared' }), { code: 'write-scope-conflict' })
      resumed = await runtime.resume(row)
      fs.writeFileSync(path.join(cwd, target), '第二轮改动\n')
      return { isError: false, value: { messageId: 'manual-message' } }
    })
    await runtime.end(resumed)
    const finished = await statusRow(current, row.id)
    assert.equal(finished.leaseState, 'released')
    assert.equal(finished.auditState, 'passed')
    assert.notEqual(finished.baselineId, first.baselineId)
    assert.equal(runtime.audits.filter((audit) => audit.childId === row.id).length, 2)
    if (facility) {
      assert.equal(facility.rows('leases').length, 0)
      await current.dispose()
      const reloaded = runtime.mount()
      assert.equal((await statusRow(reloaded, row.id)).agentName, row.name)
    }
  })
}

test('无 storageDomain 和 sessionQuery 时兼容纯内存启动、结算和卸载', async (t) => {
  const cwd = repository(t)
  const runtime = host(t, cwd, { queryMode: 'missing' })
  const current = runtime.mount()
  assert.deepEqual(inject, ['sessionProjections', 'tools', 'subagents', 'agents', 'sessions'])
  const active = await current.delegate({ isolation: 'shared' })
  await runtime.end(runtime.start())
  assert.equal((await statusRow(current, active.subagentId)).auditState, 'passed')
  assert.equal(runtime.audits.length, 1)
  assert.doesNotReject(current.dispose())
})
