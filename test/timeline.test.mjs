import assert from 'node:assert/strict'
import test from 'node:test'
import { INLINE_AUDIT_SOURCE_KIND, createDispatchTimeline, formatInlineAuditNotice } from '../lib/timeline.js'

const dispatch = (timeline, childId, fields = {}) => timeline.recordDispatched({
  parentId: 'root', childId, label: '编辑文件', writeScope: ['src/a.js'], cwd: '/repo',
  baselineId: 'base-1', leaseId: 'lease-1', ...fields,
})

const itemIds = (result) => result.items.map(({ childId }) => childId)

function makeTimeline(options = {}) {
  let tick = 0
  return createDispatchTimeline({ now: () => ++tick, ...options })
}

test('登记派发并分别记录运行、销毁、结束、审计和租约释放', () => {
  const timeline = makeTimeline()
  assert.equal(dispatch(timeline, 'worker', { startedAt: 10 }), true)
  assert.deepEqual(timeline.get('root', 'worker'), {
    childId: 'worker', parentId: 'root', label: '编辑文件', readOnly: false,
    writeScope: ['src/a.js'], cwd: '/repo', attemptSeq: 1, runId: null, baselineId: 'base-1',
    dispatchState: 'running', auditState: 'pending', leaseState: 'held', leaseId: 'lease-1',
    startedAt: 10, endedAt: null, disposedAt: null, auditedAt: null, releasedAt: null,
    updatedAt: 10, stopReason: null, violations: [], truncatedViolations: 0, incomplete: false,
    isolation: 'logical-post-audit', worktree: null, auditSummary: null, auditDeliveredVia: null,
  })
  assert.equal(timeline.recordRunStarted({ childId: 'worker', parentId: 'root', runId: 'run-1' }), true)
  assert.equal(timeline.recordDisposed({ childId: 'worker', at: 11 }), true)
  const disposed = timeline.get('root', 'worker')
  assert.equal(disposed.disposedAt, 11)
  assert.equal(disposed.dispatchState, 'running')
  assert.equal(disposed.auditState, 'pending')
  assert.equal(disposed.leaseState, 'held')
  assert.equal(disposed.endedAt, null)
  assert.deepEqual(timeline.listAttentionItems('root'), [])

  timeline.recordEnded({ childId: 'worker', runId: 'run-1', stopReason: 'completed', at: 12 })
  assert.equal(timeline.get('root', 'worker').auditState, 'pending')
  timeline.recordAudit({ childId: 'worker', runId: 'run-1', baselineId: 'base-1', passed: true, summary: '无违规', at: 13 })
  timeline.recordLeaseReleased({ childId: 'worker', leaseId: 'lease-1', at: 14 })
  const ended = timeline.get('root', 'worker')
  assert.equal(ended.runId, 'run-1')
  assert.equal(ended.stopReason, 'completed')
  assert.equal(ended.dispatchState, 'ended')
  assert.equal(ended.auditState, 'passed')
  assert.equal(ended.auditSummary, '无违规')
  assert.equal(ended.leaseState, 'released')
  assert.equal(ended.endedAt, 12)
  assert.equal(ended.auditedAt, 13)
  assert.equal(ended.releasedAt, 14)
  assert.equal(ended.updatedAt, 14)
})

test('重试重置尝试字段，并拒绝过期运行、基线和租约事件', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'worker')
  timeline.recordRunStarted({ childId: 'worker', runId: 'run-1', parentId: 'root' })
  timeline.recordDisposed({ childId: 'worker', at: 3 })
  timeline.recordEnded({ childId: 'worker', runId: 'run-1', stopReason: 'error', at: 4 })
  timeline.recordAudit({
    childId: 'worker', runId: 'run-1', baselineId: 'base-1', passed: false, incomplete: true,
    summary: '扫描失败', violations: [{ kind: 'audit-incomplete' }], at: 5,
  })
  timeline.recordLeaseReleased({ childId: 'worker', leaseId: 'lease-1', at: 6 })
  assert.equal(timeline.markAuditDelivered({ childId: 'worker', via: 'inline-pre-step' }), true)

  assert.equal(timeline.recordRetry({ childId: 'worker', baselineId: 'base-2', leaseId: 'lease-2', startedAt: 20 }), true)
  const retry = timeline.get('root', 'worker')
  assert.equal(retry.attemptSeq, 2)
  assert.equal(retry.label, '编辑文件')
  assert.deepEqual(retry.writeScope, ['src/a.js'])
  assert.equal(retry.startedAt, 20)
  assert.equal(retry.baselineId, 'base-2')
  assert.equal(retry.leaseId, 'lease-2')
  assert.equal(retry.leaseState, 'held')
  assert.equal(retry.dispatchState, 'running')
  assert.equal(retry.auditState, 'pending')
  for (const field of ['runId', 'endedAt', 'disposedAt', 'auditedAt', 'releasedAt', 'stopReason',
    'auditSummary', 'auditDeliveredVia']) {
    assert.equal(retry[field], null, field)
  }
  assert.deepEqual(retry.violations, [])
  assert.equal(retry.incomplete, false)
  assert.equal(retry.truncatedViolations, 0)
  assert.equal(timeline.recordAudit({ childId: 'worker', runId: 'run-1', baselineId: 'base-1', passed: true }), false)
  timeline.recordRunStarted({ childId: 'worker', runId: 'run-2', parentId: 'root' })
  const before = timeline.get('root', 'worker')
  assert.equal(timeline.recordRunStarted({ childId: 'worker', runId: 'run-1', parentId: 'root' }), false)
  assert.equal(timeline.recordEnded({ childId: 'worker', runId: 'run-1', stopReason: 'completed' }), false)
  assert.equal(timeline.recordAudit({ childId: 'worker', runId: 'run-1', baselineId: 'base-2', passed: true }), false)
  assert.equal(timeline.recordAudit({ childId: 'worker', runId: 'run-2', baselineId: 'base-1', passed: true }), false)
  assert.equal(timeline.recordLeaseReleased({ childId: 'worker', leaseId: 'lease-1' }), false)
  assert.deepEqual(timeline.get('root', 'worker'), before)
})

test('同一父会话重复登记刷新元数据，而只有重试增加尝试序号', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'worker')
  timeline.recordRetry({ childId: 'worker', readOnly: true, baselineId: 'base-2' })
  assert.equal(timeline.get('root', 'worker').leaseState, 'none')
  dispatch(timeline, 'worker', { label: '刷新任务', readOnly: true, leaseId: null })
  const entry = timeline.get('root', 'worker')
  assert.equal(entry.attemptSeq, 2)
  assert.equal(entry.label, '刷新任务')
  assert.equal(entry.leaseState, 'none')
  assert.equal(timeline.queryParent('root').total, 1)
})

test('只读不占租约，无基线或采样不完整不得误标通过', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'read', { readOnly: true, leaseId: null, writeScope: [] })
  assert.equal(timeline.get('root', 'read').leaseState, 'none')
  timeline.recordAudit({ childId: 'read', baselineId: 'base-1', passed: true, incomplete: true })
  assert.equal(timeline.get('root', 'read').auditState, 'failed')
  assert.equal(timeline.get('root', 'read').incomplete, true)
  timeline.recordAudit({ childId: 'read', passed: true })
  assert.equal(timeline.get('root', 'read').auditState, 'failed', '结算时未传入基线，即使登记过也不得通过')

  dispatch(timeline, 'unmanaged', { baselineId: null })
  assert.equal(timeline.get('root', 'unmanaged').auditState, 'unmanaged')
  timeline.recordAudit({ childId: 'unmanaged', passed: true })
  assert.equal(timeline.get('root', 'unmanaged').auditState, 'failed')
  timeline.recordAudit({ childId: 'unmanaged', passed: false, incomplete: true, unmanaged: true })
  assert.equal(timeline.get('root', 'unmanaged').auditState, 'unmanaged', '明确未纳入审计优先于其他标志')
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

test('违规和隔离说明使用独立安全快照，违规数量有界', () => {
  const timeline = makeTimeline({ maxViolations: 1 })
  const writeScope = ['src/a.js']
  const violations = [{ code: 'out-of-scope-write', path: 'outside', detail: { lines: ['old'] }, secret: '忽略' },
    { kind: 'target-missing', path: 'target' }]
  const isolation = { level: 'logical-post-audit', facts: ['not-a-sandbox'] }
  dispatch(timeline, 'worker', { writeScope })
  timeline.recordEnded({ childId: 'worker' })
  timeline.recordAudit({ childId: 'worker', baselineId: 'base-1', passed: false, violations, isolation })
  writeScope.push('外部修改')
  violations[0].detail.lines[0] = '外部修改'
  isolation.facts[0] = '外部修改'
  for (const snapshot of [timeline.get('root', 'worker'), timeline.queryParent('root').items[0], timeline.listAttentionItems('root')[0]]) {
    assert.deepEqual(snapshot.writeScope, ['src/a.js'])
    assert.deepEqual(snapshot.violations, [{ code: 'out-of-scope-write', path: 'outside', detail: { lines: ['old'] } }])
    assert.equal(snapshot.truncatedViolations, 1)
    assert.deepEqual(snapshot.isolation, { level: 'logical-post-audit', facts: ['not-a-sandbox'] })
    snapshot.writeScope.push('读取时修改')
    snapshot.violations[0].detail.lines[0] = '读取时修改'
    snapshot.isolation.facts[0] = '读取时修改'
  }
  assert.equal(timeline.get('root', 'worker').violations[0].detail.lines[0], 'old')
})

test('父会话内优先淘汰已结束且审计已经结算的最旧记录', () => {
  const timeline = makeTimeline({ maxPerParent: 3 })
  dispatch(timeline, 'older-active')
  dispatch(timeline, 'pending')
  timeline.recordEnded({ childId: 'pending' })
  dispatch(timeline, 'completed', { baselineId: null })
  timeline.recordEnded({ childId: 'completed' })
  dispatch(timeline, 'new-active')
  assert.equal(timeline.get('root', 'completed'), null)
  assert.deepEqual(itemIds(timeline.queryParent('root')), ['new-active', 'pending', 'older-active'])

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

test('查询按优先级和更新时间排序，分页前统计，巡检只取未结算或未送达失败项', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'running')
  dispatch(timeline, 'pending')
  timeline.recordEnded({ childId: 'pending' })
  dispatch(timeline, 'failed')
  timeline.recordEnded({ childId: 'failed' })
  timeline.recordAudit({ childId: 'failed', baselineId: 'base-1', passed: false })
  dispatch(timeline, 'passed')
  timeline.recordEnded({ childId: 'passed' })
  timeline.recordAudit({ childId: 'passed', baselineId: 'base-1', passed: true })
  dispatch(timeline, 'unmanaged', { baselineId: null })
  timeline.recordEnded({ childId: 'unmanaged' })
  dispatch(timeline, 'elsewhere', { parentId: 'other' })

  const report = timeline.queryParent('root', { limit: 2 })
  assert.equal(report.total, 5)
  assert.deepEqual(report.counts, {
    running: 1, endedPendingAudit: 1, auditPassed: 1, auditFailed: 1, auditUnmanaged: 1, worktreePendingReview: 0,
  })
  assert.deepEqual(itemIds(report), ['failed', 'pending'])
  assert.deepEqual(itemIds(timeline.queryParent('root', { includeCompleted: false })), ['running'])
  assert.deepEqual(itemIds(timeline.queryParent('root', { childId: 'passed' })), ['passed'])
  assert.deepEqual(timeline.listAttentionItems('root').map(({ childId }) => childId), ['failed', 'pending'])

  assert.equal(timeline.markAuditDelivered({ parentId: 'other', childId: 'failed', via: 'inline-pre-step' }), false)
  assert.equal(timeline.markAuditDelivered({ parentId: 'root', childId: 'failed', via: 'unknown' }), false)
  assert.equal(timeline.get('root', 'failed').auditDeliveredVia, null)
  assert.equal(timeline.markAuditDelivered({ parentId: 'root', childId: 'failed', via: 'inline-pre-step' }), true)
  assert.equal(timeline.get('root', 'failed').auditDeliveredVia, 'inline-pre-step')
  assert.deepEqual(timeline.listAttentionItems('root').map(({ childId }) => childId), ['pending'])
  assert.deepEqual(timeline.listAttentionItems('other'), [])
})

test('同帧通知区分四种审计终态，并诚实描述逻辑写后审计', () => {
  assert.equal(INLINE_AUDIT_SOURCE_KIND, 'orchestrator-write-audit-inline')
  const text = formatInlineAuditNotice([
    { childId: 'passed', entry: { auditState: 'passed', baselineId: 'base-pass', readOnly: false } },
    { childId: 'read-only', entry: { auditState: 'passed', baselineId: 'base-read', readOnly: true } },
    { childId: 'failed', entry: { auditState: 'failed', baselineId: 'base-fail', incomplete: true,
      violations: [{ kind: 'target-missing', path: 'src/out.js', detail: '交付目标消失' }], truncatedViolations: 2 } },
    { childId: 'pending', entry: { auditState: 'pending' } },
    { childId: 'unmanaged', entry: { auditState: 'unmanaged' } },
    { childId: 'unknown', entry: null },
  ])
  assert.match(text, /【passed】写作用域审计已通过（基线 base-pass；作用域内变更）。/)
  assert.match(text, /【read-only】写作用域审计已通过（基线 base-read；只读逻辑审计）。/)
  assert.match(text, /【failed】不得验收为通过。写作用域审计未通过（基线 base-fail，3 项）/)
  assert.match(text, /target-missing.*src\/out\.js.*交付目标消失/)
  assert.match(text, /另有 2 项未列出。/)
  assert.match(text, /审计采样不完整或超限。/)
  assert.match(text, /logical-post-audit.*不是物理隔离/)
  assert.match(text, /【pending】执行已结束.*pending.*delegate_status/)
  assert.match(text, /【unmanaged】未纳入.*unmanaged/)
  assert.match(text, /【unknown】未纳入.*unmanaged/)
  assert.equal(formatInlineAuditNotice([]), '')
})

const WORKTREE = {
  id: 'wt-1', path: '/repo/worktrees/wt-1', execCwd: '/repo/worktrees/wt-1/src',
  branch: 'isolated/wt-1', baseCommit: 'base-commit',
}

test('工作树登记只保留约定字段，审计及评审状态可渐进更新', () => {
  const timeline = makeTimeline()
  const input = { ...WORKTREE, ignored: true, state: 'merged', locked: true }
  dispatch(timeline, 'worker', { worktree: input })
  input.path = '/modified'
  const first = timeline.get('root', 'worker')
  assert.equal(first.isolation, 'git-worktree')
  assert.deepEqual(first.worktree, {
    ...WORKTREE, state: 'active', commits: 0, dirty: false, mergeCommit: null, conflictFiles: [], locked: false,
  })
  assert.equal(timeline.recordWorktreeState('worker', { id: 'stale-id', state: 'merged' }), false)
  assert.equal(timeline.recordWorktreeState('unknown', { id: WORKTREE.id, state: 'merged' }), false)
  timeline.recordEnded({ childId: 'worker' })
  assert.equal(timeline.recordAudit('worker', {
    baselineId: 'base-1', passed: true, isolationLevel: 'git-worktree',
    git: { commits: [{ hash: 'one' }, { hash: 'two' }], dirtyFiles: ['src/a.js'] },
  }), true)
  assert.equal(timeline.get('root', 'worker').auditState, 'passed')
  assert.equal(timeline.get('root', 'worker').worktree.commits, 2)
  assert.equal(timeline.get('root', 'worker').worktree.dirty, true)
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
    ...WORKTREE, state: 'merged', commits: 2, dirty: true, mergeCommit: 'integrated', conflictFiles: [], locked: true,
  })
})

test('旧式事件仍可传工作树审计，缺失 Git 计数时重置而不丢失隔离级别', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'worker', { worktree: WORKTREE })
  timeline.recordWorktreeState('worker', { commits: 5, dirty: true })
  timeline.recordAudit({ childId: 'worker', audit: { baselineId: 'base-1', passed: true, git: {} } })
  const entry = timeline.get('root', 'worker')
  assert.equal(entry.auditState, 'passed')
  assert.equal(entry.isolation, 'git-worktree')
  assert.equal(entry.worktree.commits, 0)
  assert.equal(entry.worktree.dirty, false)
})

test('git-worktree 同帧文案区分通过、留存待合回及违规现场', () => {
  const timeline = makeTimeline()
  dispatch(timeline, 'worker', { worktree: WORKTREE })
  timeline.recordEnded({ childId: 'worker' })
  timeline.recordWorktreeState('worker', { state: 'ready_for_review' })
  timeline.recordAudit({ childId: 'worker', baselineId: 'base-1', passed: true, isolationLevel: 'git-worktree',
    git: { commits: ['sha'], dirtyFiles: ['src/a.js'] } })
  const notice = () => formatInlineAuditNotice([{ childId: 'worker', entry: timeline.get('root', 'worker') }])
  assert.equal(notice(), '【worker】写作用域审计已通过（基线 base-1；git-worktree 独立检出，分支 isolated/wt-1，新增提交 1 个，含未提交改动）。' +
    '交付物保留在工作树 wt-1，尚未合回主仓，请调用 worktree_manage 执行 inspect / merge / discard。')
  timeline.recordAudit('worker', { baselineId: 'base-1', passed: false, isolationLevel: 'git-worktree',
    git: { commits: ['sha'], dirtyFiles: ['src/a.js'] },
    violations: [{ code: 'out-of-scope-write', path: 'elsewhere.js' }],
  })
  assert.equal(formatInlineAuditNotice(timeline.get('root', 'worker')), notice())
  assert.match(notice(), /不得验收为通过.*git-worktree 工作树 wt-1，分支 isolated\/wt-1/)
  assert.match(notice(), /out-of-scope-write.*elsewhere\.js/)
  assert.match(notice(), /违规现场保留.*尚未合回主仓/)
  assert.doesNotMatch(notice(), /logical-post-audit/)
})

test('无工作树时 logical-post-audit 同帧文本保持逐字兼容', () => {
  const text = formatInlineAuditNotice([
    { childId: 'passed', entry: { auditState: 'passed', baselineId: 'p', isolation: 'logical-post-audit' } },
    { childId: 'failed', entry: { auditState: 'failed', baselineId: 'f', isolation: 'logical-post-audit',
      violations: [{ kind: 'target-missing', path: 'src/a.js', detail: '目标缺失' }] } },
  ])
  assert.equal(text, [
    '【passed】写作用域审计已通过（基线 p；作用域内变更）。',
    '【failed】不得验收为通过。写作用域审计未通过（基线 f，1 项）：',
    '- target-missing："src/a.js"（"目标缺失"）',
    'logical-post-audit：只做工作区逻辑写后审计，不是物理隔离；不能阻止写入、覆盖工作区外或区分并发写入者。',
  ].join('\n'))
})
