import assert from 'node:assert/strict'
import test from 'node:test'
import { WRITE_SCOPE_TOOL_CODES, createDelegateTool } from '../lib/delegate.js'
import { createWriteLeases } from '../lib/write-lease.js'

/**
 * The seam that matters: `delegate` and the lease table are real, only the host is a fake.
 * These tests are the stage-1 acceptance cases of docs/zh/03-issue-0001-write-scope.md:
 * a conflict is refused before `startActivation`, disjoint scopes still run, and a failed
 * dispatch cannot leave a reservation behind. Release on a live child is covered by
 * test/index.test.mjs, where the real `subagent/end` and `agent/disposed` handlers run.
 */

const config = {
  workerProvider: { get: () => 'nexus-deepseek' },
  workerModel: { get: () => 'deepseek-v4.1-flash' },
  workerReasoningEffort: { get: () => '' },
}

const exec = () => ({ agent: { id: 'main-1' }, signal: new AbortController().signal })

/** A delegate tool whose host records every started child by id. */
function makeTool({ leases, failStart = false } = {}) {
  const started = []
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation() {
      if (failStart) throw new Error('the host refused to start the child')
      const childId = `child-${started.length + 1}`
      started.push(childId)
      return { childId }
    },
  }
  const tool = createDelegateTool({
    defineTool: (definition) => definition,
    subagents,
    config,
    leases,
  })
  return { tool, started }
}

const claim = (writeScope) => ({
  description: 'edit one file',
  prompt: 'edit src/a.js',
  cwd: 'C:/repo',
  writeScope,
})

/** The conflict is a value with the tool-level code, never the internal lease code. */
const isConflict = (error) => error?.code === WRITE_SCOPE_TOOL_CODES.conflict

test('two concurrent delegates with overlapping scopes: the second is refused before activation', async () => {
  const leases = createWriteLeases()
  const { tool, started } = makeTool({ leases })

  const [first, second] = await Promise.allSettled([
    tool.execute(claim(['src/a.js']), exec()),
    tool.execute(claim(['src/a.js']), exec()),
  ])

  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.equal(isConflict(second.reason), true)
  assert.match(second.reason.message, /写作用域冲突/)
  assert.equal(started.length, 1, 'the loser never reached the host')
  assert.equal(first.value.subagentId, 'child-1')
  assert.deepEqual(first.value.writeScope.scope, ['C:/repo/src/a.js'])
  // The reservation was rebound to the child the host actually created.
  assert.equal(leases.list()[0].childId, 'child-1')
})

test('a directory claim overlaps a file inside it, and Windows case is folded', async () => {
  const leases = createWriteLeases()
  const { tool, started } = makeTool({ leases })

  await tool.execute(claim(['src/']), exec())
  await assert.rejects(() => tool.execute(claim(['src/a.js']), exec()), isConflict)
  await assert.rejects(() => tool.execute(claim(['SRC/A.JS']), exec()), isConflict)
  assert.equal(started.length, 1)
})

test('disjoint scopes both start and both leases are registered', async () => {
  const leases = createWriteLeases()
  const { tool, started } = makeTool({ leases })

  const first = await tool.execute(claim(['src/a.js']), exec())
  const second = await tool.execute(claim(['src/b.js']), exec())
  assert.equal(first.subagentId, 'child-1')
  assert.equal(second.subagentId, 'child-2')
  assert.equal(started.length, 2)
  assert.equal(leases.size, 2)
})

test('releasing the child makes the same scope claimable again', async () => {
  const leases = createWriteLeases()
  const { tool } = makeTool({ leases })

  const first = await tool.execute(claim(['src/a.js']), exec())
  assert.equal(leases.releaseByChild(first.subagentId).released, 1)
  const next = await tool.execute(claim(['src/a.js']), exec())
  assert.equal(next.subagentId, 'child-2')
})

test('a dispatch that fails after the claim releases the reservation in finally', async () => {
  const leases = createWriteLeases()
  const { tool } = makeTool({ leases, failStart: true })

  await assert.rejects(() => tool.execute(claim(['src/a.js']), exec()), /refused to start/)
  assert.equal(leases.size, 0, 'a failed dispatch must not leak a reservation')
})

test('an invalid declaration is refused before a lease exists or a worker starts', async () => {
  const leases = createWriteLeases()
  const { tool, started } = makeTool({ leases })

  for (const writeScope of [[], ['ok.js', 42], { path: 'src/a.js' }]) {
    await assert.rejects(
      () => tool.execute(claim(writeScope), exec()),
      (error) => error?.code === WRITE_SCOPE_TOOL_CODES.invalid,
      JSON.stringify(writeScope),
    )
  }
  assert.equal(leases.size, 0)
  assert.equal(started.length, 0)
})

test('a relative scope without an inheritable cwd is refused instead of guessed', async () => {
  const leases = createWriteLeases()
  const { tool, started } = makeTool({ leases })

  await assert.rejects(
    () => tool.execute({ description: 'edit', prompt: 'edit src/a.js', writeScope: ['src/a.js'] }, exec()),
    (error) => error?.code === WRITE_SCOPE_TOOL_CODES.cwdMissing,
  )
  assert.equal(leases.size, 0)
  assert.equal(started.length, 0)
})

test('omitting writeScope keeps the old dispatch path and registers no lease', async () => {
  const leases = createWriteLeases()
  const { tool } = makeTool({ leases })

  const value = await tool.execute({ description: 'edit', prompt: 'p', cwd: 'C:/repo' }, exec())
  assert.deepEqual(value, { kind: 'activation', subagentId: 'child-1' })
  assert.equal(leases.size, 0)
})
