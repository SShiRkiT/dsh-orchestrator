import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createActionLedger,
  evaluateWakeupGate,
  inspectHostChildState,
  inspectParentSettlementNotice,
  makeParentNoticeActionKey,
  makeResumeActionKey,
  makeRetryActionKey,
  makeSettleActionKey,
  reconcileOnStartup,
} from '../lib/reconcile.js'

const ids = { rootSessionId: 'root', parentId: 'parent', childId: 'child', attemptSeq: 2 }
const runId = 'run:4'
const settleKey = makeSettleActionKey({ ...ids, runId })
const resumeKey = makeResumeActionKey({ ...ids, interruptedRunId: runId })
const retryKey = makeRetryActionKey({ ...ids, failedRunId: runId })
const hostIdle = { presence: 'persisted-inactive', running: false, ownershipMismatch: false }
const turnEnd = (kind) => ({ type: 'turn/end', data: { reason: { kind } } })
const notFound = (code = 'SESSION_QUERY_SESSION_NOT_FOUND') => Object.assign(new Error('missing'), { code })
const nativeSource = (childId, stopReason) => ({ kind: 'subagent-settled', senderSessionId: childId, stopReason })
const emptyNotice = (checked) => ({ checked, delivered: false, via: null, messageId: null, stopReason: null, seq: null })

function observed(value, { id = 'child', signal } = {}) {
  const calls = []
  let disposed = 0
  const sessionQuery = {
    observeSession(sessionId, options) {
      assert.equal(sessionId, id)
      assert.equal(options.signal, signal)
      calls.push(sessionId)
      return Object.defineProperty(value, Symbol.dispose, {
        value() { disposed += 1 },
      })
    },
    readSession() { assert.fail('observeSession is available; must not call readSession') },
  }
  return { sessionQuery, calls, get disposed() { return disposed } }
}

test('四类幂等键区分根、子会话、运行和序号，并使用确定性缺省值', () => {
  assert.equal(settleKey, 'settle:root:child:run:4')
  assert.equal(resumeKey, 'resume:root:child:run:4')
  assert.equal(retryKey, 'retry:root:child:run:4:1')
  assert.equal(makeSettleActionKey({ parentId: 'p', childId: 'c', runId: '' }), 'settle:p:c:attempt-0')
  assert.equal(makeResumeActionKey({ childId: 'c', attemptSeq: 4 }), 'resume:unknown:c:attempt-4')
  assert.equal(makeRetryActionKey({ childId: 'c', retryOrdinal: 0 }), 'retry:unknown:c:attempt-0:0')
  assert.equal(makeParentNoticeActionKey({}), 'notice:unknown:unknown:generic:0')
  assert.equal(makeParentNoticeActionKey({ parentId: 'p', childId: 'c', kind: 'retry', seqOrId: 'msg' }),
    'notice:p:c:retry:msg')
})

test('账本提交 prepared → accepted → done，保留请求身份及写序', async () => {
  let time = 10
  const written = []
  const ledger = createActionLedger({ store: { putAction: (row) => written.push(row) }, now: () => time++ })
  assert.deepEqual(ledger.canInitiate(settleKey), { allowed: true, reason: 'new', record: null })
  assert.equal(ledger.hasProcessedRun('settle', { ...ids, runId }), false)
  const prepared = await ledger.prepare(settleKey, { ...ids, runId, detail: { offset: 1 } })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.record.kind, 'settle')
  assert.match(prepared.record.requestId, /^req-[0-9a-f-]{36}$/)
  assert.equal(prepared.record.createdAt, 10)
  assert.equal(ledger.hasProcessedRun('settle', { ...ids, runId }), true)
  assert.equal(ledger.canInitiate(settleKey).reason, 'in-flight')
  assert.deepEqual(await ledger.prepare(settleKey), { ok: false, reason: 'in-flight', record: prepared.record })

  prepared.record.detail.offset = 99
  ledger.list()[0].detail.offset = 98
  ledger.canInitiate(settleKey).record.detail.offset = 97
  ledger.get(settleKey).detail.offset = 96
  written[0].detail.offset = 95
  assert.equal(ledger.get(settleKey).detail.offset, 1)

  const accepted = await ledger.markAccepted(settleKey, { requestId: 'not-the-request', messageId: 'msg' })
  assert.equal(accepted.requestId, prepared.record.requestId)
  assert.equal(accepted.messageId, 'msg')
  assert.equal(accepted.updatedAt, 11)
  assert.equal(ledger.canInitiate(settleKey).reason, 'already-accepted')
  assert.equal((await ledger.markUnknown(settleKey)).phase, 'accepted')
  await ledger.markDone(settleKey)
  assert.equal(ledger.canInitiate(settleKey).reason, 'already-done')
  assert.equal((await ledger.markAccepted(settleKey)).phase, 'done')
  assert.deepEqual(written.map((row) => row.phase), ['prepared', 'accepted', 'done'])
  assert.equal(await ledger.markDone('missing'), null)
})

test('unknown 默认禁止盲重发；显式允许后复用同一 requestId', async () => {
  const ledger = createActionLedger()
  const first = await ledger.prepare(resumeKey, { ...ids, interruptedRunId: runId, requestId: 'stable' })
  const unknown = await ledger.markUnknown(resumeKey, { detail: { reason: 'timeout' } })
  assert.equal(unknown.runId, runId)
  assert.equal(ledger.hasProcessedRun('resume', { ...ids, runId }), true)
  assert.equal(ledger.canInitiate(resumeKey).reason, 'delivery-unknown')
  assert.equal((await ledger.prepare(resumeKey)).ok, false)
  const restored = createActionLedger({ initialActions: ledger.list() })
  assert.deepEqual(restored.canInitiate(resumeKey, { allowRetryUnknown: true }), {
    allowed: true, reason: 'unknown-retry-allowed', record: unknown,
  })
  const again = await restored.prepare(resumeKey, { allowRetryUnknown: true, requestId: 'different' })
  assert.equal(again.ok, true)
  assert.equal(again.record.requestId, first.record.requestId)
  assert.equal(again.record.createdAt, first.record.createdAt)
  await restored.markDone(resumeKey)
  restored.hydrate([unknown])
  assert.equal(restored.canInitiate(resumeKey).reason, 'already-done')
  const second = createActionLedger()
  second.hydrate([unknown])
  await second.markDone(resumeKey)
  assert.equal(second.get(resumeKey).phase, 'done')
})

test('两次 prepare 并发时只允许一次，且必须等待落盘', async () => {
  const pending = Promise.withResolvers()
  const ledger = createActionLedger({ store: { putAction: () => pending.promise } })
  let ready = false
  const first = ledger.prepare(retryKey).then((result) => { ready = result.ok })
  assert.equal((await ledger.prepare(retryKey)).reason, 'in-flight')
  assert.equal(ready, false)
  pending.resolve(true)
  await first
  assert.equal(ready, true)
})

test('落盘抛错或拒绝写入时不授权任何投递，保留内存预留', async () => {
  const refused = createActionLedger({ store: { putAction: async () => false } })
  await assert.rejects(refused.prepare(resumeKey), /was not persisted/)
  assert.equal((await refused.prepare(resumeKey)).reason, 'in-flight')

  const broken = createActionLedger({ store: { putAction: async () => { throw new Error('io') } } })
  await assert.rejects(broken.prepare(retryKey), /io/)
  assert.equal((await broken.prepare(resumeKey)).reason, 'in-flight')
})

test('先取得在线运行态，不读取持久化观察；会话日志可补足游标', async () => {
  const host = await inspectHostChildState({
    childId: 'child',
    agents: { get: (id) => { assert.equal(id, 'child'); return { status: 'running' } } },
    sessions: { get: () => ({ log: [{ seq: 12 }] }) },
    sessionQuery: { observeSession: () => assert.fail('must not read historical events for a running child') },
  })
  assert.deepEqual(host, {
    childId: 'child', presence: 'live-running', alive: true, running: true, ownershipMismatch: false,
    lastTurnEndKind: null, headSeq: 12, evidenceSource: 'agents',
  })
})

test('在线闲置仍可补采证据并释放观察句柄；查询失效时保留在线事实', async () => {
  const signal = new AbortController().signal
  const observation = observed({ header: { parentSession: 'parent' }, events: [turnEnd('completed')] }, { signal })
  const agents = { get: () => ({ status: 'idle', headSeq: 8 }) }
  const host = await inspectHostChildState({ childId: 'child', agents, sessionQuery: observation.sessionQuery, signal })
  assert.equal(host.presence, 'live-idle')
  assert.equal(host.alive, true)
  assert.equal(host.running, false)
  assert.equal(host.lastTurnEndKind, 'completed')
  assert.equal(host.headSeq, 1)
  assert.equal(host.evidenceSource, 'agents+sessionQuery')
  assert.deepEqual(observation.calls, ['child'])
  assert.equal(observation.disposed, 1)

  for (const error of [new Error('io'), notFound()]) {
    const fallback = await inspectHostChildState({
      childId: 'child', agents, sessionQuery: { observeSession: () => { throw error } },
    })
    assert.equal(fallback.presence, 'live-idle')
    assert.equal(fallback.running, false)
    assert.equal(fallback.headSeq, 8)
    assert.equal(fallback.lastTurnEndKind, null)
    assert.equal(fallback.evidenceSource, 'agents')
  }
})

for (const lastTurnEndKind of ['completed', 'interrupted', 'aborted', null]) {
  test(`冷会话只读最后一条自身结束事件：${lastTurnEndKind ?? '无'}`, async () => {
    const ownEvents = lastTurnEndKind === null ? [{ type: 'turn/start' }] : [
      turnEnd('error'), { kind: 'turn/end', reason: { kind: lastTurnEndKind } }, { type: 'some/event' },
    ]
    const events = [turnEnd('completed'), ...ownEvents]
    const header = { parentSession: 'parent', rootSessionId: 'root' }
    const observation = observed({ session: header, inheritedEventCount: 1, events })
    const host = await inspectHostChildState({
      childId: 'child', expectedParentId: 'parent', expectedRootSessionId: 'root', sessionQuery: observation.sessionQuery,
    })
    assert.deepEqual(host, {
      childId: 'child', presence: 'persisted-inactive', alive: false, running: false, ownershipMismatch: false,
      lastTurnEndKind, headSeq: events.length, inheritedEventCount: 1, header, evidenceSource: 'sessionQuery',
    })
    assert.equal(observation.disposed, 1)
  })
}

test('无 observeSession 才回退 readSession，核对可证实的直接父与根归属', async () => {
  const sessionQuery = { async readSession(id) {
    assert.equal(id, 'child')
    return { header: { parentSession: 'parent', rootSessionId: 'root' }, events: [] }
  } }
  for (const [expectedParentId, expectedRootSessionId] of [['other', 'root'], ['parent', 'other']]) {
    const host = await inspectHostChildState({ childId: 'child', sessionQuery, expectedParentId, expectedRootSessionId })
    assert.equal(host.ownershipMismatch, true)
  }
})

test('明确不存在区别于查询不可用，持久探测不回退到其他接口', async () => {
  for (const code of ['SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_NOT_FOUND']) {
    const host = await inspectHostChildState({ childId: 'child', sessionQuery: {
      async observeSession() { throw notFound(code) },
      readSession: () => assert.fail('prior observation threw; readSession must not be used'),
    } })
    assert.equal(host.presence, 'not-found')
    assert.equal(host.alive, false)
    assert.equal(host.running, false)
    assert.equal(host.headSeq, 0)
  }
  for (const sessionQuery of [undefined, { readSession: () => null }]) {
    const host = await inspectHostChildState({ childId: 'child', sessionQuery })
    assert.equal(host.presence, 'unknown')
    assert.equal(host.running, null)
  }
})

test('取得观察句柄后解析日志异常，仍精确释放一次', async () => {
  const observation = observed({ get events() { throw new Error('malformed event log') } })
  const host = await inspectHostChildState({ childId: 'child', sessionQuery: observation.sessionQuery })
  assert.deepEqual(host, {
    childId: 'child', presence: 'unknown', alive: null, running: null, ownershipMismatch: false,
    lastTurnEndKind: null, headSeq: null, error: 'malformed event log', evidenceSource: 'unknown',
  })
  assert.equal(observation.disposed, 1)
})

test('观察成功后信号取消也释放句柄', async () => {
  const controller = new AbortController()
  let disposed = 0
  const host = await inspectHostChildState({ childId: 'child', signal: controller.signal, sessionQuery: {
    observeSession() {
      controller.abort()
      return { [Symbol.dispose]() { disposed += 1 } }
    },
  } })
  assert.equal(host.presence, 'unknown')
  assert.equal(disposed, 1)
})

test('父会话读取只命中指定子会话的原生 inbox 结算', async () => {
  const event = { type: 'agent/inbox/spliced', seq: 20, data: { inserted: [
    { id: 'mine', source: nativeSource('child', 'completed') },
    { id: 'foreign', source: nativeSource('other', 'error') },
  ] } }
  const observation = observed({ events: [event] }, { id: 'parent' })
  const result = await inspectParentSettlementNotice({ parentId: 'parent', childId: 'child', sessionQuery: observation.sessionQuery })
  assert.deepEqual(result, {
    checked: true, delivered: true, via: 'inbox', messageId: 'mine', stopReason: 'completed', seq: 20,
  })
  assert.equal(observation.disposed, 1)
})

test('兼容两种 user/message 结算格式并过滤继承和旧回合', async () => {
  const source = nativeSource('child', 'interrupted')
  const old = { type: 'user/message', data: { id: 'old', source } }
  const declared = { type: 'user/message', data: { messageId: 'new', source } }
  const nested = { type: 'user/message', data: { message: { id: 'nested', source } } }
  const inspect = (events, afterSeq, inheritedEventCount = 0) => inspectParentSettlementNotice({
    parentId: 'parent', childId: 'child', afterSeq, sessionQuery: { readSession: () => ({ events, inheritedEventCount }) },
  })
  assert.deepEqual(await inspect([old, nested], 1), {
    checked: true, delivered: true, via: 'user-message', messageId: 'nested', stopReason: 'interrupted', seq: 2,
  })
  assert.equal((await inspect([old, declared], 1)).messageId, 'new')
  assert.deepEqual(await inspect([old, declared], 2), emptyNotice(true))
  assert.deepEqual(await inspect([old], 0, 1), emptyNotice(true))
})

test('父会话不可查返回 unchecked，并释放解析失败的观察句柄', async () => {
  const observation = observed({ get inheritedEventCount() { throw new Error('unreadable') } }, { id: 'parent' })
  const result = await inspectParentSettlementNotice({ parentId: 'parent', childId: 'child', sessionQuery: observation.sessionQuery })
  assert.deepEqual(result, emptyNotice(false))
  assert.equal(observation.disposed, 1)
  assert.deepEqual(await inspectParentSettlementNotice({ parentId: 'parent', childId: 'child' }), emptyNotice(false))
})

function gate(kind, options = {}) {
  return evaluateWakeupGate({ ...ids, runId, kind, hostState: hostIdle, ...options })
}

test('唤醒门禁先核查回收锁、运行态、归属和存在性，再查账本', () => {
  const actionLedger = { canInitiate: () => assert.fail('host checks must precede action checks') }
  const running = { running: true, ownershipMismatch: true }
  assert.deepEqual(gate('retry', { hostState: running, worktrees: { isChildLocked: () => true }, actionLedger }),
    { allowed: false, reason: 'worktree-child-locked' })
  assert.equal(gate('resume', { hostState: running, actionLedger }).reason, 'already-running')
  assert.equal(gate('resume', { hostState: { presence: 'unknown' }, actionLedger }).reason, 'host-state-unverified')
  assert.equal(gate('resume', { hostState: { ...hostIdle, ownershipMismatch: true }, actionLedger }).reason, 'host-state-unverified')
  assert.equal(gate('resume', { hostState: { presence: 'not-found' }, actionLedger }).reason, 'child-not-found')
  assert.deepEqual(gate('resume'), { allowed: true, reason: 'ok', actionKey: resumeKey, resumeKey, retryKey: null })
  assert.deepEqual(gate('retry'), { allowed: true, reason: 'ok', actionKey: retryKey, resumeKey, retryKey })
})

for (const [first, second] of [['resume', 'retry'], ['retry', 'resume']]) {
  test(`并发 ${first} → ${second}：即使门检均先通过，实际预留仍互斥`, async () => {
    const actionLedger = createActionLedger()
    const firstGate = gate(first, { actionLedger })
    const secondGate = gate(second, { actionLedger })
    assert.equal(firstGate.allowed, true)
    assert.equal(secondGate.allowed, true)
    const firstWrite = actionLedger.prepare(firstGate.actionKey)
    assert.deepEqual(gate(second, { actionLedger }), { allowed: false, reason: 'in-flight' })
    const secondWrite = actionLedger.prepare(secondGate.actionKey)
    assert.equal((await firstWrite).ok, true)
    assert.equal((await secondWrite).ok, false)

    await actionLedger.markUnknown(firstGate.actionKey)
    assert.equal(gate(second, { actionLedger }).reason, 'delivery-unknown')
    assert.equal(gate(first, { actionLedger }).reason, 'delivery-unknown')
    const restarted = createActionLedger({ initialActions: actionLedger.list() })
    assert.equal(gate(second, { actionLedger: restarted }).reason, 'delivery-unknown')
    await actionLedger.markAccepted(firstGate.actionKey)
    assert.equal(gate(second, { actionLedger }).reason, 'already-accepted')
  })
}

const at = 100
const delegate = (childId, patch = {}) => ({
  ...ids, childId, runId, leaseId: `lease-${childId}`, dispatchState: 'running', auditState: 'pending', ...patch,
})
const lease = (childId, patch = {}) => ({
  leaseId: `lease-${childId}`, ownerKind: 'delegate', ownerId: childId, parentId: 'parent', expiresAt: at + 1, ...patch,
})

function startupAdapters(snapshot, { hostEvents = {}, online = {} } = {}) {
  const calls = []
  const updated = []
  const active = new Map()
  const opts = {
    snapshot, now: () => at,
    worktrees: { hydrateRecords: (rows) => calls.push(['worktrees', rows]) },
    leases: {
      hydrateLeases(rows, options) {
        calls.push(['leases', rows, options])
        const expiredLeaseIds = []
        for (const row of rows) {
          if (row.expiresAt <= options.now) expiredLeaseIds.push(row.leaseId)
          else active.set(row.leaseId, row)
        }
        return { expiredLeaseIds }
      },
      list: () => [...active.values()],
      get: (id) => active.get(id),
      release: (id) => { calls.push(['release', id]); active.delete(id) },
    },
    timeline: {
      hydrateEntries: (rows) => calls.push(['timeline', rows]),
      upsert: (row) => calls.push(['upsert', row.childId]),
    },
    retry: { hydrateState: (rows, options) => calls.push(['retry', rows, options]) },
    supervise: { hydrateCursor: (...args) => calls.push(['cursor', ...args]) },
    store: {
      async putDelegate(row) { updated.push(row); calls.push(['delegate', row.childId]) },
      async deleteLeases(idsToDelete) { calls.push(['delete-batch', idsToDelete]) },
      async deleteLease(id) { calls.push(['delete', id]) },
      putAction: () => assert.fail('startup readback must not mark actions settled from native markers'),
    },
    agents: { get: (id) => { calls.push(['probe-agent', id]); return online[id] } },
    sessionQuery: {
      observeSession(id) {
        calls.push(['observe', id])
        if (hostEvents[id] instanceof Error) throw hostEvents[id]
        if (!hostEvents[id]) throw notFound()
        return { ...hostEvents[id], [Symbol.dispose]() { calls.push(['dispose', id]) } }
      },
    },
    onReattachRunning: (row, host) => calls.push(['reattach', row.childId, host.presence]),
    onDelegateReconciled: (row, host, outcome) => calls.push(['outcome', row.childId, host.presence, outcome]),
  }
  return { opts, calls, updated, active }
}

test('热重载先水合保护层、重试和去重账本，再重挂运行中的会话与原巡检游标', async () => {
  const child = delegate('child', {
    watchCursor: { runId, lastSeq: 8 },
    retry: { records: [{ childId: 'child', retries: 1, fastFailures: 1, attemptStartedAt: 80 }], seenRuns: ['earlier-run'] },
  })
  const snapshot = {
    worktrees: [{ id: 'worktree-1', locked: true }], delegates: [child],
    leases: [lease('child'), lease('expired', { expiresAt: at })],
    actions: [{ key: settleKey, kind: 'settle', phase: 'done', runId }],
  }
  const { opts, calls, updated, active } = startupAdapters(snapshot, { online: { child: { status: 'running', headSeq: 14 } } })
  const ledger = createActionLedger()
  const { summary, actionLedger } = await reconcileOnStartup({ ...opts, actionLedger: ledger })
  assert.equal(actionLedger, ledger)
  assert.equal(actionLedger.hasProcessedRun('settle', { ...ids, runId }), true)
  assert.deepEqual(calls, [
    ['worktrees', snapshot.worktrees],
    ['leases', snapshot.leases, { now: at }],
    ['delete-batch', ['lease-expired']],
    ['timeline', snapshot.delegates],
    ['retry', { records: [{
      childId: 'child', parentId: 'parent', label: undefined, retries: 1, fastFailures: 1, attemptStartedAt: 80,
    }], seenRuns: [{ runId: 'earlier-run', childId: 'child' }, runId] }, { now: at }],
    ['probe-agent', 'child'],
    ['cursor', 'child', child.watchCursor, { currentRunId: runId, currentHeadSeq: 14, now: at }],
    ['reattach', 'child', 'live-running'],
  ])
  assert.deepEqual(summary, {
    reattachedRunning: 1, settledDuringOffline: 0, interruptedChildren: 0, lostChildren: 0,
    unknownChildren: 0, keptLeases: 1, releasedLeases: 0, expiredLeases: 1,
  })
  assert.deepEqual(updated, [])
  assert.deepEqual([...active.keys()], ['lease-child'])
})

test('冷重启按证据标注终态，历史审计 pending 不阻止释租或触发重发', async () => {
  const kinds = new Map([
    ['child', 'interrupted'], ['no-end', null], ['done', 'completed'], ['abort', 'aborted'],
    ['broken', 'error'], ['blocked', 'blocked'], ['exhausted', 'max-tokens'],
  ])
  const delegates = [...kinds.keys()].map((childId) => delegate(childId, { parentNoticeAfterSeq: 1 }))
  const snapshot = { delegates, leases: [...kinds.keys()].map((id) => lease(id)) }
  const observations = Object.fromEntries([...kinds].map(([id, kind]) => [id, {
    header: { parentSession: 'parent' },
    inheritedEventCount: 1,
    events: [turnEnd('completed'), ...(kind ? [turnEnd(kind)] : [])],
  }]))
  observations.parent = { events: [
    { type: 'user/message', data: { source: nativeSource('no-end', 'completed') } },
    { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'n', source: nativeSource('child', 'completed') }] } },
  ] }
  const { opts, calls, updated, active } = startupAdapters(snapshot, { hostEvents: observations, online: { abort: { status: 'idle' } } })
  const { summary } = await reconcileOnStartup(opts)
  assert.equal(summary.interruptedChildren, 2)
  assert.equal(summary.settledDuringOffline, 5)
  assert.equal(summary.releasedLeases, 7)
  assert.equal(summary.reattachedRunning, 0)
  assert.equal(active.size, 0)
  assert.deepEqual(updated.map(({ childId, dispatchState, stopReason }) => [childId, dispatchState, stopReason]), [
    ['child', 'interrupted', 'interrupted'], ['no-end', 'interrupted', 'interrupted'], ['done', 'completed', 'completed'],
    ['abort', 'aborted', 'aborted'], ['broken', 'failed', 'error'], ['blocked', 'failed', 'blocked'],
    ['exhausted', 'failed', 'max-tokens'],
  ])
  assert.ok(updated.every((row) => row.leaseState === 'released' && !Object.hasOwn(row, 'incomplete')))
  assert.ok(delegates.every((row) => row.auditState === 'pending'))
  assert.equal(updated[0].nativeNoticeDetected, true)
  assert.equal(updated[1].nativeNoticeDetected, undefined)
  assert.ok(calls.some((call) => call[0] === 'outcome' && call[1] === 'child' && call[3] === 'interrupted'))
  assert.ok(calls.some((call) => call[0] === 'outcome' && call[1] === 'done' && call[3] === 'settled-offline'))
  assert.equal(calls.filter((call) => call[0] === 'dispose').length, 14)
})

test('只在明确缺失时记 lost，查询不可用/报错和归属矛盾保持租约及原状态', async () => {
  const childIds = ['missing', 'corrupt', 'foreign']
  const snapshot = { delegates: childIds.map((id) => delegate(id)), leases: childIds.map((id) => lease(id)) }
  const { opts, calls, updated, active } = startupAdapters(snapshot, { hostEvents: {
    missing: notFound(), corrupt: new Error('bad read'), foreign: { header: { parentSession: 'other' }, events: [] },
  } })
  const summary = (await reconcileOnStartup(opts)).summary
  assert.equal(summary.lostChildren, 1)
  assert.equal(summary.unknownChildren, 2)
  assert.equal(summary.keptLeases, 2)
  assert.equal(updated.length, 1)
  assert.equal(updated[0].childId, 'missing')
  assert.equal(updated[0].dispatchState, 'lost')
  assert.equal(updated[0].leaseState, 'released')
  assert.deepEqual([...active.keys()], ['lease-corrupt', 'lease-foreign'])
  assert.deepEqual(calls.filter((call) => call[0] === 'release'), [['release', 'lease-missing']])

  const unavailable = startupAdapters(snapshot)
  const unavailableSummary = (await reconcileOnStartup({ ...unavailable.opts, sessionQuery: undefined })).summary
  assert.equal(unavailableSummary.keptLeases, 3)
  assert.equal(unavailableSummary.unknownChildren, 3)
  assert.equal(unavailable.updated.length, 0)
})

test('孤立租约只对明确停止或缺失释放；未知、运行、外部 owner 与归属冲突仍护锁', async () => {
  const leases = [lease('gone'), lease('inactive'), lease('busy'), lease('uncertain'), lease('other'),
    lease('batch', { ownerKind: 'orchestrate' })]
  const { opts, calls, active } = startupAdapters({ delegates: [], leases }, {
    online: { busy: { status: 'running' } },
    hostEvents: {
      inactive: { events: [turnEnd('completed')], header: { parentSession: 'parent' } },
      uncertain: new Error('unavailable'), other: { header: { parentSession: 'foreign' }, events: [] },
    },
  })
  const summary = (await reconcileOnStartup(opts)).summary
  assert.equal(summary.releasedLeases, 2)
  assert.equal(summary.keptLeases, 4)
  assert.deepEqual([...active.keys()], ['lease-busy', 'lease-uncertain', 'lease-other', 'lease-batch'])
  assert.ok(!calls.some((call) => call[1] === 'batch'))
})

test('终态无待办者不探测；矛盾的租约 owner 不会被委派或孤立检查释放', async () => {
  const snapshot = {
    delegates: [delegate('clean', { dispatchState: 'completed', auditState: 'passed', leaseId: null }), delegate('child')],
    leases: [lease('child', { ownerId: 'elsewhere' })],
  }
  const { opts, calls } = startupAdapters(snapshot)
  const summary = (await reconcileOnStartup(opts)).summary
  assert.equal(summary.keptLeases, 1)
  assert.equal(summary.unknownChildren, 1)
  assert.ok(!calls.some((call) => call[1] === 'clean' || call[1] === 'elsewhere'))
})

test('按 ownerId 同样关联租约，避免孤立租约绕过委派的根归属检查', async () => {
  const snapshot = { delegates: [delegate('child', { leaseId: null })], leases: [lease('child')] }
  const { opts, calls, active, updated } = startupAdapters(snapshot, {
    hostEvents: { child: { header: { parentSession: 'parent', rootSessionId: 'different' }, events: [] } },
  })
  const { summary } = await reconcileOnStartup(opts)
  assert.equal(summary.unknownChildren, 1)
  assert.equal(summary.keptLeases, 1)
  assert.equal(updated.length, 0)
  assert.equal(active.size, 1)
  assert.deepEqual(calls.filter((call) => call[0] === 'observe'), [['observe', 'child']])
})

test('租约管理器不认可的过期记录不绕过其校验直接删除', async () => {
  const row = lease('orphan', { ownerKind: 'orchestrate', expiresAt: at })
  const deleted = []
  const { summary } = await reconcileOnStartup({
    snapshot: { leases: [row] }, now: () => at,
    leases: { hydrateLeases: () => ({ expiredLeaseIds: [] }) },
    store: { deleteLeases: (rows) => deleted.push(...rows) },
  })
  assert.equal(summary.expiredLeases, 0)
  assert.equal(summary.keptLeases, 1)
  assert.deepEqual(deleted, [])
})
