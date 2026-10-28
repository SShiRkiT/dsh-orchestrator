import assert from 'node:assert/strict'
import test from 'node:test'
import { DELEGATE_TOOL, buildActivation, createDelegateTool, languageNote, readRoute } from '../lib/delegate.js'

const cfg = (provider, model, effort = '') => ({
  workerProvider: { get: () => provider },
  workerModel: { get: () => model },
  workerReasoningEffort: { get: () => effort },
})

test('readRoute returns provider and model, and omits an empty effort', () => {
  assert.deepEqual(readRoute(cfg('nexus-deepseek', 'deepseek-v4.1-flash')), {
    provider: 'nexus-deepseek',
    model: 'deepseek-v4.1-flash',
  })
})

test('readRoute carries a named effort and trims whitespace', () => {
  assert.deepEqual(readRoute(cfg(' nexus-claude ', ' claude-opus-5.5 ', ' high ')), {
    provider: 'nexus-claude',
    model: 'claude-opus-5.5',
    reasoningEffort: 'high',
  })
})

test('readRoute refuses an unconfigured route instead of inheriting the parent silently', () => {
  assert.throws(() => readRoute(cfg('', 'm')), /worker route is not configured/)
  assert.throws(() => readRoute(cfg('p', '  ')), /worker route is not configured/)
})

test('buildActivation shapes the spawn request with the route and parent delivery', () => {
  const parent = { id: 'main' }
  const signal = new AbortController().signal
  const route = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  const spec = buildActivation({ args: { description: 'fix parser', prompt: 'do it' }, parent, route, maxDepth: 2, signal })
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'fix parser')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.signal, signal)
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: languageNote('do it') + 'do it' }])
  assert.equal(spec.request.parent, parent)
  assert.deepEqual(spec.request.agentOptions, route)
  assert.equal(spec.request.maxDepth, 2)
  assert.equal('cwd' in spec.request, false)
})

test('buildActivation passes cwd through and leaves out an undefined depth', () => {
  const spec = buildActivation({ args: { description: 'd', prompt: 'p', cwd: 'sub' }, parent: {}, route: {}, maxDepth: undefined })
  assert.equal(spec.request.cwd, 'sub')
  assert.equal('maxDepth' in spec.request, false)
})

test('the tool is concurrency-safe, named delegate, and takes no model parameters', () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config: cfg('p', 'm') })
  assert.equal(tool.name, DELEGATE_TOOL)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(tool.parameters).sort(), ['cwd', 'description', 'prompt'])
  // The host schema dialect has no required keyword, so the tool validates at call time.
  assert.equal('required' in tool.parameters.prompt, false)
})

test('execute rejects a missing prompt or description before touching the route', async () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config: cfg('p', 'm') })
  await assert.rejects(() => tool.execute({ description: 'x' }, { agent: {} }), /non-empty prompt/)
  await assert.rejects(() => tool.execute({ prompt: 'x' }, { agent: {} }), /non-empty description/)
})

test('execute reads the route per call, so a changed route applies to the next delegation', async () => {
  const seen = []
  let route = ['nexus-deepseek', 'deepseek-v4.1-flash']
  const config = {
    workerProvider: { get: () => route[0] },
    workerModel: { get: () => route[1] },
    workerReasoningEffort: { get: () => '' },
  }
  const subagents = {
    resolveMaxDepth: () => 2,
    startActivation: async (spec) => {
      seen.push(spec.request.agentOptions)
      return { childId: 'child-' + seen.length }
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config })
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  const first = await tool.execute({ description: 'a', prompt: 'x' }, exec)
  route = ['nexus-claude', 'claude-opus-5.5']
  await tool.execute({ description: 'b', prompt: 'y' }, exec)
  assert.deepEqual(first, { kind: 'activation', subagentId: 'child-1' })
  assert.equal(seen[0].model, 'deepseek-v4.1-flash')
  assert.equal(seen[1].model, 'claude-opus-5.5')
})

test('execute fails loudly without a calling agent and does not start anything', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm') })
  await assert.rejects(() => tool.execute({ description: 'a', prompt: 'x' }, { signal: new AbortController().signal }), /requires a calling agent/)
  assert.equal(started, false)
})

test('an aborted signal stops execute before a worker is started', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm') })
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => tool.execute({ description: 'a', prompt: 'x' }, { agent: {}, signal: ac.signal }))
  assert.equal(started, false)
})
