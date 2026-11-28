import assert from 'node:assert/strict'
import test from 'node:test'
import { createDispatchTimeline } from '../lib/timeline.js'
import { createWorktreeManager } from '../lib/worktree.js'
import { createWorktreeManageTool } from '../lib/worktree-manage.js'
import { createPersistentWorktreeTool } from '../lib/worktree-tool.js'
import { createWriteLeases } from '../lib/write-lease.js'
import { normalizeScope, overlaps } from '../lib/write-scope.js'
import { ISOLATION_MODES, formatWorktreeError, leaseFailure, parseIsolation } from '../lib/write-scope-tool.js'

const ROOT = { agent: { id: 'root', session: { header: { cwd: '/repo' } } } }
const CHILD = { agent: { id: 'child-1', parentId: 'root' } }
const TREE = {
  id: 'wt-1', childId: 'child-1', parentId: 'root', branch: 'isolated/1', baseCommit: 'base',
  worktreePath: '/repo/.dsh-orchestrator/worktrees/wt-1', state: 'ready_for_review',
}
const PRIVATE = { ...TREE, id: 'wt-2', childId: 'child-2', parentId: 'other', branch: 'isolated/private' }
const STAGE_IDS = [TREE.childId, 'child-prior-stage']

function assertLosslessJson(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value) && !Object.is(value, -0), `${path}: 非 lossless JSON 数字`)
    return
  }
  assert.equal(typeof value, 'object', `${path}: 非 JSON 值`)
  assert.ok(!ancestors.has(value), `${path}: 循环引用`)
  ancestors.add(value)
  try {
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    assert.ok(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null,
      `${path}: 非普通 JSON 原型`)
    const keys = Reflect.ownKeys(value)
    if (array) assert.equal(keys.length, value.length + 1, `${path}: 数组空洞或额外键`)
    for (const key of keys) {
      assert.equal(typeof key, 'string', `${path}: Symbol 键`)
      if (array && key === 'length') continue
      const propertyPath = `${path}.${key}`
      // The host checks array indices for ownership; assert the projected indices are enumerable too.
      assert.equal(Object.getOwnPropertyDescriptor(value, key)?.enumerable, true, `${propertyPath}: 不可枚举`)
      if (!array) assertLosslessJson(value[key], propertyPath, ancestors)
    }
    if (array) {
      for (let index = 0; index < value.length; index += 1) {
        assert.ok(Object.hasOwn(value, index), `${path}[${index}]: 数组空洞`)
        assertLosslessJson(value[index], `${path}[${index}]`, ancestors)
      }
    }
  } finally {
    ancestors.delete(value)
  }
}

function worktreeSnapshot(fields = {}) {
  const manager = createWorktreeManager()
  manager.hydrateRecords([{ ...TREE, childIds: STAGE_IDS, ...fields }])
  return manager.get(TREE.id)
}

function fixture(overrides = {}, createTool = createWorktreeManageTool) {
  const calls = []
  const timeline = createDispatchTimeline()
  timeline.recordDispatched({ parentId: TREE.parentId, childId: TREE.childId, worktree: TREE })
  timeline.recordWorktreeState(TREE.childId, { id: TREE.id, state: TREE.state, commits: 2, dirty: true })
  const handlers = {
    list: () => [TREE, { ...TREE, id: 'wt-old', state: 'merged' }, PRIVATE],
    getByWorktreeOrChild: (id) => [TREE, PRIVATE].find((entry) => [entry.id, entry.childId].includes(id)) ?? null,
    inspect: () => ({ ok: true, worktree: TREE, exists: true, aheadCount: 2, commits: ['one', 'two'],
      diffPatch: '+new', diffTruncated: true, dirty: true }),
    merge: () => ({ ok: true, merged: true, mergeCommit: 'combined',
      worktree: worktreeSnapshot({ state: 'merged', mergeCommit: 'combined' }) }),
    discard: () => ({ ok: true, discarded: true, worktree: worktreeSnapshot({ state: 'discarded' }) }),
    prune: () => ({ ok: true, orphans: ['old'], prunedWorktrees: ['old'], prunedBranches: ['branch-old'] }),
    ...overrides,
  }
  const worktrees = Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, (...args) => {
    calls.push([method, ...args])
    return handler(...args)
  }]))
  const tool = createTool({ worktrees, timeline, isRootAgent: (exec) => exec === ROOT })
  return { tool, calls, timeline, async run(args) {
    const result = await tool.execute(args, ROOT)
    assertLosslessJson(result)
    return result
  } }
}

const text = (result) => result.content[0].text

test('管理工具使用宿主定义及参数默认值，不允许以参数选择父会话', () => {
  const registered = []
  const tool = createWorktreeManageTool({ defineTool(definition) {
    registered.push(definition)
    return definition
  } })
  assert.deepEqual(registered, [tool])
  assert.equal(tool.name, 'worktree_manage')
  assert.deepEqual(tool.parameters.action.enum, ['list', 'inspect', 'merge', 'discard', 'prune'])
  assert.equal(tool.parameters.action.required, true)
  assert.equal(tool.parameters.maxDiffChars.default, 12000)
  assert.equal(tool.parameters.maxCommits.default, 20)
  assert.equal(tool.parameters.strategy.default, 'merge')
  assert.equal(tool.parameters.deleteAfterMerge.default, true)
  assert.equal(tool.parameters.parentId, undefined)
  assert.equal(tool.isConcurrencySafe(), false)
  assert.equal(createWorktreeManageTool({ toolName: 'review' }).name, 'review')
})

test('list 默认不含已关闭项，并对返回记录做归属校验', async () => {
  const { run, calls, tool } = fixture()
  const open = await run({ action: 'list', parentId: 'other' })
  assert.deepEqual(open.details, { action: 'list', ok: true, total: 1, worktrees: [TREE] })
  assert.match(text(open), /1 棵工作树.*[\s\S]*wt-1.*ready_for_review/)
  assert.doesNotMatch(text(open), /private|wt-old/)
  assert.deepEqual(tool.output.render({}, open), open.content)
  const all = await run({ action: 'list', includeClosed: true })
  assert.deepEqual(all.details.worktrees.map(({ id }) => id), ['wt-1', 'wt-old'])
  assert.deepEqual(calls, [
    ['list', { parentId: 'root', includeClosed: false }],
    ['list', { parentId: 'root', includeClosed: true }],
  ])
})

test('list 将真实管理器的多阶段绑定和关闭墓碑投影为可枚举字段', async () => {
  const manager = createWorktreeManager()
  const closedIds = ['closed-last', 'closed-first']
  assert.deepEqual(manager.hydrateRecords([
    { ...TREE, childIds: STAGE_IDS, createdAt: 2 },
    { id: 'wt-old', childId: closedIds[0], childIds: closedIds, parentId: TREE.parentId,
      state: 'merged', locked: true, worktreePath: null, mergeCommit: 'combined', createdAt: 1 },
  ]), { restored: 2, skipped: 0 })
  const original = manager.get('wt-old')
  assert.throws(() => assertLosslessJson(original), /childIds: 不可枚举/)
  assert.equal(Object.getOwnPropertyDescriptor(original, 'locked').enumerable, false)

  const { run } = fixture({ list: manager.list })
  const { details: { worktrees } } = await run({ action: 'list', includeClosed: true })
  assert.equal(worktrees.length, 2)
  assert.deepEqual(worktrees[0].childIds, STAGE_IDS)
  assert.equal(worktrees[0].locked, false)
  const { id, state, worktreePath, childIds, locked, mergeCommit } = worktrees[1]
  assert.deepEqual({ id, state, worktreePath, childIds, locked, mergeCommit }, {
    id: 'wt-old', state: 'merged', worktreePath: null, childIds: closedIds, locked: true, mergeCommit: 'combined',
  })
  assert.notEqual(worktrees[1], original)
  assert.notEqual(worktrees[1].childIds, original.childIds)
  assert.equal(Object.getOwnPropertyDescriptor(original, 'childIds').enumerable, false)
})

test('inspect 支持 worktreeId 或 childId，回传 diff、提交及脏状态', async () => {
  const commits = [{ hash: 'commit-a', subject: '交付一' }, { hash: 'commit-b', subject: '交付二' }]
  const worktree = worktreeSnapshot()
  const { run, calls } = fixture({ inspect: async () => ({ ok: true, worktree, dirty: true,
    aheadCount: 2, diffPatch: '+new', diffTruncated: true, commits }) })
  const result = await run({ action: 'inspect', childId: 'child-1' })
  assert.equal(result.details.action, 'inspect')
  assert.equal(result.details.ok, true)
  assert.equal(result.details.dirty, true)
  assert.equal(result.details.aheadCount, 2)
  assert.equal(result.details.diffPatch, '+new')
  assert.deepEqual(result.details.commits, commits)
  assert.deepEqual(result.details.worktree.childIds, STAGE_IDS)
  assert.match(text(result), /wt-1.*分支 isolated\/1.*新增提交 2 个.*未提交改动.*差异已截断/)
  await run({ action: 'inspect', worktreeId: 'wt-1', childId: PRIVATE.childId, maxDiffChars: 64000, maxCommits: 1 })
  assert.deepEqual(calls, [
    ['getByWorktreeOrChild', 'child-1'], ['inspect', 'wt-1', { maxDiffChars: 12000, maxCommits: 20 }],
    ['getByWorktreeOrChild', 'wt-1'], ['inspect', 'wt-1', { maxDiffChars: 64000, maxCommits: 1 }],
  ])
  const missing = await run({ action: 'inspect', childId: 'unknown' })
  assert.deepEqual(missing.details, { action: 'inspect', ok: false, code: 'worktree-not-found' })
})

test('merge 成功传递策略和变更选项，时间线记录合回提交并锁定', async () => {
  const { run, calls, timeline } = fixture()
  const result = await run({ action: 'merge', childId: 'child-1', strategy: 'squash',
    commitMessage: '合回交付', autoStageDirty: true, deleteAfterMerge: false })
  assert.deepEqual(calls, [
    ['getByWorktreeOrChild', 'child-1'],
    ['merge', 'wt-1', { strategy: 'squash', commitMessage: '合回交付', autoStageDirty: true, deleteAfterMerge: false }],
  ])
  assert.equal(result.details.ok, true)
  assert.deepEqual(result.details.worktree.childIds, STAGE_IDS)
  assert.equal(result.details.worktree.locked, true)
  assert.match(text(result), /已合回（提交 combined）/)
  const { state, mergeCommit, locked } = timeline.get('root', 'child-1').worktree
  assert.deepEqual({ state, mergeCommit, locked }, { state: 'merged', mergeCommit: 'combined', locked: true })
})

test('merge 冲突保留文件清单与现场，工作树不锁定', async () => {
  const conflictFiles = ['src/a.js', 'src/b.js']
  const { run, calls, timeline } = fixture({ merge: () => ({
    ok: false, code: 'merge-conflict', worktree: worktreeSnapshot({ state: 'merge_conflict', conflictFiles }),
    conflictFiles, rollbackError: 'Git 回退失败',
  }) })
  const result = await run({ action: 'merge', worktreeId: 'wt-1' })
  assert.deepEqual(calls[1], ['merge', 'wt-1', { strategy: 'merge', autoStageDirty: false, deleteAfterMerge: true }])
  assert.equal(result.details.ok, false)
  assert.deepEqual(result.details.conflictFiles, conflictFiles)
  assert.deepEqual(result.details.worktree.conflictFiles, conflictFiles)
  assert.equal(result.details.worktree.locked, false)
  assert.match(text(result), /冲突（2 个文件），未合回，保留现场/)
  assert.match(text(result), /源仓自动回退失败/)
  const worktree = timeline.get('root', 'child-1').worktree
  assert.equal(worktree.state, 'merge_conflict')
  assert.equal(worktree.locked, false)
  assert.deepEqual(worktree.conflictFiles, conflictFiles)
})

test('merge 脏保护或无提交时不误标为已合回', async () => {
  for (const result of [
    { ok: false, code: 'worktree-dirty', message: '工作树仍有未提交改动。', worktree: worktreeSnapshot() },
    { ok: false, code: 'source-repo-dirty', message: '源仓库有未提交改动。', worktree: worktreeSnapshot() },
    { ok: true, noop: true, merged: false, worktree: worktreeSnapshot() },
  ]) {
    const { run, timeline } = fixture({ merge: () => result })
    const response = await run({ action: 'merge', worktreeId: 'wt-1' })
    assert.equal(response.details.ok, result.ok)
    assert.equal(response.details.code, result.code)
    assert.doesNotMatch(text(response), /已合回/)
    assert.match(text(response), result.noop ? /工作树未关闭/ : /未提交改动/)
    const worktree = timeline.get('root', 'child-1').worktree
    assert.equal(worktree.state, 'ready_for_review')
    assert.equal(worktree.locked, false)
    assert.equal(worktree.mergeCommit, null)
  }
})

test('merge 已合回但清理失败时保留合回证据，不伪装成全成功', async () => {
  const { run, timeline } = fixture({ merge: () => ({ ok: false, code: 'worktree-cleanup-failed',
    merged: true, mergeCommit: 'combined', worktree: { ...TREE, state: 'cleanup_failed' } }) })
  const result = await run({ action: 'merge', worktreeId: 'wt-1' })
  assert.equal(result.details.ok, false)
  assert.match(text(result), /已合回，但清理失败/)
  const worktree = timeline.get('root', 'child-1').worktree
  assert.equal(worktree.state, 'cleanup_failed')
  assert.equal(worktree.mergeCommit, 'combined')
  assert.equal(worktree.locked, false)
})

test('discard 透传 force 并同步锁定，不影响其他子代理', async () => {
  const { run, calls, timeline } = fixture()
  const result = await run({ action: 'discard', childId: TREE.childId, force: true })
  assert.deepEqual(calls[1], ['discard', 'wt-1', { force: true }])
  assert.equal(result.details.ok, true)
  assert.deepEqual(result.details.worktree.childIds, STAGE_IDS)
  assert.equal(result.details.worktree.locked, true)
  assert.match(text(result), /已丢弃/)
  assert.equal(timeline.get('root', TREE.childId).worktree.state, 'discarded')
  assert.equal(timeline.get('root', TREE.childId).worktree.locked, true)
  assert.equal(timeline.get('root', PRIVATE.childId), null)
  await run({ action: 'discard', worktreeId: TREE.id })
  assert.deepEqual(calls[3], ['discard', 'wt-1', { force: false }])
})

test('prune 只取调用会话 cwd，支持预览及执行', async () => {
  const { run, calls } = fixture({ prune: ({ dryRun }) => ({ ok: true, orphans: ['a', 'b'],
    prunedWorktrees: dryRun ? [] : ['a'], prunedBranches: dryRun ? [] : ['b'], errors: [] }) })
  const preview = await run({ action: 'prune', dryRun: true, cwd: '/another-repo' })
  assert.match(text(preview), /清理预览.*2 个孤立项，未执行删除/)
  assert.deepEqual(preview.details.prunedWorktrees, [])
  const actual = await run({ action: 'prune' })
  assert.match(text(actual), /工作树 1 棵，分支 1 个/)
  assert.deepEqual(actual.details.prunedBranches, ['b'])
  assert.deepEqual(calls, [
    ['prune', { repoRoot: '/repo', dryRun: true }], ['prune', { repoRoot: '/repo', dryRun: false }],
  ])
})

for (const [mode, options, dryRun] of [
  ['dryRun: true', { dryRun: true }, true],
  ['dryRun: false', { dryRun: false }, false],
  ['省略 dryRun', {}, false],
]) {
  test(`持久化入口 prune 返回结构化回执（${mode}）`, async () => {
    const events = []
    const { run, calls } = fixture({
      exportRecords() {
        events.push('exportRecords')
        return []
      },
      prune({ repoRoot, dryRun }) {
        events.push('prune')
        return {
          ok: true, repoRoot, dryRun, orphans: ['old'], errors: [],
          prunedWorktrees: dryRun ? [] : ['old'],
          prunedBranches: dryRun ? [] : ['branch-old'],
        }
      },
    }, (dependencies) => createPersistentWorktreeTool({
      ...dependencies,
      assertActive: () => events.push('assertActive'),
      isWakePending: () => assert.fail('prune 无单棵工作树目标'),
      stateStore: {
        putWorktree: () => assert.fail('登记记录没有变化'),
        async flush() { events.push('flush') },
      },
      persist: (write) => write,
    }))
    const result = await run({ action: 'prune', cwd: '/another-repo', ...options })
    assert.deepEqual(result.details, {
      action: 'prune', ok: true, repoRoot: '/repo', dryRun, orphans: ['old'], errors: [],
      prunedWorktrees: dryRun ? [] : ['old'],
      prunedBranches: dryRun ? [] : ['branch-old'],
    })
    assert.match(text(result), dryRun ? /清理预览.*未执行删除/ : /清理完成/)
    assert.deepEqual(calls.filter(([method]) => method !== 'exportRecords'), [
      ['prune', { repoRoot: '/repo', dryRun }],
    ])
    assert.deepEqual(events, dryRun
      ? ['prune']
      : ['assertActive', 'exportRecords', 'prune', 'exportRecords', 'flush'])
  })
}

test('持久化入口 merge 和 discard 仍阻止恢复中的子代理工作树变更', async () => {
  const record = worktreeSnapshot()
  const events = []
  const { run, calls } = fixture({
    getByWorktreeOrChild: () => record,
  }, (dependencies) => createPersistentWorktreeTool({
    ...dependencies,
    assertActive: () => events.push('assertActive'),
    isWakePending(childId) {
      events.push(childId)
      return childId === STAGE_IDS[1]
    },
  }))
  for (const action of ['merge', 'discard']) {
    const { details } = await run({ action, childId: TREE.childId })
    assert.deepEqual(details, {
      action, ok: false, code: 'worktree-active', message: '子代理正在恢复，待本轮结算后再操作工作树。',
    })
  }
  assert.deepEqual(calls, [
    ['getByWorktreeOrChild', TREE.childId], ['getByWorktreeOrChild', TREE.id],
    ['getByWorktreeOrChild', TREE.childId], ['getByWorktreeOrChild', TREE.id],
  ])
  assert.deepEqual(events, ['assertActive', ...STAGE_IDS, 'assertActive', ...STAGE_IDS])
})

test('空列表和检查、合回、丢弃、清理的业务错误均有合法 JSON 回执', async () => {
  const manager = createWorktreeManager()
  manager.hydrateRecords([{ ...TREE, childIds: STAGE_IDS, state: 'active' }])
  const { run } = fixture({
    list: () => [], getByWorktreeOrChild: manager.getByWorktreeOrChild,
    inspect: manager.inspect, merge: manager.merge, discard: manager.discard,
    prune: () => ({ ok: false, code: 'not-git-repo', message: '清理目录不在 Git 工作树内。' }),
  })
  assert.deepEqual((await run({ action: 'list' })).details.worktrees, [])
  for (const [action, code] of [
    ['inspect', 'worktree-invalid-record'], ['merge', 'worktree-active'], ['discard', 'worktree-active'],
  ]) {
    const missing = await run({ action, childId: 'unknown' })
    assert.deepEqual(missing.details, { action, ok: false, code: 'worktree-not-found' })
    const rejected = await run({ action, childId: TREE.childId })
    assert.equal(rejected.details.ok, false)
    assert.equal(rejected.details.code, code)
    assert.deepEqual(rejected.details.worktree.childIds, STAGE_IDS)
  }
  const rejected = await run({ action: 'prune' })
  assert.equal(rejected.details.ok, false)
  assert.equal(rejected.details.code, 'not-git-repo')
  assert.match(text(rejected), /清理失败/)
})

test('回执规范化递归移除非 JSON 元数据并保留数组位置和共享数据', async () => {
  const shared = Object.assign(Object.create(null), { message: '部分孤立项无法清理' })
  const array = [undefined, , Infinity, -0, shared]
  array.extra = '不属于数组元素'
  const entry = {
    path: '/repo/orphan', shared, array,
    optional: undefined, invalid: NaN, special: -Infinity, date: new Date(0),
    fn() {}, big: 1n, symbol: Symbol('值'), [Symbol('键')]: '忽略',
  }
  Object.defineProperty(entry, 'hidden', { value: '忽略' })
  entry.circular = entry
  const { run } = fixture({ prune: () => ({ ok: true, errors: [entry] }) })
  const { details: { errors } } = await run({ action: 'prune' })
  const expected = { message: shared.message }
  assert.deepEqual(errors, [{ path: '/repo/orphan', shared: expected,
    array: [null, null, null, 0, expected], invalid: null, special: null }])
  assert.notEqual(errors[0].shared, shared)
  assert.notEqual(errors[0].shared, errors[0].array[4])
})

test('子代理和身份不完整的调用者不能触碰管理器', async () => {
  const { tool, calls } = fixture()
  await assert.rejects(() => tool.execute({ action: 'list' }, CHILD), /仅根代理可调用 worktree_manage/)
  const anonymous = createWorktreeManageTool({ isRootAgent: () => true })
  await assert.rejects(() => anonymous.execute({ action: 'list' }, {}), /无法识别调用代理的会话 ID/)
  await assert.rejects(() => anonymous.execute({ action: 'prune' }, { agent: { id: 'root' } }), /无法识别当前会话工作目录/)
  assert.deepEqual(calls, [])
})

test('inspect、merge、discard 均拒绝操作其他父代理的记录', async () => {
  const { run, calls } = fixture()
  for (const action of ['inspect', 'merge', 'discard']) {
    await assert.rejects(() => run({ action, childId: PRIVATE.childId }), /不属于当前根代理/)
  }
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['getByWorktreeOrChild', PRIVATE.childId]))
})

test('拒绝缺少定位参数、未知操作或越界参数，且不触碰管理器', async () => {
  const { run, calls } = fixture()
  for (const [args, expected] of [
    [{}, /action 必须/],
    [{ action: 'inspect' }, /需要提供 worktreeId 或 childId/],
    [{ action: 'discard', worktreeId: ' ' }, /worktreeId 必须是非空字符串/],
    [{ action: 'inspect', worktreeId: 'wt-1', maxDiffChars: 999 }, /1000\.\.64000/],
    [{ action: 'inspect', childId: 'child-1', maxCommits: 101 }, /1\.\.100/],
    [{ action: 'inspect', childId: 'child-1', maxCommits: 1.5 }, /1\.\.100/],
    [{ action: 'merge', worktreeId: 'wt-1', strategy: 'rebase' }, /strategy 必须/],
    [{ action: 'merge', worktreeId: 'wt-1', autoStageDirty: 'true' }, /autoStageDirty 必须是布尔值/],
    [{ action: 'list', includeClosed: null }, /includeClosed 必须是布尔值/],
  ]) {
    await assert.rejects(() => run(args), expected)
  }
  assert.deepEqual(calls, [])
})

test('isolation 区分显式选择与默认值，并为常见工作树错误提供中文文案', () => {
  assert.deepEqual(ISOLATION_MODES, ['auto', 'worktree', 'shared'])
  assert.equal(Object.isFrozen(ISOLATION_MODES), true)
  for (const input of [undefined, null, '']) {
    assert.deepEqual(parseIsolation(input), { ok: true, mode: 'auto', explicit: false })
  }
  for (const mode of ISOLATION_MODES) {
    assert.deepEqual(parseIsolation(` ${mode.toUpperCase()} `), { ok: true, mode, explicit: true })
  }
  for (const input of ['physical', ' ', true, 5, []]) {
    assert.deepEqual(parseIsolation(input), { ok: false, code: 'isolation-invalid', message: formatWorktreeError('isolation-invalid') })
  }
  for (const [code, expected] of [
    ['not-git-repo', /不在 Git 仓库/], ['unborn-head', /尚无初始提交/],
    ['worktree-outside-workspace', /超出会话工作区/], ['worktree-create-failed', /无法创建/],
    ['worktree-child-locked', /已回收/],
  ]) assert.match(formatWorktreeError(code, '补充原因'), new RegExp(`${expected.source}.*补充原因`))
})

test('租约按物理路径互斥，不同 Worktree 的相同相对路径或 * 可并行', () => {
  const leases = createWriteLeases({ now: () => 10 })
  const cwd1 = '/repo/.dsh-orchestrator/worktrees/wt-1'
  const cwd2 = '/repo/.dsh-orchestrator/worktrees/wt-10'
  const acquire = (childId, cwd, scope) => leases.acquire({ childId, parentId: 'root', cwd, scope })
  const first = acquire('first', cwd1, ['*'])
  assert.deepEqual(first.lease.entries, [{ kind: 'root', key: cwd1, path: cwd1 }])
  assert.equal(acquire('independent', cwd2, ['*']).ok, true)
  assert.equal(acquire('third', '/another-wt', ['src/app.js']).ok, true)
  assert.equal(acquire('fourth', '/yet-another-wt', ['src/app.js']).ok, true)
  for (const [cwd, scope, physicalPath] of [
    [`${cwd1}/.`, ['*'], cwd1],
    [cwd1, ['src/app.js'], `${cwd1}/src/app.js`],
    [`${cwd1}/src`, ['*'], `${cwd1}/src`],
    ['/repo/.dsh-orchestrator', ['worktrees/'], '/repo/.dsh-orchestrator/worktrees'],
  ]) {
    const refused = acquire('blocked', cwd, scope)
    assert.equal(refused.ok, false)
    const error = leaseFailure(refused)
    assert.equal(error.code, 'write-scope-conflict')
    assert.deepEqual(error.details[0], { path: physicalPath, owner: 'first', label: null })
  }
  assert.equal(acquire('same-file', '/another-wt', ['src/app.js']).ok, false)
})

test('物理 root 支持 realpath 与 Windows 大小写，同时兼容旧式全局 root', () => {
  const tree = normalizeScope(['*'], 'C:/Repo/wt-1').entries[0]
  const alias = normalizeScope(['*'], 'C:/alias', { realpath: () => 'c:/repo/WT-1' }).entries[0]
  const otherDrive = normalizeScope(['*'], 'D:/repo/wt-1').entries[0]
  const adjacent = normalizeScope(['src/a.js'], 'C:/repo/wt-10').entries[0]
  assert.equal(overlaps(tree, alias), true)
  assert.equal(overlaps(tree, otherDrive), false)
  assert.equal(overlaps(tree, adjacent), false)
  assert.equal(overlaps({ kind: 'root', path: '.', key: '.' }, otherDrive), true)
  assert.equal(overlaps(adjacent, { kind: 'root' }), true)
})
