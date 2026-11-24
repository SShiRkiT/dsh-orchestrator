import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The host APIs are simulated; tool assembly, lifecycle hooks, leases and Git I/O are real.
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
const importHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { apply, DEFAULT_ALLOWED_TOOLS, INLINE_AUDIT_SOURCE_KIND } = await import('../lib/index.js')
test.after(() => importHook.deregister())

const sharedFile = 'src/shared.txt'
const initialText = 'initial\n'
const rootIgnore = 'ignored.txt\n'
const claim = { writeScope: [sharedFile] }
const route = { provider: 'test', model: 'test' }
const completed = { stopReason: 'completed', output: [{ type: 'text', text: '完成' }] }
const drain = () => new Promise((resolve) => setImmediate(resolve))

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  }).trimEnd()
}

function put(cwd, name, text) {
  const filename = path.join(cwd, name)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, text)
}

const read = (cwd, name) => fs.readFileSync(path.join(cwd, name), 'utf8')
const status = (cwd) => git(cwd, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all')
const head = (cwd) => git(cwd, 'rev-parse', 'HEAD')

function commit(cwd, subject) {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-m', subject)
  return head(cwd)
}

function initialize(cwd) {
  git(cwd, 'init', '--initial-branch=main')
  git(cwd, 'config', 'user.name', 'Phase 2 Integration')
  git(cwd, 'config', 'user.email', 'phase2@example.invalid')
  git(cwd, 'config', 'core.autocrlf', 'false')
  git(cwd, 'config', 'core.hooksPath', '.git/hooks')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  put(cwd, '.gitignore', rootIgnore)
  put(cwd, sharedFile, initialText)
  commit(cwd, 'Initial')
}

function createHost(cwd, { config = {}, runStage } = {}) {
  const hooks = new Map()
  const tools = new Map()
  const disposers = []
  const starts = []
  const audits = []
  const prompts = []
  const notices = []
  const parent = {
    id: 'root', cwd, session: { header: { cwd } }, inbox: { nextTurn: [], nextStep: [] },
    ctx: { tools: { guard: () => () => {} } },
    followup(message) { notices.push(message) },
  }
  const exec = { agent: parent, signal: new AbortController().signal }
  const agents = new Map([[parent.id, parent]])
  const lifecycle = (event, id, runId, extra) => hooks.get(`subagent/${event}`)({
    id, runId, parentSessionId: parent.id, ...extra,
  })
  const start = (id, runId) => lifecycle('start', id, runId)
  const end = (id, runId = `${id}/first`, stopReason = 'completed') => lifecycle('end', id, runId, { stopReason })
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (setup) => disposers.push(setup()),
    on: (event, handler) => hooks.set(event, handler),
    emit(event, data) {
      if (event === 'orchestrator/write-audit') audits.push(data)
    },
    tools: {
      register: (spec) => tools.set(spec.name, spec),
      view: () => ({ knownNames: DEFAULT_ALLOWED_TOOLS }),
      definitions: () => DEFAULT_ALLOWED_TOOLS.map((name) => ({ name })),
    },
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    sessions: { get: (id) => agents.get(id)?.session, flush: async () => true },
    sessionProjections: { stateOf: () => ({ 'next-turn': [], 'next-step': [] }) },
    subagents: {
      resolveMaxDepth: () => 2,
      resolveName: async (_parent, name) => starts.find((row) => row.name === name)?.id ?? name,
      async startActivation(spec) {
        const number = starts.length + 1
        const id = `child-${number}`
        const name = `worker-${number}`
        const childCwd = spec.cwd ?? cwd
        const row = { spec, id, name }
        starts.push(row)
        agents.set(id, { id, cwd: childCwd, options: { subagentDepth: 1 }, session: { log: [], header: { cwd: childCwd } } })
        start(id, `${id}/first`)
        if (spec.delivery !== 'caller') return { childId: id, name }
        const result = Promise.resolve().then(async () => {
          await runStage?.(row)
          end(id)
          return completed
        })
        return { childId: id, result, dispose: async () => {} }
      },
      async prompt(request) {
        prompts.push(request)
        return { messageId: 'queued' }
      },
    },
  }
  apply(ctx, config)
  const execute = (name, args) => tools.get(name).execute(args, exec)
  return {
    cwd, starts, audits, notices, prompts, start, end,
    delegate: (args = claim) => execute('delegate', { ...route, description: '写入任务', prompt: '按作用域写入', ...args }),
    batch: (args) => execute('orchestrate', { ...route, ...args }),
    manage: (action, args = {}) => execute('worktree_manage', { action, ...args }),
    async status(childId) {
      return (await execute('delegate_status', childId ? { childId } : {})).details
    },
    preMessage(target) {
      return hooks.get('tools/pre-execute')(
        { ...exec, name: 'send_message', arguments: { agent: target, message: '继续处理' } },
        async () => ({ kind: 'continue' }),
      )
    },
    sendMessage(target, deliver) {
      return hooks.get('tools/execute')(
        { ...exec, name: 'send_message', arguments: { agent: target, message: '继续处理' } }, deliver,
      )
    },
    settleFrame(childId) {
      const settlement = {
        id: `settled-${childId}`, role: 'user', content: [{ type: 'text', text: `原生结算：${childId}` }],
        source: { kind: 'subagent-settled', senderSessionId: childId },
      }
      const messages = [settlement]
      return hooks.get('agent/pre-step')({ agent: parent, messages, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
    },
    dispose() {
      while (disposers.length) {
        const disposer = disposers.pop()
        if (typeof disposer === 'function') disposer()
      }
    },
  }
}

async function withHost(run, { repository = true, ...options } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phase2-'))
  let host
  try {
    const cwd = fs.realpathSync.native(tempDir)
    if (repository) initialize(cwd)
    host = createHost(cwd, options)
    return await run(host)
  } finally {
    try {
      host?.dispose()
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}

async function assertLocked(host, target, reason = /worktree-child-locked/) {
  const result = await host.preMessage(target)
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /worktree-child-locked/)
  assert.match(result.reason, reason)
}

const lineOf = (response) => response.content[0].text
const entryOf = async (host, childId) => (await host.status(childId)).items[0]
const rowOf = async (host, worktreeId) => (await host.manage('list')).details.worktrees.find(({ id }) => id === worktreeId)

function assertReclaimed(cwd, { path: worktreePath, branch }) {
  assert.equal(fs.existsSync(worktreePath), false)
  assert.equal(git(cwd, 'branch', '--list', branch), '')
}

test('phase 2: default delegate audits, reviews and merges a real isolated checkout', () => withHost(async (h) => {
  const { subagentId, agentName, worktree } = await h.delegate()
  const workerCwd = h.starts[0].spec.cwd
  assert.equal(workerCwd, path.join(h.cwd, '.dsh-orchestrator', 'worktrees', worktree.id))
  assert.equal(workerCwd, worktree.execCwd)
  assert.equal(read(h.cwd, '.gitignore'), rootIgnore)
  assert.equal(status(h.cwd), '')

  put(workerCwd, sharedFile, 'isolated delivery\n')
  const delivered = commit(workerCwd, 'Deliver isolated change')
  h.end(subagentId)
  assert.equal(read(h.cwd, sharedFile), initialText)
  assert.equal(status(h.cwd), '')
  assert.equal(h.audits[0].audit.isolationLevel, 'git-worktree')
  assert.equal(h.audits[0].audit.passed, true)
  assert.equal(h.audits[0].audit.git.commits[0].hash, delivered)
  const frame = await h.settleFrame(subagentId)
  assert.deepEqual(frame.messages.map(({ source }) => source.kind), ['subagent-settled', INLINE_AUDIT_SOURCE_KIND])
  const notice = frame.messages.at(-1).content[0].text
  assert.ok(notice.includes(`【${subagentId}】（${agentName}）`))
  assert.match(notice, /写作用域审计已通过.*git-worktree.*尚未合回主仓.*worktree_manage/)
  assert.deepEqual(h.notices, [], 'the audit does not queue an extra turn')
  assert.equal((await h.status()).counts.worktreePendingReview, 1)

  const list = await h.manage('list')
  assert.deepEqual(list.details.worktrees.map(({ id, state }) => [id, state]), [[worktree.id, 'ready_for_review']])
  const review = await h.manage('inspect', { childId: subagentId })
  assert.equal(review.details.ok, true)
  assert.equal(review.details.commits[0].subject, 'Deliver isolated change')
  assert.match(review.details.diffPatch, /\+isolated delivery/)
  const result = await h.manage('merge', { worktreeId: worktree.id })
  assert.equal(result.details.ok, true, lineOf(result))
  assert.equal(result.details.cleaned, true)
  assert.equal(read(h.cwd, sharedFile), 'isolated delivery\n')
  assert.equal(read(h.cwd, '.gitignore'), rootIgnore)
  assert.equal(status(h.cwd), '')
  assert.equal((await h.status()).counts.worktreePendingReview, 0)
  assertReclaimed(h.cwd, worktree)
  await assertLocked(h, subagentId)
}))

test('phase 2: simultaneous claims overlap only when they share a physical checkout', () => withHost(async (h) => {
  const isolated = await Promise.all([h.delegate(), h.delegate()])
  assert.equal(new Set(isolated.map(({ worktree }) => worktree.path)).size, 2)
  for (const { worktree, writeScope } of isolated) {
    assert.ok(writeScope.leaseId)
    assert.ok(fs.existsSync(worktree.path))
  }
  const sharedClaim = { ...claim, isolation: 'shared' }
  const shared = await Promise.allSettled([h.delegate(sharedClaim), h.delegate(sharedClaim)])
  const started = shared.filter(({ status: outcome }) => outcome === 'fulfilled')
  const blocked = shared.filter(({ status: outcome }) => outcome === 'rejected')
  assert.equal(started.length, 1)
  assert.equal(started[0].value.worktree, undefined)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].reason.code, 'write-scope-conflict')
  // The losing call checks the lease while the winner is still awaiting its host receipt.
  assert.match(blocked[0].reason.details[0].owner, /^pending:root:\d+$/)
  assert.equal(h.starts.length, 3)
}))

test('phase 2: a real merge conflict rolls back the source and preserves the unlocked delivery', () => withHost(async (h) => {
  const first = await h.delegate()
  const second = await h.delegate()
  put(first.worktree.path, sharedFile, 'first worker\n')
  commit(first.worktree.path, 'First edit')
  put(second.worktree.path, sharedFile, 'second worker\n')
  const secondHead = commit(second.worktree.path, 'Conflicting edit')
  h.end(first.subagentId)
  h.end(second.subagentId)
  const merged = await h.manage('merge', { childId: first.subagentId })
  assert.equal(merged.details.ok, true, lineOf(merged))
  const conflict = await h.manage('merge', { childId: second.subagentId })
  assert.equal(conflict.details.ok, false)
  assert.equal(conflict.details.code, 'merge-conflict')
  assert.deepEqual(conflict.details.conflictFiles, [sharedFile])
  assert.equal(conflict.details.worktree.state, 'merge_conflict')
  assert.equal(fs.existsSync(path.join(h.cwd, '.git', 'MERGE_HEAD')), false)
  assert.equal(status(h.cwd), '')
  assert.equal(head(h.cwd), merged.details.mergeCommit)
  assert.equal(read(h.cwd, sharedFile), 'first worker\n')
  assert.equal(head(second.worktree.path), secondHead)
  assert.equal(read(second.worktree.path, sharedFile), 'second worker\n')
  assert.equal((await entryOf(h, second.subagentId)).worktree.locked, false)
  assert.equal((await h.preMessage(h.starts[1].name)).kind, 'continue')
  const discarded = await h.manage('discard', { worktreeId: second.worktree.id, force: true })
  assert.equal(discarded.details.ok, true, lineOf(discarded))
  assertReclaimed(h.cwd, second.worktree)
}))

test('phase 2: send_message blocks reclaimed and externally missing worktrees by ID or name', () => withHost(async (h) => {
  const discarded = await h.delegate()
  h.end(discarded.subagentId)
  assert.equal((await h.manage('discard', { childId: discarded.subagentId, force: true })).details.ok, true)
  assertReclaimed(h.cwd, discarded.worktree)
  for (const target of [discarded.subagentId, h.starts[0].name]) await assertLocked(h, target)

  const missing = await h.delegate()
  const expectedPath = path.join(h.cwd, '.dsh-orchestrator', 'worktrees', missing.worktree.id)
  assert.equal(missing.worktree.path, expectedPath)
  fs.rmSync(expectedPath, { recursive: true, force: true })
  assert.equal((await rowOf(h, missing.worktree.id)).state, 'active')
  for (const target of [missing.subagentId, h.starts[1].name]) {
    await assertLocked(h, target, /执行目录已缺失.*防写入主工作区/)
  }
  assert.equal(status(h.cwd), '')
}))

test('phase 2: orchestrate isolates items, reuses each checkout across stages and locks all reclaimed stages', () => {
  const stages = new Map()
  const runStage = ({ spec, id }) => {
    const [, item, stage] = /item (\d+).*stage (\d+)/.exec(spec.label)
    stages.set(`${item}/${stage}`, { id, cwd: spec.cwd })
    if (stage === '1') {
      put(spec.cwd, sharedFile, `item ${item}: first stage\n`)
      commit(spec.cwd, `Item ${item} stage 1`)
    } else {
      assert.equal(read(spec.cwd, sharedFile), `item ${item}: first stage\n`)
      put(spec.cwd, sharedFile, `item ${item}: second stage\n`)
      commit(spec.cwd, `Item ${item} stage 2`)
    }
  }
  return withHost(async (h) => {
    const result = await h.batch({
      ...claim, items: ['one', 'two'], maxConcurrency: 2,
      stages: [{ name: 'first', prompt: 'write' }, { name: 'second', prompt: 'read and extend' }],
    })
    assert.equal(result.agentsStarted, 4)
    assert.deepEqual(result.errors, [])
    assert.equal(result.audit.isolationLevel, 'git-worktree')
    assert.equal(result.audit.passed, true)
    const [item0, item1] = result.details.worktrees
    assert.deepEqual([item0.itemIndex, item1.itemIndex], [0, 1])
    assert.notEqual(item0.path, item1.path)
    assert.equal(item0.path, stages.get('1/1').cwd)
    assert.equal(item0.path, stages.get('1/2').cwd)
    assert.equal(item1.path, stages.get('2/1').cwd)
    assert.equal(item1.path, stages.get('2/2').cwd)
    assert.equal(h.audits.length, 2)
    for (const item of [item0, item1]) {
      assert.equal(item.audit.git.commits.length, 2)
      assert.equal((await rowOf(h, item.worktreeId)).state, 'ready_for_review')
    }
    const dropped = await h.manage('discard', { worktreeId: item0.worktreeId, force: true })
    assert.equal(dropped.details.ok, true, lineOf(dropped))
    assertReclaimed(h.cwd, item0)
    for (const key of ['1/1', '1/2']) await assertLocked(h, stages.get(key).id)
    for (const key of ['2/1', '2/2']) assert.equal((await h.preMessage(stages.get(key).id)).kind, 'continue')
    assert.equal((await rowOf(h, item1.worktreeId)).state, 'ready_for_review')
    assert.equal(status(h.cwd), '')
  }, { runStage })
})

test('phase 2: auto fallback, forced mode, read-only dispatch and plugin disposal respect isolation boundaries', async () => {
  await withHost(async (h) => {
    const shared = await h.delegate()
    h.end(shared.subagentId)
    assert.equal(shared.worktree, undefined)
    assert.equal(h.audits[0].audit.isolationLevel, 'logical-post-audit')
    await assert.rejects(h.delegate({ ...claim, isolation: 'worktree' }), { code: 'not-git-repo' })
    assert.equal(h.starts.length, 1)
    assert.equal(fs.existsSync(path.join(h.cwd, '.dsh-orchestrator')), false)
  }, { repository: false })

  await withHost(async (h) => {
    const shared = await h.delegate()
    h.end(shared.subagentId)
    assert.equal(shared.worktree, undefined)
    assert.equal(h.audits[0].audit.isolationLevel, 'logical-post-audit')
    assert.equal(fs.existsSync(path.join(h.cwd, '.dsh-orchestrator')), false)
  }, { config: { worktreeIsolationEnabled: false } })

  await withHost(async (h) => {
    const reader = await h.delegate({ readOnly: true })
    h.end(reader.subagentId)
    assert.equal(reader.worktree, undefined)
    assert.equal(h.audits[0].audit.isolationLevel, 'logical-post-audit')
    assert.equal(h.audits[0].audit.readOnly, true)
    await assert.rejects(h.delegate({ readOnly: true, isolation: 'worktree' }), /只读任务.*Worktree/)
    assert.equal(h.starts.length, 1)
    assert.equal(fs.existsSync(path.join(h.cwd, '.dsh-orchestrator')), false)
    const writable = await h.delegate()
    put(writable.worktree.path, sharedFile, 'retained after disposal\n')
    h.end(writable.subagentId)
    assert.equal((await rowOf(h, writable.worktree.id)).state, 'ready_for_review')
    h.dispose()
    assert.equal(read(writable.worktree.path, sharedFile), 'retained after disposal\n')
    assert.equal(read(h.cwd, sharedFile), initialText)
    assert.equal(status(h.cwd), '')
  })
})

for (const mode of ['manual rework', 'automatic retry']) {
  test(`phase 2: ${mode} updates the audit summary in review and timeline`, () => withHost(async (h) => {
    const { subagentId, agentName, worktree } = await h.delegate()
    assert.equal(agentName, h.starts[0].name)
    assert.equal((await entryOf(h, subagentId)).agentName, agentName)
    put(worktree.path, sharedFile, 'first attempt\n')
    commit(worktree.path, 'First attempt')
    const outside = path.join(worktree.path, 'outside.txt')
    put(worktree.path, 'outside.txt', 'not in scope\n')
    h.end(subagentId, `${subagentId}/first`, mode === 'automatic retry' ? 'error' : 'completed')
    await drain()
    assert.equal((await rowOf(h, worktree.id)).state, 'ready_for_review')
    assert.deepEqual((await rowOf(h, worktree.id)).auditSummary, { commits: 1, dirty: true, auditPassed: false })
    const secondRun = `${subagentId}/second`
    if (mode === 'automatic retry') {
      assert.equal(h.prompts.length, 1)
      assert.equal(h.prompts[0].childSessionId, subagentId)
      h.start(subagentId, secondRun)
    } else {
      assert.deepEqual(h.prompts, [])
      assert.equal((await h.preMessage(agentName)).kind, 'continue')
      assert.equal((await entryOf(h, subagentId)).leaseState, 'released')
      await h.sendMessage(agentName, async () => {
        assert.equal((await entryOf(h, subagentId)).leaseState, 'held')
        assert.equal((await h.manage('discard', { childId: subagentId, force: true })).details.code, 'worktree-active')
        h.start(subagentId, secondRun)
        return { isError: false, value: { messageId: 'delivered' } }
      })
    }
    assert.equal((await rowOf(h, worktree.id)).state, 'active')
    assert.equal((await h.manage('merge', { childId: subagentId })).details.code, 'worktree-active')
    fs.unlinkSync(outside)
    put(worktree.path, sharedFile, 'fixed second attempt\n')
    commit(worktree.path, 'Second attempt')
    h.end(subagentId, secondRun)

    const list = await h.manage('list')
    const inspect = await h.manage('inspect', { worktreeId: worktree.id })
    const current = await entryOf(h, subagentId)
    const expected = { commits: 2, dirty: false, auditPassed: true }
    assert.deepEqual(list.details.worktrees[0].auditSummary, expected)
    assert.deepEqual(inspect.details.worktree.auditSummary, expected)
    assert.match(lineOf(list), /最近审计通过（2 个提交）/)
    assert.match(lineOf(inspect), /最近审计通过（2 个提交）/)
    assert.equal(inspect.details.aheadCount, 2)
    assert.equal(current.attemptSeq, 2)
    assert.equal(current.runId, secondRun)
    assert.equal(current.auditState, 'passed')
    assert.equal(current.worktree.state, 'ready_for_review')
    assert.equal(current.worktree.commits, 2)
    assert.equal(current.worktree.dirty, false)
    assert.deepEqual(h.audits.map(({ audit }) => audit.passed), [false, true])
    assert.notEqual(h.audits[0].audit.baselineId, h.audits[1].audit.baselineId)
    assert.equal(current.baselineId, h.audits[1].audit.baselineId)
  }))
}

test('phase 2: completed squash with a retained branch guides cleanup and cannot merge twice', () => withHost(async (h) => {
  const { subagentId, worktree } = await h.delegate()
  put(worktree.path, sharedFile, 'squashed result\n')
  commit(worktree.path, 'Worktree change')
  h.end(subagentId)
  const merged = await h.manage('merge', { childId: subagentId, strategy: 'squash' })
  assert.equal(merged.details.merged, true)
  assert.equal(merged.details.cleaned, false)
  assert.equal(merged.details.worktree.state, 'cleanup_failed')
  assert.match(lineOf(merged), /已合回，但清理失败[\s\S]*discard.*force: true/)
  assert.equal(read(h.cwd, sharedFile), 'squashed result\n')
  const duplicate = await h.manage('merge', { childId: subagentId })
  assert.equal(duplicate.details.code, 'worktree-already-closed')
  assert.match(lineOf(duplicate), /已合回.*不要重复合并.*discard.*force: true/)
  assert.equal(head(h.cwd), merged.details.mergeCommit)
  await assertLocked(h, subagentId)
  const discard = await h.manage('discard', { childId: subagentId, force: true })
  assert.equal(discard.details.ok, true, lineOf(discard))
  assert.match(lineOf(discard), /已清理，交付物此前已合回/)
  assertReclaimed(h.cwd, worktree)
  assert.equal(head(h.cwd), merged.details.mergeCommit)
  assert.equal(status(h.cwd), '')
}))
