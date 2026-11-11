import assert from 'node:assert/strict'
import test from 'node:test'
import { WRITE_SCOPE_TOOL_CODES, createDelegateTool } from '../lib/delegate.js'
import { createOrchestrateTool } from '../lib/orchestrate.js'
import { createWriteLeases } from '../lib/write-lease.js'

/**
 * The seam that matters: the two tools and the lease table are real, only the host is a
 * fake. These tests are the acceptance cases of
 * docs/zh/03-issue-0001-write-scope.md: stage 1 covers `delegate` alone, stage 2 adds the
 * batch (`orchestrate`). Two tools only exclude each other because the plugin injects the
 * *same* table into both, which is why the cross-tool cases live here.
 */

const config = {
  workerProvider: { get: () => 'nexus-deepseek' },
  workerModel: { get: () => 'deepseek-v4.1-flash' },
  workerReasoningEffort: { get: () => '' },
}

const exec = () => ({ agent: { id: 'main-1' }, signal: new AbortController().signal })

const waitFor = async (predicate, timeoutMs = 1500) => {
  const begun = Date.now()
  while (!predicate()) {
    if (Date.now() - begun > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

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

/** An orchestrate tool whose workers settle immediately unless a gate holds them. */
function makeOrchestrator({ leases, gate } = {}) {
  const started = []
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      const index = started.length
      started.push(spec)
      if (gate !== undefined) await gate
      return {
        childId: `batch-child-${index + 1}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: `ok-${index}` }],
          stopReason: 'completed',
        }),
        dispose: async () => {},
      }
    },
  }
  const tool = createOrchestrateTool({
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

const batch = (writeScope, items = [1]) => ({
  cwd: 'C:/repo',
  writeScope,
  items,
  stages: [{ name: 's', prompt: 'p' }],
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

test('a lease held by delegate refuses an overlapping orchestrate batch', async () => {
  const leases = createWriteLeases()
  const delegate = makeTool({ leases })
  const first = await delegate.tool.execute(claim(['src/a.js']), exec())
  assert.equal(first.subagentId, 'child-1')

  const { tool: orchestrate, started } = makeOrchestrator({ leases })
  const refused = await orchestrate.execute(batch(['src/a.js']), exec()).then(
    () => undefined,
    (error) => error,
  )
  assert.equal(isConflict(refused), true)
  // The refusal is a pre-dispatch decision: the whole batch is rejected, no item runs.
  assert.equal(started.length, 0, 'no worker of the refused batch started')
  assert.equal(leases.size, 1, 'the refused batch left the delegate lease untouched')

  // Settlement frees the path for the batch, which releases its own lease on finishing.
  leases.releaseByChild(first.subagentId)
  const result = await orchestrate.execute(batch(['src/a.js']), exec())
  assert.equal(result.agentsStarted, 1)
  assert.equal(leases.size, 0, 'the batch released its lease when it settled')
})

test('a lease held by an orchestrate batch refuses an overlapping delegate', async () => {
  const leases = createWriteLeases()
  let releaseBatch
  const gate = new Promise((resolve) => {
    releaseBatch = resolve
  })
  const { tool: orchestrate, started } = makeOrchestrator({ leases, gate })
  const running = orchestrate.execute(batch(['src/']), exec())
  await waitFor(() => started.length === 1)
  assert.equal(leases.list()[0].scope[0], 'C:/repo/src')

  const delegate = makeTool({ leases })
  const refused = await delegate.tool.execute(claim(['src/a.js']), exec()).then(
    () => undefined,
    (error) => error,
  )
  assert.equal(isConflict(refused), true)
  assert.equal(delegate.started.length, 0, 'the refused delegate never reached the host')

  releaseBatch()
  const result = await running
  assert.equal(result.agentsStarted, 1)
  assert.equal(leases.size, 0)
  const after = await delegate.tool.execute(claim(['src/a.js']), exec())
  assert.equal(after.subagentId, 'child-1', 'the path is claimable once the batch settles')
})

test('a batch result never carries the declaration, even while another lease is live', async () => {
  const leases = createWriteLeases()
  const delegate = makeTool({ leases })
  const held = await delegate.tool.execute(claim(['src/z.js']), exec())

  const { tool: orchestrate } = makeOrchestrator({ leases })
  const result = await orchestrate.execute(batch(['src/a.js'], [{ id: 1 }]), exec())
  assert.deepEqual(Object.keys(result).sort(), ['agentsStarted', 'errors', 'kind', 'results'])
  assert.deepEqual(result.results, [{ index: 0, output: 'ok-0', stopReason: 'completed' }])
  // `writeScope` stays dispatch metadata: it is neither an item, a result nor an error.
  assert.equal(JSON.stringify(result).includes('writeScope'), false)
  assert.equal(JSON.stringify(result).includes('src/a.js'), false)
  assert.equal(leases.size, 1, 'the delegate lease outlives the batch')

  leases.releaseByChild(held.subagentId)
  assert.equal(leases.size, 0)
})

test('an undeclared batch neither claims a lease nor is blocked by another writer', async () => {
  const leases = createWriteLeases()
  const delegate = makeTool({ leases })
  const held = await delegate.tool.execute(claim(['src/a.js']), exec())

  const { tool: orchestrate } = makeOrchestrator({ leases })
  const result = await orchestrate.execute(
    { cwd: 'C:/repo', items: [1], stages: [{ name: 's', prompt: 'p' }] },
    exec(),
  )
  // Compatibility promise of §6.7.1: an omitted declaration is "not declared", so the
  // batch keeps running exactly as it did before this feature existed.
  assert.equal(result.agentsStarted, 1)
  assert.equal(leases.size, 1, 'the undeclared batch registered nothing')
  leases.releaseByChild(held.subagentId)
})
