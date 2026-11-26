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
    writeScope: ['src/a.js'], leaseId: `lease-${childId}`,
    ...values,
  })
  dispatch('running')
  dispatch('waiting')
  timeline.recordEnded({ childId: 'waiting' })
  dispatch('settled')
  timeline.recordEnded({ childId: 'settled' })
  timeline.recordLeaseReleased({ childId: 'settled', leaseId: 'lease-settled' })
  dispatch('reader', { readOnly: true, leaseId: null, writeScope: [] })
  timeline.recordEnded({ childId: 'reader' })
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
  assert.match(tool.description, /查询.*写租约.*edit/)
  assert.equal(tool.isConcurrencySafe(), false)
  assert.deepEqual(Object.keys(tool.parameters), ['action', 'childId', 'writeScope', 'readOnly', 'includeCompleted', 'limit'])
  assert.equal(tool.parameters.childId.type, 'string')
  assert.equal(tool.parameters.includeCompleted.type, 'boolean')
  assert.equal(tool.parameters.includeCompleted.default, true)
  assert.equal(tool.parameters.limit.type, 'integer')
  assert.equal(tool.parameters.limit.default, 20)
  assert.deepEqual(tool.parameters.limit.enum, Array.from({ length: 64 }, (_, index) => index + 1))
  assert.equal(createDelegateStatusTool({ timeline, toolName: 'check' }).name, 'check')
})

test('返回中文总览、执行和租约状态和结构化详情', async () => {
  const { timeline } = makeFixture()
  const tool = createDelegateStatusTool({ timeline, isRootAgent: (agent) => agent === ROOT })
  const result = await tool.execute({}, { agent: ROOT })
  const [{ type, text }] = result.content
  assert.equal(type, 'text')
  assert.match(text, /委派状态：共 4 条，本次显示 4 条/)
  assert.match(text, /运行中 1，已结束 3，工作树待评审 0/)
  assert.match(text, /【running】任务 running：执行 running，租约 held/)
  assert.match(text, /【waiting】任务 waiting：执行 ended，租约 held/)
  assert.match(text, /【settled】任务 settled：执行 ended，租约 released/)
  assert.match(text, /【reader】任务 reader：执行 ended，租约 none/)
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
  assert.match(hidden.content[0].text, /当前会话没有符合条件/)
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
  await assert.rejects(() => tool.execute({}, { agent: CHILD }), /仅限根代理调用/)
  await assert.rejects(() => tool.execute({}, undefined), /无法识别调用代理的会话 ID/)
  await assert.rejects(() => tool.execute({}, { agent: { session: { id: ROOT.id } } }), /无法识别调用代理的会话 ID/)
  assert.deepEqual(callers, [CHILD])
})

test('查询支持精确子代理、筛选未结束和限制输出条数', async () => {
  const { timeline } = makeFixture()
  const tool = createDelegateStatusTool({ timeline })
  const exec = { agent: ROOT }
  const limited = await tool.execute({ limit: 1 }, exec)
  assert.equal(limited.details.total, 4)
  assert.equal(limited.details.items.length, 1)
  assert.equal(limited.details.items[0].childId, 'running')
  const selected = await tool.execute({ childId: 'settled', limit: 64 }, exec)
  assert.deepEqual(selected.details.items.map(({ childId }) => childId), ['settled'])
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
  assert.equal(result.details.total, 29)
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
    }
  }
  const { execute } = createDelegateStatusTool({ timeline })
  const exec = { agent: ROOT }
  const limited = await execute({ limit: 1 }, exec)
  assert.equal(limited.details.total, 10)
  assert.equal(limited.details.items.length, 1)
  assert.equal(limited.details.counts.worktreePendingReview, 2)
  assert.match(limited.content[0].text, /工作树待评审 2/)
  const conflict = await execute({ childId: 'merge_conflict' }, exec)
  assert.deepEqual(conflict.details.items[0].worktree, {
    id: 'wt-merge_conflict', branch: 'isolated/merge_conflict', state: 'merge_conflict',
    locked: false, execCwd: '/internal-cwd', baseCommit: 'base', mergeCommit: 'merge', conflictFiles: ['src/a.js'], path: '/repo/pool/merge_conflict',
  })
  assert.match(conflict.content[0].text, /\[wt:wt-merge_conflict merge_conflict\]/)
  const merged = await execute({ childId: 'merged' }, exec)
  assert.equal(merged.details.items[0].worktree.locked, true)
  assert.equal(merged.details.counts.worktreePendingReview, 0)
  assert.equal((await execute({ includeCompleted: false }, exec)).details.counts.worktreePendingReview, 0)
  assert.equal((await execute({ childId: 'settled' }, exec)).details.items[0].worktree, null)
})
