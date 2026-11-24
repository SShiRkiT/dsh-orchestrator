import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_DELEGATE_STATUS_TOOL_NAME, createDelegateStatusTool } from '../lib/delegate-status.js'
import { createDispatchTimeline } from '../lib/timeline.js'

const ROOT = { id: 'root', session: { id: 'elsewhere' } }
const OTHER = { id: 'elsewhere' }
const CHILD = { id: 'child', parentId: 'root' }

function makeFixture() {
  let now = 0
  const timeline = createDispatchTimeline({ now: () => ++now })
  const dispatch = (childId, values = {}) => timeline.recordDispatched({
    parentId: ROOT.id, childId, label: `任务 ${childId}`, readOnly: false,
    writeScope: ['src/a.js'], baselineId: `base-${childId}`, leaseId: `lease-${childId}`,
    ...values,
  })
  dispatch('running')
  dispatch('pending')
  timeline.recordEnded({ childId: 'pending' })
  dispatch('passed')
  timeline.recordEnded({ childId: 'passed' })
  timeline.recordAudit({ childId: 'passed', baselineId: 'base-passed', passed: true })
  timeline.recordLeaseReleased({ childId: 'passed', leaseId: 'lease-passed' })
  dispatch('failed')
  timeline.recordEnded({ childId: 'failed' })
  timeline.recordAudit({
    childId: 'failed', baselineId: 'base-failed', passed: false,
    violations: [{ code: 'out-of-scope-write', path: 'outside.js', reason: '未声明' }],
  })
  timeline.recordLeaseReleased({ childId: 'failed', leaseId: 'lease-failed' })
  dispatch('unmanaged', { baselineId: null, readOnly: true, leaseId: null })
  timeline.recordEnded({ childId: 'unmanaged' })
  dispatch('private', { parentId: OTHER.id, label: '另一个父会话的私有任务' })
  return { timeline, dispatch }
}

test('工具定义可通过宿主构建函数，schema 不暴露 parentId', () => {
  const { timeline } = makeFixture()
  const registered = []
  const tool = createDelegateStatusTool({
    timeline,
    defineTool(definition) {
      registered.push(definition)
      return definition
    },
  })
  assert.deepEqual(registered, [tool])
  assert.equal(tool.name, DEFAULT_DELEGATE_STATUS_TOOL_NAME)
  assert.equal(tool.name, 'delegate_status')
  assert.match(tool.description, /只读.*验收/)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(tool.parameters), ['childId', 'includeCompleted', 'limit'])
  assert.equal(tool.parameters.childId.type, 'string')
  assert.equal(tool.parameters.includeCompleted.type, 'boolean')
  assert.equal(tool.parameters.includeCompleted.default, true)
  assert.equal(tool.parameters.limit.type, 'integer')
  assert.equal(tool.parameters.limit.default, 20)
  assert.deepEqual(tool.parameters.limit.enum, Array.from({ length: 64 }, (_, index) => index + 1))
  assert.equal(createDelegateStatusTool({ timeline, toolName: 'check' }).name, 'check')
})

test('返回中文总览、每条验收状态、失败证据和结构化详情', async () => {
  const { timeline } = makeFixture()
  const tool = createDelegateStatusTool({ timeline, isRootAgent: (agent) => agent === ROOT })
  const result = await tool.execute({}, { agent: ROOT })
  const [{ type, text }] = result.content
  assert.equal(type, 'text')
  assert.match(text, /委派验收状态：共 5 条，本次显示 5 条/)
  assert.match(text, /运行中 1；已结束待审计 1；审计通过 1；审计失败 1；未纳入审计 1/)
  assert.match(text, /【running】任务 running：执行 running；审计 pending；租约 held；基线 base-running/)
  assert.match(text, /【pending】任务 pending：执行 ended；审计 pending/)
  assert.match(text, /【passed】任务 passed：执行 ended；审计 passed；租约 released/)
  assert.match(text, /【failed】任务 failed：执行 ended；审计 failed；租约 released；基线 base-failed/)
  assert.match(text, /【unmanaged】任务 unmanaged：执行 ended；审计 unmanaged；租约 none；基线 无/)
  assert.match(text, /不得验收为通过/)
  assert.match(text, /out-of-scope-write.*outside\.js.*未声明/)
  assert.doesNotMatch(text, /另一个父会话的私有任务/)
  assert.deepEqual(tool.output.render({}, result), result.content)
  assert.deepEqual(result.details, timeline.queryParent(ROOT.id))
  result.details.items[0].label = '读者的修改'
  assert.notEqual(timeline.queryParent(ROOT.id).items[0].label, '读者的修改')
})

test('仅依据 exec.agent.id 查询，不会从参数或其他会话字段读取', async () => {
  const { timeline } = makeFixture()
  const tool = createDelegateStatusTool({ timeline })
  const hidden = await tool.execute({ childId: 'private' }, { agent: ROOT, parentId: OTHER.id })
  assert.equal(hidden.details.parentId, ROOT.id)
  assert.equal(hidden.details.total, 0)
  assert.deepEqual(hidden.details.items, [])
  assert.match(hidden.content[0].text, /当前会话没有符合条件.*不代表验收通过/)
  assert.doesNotMatch(hidden.content[0].text, /另一个父会话的私有任务/)

  const own = await tool.execute({ childId: 'private' }, { agent: OTHER })
  assert.deepEqual(own.details.items.map(({ childId }) => childId), ['private'])
  await assert.rejects(
    () => tool.execute({ parentId: OTHER.id, childId: 'private' }, { agent: ROOT }),
    /不接受 parentId 参数/,
  )
})

test('拒绝子代理和缺失会话身份，且不触碰查询状态库', async () => {
  const callers = []
  const tool = createDelegateStatusTool({
    timeline: { queryParent: () => assert.fail('未经授权的调用不能触碰状态库') },
    isRootAgent(agent) {
      callers.push(agent)
      return agent === ROOT
    },
  })
  await assert.rejects(() => tool.execute({}, { agent: CHILD }), /仅限根代理调用.*子代理不能查询/)
  await assert.rejects(() => tool.execute({}, undefined), /无法识别调用代理的会话 ID/)
  await assert.rejects(() => tool.execute({}, { agent: { session: { id: ROOT.id } } }), /无法识别调用代理的会话 ID/)
  assert.deepEqual(callers, [CHILD])
})

test('查询支持精确子代理、筛选未结束和限制输出条数', async () => {
  const { timeline } = makeFixture()
  const tool = createDelegateStatusTool({ timeline })
  const exec = { agent: ROOT }
  const limited = await tool.execute({ limit: 1 }, exec)
  assert.equal(limited.details.total, 5)
  assert.equal(limited.details.items.length, 1)
  assert.equal(limited.details.items[0].childId, 'failed')
  const selected = await tool.execute({ childId: 'passed', limit: 64 }, exec)
  assert.deepEqual(selected.details.items.map(({ childId }) => childId), ['passed'])
  const running = await tool.execute({ includeCompleted: false }, exec)
  assert.equal(running.details.total, 1)
  assert.equal(running.details.counts.running, 1)
  assert.deepEqual(running.details.items.map(({ childId }) => childId), ['running'])
})

test('执行端在触碰状态库前拒绝不符合 schema 的参数', async () => {
  const tool = createDelegateStatusTool({
    timeline: { queryParent: () => assert.fail('不合法的参数不能触碰状态库') },
  })
  const exec = { agent: ROOT }
  for (const limit of [0, 65, -1, 1.5, '20', null]) {
    await assert.rejects(() => tool.execute({ limit }, exec), /limit 必须是 1\.\.64 之间的整数/)
  }
  await assert.rejects(() => tool.execute({ childId: ' ' }, exec), /childId 必须是非空字符串/)
  await assert.rejects(() => tool.execute({ includeCompleted: 'false' }, exec), /includeCompleted 必须是布尔值/)
})

test('未传分页参数默认展示最近的 20 条，而总览不截断', async () => {
  const { timeline, dispatch } = makeFixture()
  for (let index = 1; index <= 25; index += 1) dispatch(`recent-${index}`)
  const tool = createDelegateStatusTool({ timeline })
  const result = await tool.execute(undefined, { agent: ROOT })
  assert.equal(result.details.total, 30)
  assert.equal(result.details.counts.running, 26)
  assert.equal(result.details.items.length, 20)
  assert.equal(result.details.items[0].childId, 'recent-25')
})

test('透出工作树交付摘要并在分页前统计待评审和冲突项', async () => {
  const { timeline, dispatch } = makeFixture()
  const states = ['ready_for_review', 'merge_conflict', 'merged', 'discarded', 'cleanup_failed', 'active']
  for (const state of states) {
    dispatch(state, { worktree: {
      id: `wt-${state}`, branch: `isolated/${state}`, path: `/repo/pool/${state}`,
      execCwd: '/internal-cwd', baseCommit: 'base',
    } })
    timeline.recordWorktreeState(state, { state, commits: 2, dirty: true, locked: state === 'merged',
      mergeCommit: 'merge', conflictFiles: ['src/a.js'] })
    if (state !== 'active') {
      timeline.recordEnded({ childId: state })
      timeline.recordAudit({ childId: state, baselineId: `base-${state}`, passed: true })
    }
  }
  const { execute } = createDelegateStatusTool({ timeline })
  const exec = { agent: ROOT }
  const limited = await execute({ limit: 1 }, exec)
  assert.equal(limited.details.total, 11)
  assert.equal(limited.details.items.length, 1)
  assert.equal(limited.details.counts.worktreePendingReview, 2)
  assert.match(limited.content[0].text, /工作树待评审 2/)
  const conflict = await execute({ childId: 'merge_conflict' }, exec)
  assert.deepEqual(conflict.details.items[0].worktree, {
    id: 'wt-merge_conflict', branch: 'isolated/merge_conflict', state: 'merge_conflict',
    commits: 2, dirty: true, locked: false, path: '/repo/pool/merge_conflict',
  })
  assert.match(conflict.content[0].text, /\[wt:wt-merge_conflict merge_conflict\]/)
  const merged = await execute({ childId: 'merged' }, exec)
  assert.equal(merged.details.items[0].worktree.locked, true)
  assert.equal(merged.details.counts.worktreePendingReview, 0)
  assert.equal((await execute({ includeCompleted: false }, exec)).details.counts.worktreePendingReview, 0)
  assert.equal((await execute({ childId: 'passed' }, exec)).details.items[0].worktree, null)
})
