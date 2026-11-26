import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'

import { createRetry } from '../lib/retry.js'
import { createSupervisor } from '../lib/supervise.js'
import { createDispatchTimeline } from '../lib/timeline.js'
import { createWorktreeManager, isWorktreeLockedRecord } from '../lib/worktree.js'
import { createWriteLeases, WRITE_LEASE_CODES } from '../lib/write-lease.js'

const json = (value) => JSON.parse(JSON.stringify(value))

await test('工作树还原全阶段锁墓碑，不调用 Git，也不会被旧记录覆盖', (t) => {
  const noGit = t.mock.method(childProcess, 'execFileSync', () => {
    assert.fail('hydrateRecords 不得执行 Git')
  })
  syncBuiltinESMExports()
  t.after(() => {
    noGit.mock.restore()
    syncBuiltinESMExports()
  })
  const original = createWorktreeManager({ now: () => 25 })
  const row = {
    id: 'wt-abc', parentId: 'root', childId: 'stage-1', childIds: ['stage-1', null, 'stage-1'],
    state: 'cleanup_failed', mergeCommit: 'merge-sha', createdAt: 10, updatedAt: 20,
    auditSummary: { passed: true, counts: [1] },
  }
  assert.deepEqual(original.hydrateRecords([row]), { restored: 1, skipped: 0 })
  original.rebindChild(row.id, 'stage-2')
  original.bindChild(row.id, 'stage-3')
  assert.equal(original.getByChild('stage-1'), null)
  assert.equal(original.getByChild('stage-3').id, row.id)
  const exported = original.exportRecords()
  assert.deepEqual(exported[0].childIds, ['stage-2', 'stage-1', 'stage-3'])
  assert.equal(exported[0].locked, true)
  assert.equal(Object.hasOwn(exported[0], 'auditSummary'), false)
  exported[0].childIds.push('unbound')
  assert.deepEqual(original.exportRecords()[0].childIds, ['stage-2', 'stage-1', 'stage-3'])

  const restored = createWorktreeManager()
  assert.deepEqual(restored.hydrateRecords(json(original.exportRecords())), { restored: 1, skipped: 0 })
  assert.deepEqual(restored.hydrateRecords([{ ...row, state: 'active', mergeCommit: null }]),
    { restored: 0, skipped: 1 })
  const map = restored.getChildWorktreeMap()
  for (const childId of ['stage-1', 'stage-2', 'stage-3']) {
    assert.equal(map.get(childId), row.id)
    assert.equal(restored.getByChild(childId).id, row.id)
    assert.equal(restored.isChildLocked(childId).locked, true)
  }
  assert.equal(isWorktreeLockedRecord(restored.get(row.id)), true)
  assert.equal(isWorktreeLockedRecord({ state: 'active', cleaned: true }), true)
  assert.equal(isWorktreeLockedRecord({ state: 'active' }), false)
  map.clear()
  assert.equal(restored.getChildWorktreeMap().size, 3)
  assert.equal(noGit.mock.callCount(), 0)
  assert.deepEqual(restored.hydrateRecords([], { replace: true }), { restored: 0, skipped: 0 })
  assert.equal(restored.getChildWorktreeMap().size, 0)
})

await test('写租约还原物理路径冲突、过期与重复处理，默认 ID 跨实例唯一', () => {
  let now = 100
  const original = createWriteLeases({ now: () => now })
  const claim = (table, childId, parentId, scope, ttlMs = 100) => table.acquire({
    childId, parentId, scope, cwd: 'C:/project', ttlMs,
  })
  const live = claim(original, 'child-a', 'root-a', ['Shared/'], 300).lease
  const expired = claim(original, 'child-expired', 'root-a', ['expired.js'], 10).lease
  const otherInstance = createWriteLeases({ now: () => now })
  assert.notEqual(claim(otherInstance, 'child-x', 'root-x', ['Shared/']).lease.leaseId, live.leaseId)
  const saved = json(original.exportLeases())
  assert.equal(saved.length, 2)
  assert.equal(saved[0].ownerId, 'child-a')
  assert.equal(saved[0].ownerKind, 'delegate')
  now = 110
  assert.equal(original.exportLeases().length, 1)

  const restored = createWriteLeases({ now: () => now })
  const differentOwner = { ...saved[0], leaseId: 'legacy-other', ownerId: 'other', parentId: 'root-z' }
  const invalid = { ...saved[0], leaseId: 'forged-path', entries: [{ path: 'relative', key: 'relative', kind: 'file' }] }
  const stats = restored.hydrateLeases([...saved, saved[0], differentOwner, invalid])
  assert.deepEqual(stats, { restored: 1, skippedExpired: 1, skippedInvalid: 3, expiredLeaseIds: [expired.leaseId] })
  assert.deepEqual(restored.exportLeases(), [saved[0]])
  const conflict = claim(restored, 'child-b', 'root-b', ['shared/file.js'])
  assert.equal(conflict.code, WRITE_LEASE_CODES.conflict)
  assert.equal(conflict.conflicts[0].leaseId, live.leaseId)
  assert.equal(claim(restored, 'child-a', 'root-b', ['Shared/']).code, WRITE_LEASE_CODES.conflict)
  assert.equal(claim(restored, 'new-child', 'root-b', ['expired.js']).ok, true)
  assert.equal(restored.releaseChild('child-a').released, 1)
  assert.equal(claim(restored, 'child-b', 'root-b', ['shared/file.js']).ok, true)
})

await test('原子缩窄和只读切换保留回滚保护，换租冲突不改原租约', () => {
  const table = createWriteLeases({ now: () => 100 })
  const owner = { childId: 'owner', parentId: 'root', cwd: 'C:/project' }
  const other = { childId: 'other', parentId: 'root-b', cwd: owner.cwd }
  const original = table.acquire({ ...owner, scope: ['one.js', 'two.js'] }).lease
  table.acquire({ ...other, scope: ['three.js'] })
  const originalRecords = table.exportLeases()
  const conflict = table.replaceOwnerLease({ ...owner, scope: ['one.js', 'three.js'] }, { reversible: true })
  assert.equal(conflict.code, WRITE_LEASE_CODES.conflict)
  assert.deepEqual(table.exportLeases(), originalRecords)

  const narrow = table.replaceOwnerLease({ ...owner, scope: ['one.js'] }, { reversible: true })
  assert.equal(narrow.ok, true)
  assert.equal(narrow.lease.leaseId, original.leaseId)
  assert.equal(narrow.lease.entries.length, 1)
  assert.equal(table.acquire({ ...other, scope: ['two.js'] }).code, WRITE_LEASE_CODES.conflict)
  assert.equal(narrow.rollback(), true)
  assert.deepEqual(table.exportLeases().find(({ ownerId }) => ownerId === owner.childId),
    originalRecords.find(({ ownerId }) => ownerId === owner.childId))

  const reader = table.replaceOwnerLease({ ...owner, readOnly: true, scope: [] }, { reversible: true })
  assert.equal(reader.ok, true)
  assert.equal(reader.lease, null)
  assert.equal(table.has(original.leaseId), false)
  assert.equal(table.acquire({ ...other, scope: ['two.js'] }).code, WRITE_LEASE_CODES.conflict)
  assert.equal(reader.commit(), true)
  assert.equal(table.acquire({ ...other, scope: ['two.js'] }).ok, true)
})

await test('时间线往返并在子级上限优先淘汰普通终态', () => {
  const original = createDispatchTimeline()
  const base = { parentId: 'root', updatedAt: 10, startedAt: 1, endedAt: 8, dispatchState: 'completed' }
  const protectedRows = [
    { ...base, childId: 'active', dispatchState: 'dispatched', endedAt: null, updatedAt: 2 },
    { ...base, childId: 'review', worktreeId: 'wt-ready', worktreeState: 'ready', updatedAt: 5 },
    { ...base, childId: 'cleanup', worktreeId: 'wt-cleanup', worktreeState: 'cleanup-failed', updatedAt: 6 },
  ]
  const pending = { ...base, childId: 'legacy-pending', auditState: 'pending', updatedAt: 3 }
  const ordinary = { ...base, childId: 'ordinary', auditState: 'passed', attemptSeq: 2, runId: 'run-2',
    stopReason: 'completed', baselineId: 'base', incomplete: true, auditDeliveredVia: 'inline-pre-step',
    leaseId: 'lease-1', leaseState: 'released', label: '交付', cwd: '/repo', readOnly: true, writeScope: ['src/'] }
  assert.deepEqual(original.hydrateEntries([...protectedRows, pending, ordinary, { childId: '' }]), { restored: 5, skipped: 1 })
  const row = original.get('root', 'ordinary')
  for (const key of ['attemptSeq', 'runId', 'stopReason', 'leaseId', 'leaseState', 'startedAt', 'endedAt', 'updatedAt', 'label', 'cwd', 'readOnly', 'writeScope']) {
    assert.deepEqual(row[key], ordinary[key], key)
  }
  for (const key of ['baselineId', 'auditState', 'incomplete', 'auditDeliveredVia']) assert.equal(Object.hasOwn(row, key), false, key)
  assert.equal(row.dispatchState, 'ended')
  const restored = createDispatchTimeline({ maxPerParent: 5 })
  const snap = original.exportEntries()
  assert.deepEqual(restored.hydrateEntries(json(snap)), { restored: 5, skipped: 0 })
  assert.deepEqual(restored.exportEntries(), snap)
  snap.find(({ childId }) => childId === 'ordinary').writeScope.push('foreign')
  assert.deepEqual(original.get('root', 'ordinary').writeScope, ['src/'])
  assert.equal(restored.get('root', 'review').worktree.state, 'ready_for_review')
  assert.equal(restored.get('root', 'cleanup').worktree.state, 'cleanup_failed')
  assert.deepEqual(restored.hydrateEntries([{ ...ordinary, updatedAt: 7 }]), { restored: 0, skipped: 1 })
  restored.recordDispatched({ parentId: 'root', childId: 'latest', startedAt: 20 })
  assert.equal(restored.get('root', 'legacy-pending'), null)
  assert.ok(restored.get('root', 'ordinary'))
  for (const { childId } of protectedRows) assert.ok(restored.get('root', childId), childId)
})

await test('时间线父桶满时优先淘汰没有未决子项的父会话', () => {
  const timeline = createDispatchTimeline({ maxParents: 2, now: () => 20 })
  timeline.recordDispatched({ parentId: 'old-protected', childId: 'open', startedAt: 1 })
  timeline.recordDispatched({ parentId: 'newer-ordinary', childId: 'done', startedAt: 2 })
  timeline.recordEnded({ parentId: 'newer-ordinary', childId: 'done', at: 3 })
  timeline.recordDispatched({ parentId: 'new', childId: 'new-child', startedAt: 4 })
  assert.ok(timeline.get('old-protected', 'open'))
  assert.ok(timeline.get('new', 'new-child'))
  assert.equal(timeline.get('newer-ordinary', 'done'), null)
})

await test('Retry 还原快速失败预算和 run 去重，不在水合时投递', async () => {
  let now = 100
  const prompts = []
  const wakes = []
  const adapters = {
    now: () => now,
    deliverPrompt: (...args) => prompts.push(args),
    wakeParent: (...args) => wakes.push(args),
  }
  const crash = { stopReason: 'error' }
  const original = createRetry(adapters)
  original.track('worker', { parentId: 'root', label: '任务' })
  assert.equal(await original.settle('worker', crash, 'run-a'), 'retry')
  now += 1000
  assert.equal(await original.settle('worker', crash, 'run-b'), 'retry')
  const snapshot = json(original.exportState())
  assert.deepEqual(snapshot, original.exportChildRecord('worker'))
  const restored = createRetry(adapters)
  assert.deepEqual(restored.hydrateState(snapshot), { restored: 1, skipped: 0, restoredRuns: 2 })
  assert.deepEqual(restored.exportState(), snapshot)
  assert.equal(prompts.length, 2)
  assert.equal(wakes.length, 0)
  assert.equal(await restored.settle('worker', crash, 'run-a'), 'duplicate')
  now += 1000
  assert.equal(await restored.settle('worker', crash, 'run-c'), 'unavailable')
  assert.equal(prompts.length, 2)
  assert.equal(wakes.length, 1)
  const terminal = json(restored.exportChildRecord('worker'))
  const next = createRetry(adapters)
  next.hydrateState(terminal, { childId: 'worker' })
  assert.deepEqual(next.exportChildRecord('worker'), terminal)
})

await test('Retry 恢复后仍按原窗口重置慢失败预算，并限制容量', async () => {
  const retry = createRetry({ now: () => 1000, windowMs: 100, maxRecords: 1, deliverPrompt: () => {} })
  const record = { parentId: 'root', attemptStartedAt: 100, retries: 2, fastFailures: 2 }
  retry.hydrateState({
    records: [{ ...record, childId: 'evicted' }, { ...record, childId: 'survivor' }],
    seenRuns: Array.from({ length: 300 }, (_, index) => `run-${index}`),
  })
  assert.equal(retry.has('evicted'), false)
  assert.equal(retry.exportState().seenRuns.length, 256)
  assert.equal(await retry.settle('survivor', { stopReason: 'error' }, 'run-299'), 'duplicate')
  assert.equal(await retry.settle('survivor', { stopReason: 'error' }, 'fresh-run'), 'retry')
  const [restored] = retry.exportState().records
  assert.equal(restored.retries, 1)
  assert.equal(restored.fastFailures, 1)
})

await test('巡检同 run 续游标、新 run 以当前 head 重置，且水合不执行巡检', () => {
  let reads = 0
  const opts = { config: { intervalSeconds: 2 }, now: () => 10000, readEvents: () => { reads += 1 } }
  const original = createSupervisor(opts)
  original.track({ childId: 'tracked', parentId: 'root', runId: 'track-run', resumed: true, startedAt: 9000, sinceSeq: 5 })
  assert.equal(original.exportCursor('tracked').runId, 'track-run')
  const cursor = {
    childId: 'child', parentId: 'root', runId: 'run-a', runSinceSeq: 12, lastSeq: 34,
    lastInspectionAt: 9500, nextDueAt: 11500, intervalMs: 2000, noticesSent: 2, startedAt: 5000,
  }
  assert.equal(original.hydrateCursor('child', cursor, { currentRunId: 'run-a' }), true)
  const snapshot = json(original.exportCursors())
  const hot = createSupervisor(opts)
  assert.deepEqual(hot.hydrateCursors(snapshot), { restored: 2, skipped: 0 })
  assert.deepEqual(hot.exportCursor('child'), cursor)
  hot.track({ childId: 'child', parentId: 'root', runId: 'run-a', resumed: true, sinceSeq: 50 })
  assert.deepEqual(hot.exportCursor('child'), cursor)
  assert.equal(hot.hydrateCursor('child', { ...cursor, lastSeq: 14 }, { currentRunId: 'run-a' }), false)
  assert.equal(hot.hydrateCursor('other', cursor), false)
  assert.equal(hot.hydrateCursor('child', cursor, { currentRunId: 'run-b', currentHeadSeq: 3 }), true)
  assert.deepEqual(hot.exportCursor('child'), {
    childId: 'child', parentId: 'root', runId: 'run-b', runSinceSeq: 3, lastSeq: 3,
    lastInspectionAt: null, nextDueAt: 12000, intervalMs: 2000, noticesSent: 0, startedAt: 10000,
  })
  assert.equal(hot.hydrateCursor('child', cursor, { currentRunId: 'run-c' }), true)
  assert.equal(hot.exportCursor('child').lastSeq, 0)
  assert.equal(reads, 0)
})
