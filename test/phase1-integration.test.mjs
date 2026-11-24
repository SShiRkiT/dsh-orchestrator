import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
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
const { apply, DEFAULT_ALLOWED_TOOLS, INLINE_AUDIT_SOURCE_KIND, SUPERVISE_SOURCE_KIND } = await import('../lib/index.js')
test.after(() => stubHook.deregister())

const finished = { stopReason: 'completed', output: [{ type: 'text', text: '完成' }] }
const put = (cwd, name, text = name) => writeFileSync(path.join(cwd, name), text)
const sha = (text) => createHash('sha256').update(text).digest('hex')
const drain = () => new Promise((resolve) => setImmediate(resolve))
const hasConflict = (owner) => (error) => error?.code === 'write-scope-conflict' &&
  error.details.some((row) => row.owner === owner)

function harness(t, { onStart, onAudit, onPrompt, team = NATIVE_TEAM_TOOLS } = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'dsh-phase1-'))
  const names = [...DEFAULT_ALLOWED_TOOLS, ...team, 'subagent_fork', 'workflow']
  const subscriptions = new Map()
  const toolSpecs = new Map()
  const liveAgents = new Map()
  const notices = []
  const audits = []
  const prompts = []
  const starts = []
  const disposers = []
  const config = { superviseIntervalSeconds: 10 }
  const guards = new Map()
  const removed = []
  const replacements = []
  const makeRoot = (id) => {
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
      session: { header: { cwd } },
      followup(message) { notices.push(message); inbox.nextTurn.push(message) },
      ctx: { tools: { guard: (fn) => { guards.set(id, fn) } } },
    }
    liveAgents.set(id, agent)
    subscriptions.get('agent/created')?.({ agent })
    return agent
  }
  const parent = makeRoot('root')
  const exec = { agent: parent, signal: new AbortController().signal }
  const ctx = {
    tools: {
      register: (spec) => { toolSpecs.set(spec.name, spec) },
      view: () => ({ knownNames: names }),
      definitions: () => names.map((name) => ({ name })),
    },
    agents: { get: (id) => liveAgents.get(id), list: () => [...liveAgents.values()] },
    sessions: { get: (id) => liveAgents.get(id)?.session, flush: async () => true },
    sessionProjections: { stateOf: () => ({ 'next-turn': [], 'next-step': [] }) },
    effect: (setup) => disposers.push(setup()),
    on: (event, listener) => subscriptions.set(event, listener),
    emit(event, payload) {
      if (event !== 'orchestrator/write-audit') return
      audits.push(payload)
      onAudit?.(payload)
    },
    logger: { info() {}, warn() {} },
    subagents: {
      resolveMaxDepth: () => 2,
      async startActivation(spec) {
        const id = `worker-${starts.length + 1}`
        const agent = { id, options: { subagentDepth: 1 }, session: { log: [], header: { cwd } } }
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
  apply(ctx, config)
  t.after(() => {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    rmSync(cwd, { recursive: true, force: true })
  })
  const route = { provider: 'test', model: 'test' }
  return {
    cwd, config, ctx, parent, starts, notices, audits, prompts, toolSpecs, makeRoot, removed, replacements,
    check: (name) => guards.get(parent.id)({ name, agent: parent }),
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
    claim(kind, turn) {
      const queue = parent.inbox.nextTurn
      const index = queue.findIndex((message) => message.source.kind === kind)
      assert.notEqual(index, -1, `no queued ${kind} message`)
      const [message] = queue.splice(index, 1)
      subscriptions.get('agent/inbox/claimed')({ agent: parent, message, turn })
      return message
    },
    preStep(messages, { turn = 1, step = 1, agent = parent, signal, next } = {}) {
      const decision = { kind: 'enter', messages }
      return subscriptions.get('agent/pre-step')({ agent, messages, turn, step, signal }, next ?? (async () => decision))
    },
    turnEnd(turn) {
      subscriptions.get('session/event')(parent.session, { type: 'turn/end', data: { turn } })
    },
  }
}

function codes(audit) {
  return audit.violations.map(({ code }) => code).sort()
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
  assert.match(h.toolSpecs.get('delegate').description, /team_task_\* 仅用于共享任务板/)
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

test('phase 1: read-only delegate and batch coexist with an active writer and report observed writes', async (t) => {
  let h
  h = harness(t, { onStart(spec) {
    if (spec.delivery === 'caller') put(h.cwd, 'batch-unauthorized.txt')
  } })
  const writer = await h.delegate({ writeScope: ['allowed.txt'] })
  const reader = await h.delegate({ readOnly: true })
  assert.equal(reader.readOnly, true)
  assert.ok(reader.baselineId)
  assert.ok(!Object.hasOwn(reader, 'writeScope'))
  assert.match(h.starts[1].spec.prompt[0].text, /逻辑写后审计并告警/)
  await assert.rejects(h.delegate({ readOnly: true, writeScope: ['allowed.txt'] }), /互斥/)
  await assert.rejects(h.batch({ readOnly: true, writeScope: ['allowed.txt'] }), /互斥/)
  await assert.rejects(h.delegate({ readOnly: 'true' }), /必须是布尔值/)
  await assert.rejects(h.batch({ readOnly: true, expectedTargets: ['../outside.txt'] }), /相对文件路径/)
  await assert.rejects(h.delegate({ readOnly: true, expectedFingerprints: { 'allowed.txt': 'bad' } }), /SHA-256/)
  put(h.cwd, 'delegate-unauthorized.txt')
  h.end(reader.subagentId)
  await drain()
  assert.deepEqual(h.notices, [])
  assert.equal(h.audits[0].childId, reader.subagentId)
  assert.deepEqual(codes(h.audits[0].audit), ['out-of-scope-write'])
  const decision = await h.preStep([settled(reader.subagentId)])
  assert.match(decision.messages.at(-1).content[0].text, /out-of-scope-write.*delegate-unauthorized\.txt/)
  const batch = await h.batch({ readOnly: true })
  assert.deepEqual(codes(batch.audit), ['out-of-scope-write'])
  assert.equal(batch.audit.isolationLevel, 'logical-post-audit')
  const [rendered] = h.toolSpecs.get('orchestrate').output.render({}, batch)
  assert.match(rendered.text, /out-of-scope-write.*batch-unauthorized\.txt/)
  await assert.rejects(h.delegate({ writeScope: ['allowed.txt'] }), hasConflict(writer.subagentId))
  const readerWithEmptyScope = await h.delegate({ readOnly: true, writeScope: [] })
  assert.equal(readerWithEmptyScope.readOnly, true)
})

test('phase 1: both writable paths audit before release and preserve structured violations', async (t) => {
  const checks = []
  let h
  h = harness(t, {
    onStart(spec) {
      if (spec.delivery === 'caller') put(h.cwd, 'batch-outside.txt')
    },
    onAudit({ childId }) {
      const checked = h.delegate({ writeScope: [childId.startsWith('batch-') ? 'batch.txt' : 'target.txt'] })
      checks.push(assert.rejects(checked, hasConflict(childId)))
    },
  })
  put(h.cwd, 'target.txt', 'before')
  const child = await h.delegate({
    writeScope: ['target.txt'], expectedFingerprints: { 'target.txt': sha('stale') }, expectedTargets: ['target.txt'],
  })
  put(h.cwd, 'outside.txt')
  unlinkSync(path.join(h.cwd, 'target.txt'))
  h.end(child.subagentId)
  const batch = await h.batch({ writeScope: ['batch.txt'] })
  await Promise.all(checks)
  await drain()
  assert.equal(checks.length, 2)
  assert.equal(h.audits[0].audit.baselineId, child.baselineId)
  assert.deepEqual(codes(h.audits[0].audit), ['fingerprint-mismatch', 'out-of-scope-write', 'target-missing'])
  assert.deepEqual(codes(batch.audit), ['out-of-scope-write'])
  assert.deepEqual(h.notices, [])
  const decision = await h.preStep([settled(child.subagentId)])
  assert.match(decision.messages.at(-1).content[0].text, /不得验收为通过/)
  assert.match(decision.messages.at(-1).content[0].text, /target-missing/)
  assert.equal(typeof (await h.delegate({ writeScope: ['target.txt'] })).writeScope.leaseId, 'string')
  assert.equal(typeof (await h.delegate({ writeScope: ['batch.txt'] })).writeScope.leaseId, 'string')
})

test('phase 1: retry reacquires before queueing, refreshes its baseline and ignores stale lifecycle events', async (t) => {
  const h = harness(t)
  put(h.cwd, 'target.txt', 'before')
  const child = await h.delegate({ writeScope: ['target.txt'], expectedFingerprints: { 'target.txt': sha('before') } })
  put(h.cwd, 'target.txt', 'first attempt')
  put(h.cwd, 'already-present.txt')
  h.end(child.subagentId, 'error')
  await drain()
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0].childSessionId, child.subagentId)
  const freshId = /本轮写后审计基线：([^。]+)/.exec(h.prompts[0].content[0].text)?.[1]
  assert.ok(freshId && freshId !== child.baselineId)
  const retryAttempt = await statusOf(h, child.subagentId)
  assert.equal(retryAttempt.attemptSeq, 2)
  assert.equal(retryAttempt.runId, null)
  assert.equal(retryAttempt.dispatchState, 'running')
  assert.equal(retryAttempt.auditState, 'pending')
  assert.equal(retryAttempt.baselineId, freshId)
  assert.equal(retryAttempt.leaseState, 'held')
  assert.notEqual(retryAttempt.leaseId, child.writeScope.leaseId)
  h.start(child.subagentId, 'second-run')
  h.end(child.subagentId, 'error')
  // The exact old run id is already closed; delivery of the duplicate cannot touch the new lease.
  assert.equal(h.prompts.length, 1)
  await assert.rejects(h.delegate({ writeScope: ['target.txt'] }), hasConflict(child.subagentId))
  put(h.cwd, 'target.txt', 'second attempt')
  h.end(child.subagentId, 'completed', 'second-run')
  assert.equal(h.audits.length, 2)
  assert.equal(h.audits[1].audit.baselineId, freshId)
  assert.deepEqual(h.audits[1].audit.changedFiles.map(({ path: filename }) => filename), ['target.txt'])
  assert.equal(h.audits[1].audit.passed, true)
  const retryResult = await statusOf(h, child.subagentId)
  assert.equal(retryResult.attemptSeq, 2)
  assert.equal(retryResult.runId, 'second-run')
  assert.equal(retryResult.auditState, 'passed')
  assert.equal(retryResult.leaseState, 'released')
  await h.delegate({ writeScope: ['target.txt'] })
})

test('phase 1: disposal before settlement allows a new writer, then retry conflict refuses to queue', async (t) => {
  const h = harness(t)
  const old = await h.delegate({ writeScope: ['target.txt'] })
  h.dispose(h.starts[0].agent)
  const current = await h.delegate({ writeScope: ['target.txt'] })
  h.end(old.subagentId, 'error')
  await drain()
  assert.equal(h.prompts.length, 0)
  assert.deepEqual(h.audits.map(({ childId }) => childId), [old.subagentId])
  const [notice] = h.notices.filter((message) => message.source.kind === 'orchestrator-retry')
  assert.match(notice.content[0].text, /已拒绝自动续跑（write-lease-conflict）/)
  assert.match(notice.content[0].text, /target\.txt/)
  assert.ok(notice.content[0].text.includes(current.subagentId))
  await assert.rejects(h.delegate({ writeScope: ['target.txt'] }), hasConflict(current.subagentId))
})

test('phase 1: host prompt failure clears only the reacquired write lease', async (t) => {
  const h = harness(t, { onPrompt() { throw new Error('host queue rejected') } })
  const original = await h.delegate({ writeScope: ['target.txt'] })
  h.end(original.subagentId, 'error')
  await drain()
  assert.equal(h.prompts.length, 1)
  assert.match(h.notices.find(({ source }) => source.kind === 'orchestrator-retry').content[0].text, /host queue rejected/)
  await h.delegate({ writeScope: ['target.txt'] })
})

test('phase 1: a read-only retry remains lease-free even with a live writer', async (t) => {
  const h = harness(t)
  const writer = await h.delegate({ writeScope: ['target.txt'] })
  const reader = await h.delegate({ readOnly: true })
  h.end(reader.subagentId, 'error')
  await drain()
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0].childSessionId, reader.subagentId)
  assert.match(h.prompts[0].content[0].text, /不占写租约.*逻辑写后审计/)
  assert.ok(!h.prompts[0].content[0].text.includes(reader.baselineId))
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

// A real synchronous audit has only a brief ended/pending window: observe it at the start of the disk scan.
test('phase 1 T1: delegate_status isolates parent sessions and discloses the exact dispatch, audit and lease state', async (t) => {
  const h = harness(t)
  const other = h.makeRoot('another-root')
  const running = await h.delegate({ description: '根会话写入', writeScope: ['output.txt'] })
  const reader = await h.delegate({ readOnly: true })
  const foreign = await h.delegate({ description: '另一根会话私有任务', readOnly: true }, other)
  const child = h.starts[0].agent

  const active = await statusOf(h, running.subagentId)
  assert.equal(active.dispatchState, 'running')
  assert.equal(active.auditState, 'pending')
  assert.equal(active.runId, `${child.id}-first`)
  assert.equal(active.leaseState, 'held')
  assert.equal(active.leaseId, running.writeScope.leaseId)
  assert.deepEqual(active.writeScope, ['output.txt'])
  const readOnly = await statusOf(h, reader.subagentId)
  assert.equal(readOnly.baselineId, reader.baselineId)
  assert.equal(readOnly.leaseState, 'none')
  assert.equal(readOnly.leaseId, null)

  let pending
  const opendirSync = fs.opendirSync
  const observeDirectory = t.mock.method(fs, 'opendirSync', (...args) => {
    if (args[0] === h.cwd) pending ??= h.status({ childId: child.id })
    return opendirSync(...args)
  })
  try {
    put(h.cwd, 'output.txt')
    h.end(child.id)
  } finally {
    observeDirectory.mock.restore()
  }
  assert.ok(pending, 'the real disk snapshot must expose an ended/pending state')
  const auditInProgress = await pending
  assert.equal(auditInProgress.counts.endedPendingAudit, 1)
  assert.equal(auditInProgress.items[0].dispatchState, 'ended')
  assert.equal(auditInProgress.items[0].auditState, 'pending')
  const passed = await statusOf(h, child.id)
  assert.equal(passed.auditState, 'passed')
  assert.equal(passed.leaseState, 'released')
  assert.equal(passed.stopReason, 'completed')

  h.end(reader.subagentId)
  const failed = await statusOf(h, reader.subagentId)
  assert.equal(failed.auditState, 'failed')
  assert.equal(failed.leaseState, 'none')
  assert.equal(failed.isolation, 'logical-post-audit')
  assert.equal(failed.violations[0].path, 'output.txt')

  for (const enabled of [true, false]) {
    h.config.enabled = enabled
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
  }
})

test('phase 1 T2: pre-step attaches one ordered notice for passed and pending settlements without certifying disposal', async (t) => {
  let h
  h = harness(t, {
    onStart(spec, id) {
      if (spec.label === '接单前已销毁') h.dispose(h.starts.find(({ agent }) => agent.id === id).agent)
    },
  })
  const passed = await h.delegate({ readOnly: true })
  const pending = await h.delegate({ writeScope: ['pending.txt'], description: '接单前已销毁' })
  h.end(passed.subagentId)
  const disposed = await statusOf(h, pending.subagentId)
  assert.ok(disposed.disposedAt !== null)
  assert.equal(disposed.dispatchState, 'running')
  assert.equal(disposed.auditState, 'pending')
  assert.equal(disposed.leaseState, 'released')

  const nativePassed = settled(passed.subagentId)
  const nativePending = settled(pending.subagentId)
  const duplicate = settled(passed.subagentId, 'another-native-passed')
  const unknown = { ...settled('untracked'), content: nativePassed.content }
  const untouched = { kind: 'enter', messages: [unknown] }
  assert.equal(await h.preStep([unknown], { next: async () => untouched }), untouched)
  const other = h.makeRoot('other')
  assert.deepEqual((await h.preStep([nativePassed], { agent: other })).messages, [nativePassed])

  const originals = [nativePassed, nativePending, duplicate, unknown]
  const decision = await h.preStep(originals)
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(decision.messages.slice(0, -1), originals)
  const auditMessage = decision.messages.at(-1)
  assert.equal(auditMessage.source.kind, INLINE_AUDIT_SOURCE_KIND)
  assert.equal(auditMessage.role, 'user')
  const [passText, pendingText, ...extra] = auditMessage.content[0].text.split('\n')
  assert.deepEqual(extra, [])
  assert.ok(passText.includes(`【${passed.subagentId}】`))
  assert.match(passText, /审计已通过/)
  assert.ok(pendingText.includes(`【${pending.subagentId}】`))
  assert.match(pendingText, /pending.*不得直接验收通过/)
  assert.equal((await statusOf(h, passed.subagentId)).auditDeliveredVia, 'inline-pre-step')
  assert.equal((await statusOf(h, pending.subagentId)).auditDeliveredVia, null)
  h.end(pending.subagentId)
  assert.equal((await statusOf(h, pending.subagentId)).auditState, 'passed')
})

test('phase 1 T3: failed audit publishes evidence and attaches it inline without independently waking the parent', async (t) => {
  const h = harness(t)
  const worker = await h.delegate({ writeScope: ['required.txt'], expectedTargets: ['required.txt'] })
  put(h.cwd, 'out-of-scope.txt')
  const native = settled(worker.subagentId)
  const pending = await h.preStep([native])
  assert.match(pending.messages.at(-1).content[0].text, /不得直接验收通过/)
  assert.equal((await statusOf(h, worker.subagentId)).auditDeliveredVia, null)
  h.end(worker.subagentId)
  await drain()

  const expectedCodes = ['out-of-scope-write', 'target-missing']
  assert.deepEqual(h.notices, [], 'the audit must not call parent.followup')
  assert.deepEqual(h.parent.inbox.nextTurn, [])
  const [event] = h.audits
  assert.equal(event.childId, worker.subagentId)
  assert.equal(event.parentId, h.parent.id)
  assert.equal(event.audit.passed, false)
  assert.deepEqual(codes(event.audit), expectedCodes)
  const failed = await statusOf(h, worker.subagentId)
  assert.equal(failed.auditState, 'failed')
  assert.deepEqual(failed.violations, event.audit.violations)
  assert.equal(failed.auditDeliveredVia, null)

  const rejected = await h.preStep([native], { next: async () => ({ kind: 'reject' }) })
  assert.equal(rejected.kind, 'reject')
  assert.equal((await statusOf(h, worker.subagentId)).auditDeliveredVia, null)
  const controller = new AbortController()
  const aborted = await h.preStep([native], { signal: controller.signal, next: async () => {
    controller.abort()
    return { kind: 'enter', messages: [native] }
  } })
  assert.deepEqual(aborted.messages, [native])
  assert.equal((await statusOf(h, worker.subagentId)).auditDeliveredVia, null)

  const decision = await h.preStep([native], { turn: 2 })
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0], native)
  const [, inline] = decision.messages
  assert.equal(inline.source.kind, INLINE_AUDIT_SOURCE_KIND)
  assert.match(inline.content[0].text, /不得验收为通过/)
  assert.match(inline.content[0].text, /out-of-scope-write.*out-of-scope\.txt/)
  assert.match(inline.content[0].text, /target-missing.*required\.txt/)
  assert.match(inline.content[0].text, /logical-post-audit.*不是物理隔离/)
  assert.deepEqual(h.notices, [])
  assert.deepEqual(h.parent.inbox.nextTurn, [])
  assert.equal((await statusOf(h, worker.subagentId)).auditDeliveredVia, 'inline-pre-step')
})

test('phase 1 T4: claimed patrols suppress the next tick and recompiled notices retain live audit attention', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const h = harness(t)
  const failed = await h.delegate({ readOnly: true, description: '失败待送达' })
  put(h.cwd, 'unapproved.txt')
  h.end(failed.subagentId)
  await drain()

  const runner = await h.delegate({ readOnly: true, description: '巡检触发项' })
  const sibling = await h.delegate({ readOnly: true, description: '同父安静项' })
  const tick = async () => { t.mock.timers.tick(10_001); await drain() }
  h.starts[1].agent.session.log.push({ seq: 1, time: Date.now(), type: 'turn/start', data: {} })
  await tick()
  const [initial] = supervisionFor(h)
  assert.ok(initial)
  assert.deepEqual(new Set(initial.source.childIds), new Set([runner.subagentId, sibling.subagentId, failed.subagentId]))
  const originalText = initial.content[0].text
  for (const label of ['巡检触发项', '同父安静项', '失败待送达']) assert.ok(originalText.includes(label))

  h.end(sibling.subagentId)
  await drain()
  const [updated] = supervisionFor(h)
  assert.equal(updated.id, initial.id)
  assert.deepEqual(h.replacements, [initial.id])
  assert.deepEqual(updated.source.childIds, [runner.subagentId, failed.subagentId])
  assert.match(updated.content[0].text, /失败待送达/)
  assert.doesNotMatch(updated.content[0].text, /同父安静项/)

  const claim = h.claim(SUPERVISE_SOURCE_KIND, 20)
  h.config.superviseNotifyOnNoProgress = true
  await tick()
  assert.deepEqual(supervisionFor(h), [], 'the claim protects the gap before pre-step')
  h.end(runner.subagentId)
  const decision = await h.preStep([claim], { turn: 20 })
  assert.equal(decision.kind, 'enter')
  const [attentionOnly] = decision.messages
  assert.equal(attentionOnly.id, initial.id)
  assert.deepEqual(attentionOnly.source.childIds, [failed.subagentId])
  assert.match(attentionOnly.content[0].text, /失败待送达/)
  assert.doesNotMatch(attentionOnly.content[0].text, /巡检触发项/)
  assert.match(h.check('todo_write'), /当前为定时巡检回合/)

  const nextRunner = await h.delegate({ readOnly: true, description: '下一巡检项' })
  await tick()
  assert.deepEqual(supervisionFor(h), [], 'the active pre-step turn suppresses another patrol after claim transfer')
  h.turnEnd(20)
  await tick()
  const [next] = supervisionFor(h)
  assert.ok(next)
  assert.deepEqual(next.source.childIds, [nextRunner.subagentId, failed.subagentId])
  h.end(nextRunner.subagentId)
  await drain()
  assert.deepEqual(supervisionFor(h)[0].source.childIds, [failed.subagentId], 'an unclaimed attention-only notice stays queued')

  const final = await h.preStep([settled(failed.subagentId)], { turn: 21 })
  assert.equal(final.messages.at(-1).source.kind, INLINE_AUDIT_SOURCE_KIND)
  await drain()
  const delivered = await statusOf(h, failed.subagentId)
  assert.equal(delivered.auditDeliveredVia, 'inline-pre-step')
  assert.deepEqual(supervisionFor(h), [])
  assert.ok(h.removed.includes(next.id))
})
