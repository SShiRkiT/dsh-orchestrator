import assert from 'node:assert/strict'
import test from 'node:test'
import { createDispatchTimeline } from '../lib/timeline.js'

const dispatch = (timeline, childId, fields = {}) => timeline.recordDispatched({
  parentId: 'root', childId, label: '编辑文件', writeScope: ['src/a.js'], cwd: '/repo',
  leaseId: 'lease-1', ...fields,
})

const itemIds = (result) => result.items.map(({ childId }) => childId)

function makeTimeline(options = {}) {
  let tick = 0
  return createDispatchTimeline({ now: () => ++tick, ...options })
}

test('登记派发并分别记录运行、销毁、结束和租约释放', () => {
  const timeline = makeTimeline()
  assert.equal(dispatch(timeline, 'worker', { startedAt: 10 }), true)
  assert.deepEqual(timeline.get('root', 'worker'), {
    childId: 'worker', parentId: 'root', label: '编辑文件', readOnly: false,
    writeScope: ['src/a.js'], cwd: '/repo', attemptSeq: 1, runId: null,
    dispatchState: 'running', leaseState: 'held', leaseId: 'lease-1',
    startedAt: 10, endedAt: null, disposedAt: null, releasedAt: null,
    updatedAt: 10, stopReason: null, worktree: null, pendingNextTurn: null,
  })
  assert.equal(timeline.recordRunStarted({ childId: 'worker', parentId: 'root', runId: 'run-1' }), true)
  assert.equal(timeline.recordDisposed({ childId: 'worker', at: 11 }), true)
  const disposed = timeline.get('root', 'worker')
  assert.equal(disposed.disposedAt, 11)
  assert.equal(disposed.dispatchState, 'running')
  assert.equal(disposed.leaseState, 'held')
  assert.equal(disposed.endedAt, null)
  timeline.recordEnded({ childId: 'worker', runId: 'run-1', stopReason: 'completed', at: 12 })
  timeline.recordLeaseReleased({ childId: 'worker', leaseId: 'lease-1', at: 14 })
  const ended = timeline.get('root', 'worker')
  assert.equal(ended.runId, 'run-1')
  assert.equal(ended.stopReason, 'completed')
  assert.equal(ended.dispatchState, 'ended')
  assert.equal(ended.leaseState, 'released')
  assert.equal(ended.endedAt, 12)
  assert.equal(ended.releasedAt, 14)
  assert.equal(ended.updatedAt, 14)
})

test('重试重置尝试字段，并拒绝过期运行和租约事件', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'worker')
  timeline.recordRunStarted({ childId: 'worker', runId: 'run-1', parentId: 'root' })
  timeline.recordDisposed({ childId: 'worker', at: 3 })
  timeline.recordEnded({ childId: 'worker', runId: 'run-1', stopReason: 'error', at: 4 })
  timeline.recordLeaseReleased({ childId: 'worker', leaseId: 'lease-1', at: 6 })

  assert.equal(timeline.recordRetry({ childId: 'worker', leaseId: 'lease-2', startedAt: 20 }), true)
  const retry = timeline.get('root', 'worker')
  assert.equal(retry.attemptSeq, 2)
  assert.equal(retry.label, '编辑文件')
  assert.deepEqual(retry.writeScope, ['src/a.js'])
  assert.equal(retry.startedAt, 20)
  assert.equal(retry.leaseId, 'lease-2')
  assert.equal(retry.leaseState, 'held')
  assert.equal(retry.dispatchState, 'running')
  for (const field of ['runId', 'endedAt', 'disposedAt', 'releasedAt', 'stopReason', 'pendingNextTurn']) {
    assert.equal(retry[field], null, field)
  }
  timeline.recordRunStarted({ childId: 'worker', runId: 'run-2', parentId: 'root' })
  const before = timeline.get('root', 'worker')
  assert.equal(timeline.recordRunStarted({ childId: 'worker', runId: 'run-1', parentId: 'root' }), false)
  assert.equal(timeline.recordEnded({ childId: 'worker', runId: 'run-1', stopReason: 'completed' }), false)
  assert.equal(timeline.recordLeaseReleased({ childId: 'worker', leaseId: 'lease-1' }), false)
  assert.deepEqual(timeline.get('root', 'worker'), before)
})

test('同一父会话重复登记刷新元数据，而只有重试增加尝试序号', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'worker')
  timeline.recordRetry({ childId: 'worker', readOnly: true })
  assert.equal(timeline.get('root', 'worker').leaseState, 'none')
  dispatch(timeline, 'worker', { label: '刷新任务', readOnly: true, leaseId: null })
  const entry = timeline.get('root', 'worker')
  assert.equal(entry.attemptSeq, 2)
  assert.equal(entry.label, '刷新任务')
  assert.equal(entry.leaseState, 'none')
  assert.equal(timeline.queryParent('root').total, 1)
})

test('跨父精确查询不可见，同名子代理的无归属写入不猜测', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'same')
  dispatch(timeline, 'same', { parentId: 'other', label: '其他父会话' })
  dispatch(timeline, 'private', { parentId: 'other' })
  assert.equal(timeline.get('root', 'private'), null)
  assert.deepEqual(itemIds(timeline.queryParent('root', { childId: 'private' })), [])
  assert.equal(timeline.recordRunStarted({ parentId: 'other', childId: 'same', runId: 'other-run' }), true)
  assert.equal(timeline.recordEnded({ childId: 'same', runId: 'other-run' }), false)
  assert.equal(timeline.recordEnded({ parentId: 'unknown', childId: 'private' }), false)
  assert.equal(timeline.get('other', 'same').runId, 'other-run')
  assert.equal(timeline.get('root', 'same').runId, null)
  assert.deepEqual(itemIds(timeline.queryParent('root')), ['same'])
})

test('父会话内优先淘汰已结束且没有保护条件的最旧记录', () => {
  const timeline = makeTimeline({ maxPerParent: 3 })
  dispatch(timeline, 'older-active')
  dispatch(timeline, 'pending', { worktree: { id: 'wt-open' } })
  timeline.recordEnded({ childId: 'pending' })
  dispatch(timeline, 'completed', {})
  timeline.recordEnded({ childId: 'completed' })
  dispatch(timeline, 'new-active')
  assert.equal(timeline.get('root', 'completed'), null)
  assert.deepEqual(itemIds(timeline.queryParent('root')), ['new-active', 'older-active', 'pending'])

  dispatch(timeline, 'newer-active')
  assert.equal(timeline.get('root', 'older-active'), null, '没有可淘汰的结算记录时仍保持有界')
  assert.equal(timeline.recordDisposed({ childId: 'older-active' }), false)
})

test('父会话数量有界，淘汰最少近期更新的父会话', () => {
  const timeline = makeTimeline({ maxParents: 2 })
  dispatch(timeline, 'first', { parentId: 'one' })
  dispatch(timeline, 'second', { parentId: 'two' })
  timeline.recordRunStarted({ parentId: 'one', childId: 'first', runId: 'run' })
  dispatch(timeline, 'third', { parentId: 'three' })
  assert.equal(timeline.get('two', 'second'), null)
  assert.equal(timeline.recordDisposed({ childId: 'second' }), false)
  assert.equal(timeline.get('one', 'first').runId, 'run')
  assert.equal(timeline.queryParent('three').total, 1)
})

test('查询按优先级和更新时间排序，分页前统计', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'running')
  dispatch(timeline, 'pending')
  timeline.recordEnded({ childId: 'pending' })
  dispatch(timeline, 'failed')
  timeline.recordEnded({ childId: 'failed' })
  dispatch(timeline, 'passed')
  timeline.recordEnded({ childId: 'passed' })
  dispatch(timeline, 'unmanaged', {})
  timeline.recordEnded({ childId: 'unmanaged' })
  dispatch(timeline, 'elsewhere', { parentId: 'other' })

  const report = timeline.queryParent('root', { limit: 2 })
  assert.equal(report.total, 5)
  assert.deepEqual(report.counts, {
    running: 1, ended: 4, worktreePendingReview: 0,
  })
  assert.deepEqual(itemIds(report), ['running', 'unmanaged'])
  assert.deepEqual(itemIds(timeline.queryParent('root', { includeCompleted: false })), ['running'])
  assert.deepEqual(itemIds(timeline.queryParent('root', { childId: 'passed' })), ['passed'])
})

const WORKTREE = {
  id: 'wt-1', path: '/repo/worktrees/wt-1', execCwd: '/repo/worktrees/wt-1/src',
  branch: 'isolated/wt-1', baseCommit: 'base-commit',
}

test('工作树登记只保留约定字段，评审状态可渐进更新', () => {
  const timeline = makeTimeline()
  const input = { ...WORKTREE, ignored: true, state: 'merged', locked: true }
  dispatch(timeline, 'worker', { worktree: input })
  input.path = '/modified'
  const first = timeline.get('root', 'worker')
  assert.deepEqual(first.worktree, {
    ...WORKTREE, state: 'active', mergeCommit: null, conflictFiles: [], locked: false,
  })
  assert.equal(timeline.recordWorktreeState('worker', { id: 'stale-id', state: 'merged' }), false)
  assert.equal(timeline.recordWorktreeState('unknown', { id: WORKTREE.id, state: 'merged' }), false)
  timeline.recordEnded({ childId: 'worker' })
  assert.equal(timeline.recordWorktreeState('worker', { id: WORKTREE.id, state: 'ready_for_review' }), true)
  const files = ['src/a.js']
  timeline.recordWorktreeState('worker', { state: 'merge_conflict', conflictFiles: files })
  files.push('不应记录的外部修改')
  const snapshot = timeline.get('root', 'worker')
  assert.equal(snapshot.worktree.state, 'merge_conflict')
  assert.deepEqual(snapshot.worktree.conflictFiles, ['src/a.js'])
  snapshot.worktree.conflictFiles.push('读取时修改')
  assert.deepEqual(timeline.get('root', 'worker').worktree.conflictFiles, ['src/a.js'])
  timeline.recordWorktreeState('worker', { state: 'merged', mergeCommit: 'integrated', conflictFiles: [], locked: true })
  assert.deepEqual(timeline.get('root', 'worker').worktree, {
    ...WORKTREE, state: 'merged', mergeCommit: 'integrated', conflictFiles: [], locked: true,
  })
})
