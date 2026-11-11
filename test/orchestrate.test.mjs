import assert from 'node:assert/strict'
import test from 'node:test'
import { LIMITS, ORCHESTRATE_TOOL } from '../lib/api.js'
import {
  buildStagePrompt,
  collectText,
  createOrchestrateTool,
  parseOrchestrateArgs,
  readStageOutput,
  runOrchestration,
} from '../lib/orchestrate.js'
import { createWriteLeases } from '../lib/write-lease.js'
import { WRITE_SCOPE_TOOL_CODES } from '../lib/write-scope-tool.js'

const ROUTE = { provider: 'nexus-deepseek', model: 'deepseek-v4.1-flash' }
const cfg = (provider = ROUTE.provider, model = ROUTE.model, effort = '') => ({
  workerProvider: { get: () => provider },
  workerModel: { get: () => model },
  workerReasoningEffort: { get: () => effort },
})
const exec = (signal = new AbortController().signal) => ({ agent: { id: 'main' }, signal })
const tool = (
  config = cfg(),
  subagents = { resolveMaxDepth: () => 3, startActivation: async () => ({}) },
  leases,
) => createOrchestrateTool({ defineTool: (definition) => definition, subagents, config, leases })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate, timeoutMs = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await delay(5)
  }
}

/** Parse the item/stage numbers out of the activation label the tool builds. */
const itemOf = (spec) => Number(/item (\d+)\//.exec(spec.label)[1]) - 1
const stageOf = (spec) => Number(/stage (\d+)\//.exec(spec.label)[1]) - 1

/**
 * A subagent service whose handler runs one worker. `result` is a promise, as in
 * the host contract, so the tool's own maxConcurrency is what bounds live workers.
 */
function trackedSubagents(handler) {
  const calls = []
  const disposed = []
  let active = 0
  let maxActive = 0
  const subagents = {
    resolveMaxDepth: () => 3,
    async startActivation(spec) {
      const index = calls.length
      calls.push(spec)
      const result = (async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          return await handler(spec, index)
        } finally {
          active -= 1
        }
      })()
      return {
        childId: `child-${index + 1}`,
        result,
        dispose: async () => {
          disposed.push(index)
        },
      }
    },
  }
  return { subagents, calls, disposed, maxActive: () => maxActive }
}

const textResult = (text) => ({ output: [{ type: 'text', text }], stopReason: 'completed' })

test('the tool is named orchestrate, takes optional route overrides and defaults maxConcurrency to 4', () => {
  const definition = tool()
  assert.equal(definition.name, ORCHESTRATE_TOOL)
  assert.equal(definition.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(definition.parameters).sort(), [
    'cwd',
    'items',
    'maxConcurrency',
    'model',
    'provider',
    'reasoning_effort',
    'stages',
    'writeScope',
  ])
  for (const key of ['provider', 'model', 'reasoning_effort']) {
    assert.equal('required' in definition.parameters[key], false)
  }
  for (const key of ['provider', 'model']) {
    assert.match(definition.parameters[key].description, /仅当用户显式点名/)
  }
  assert.match(definition.parameters.reasoning_effort.description, /仅当用户点名时才设置/)
  // The batch-level declaration is optional and has no default, exactly like `delegate`:
  // omitting it means "not declared", which must stay distinguishable from `[]`.
  assert.equal('required' in definition.parameters.writeScope, false)
  assert.equal('default' in definition.parameters.writeScope, false)
  assert.equal(definition.parameters.writeScope.type, 'array')
  assert.equal(definition.parameters.writeScope.items.type, 'string')
  assert.match(definition.parameters.writeScope.description, /write-scope-conflict/)
  assert.deepEqual(parseOrchestrateArgs({ items: [1], stages: [{ name: 's', prompt: 'p' }] }), {
    cwd: undefined,
    items: [1],
    stages: [{ name: 's', prompt: 'p' }],
    maxConcurrency: 4,
  })
  // The key exists only when the caller declared it, so an undeclared plan keeps the
  // exact shape every existing caller and test compares against.
  assert.equal(
    'writeScope' in parseOrchestrateArgs({ items: [1], stages: [{ name: 's', prompt: 'p' }] }),
    false,
  )
  assert.deepEqual(
    parseOrchestrateArgs({ items: [1], stages: [{ name: 's', prompt: 'p' }], writeScope: ['src/a.js'] })
      .writeScope,
    ['src/a.js'],
  )
  assert.equal(parseOrchestrateArgs({ cwd: '  work  ', items: [1], stages: [{ name: 's', prompt: 'p' }] }).cwd, 'work')
  assert.equal(LIMITS.items.max, 64)
  assert.equal(LIMITS.stages.max, 8)
})

test('every worker uses the configured route, caller delivery and the stage outputSchema', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  const { subagents, calls } = trackedSubagents(async () => textResult('done'))
  const definition = tool(cfg(), subagents)
  await definition.execute(
    {
      cwd: 'work',
      items: [{ id: 1 }, { id: 2 }],
      stages: [
        { name: 'first', prompt: 'do it' },
        { name: 'second', prompt: 'check it', schema },
      ],
    },
    exec(),
  )
  assert.equal(calls.length, 4)
  for (const spec of calls) {
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.delivery, 'caller')
    assert.deepEqual(spec.request.agentOptions, ROUTE)
    assert.deepEqual(spec.request.parent, { id: 'main' })
    assert.equal(spec.request.cwd, 'work')
    assert.equal(spec.request.maxDepth, 3)
    assert.equal(JSON.stringify(spec.request).includes('"provider":"nexus-deepseek"'), true)
    if (stageOf(spec) === 1) assert.deepEqual(spec.request.outputSchema, schema)
    else assert.equal('outputSchema' in spec.request, false)
  }
})

test('an unconfigured worker route fails before any worker starts', async () => {
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  await assert.rejects(
    () => tool(cfg('', 'm'), subagents).execute({ items: [1], stages: [{ name: 's', prompt: 'p' }] }, exec()),
    /worker route is not configured/,
  )
  assert.equal(calls.length, 0)
})

test('invalid arguments and stage schemas fail globally before any worker starts', async () => {
  const stage = { name: 's', prompt: 'p' }
  const cases = [
    [{ stages: [stage] }, /"items" must be a JSON array/],
    [{ items: [], stages: [stage] }, /must contain 1\.\.64 entries/],
    [{ items: Array.from({ length: 65 }, (_, i) => i), stages: [stage] }, /must contain 1\.\.64 entries/],
    [{ items: [() => 1], stages: [stage] }, /item 1 is not a lossless JSON value/],
    [{ items: [1], stages: [] }, /must contain 1\.\.8 stages/],
    [{ items: [1], stages: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, prompt: 'p' })) }, /must contain 1\.\.8 stages/],
    [{ items: [1], stages: [{ name: '', prompt: 'p' }] }, /stage 1 requires a non-empty "name"/],
    [{ items: [1], stages: [{ name: 's' }] }, /stage 1 requires a non-empty "prompt"/],
    [{ items: [1], stages: [stage], maxConcurrency: 0 }, /maxConcurrency.*1\.\.16/],
    [{ items: [1], stages: [stage], maxConcurrency: 17 }, /maxConcurrency.*1\.\.16/],
    [{ items: [1], stages: [stage], maxConcurrency: 2.5 }, /maxConcurrency.*integer/],
    [{ items: [1], stages: [stage], cwd: 7 }, /"cwd" must be a string/],
    [{ items: [1], stages: [stage], cwd: '' }, /"cwd" must be a non-empty string/],
    [{ items: [1], stages: [stage], cwd: '   ' }, /"cwd" must be a non-empty string/],
    [{ items: [1], stages: [stage], cwd: '\t\n' }, /"cwd" must be a non-empty string/],
    [{ items: [1], stages: [stage], extra: true }, /arguments has unknown field "extra"/],
    [{ items: [1], stages: [{ ...stage, provider: 'nexus-deepseek' }] }, /stage 1 has unknown field "provider"/],
    [{ items: [1], stages: [{ ...stage, model: 'deepseek-v4.1-flash' }] }, /stage 1 has unknown field "model"/],
    // A batch is one write unit: per-stage scope is not part of the contract, and silently
    // accepting it would promise an isolation the first version does not provide.
    [{ items: [1], stages: [{ ...stage, writeScope: ['src/a.js'] }] }, /stage 1 has unknown field "writeScope"/],
    [{ items: [1], stages: [{ ...stage, schema: { type: 'array' } }] }, /unsupported stage schema.*must be "object"/],
    [{ items: [1], stages: [{ ...stage, schema: { type: 'object', nope: true } }] }, /nope is not a supported keyword/],
  ]
  for (const [args, pattern] of cases) {
    const { subagents, calls } = trackedSubagents(async () => textResult('x'))
    await assert.rejects(() => tool(cfg(), subagents).execute(args, exec()), pattern)
    assert.equal(calls.length, 0, JSON.stringify(args))
  }
})

test('24 items fan out within maxConcurrency and keep result order', async () => {
  const { subagents, calls, maxActive } = trackedSubagents(async (spec) => {
    await delay(10)
    return textResult(`item-${itemOf(spec) + 1}`)
  })
  const items = Array.from({ length: 24 }, (_, index) => ({ n: index }))
  const result = await tool(cfg(), subagents).execute(
    { items, stages: [{ name: 'one', prompt: 'p' }], maxConcurrency: 3 },
    exec(),
  )
  assert.equal(calls.length, 24)
  assert.equal(result.kind, 'orchestration')
  assert.equal(result.agentsStarted, 24)
  assert.equal(result.errors.length, 0)
  assert.equal(result.results.length, 24)
  result.results.forEach((entry, index) => {
    assert.equal(entry.index, index)
    assert.equal(entry.output, `item-${index + 1}`)
    assert.equal(entry.stopReason, 'completed')
  })
  assert.equal(maxActive() <= 3, true, `max active ${maxActive()}`)
  assert.equal(maxActive() >= 2, true, 'workers should overlap')
})

test('a pipeline has no global barrier and feeds the previous stage output forward', async () => {
  const events = []
  let releaseSlow
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve
  })
  const { subagents, calls } = trackedSubagents(async (spec) => {
    const item = itemOf(spec)
    const stage = stageOf(spec)
    if (item === 0 && stage === 0) {
      events.push('slow-start')
      await slowGate
      events.push('slow-end')
      return textResult('slow')
    }
    if (item === 1 && stage === 1) {
      events.push('fast-stage2')
      releaseSlow()
      return textResult('fast')
    }
    return textResult(`i${item}s${stage}`)
  })

  const running = tool(cfg(), subagents).execute(
    {
      items: [{ id: 'a' }, { id: 'b' }],
      stages: [
        { name: 'extract', prompt: 'Extract.' },
        { name: 'verify', prompt: 'Verify.' },
      ],
      maxConcurrency: 4,
    },
    exec(),
  )

  let barrier = false
  try {
    await waitUntil(() => events.includes('fast-stage2'))
  } catch {
    barrier = true
  } finally {
    releaseSlow()
  }
  const result = await running
  assert.equal(barrier, false, 'item 2 stage 2 must start before item 1 stage 1 finishes')
  assert.equal(events.indexOf('fast-stage2') < events.indexOf('slow-end'), true)

  const stage2 = calls.find((spec) => itemOf(spec) === 1 && stageOf(spec) === 1)
  assert.match(stage2.request.prompt[0].text, /Verify\./)
  assert.match(stage2.request.prompt[0].text, /"id":"b"/)
  assert.match(stage2.request.prompt[0].text, /上一阶段 "extract" 输出 \(JSON\):/)
  assert.match(stage2.request.prompt[0].text, /"i1s0"/)
  assert.equal(result.results[1].output, 'fast')
})

test('a structured result is used as-is and validated', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const { subagents, calls } = trackedSubagents(async () => ({
    output: [],
    stopReason: 'completed',
    structured: { answer: 42 },
  }))
  const result = await tool(cfg(), subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.deepEqual(result.results[0].output, { answer: 42 })
  assert.equal(calls[0].request.outputSchema, schema)
})

test('text that is strictly JSON falls back when there is no structured result', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const { subagents } = trackedSubagents(async () => textResult('{"answer":7}'))
  const result = await tool(cfg(), subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.deepEqual(result.results[0].output, { answer: 7 })
})

test('a run marked error with no structured result still recovers strict JSON text', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const { subagents } = trackedSubagents(async () => ({
    output: [{ type: 'text', text: '{"ans' }, { type: 'text', text: 'wer":7}' }],
    stopReason: 'error',
  }))
  const result = await tool(cfg(), subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.equal(result.errors.length, 0)
  assert.deepEqual(result.results[0].output, { answer: 7 })
  assert.equal(typeof result.results[0].output, 'object')
})

test('an error run with unusable text still fails that item and never echoes the text', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const cases = [
    ['ANSWER: 7', /not strictly JSON/],
    ['{"answer":', /not strictly JSON/],
    ['```json\n{"answer":7}\n```', /not strictly JSON/],
    ['{"answer":"seven"}', /text result does not match the stage schema/],
    ['{"nope":1}', /text result does not match the stage schema/],
  ]
  for (const [text, pattern] of cases) {
    const { subagents } = trackedSubagents(async () => ({ output: [{ type: 'text', text }], stopReason: 'error' }))
    const result = await tool(cfg(), subagents).execute(
      { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
      exec(),
    )
    assert.equal(result.results[0], null, text)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].message, pattern)
    assert.equal(result.errors[0].message.includes(text), false, 'the worker text must not leak into the error')
  }
})

test('aborted, max-tokens and refusal never recover JSON text, even with a schema', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  for (const stopReason of ['aborted', 'max-tokens', 'refusal', 'timeout', undefined]) {
    for (const structured of [false, true]) {
      const { subagents } = trackedSubagents(async () => ({
        output: [{ type: 'text', text: '{"answer":7}' }],
        stopReason,
        ...(structured ? { structured: { answer: 7 } } : {}),
      }))
      const result = await tool(cfg(), subagents).execute(
        { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
        exec(),
      )
      assert.equal(result.results[0], null, `${stopReason} structured=${structured}`)
      assert.match(result.errors[0].message, /stopped with reason/)
    }
  }
})

test('an invalid structured result fails even when the text would parse, whatever the stop reason', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  for (const stopReason of ['completed', 'error']) {
    const { subagents } = trackedSubagents(async () => ({
      output: [{ type: 'text', text: '{"answer":7}' }],
      stopReason,
      structured: { answer: 'bad' },
    }))
    const result = await tool(cfg(), subagents).execute(
      { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
      exec(),
    )
    assert.equal(result.results[0], null, stopReason)
    assert.match(result.errors[0].message, /structured result does not match the stage schema/)
  }
})

test('a structured result is authoritative even when the text would also parse', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const { subagents } = trackedSubagents(async () => ({
    output: [{ type: 'text', text: '{"answer":7}' }],
    stopReason: 'completed',
    structured: { answer: 'bad' },
  }))
  const result = await tool(cfg(), subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.equal(result.results[0], null)
  assert.match(result.errors[0].message, /structured result does not match the stage schema/)
})

test('a non-JSON fallback or a schema mismatch fails that item', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const notJson = trackedSubagents(async () => textResult('not json'))
  let result = await tool(cfg(), notJson.subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.equal(result.results[0], null)
  assert.match(result.errors[0].message, /not strictly JSON/)

  const mismatch = trackedSubagents(async () => textResult('{"answer":"x"}'))
  result = await tool(cfg(), mismatch.subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.equal(result.results[0], null)
  assert.match(result.errors[0].message, /text result does not match the stage schema/)
})

test('one failing item is isolated, later stages for it are skipped and order is kept', async () => {
  const { subagents, calls } = trackedSubagents(async (spec) => {
    if (itemOf(spec) === 1 && stageOf(spec) === 1) return { output: [], stopReason: 'error' }
    return textResult(`i${itemOf(spec)}s${stageOf(spec)}`)
  })
  const result = await tool(cfg(), subagents).execute(
    {
      items: ['a', 'b', 'c'],
      stages: [
        { name: 'first', prompt: 'p1' },
        { name: 'second', prompt: 'p2' },
        { name: 'third', prompt: 'p3' },
      ],
      maxConcurrency: 4,
    },
    exec(),
  )
  assert.equal(result.results[0].output, 'i0s2')
  assert.equal(result.results[1], null)
  assert.equal(result.results[2].output, 'i2s2')
  assert.deepEqual(result.errors, [
    { index: 1, stage: 'second', message: 'worker stopped with reason "error" before finishing the stage' },
  ])
  // Item 1 stops after the failing stage: 3 first + 3 second + 2 third calls.
  assert.equal(calls.length, 8)
  assert.equal(calls.filter((spec) => itemOf(spec) === 1).length, 2)
  assert.equal(result.agentsStarted, 8)
})

test('a worker that fails to start is isolated like any other item failure', async () => {
  let starts = 0
  const subagents = {
    resolveMaxDepth: () => 3,
    async startActivation() {
      const index = starts
      starts += 1
      if (index === 1) throw new Error('spawn failed')
      return { childId: `child-${index}`, result: Promise.resolve(textResult('ok')), dispose: async () => {} }
    },
  }
  const result = await tool(cfg(), subagents).execute(
    { items: ['a', 'b', 'c'], stages: [{ name: 's', prompt: 'p' }], maxConcurrency: 1 },
    exec(),
  )
  assert.equal(result.results[0].output, 'ok')
  assert.equal(result.results[1], null)
  assert.equal(result.results[2].output, 'ok')
  assert.deepEqual(result.errors, [{ index: 1, stage: 's', message: 'spawn failed' }])
  assert.equal(result.agentsStarted, 2)
})

test('aborting stops new dispatch, clears running workers and rejects the call', async () => {
  const ac = new AbortController()
  const reason = new Error('stop now')
  const calls = []
  const disposed = []
  const subagents = {
    resolveMaxDepth: () => 3,
    async startActivation(spec) {
      const index = calls.length
      calls.push(spec)
      let settle
      const result = new Promise((resolve) => {
        settle = resolve
      })
      return {
        childId: `child-${index}`,
        result,
        dispose: async () => {
          disposed.push(index)
          settle({ output: [], stopReason: 'aborted' })
        },
      }
    },
  }
  const running = tool(cfg(), subagents).execute(
    { items: ['a', 'b', 'c'], stages: [{ name: 's', prompt: 'p' }], maxConcurrency: 1 },
    { agent: { id: 'main' }, signal: ac.signal },
  )
  await waitUntil(() => calls.length === 1)
  ac.abort(reason)
  await assert.rejects(() => running, (error) => error === reason)
  assert.equal(calls.length, 1, 'queued items must not start after the abort')
  assert.deepEqual(disposed, [0], 'the running worker must be disposed')
})

test('aborting rejects immediately while startActivation is still pending', async () => {
  const ac = new AbortController()
  const reason = new Error('stop now')
  const calls = []
  let releaseStart
  const subagents = {
    resolveMaxDepth: () => 3,
    startActivation(spec) {
      calls.push(spec)
      return new Promise((resolve) => {
        releaseStart = () => resolve({ childId: 'late', result: new Promise(() => {}), dispose: async () => {} })
      })
    },
  }
  const running = tool(cfg(), subagents).execute(
    { items: ['a'], stages: [{ name: 's', prompt: 'p' }] },
    { agent: { id: 'main' }, signal: ac.signal },
  )
  await waitUntil(() => calls.length === 1)
  ac.abort(reason)
  try {
    const outcome = await Promise.race([
      running.then(() => 'resolved', (error) => error),
      delay(200).then(() => 'still-pending'),
    ])
    assert.equal(outcome, reason, 'abort must not wait for a hanging startActivation')
  } finally {
    releaseStart()
  }
  assert.equal(calls.length, 1)
})

test('a handle that resolves after the abort is disposed and never dispatched', async () => {
  const ac = new AbortController()
  const calls = []
  const disposed = []
  let releaseStart
  const subagents = {
    resolveMaxDepth: () => 3,
    startActivation(spec) {
      calls.push(spec)
      return new Promise((resolve) => {
        releaseStart = () =>
          resolve({
            childId: 'late',
            // A late handle must not leave this rejection unhandled.
            result: Promise.reject(new Error('late worker failure')),
            dispose: async () => {
              disposed.push('late')
            },
          })
      })
    },
  }
  const running = tool(cfg(), subagents).execute(
    { items: ['a'], stages: [{ name: 's', prompt: 'p' }] },
    { agent: { id: 'main' }, signal: ac.signal },
  )
  await waitUntil(() => calls.length === 1)
  ac.abort(new Error('stop'))
  await assert.rejects(() => running, /stop/)
  assert.deepEqual(disposed, [], 'a start that is still pending has nothing to dispose')
  releaseStart()
  await waitUntil(() => disposed.length === 1)
  await delay(20)
  assert.equal(calls.length, 1, 'a late handle must not dispatch a new worker')
  assert.deepEqual(disposed, ['late'], 'the late handle is disposed exactly once')
})

test('a worker stopping with reason "aborted" is an item failure, not a call abort', async () => {
  const { subagents } = trackedSubagents(async (spec) =>
    itemOf(spec) === 0 ? { output: [], stopReason: 'aborted' } : textResult('fine'),
  )
  const result = await tool(cfg(), subagents).execute(
    { items: ['a', 'b'], stages: [{ name: 's', prompt: 'p' }] },
    exec(),
  )
  assert.equal(result.results[0], null)
  assert.equal(result.results[1].output, 'fine')
  assert.match(result.errors[0].message, /stopped with reason "aborted"/)
})

test('an oversized serialized result is an explicit error, never truncated', async () => {
  const { subagents } = trackedSubagents(async () => textResult('x'.repeat(LIMITS.serializedResultChars + 10)))
  await assert.rejects(
    () => tool(cfg(), subagents).execute({ items: [1], stages: [{ name: 's', prompt: 'p' }] }, exec()),
    /character limit/,
  )
})

test('execute refuses a missing agent or signal before starting a worker', async () => {
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  await assert.rejects(
    () => tool(cfg(), subagents).execute({ items: [1], stages: [{ name: 's', prompt: 'p' }] }, { signal: new AbortController().signal }),
    /requires a calling agent/,
  )
  await assert.rejects(
    () => tool(cfg(), subagents).execute({ items: [1], stages: [{ name: 's', prompt: 'p' }] }, { agent: {} }),
    /requires a cancellation signal/,
  )
  assert.equal(calls.length, 0)
})

test('stage prompts carry the instruction, the original item and the previous output', () => {
  const first = buildStagePrompt({
    stage: { name: 'extract', prompt: 'Extract facts.' },
    stageIndex: 0,
    stageCount: 2,
    item: { id: 'a', nested: [1, 2] },
    itemIndex: 0,
    itemCount: 2,
  })
  assert.match(first, /^Extract facts\./)
  assert.match(first, /阶段 "extract"（1\/2），条目 1\/2。/)
  assert.match(first, /原始条目 \(JSON\):\n\{"id":"a","nested":\[1,2\]\}/)
  assert.match(first, /这是第一个阶段/)
  assert.equal(first.includes('上一阶段'), false)

  const second = buildStagePrompt({
    stage: { name: 'verify', prompt: 'Verify facts.' },
    stageIndex: 1,
    stageCount: 2,
    item: { id: 'a' },
    itemIndex: 0,
    itemCount: 2,
    previous: { stageName: 'extract', output: { facts: ['x'] } },
  })
  assert.match(second, /上一阶段 "extract" 输出 \(JSON\):\n\{"facts":\["x"\]\}/)
  assert.match(second, /在此基础上继续/)

  // A schema stage asks for structured_output first and JSON-only text otherwise.
  assert.equal(first.includes('structured_output'), false)
  assert.equal(second.includes('structured_output'), false)
  const structured = buildStagePrompt({
    stage: { name: 'classify', prompt: 'Classify.', schema: { type: 'object' } },
    stageIndex: 0,
    stageCount: 1,
    item: { id: 'a' },
    itemIndex: 0,
    itemCount: 1,
  })
  assert.match(structured, /优先调用一次 structured_output 工具/)
  assert.match(structured, /只输出符合阶段 schema 的 JSON 对象/)
  assert.match(structured, /不要解释、不要 Markdown、不要代码块。$/)
})

test('readStageOutput handles text, a missing result, an empty result and text parts', () => {
  assert.equal(readStageOutput({}, { output: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], stopReason: 'completed' }), 'ab')
  assert.equal(collectText('plain'), 'plain')
  assert.equal(collectText([{ type: 'text', text: 'x' }, { type: 'image' }]), 'x')
  assert.throws(() => readStageOutput({}, undefined), /no result/)
  assert.throws(() => readStageOutput({}, { output: [], stopReason: 'error' }), /stopped with reason "error"/)
})

test('runOrchestration can be driven directly with a plan', async () => {
  const { subagents } = trackedSubagents(async () => textResult('direct'))
  const result = await runOrchestration({
    plan: { cwd: undefined, items: [1], stages: [{ name: 's', prompt: 'p' }], maxConcurrency: 1 },
    parent: { id: 'main' },
    route: ROUTE,
    maxDepth: 2,
    subagents,
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, {
    kind: 'orchestration',
    agentsStarted: 1,
    results: [{ index: 0, output: 'direct', stopReason: 'completed' }],
    errors: [],
  })
})

test('an explicit provider and model apply to every worker of the call and skip the configured route', async () => {
  // An empty configured route would throw if it were read, so the override must short-circuit it.
  const { subagents, calls } = trackedSubagents(async () => textResult('done'))
  const result = await tool(cfg('', ''), subagents).execute(
    {
      provider: 'nexus-claude',
      model: 'claude-opus-5.5',
      items: [{ id: 1 }, { id: 2 }],
      stages: [{ name: 'one', prompt: 'p' }],
    },
    exec(),
  )
  assert.equal(calls.length, 2)
  for (const spec of calls) {
    assert.deepEqual(spec.request.agentOptions, { provider: 'nexus-claude', model: 'claude-opus-5.5' })
  }
  assert.equal(result.agentsStarted, 2)
  assert.equal(result.errors.length, 0)
})

test('provider and model must be given together, and no worker starts', async () => {
  for (const args of [
    { provider: 'nexus-claude' },
    { model: 'claude-opus-5.5' },
    { provider: 'nexus-claude', model: '  ' },
    { reasoning_effort: 'high' },
  ]) {
    const { subagents, calls } = trackedSubagents(async () => textResult('x'))
    await assert.rejects(
      () =>
        tool(cfg('nexus-deepseek', 'deepseek-v4.1-flash'), subagents).execute(
          { items: [1], stages: [{ name: 's', prompt: 'p' }], ...args },
          exec(),
        ),
      /"provider" and "model" must be given together/,
    )
    assert.equal(calls.length, 0, JSON.stringify(args))
  }
})

test('a non-string override field is refused instead of coerced', async () => {
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  await assert.rejects(
    () =>
      tool(cfg(), subagents).execute(
        { items: [1], stages: [{ name: 's', prompt: 'p' }], provider: 7, model: 'm' },
        exec(),
      ),
    /"provider" must be a string/,
  )
  assert.equal(calls.length, 0)
})

test('reasoning_effort passes through with the override for every worker', async () => {
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  await tool(cfg('', ''), subagents).execute(
    {
      provider: 'nexus-claude',
      model: 'claude-opus-5.5',
      reasoning_effort: 'high',
      items: [1],
      stages: [{ name: 's', prompt: 'p' }],
    },
    exec(),
  )
  assert.deepEqual(calls[0].request.agentOptions, {
    provider: 'nexus-claude',
    model: 'claude-opus-5.5',
    reasoningEffort: 'high',
  })
})

test('the description is a compact pipeline brief and does not repeat the main-agent rule', () => {
  // The rule and the whitelist are rendered by `delegate` only; this text points at them
  // and then describes the fan-out, so a main agent reads the long rule once.
  const definition = createOrchestrateTool({
    defineTool: (d) => d,
    subagents: {},
    config: cfg(),
    allowedTools: ['delegate', 'orchestrate', 'todo_write'],
  })
  assert.equal(definition.description.includes('主代理规则：主代理只负责规划'), false)
  assert.equal(definition.description.includes('主代理可用工具'), false)
  assert.match(definition.description, /^主代理规则同 delegate/)
  assert.match(definition.description, /按 item 派发子代理/)
  assert.match(definition.description, /只有一个 stage 时即批量扇出/)
  assert.match(definition.description, /不存在全局阶段屏障/)
  assert.match(definition.description, /阶段指令、原始 item、上一阶段输出会一并给出/)
  assert.match(definition.description, /所有子代理统一走配置的 worker 路由/)
  assert.match(definition.description, /其输出是校验过的 JSON 对象/)
  assert.match(definition.description, /置为 null 并记入 errors/)
  assert.match(definition.description, /maxConcurrency 限制同时运行的子代理数/)
  assert.match(definition.description, /可并发安全调用/)
  // The route parameters carry the same one-line condition, where a model would be typed.
  for (const param of ['provider', 'model']) {
    const description = definition.parameters[param].description
    assert.match(description, /仅当用户显式点名/, param)
    assert.match(description, /仅限本次派发，禁止复用历史轮次或摘要中的模型/, param)
    assert.match(description, /严禁自行选择模型/, param)
  }
  assert.match(definition.parameters.reasoning_effort.description, /仅当用户点名时才设置/)
  assert.equal(definition.description.includes('takes no provider or model parameters'), false)
})

test('the description has no worker variant and does not follow the live whitelist', () => {
  const bare = createOrchestrateTool({ defineTool: (x) => x, subagents: {}, config: cfg() })
  const listed = createOrchestrateTool({
    defineTool: (x) => x,
    subagents: {},
    config: cfg(),
    allowedTools: ['delegate', 'orchestrate'],
  })
  assert.equal(bare.description, listed.description)
  assert.match(bare.description, /按 item 派发子代理/)
  assert.equal(bare.parameters.items.required, true)
  assert.deepEqual(Object.keys(bare.parameters).sort(), [
    'cwd',
    'items',
    'maxConcurrency',
    'model',
    'provider',
    'reasoning_effort',
    'stages',
    'writeScope',
  ])
})

test('buildStagePrompt appends the batch scope only when one was declared', () => {
  const base = {
    stage: { name: 's', prompt: 'p' },
    stageIndex: 0,
    stageCount: 1,
    item: { a: 1 },
    itemIndex: 0,
    itemCount: 1,
  }
  const undeclared = buildStagePrompt(base)
  // Byte-identical when nothing was declared: an omitted scope must not add a paragraph,
  // a blank line or a trailing separator.
  assert.equal(buildStagePrompt({ ...base, writeScope: undefined }), undeclared)
  assert.equal(buildStagePrompt({ ...base, writeScope: [] }), undeclared)
  assert.equal(undeclared.includes('写作用域'), false)
  const declared = buildStagePrompt({ ...base, writeScope: ['C:/repo/src/a.js'] })
  assert.equal(declared.startsWith(undeclared), true, 'the constraint is appended, never interleaved')
  assert.match(declared, /本批次的写作用域/)
  assert.match(declared, /C:\/repo\/src\/a\.js/)
  assert.match(declared, /声明而非授权/)
})

test('a declared batch holds one lease from before the first worker until the last settles', async () => {
  const leases = createWriteLeases()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const seen = []
  const { subagents, calls } = trackedSubagents(async () => {
    seen.push(leases.size)
    await gate
    return textResult('done')
  })
  const running = tool(cfg(), subagents, leases).execute(
    {
      cwd: 'C:/repo',
      writeScope: ['src/a.js'],
      items: [1, 2],
      stages: [{ name: 's', prompt: 'p' }],
      maxConcurrency: 2,
    },
    exec(),
  )

  await waitUntil(() => calls.length === 2)
  assert.equal(leases.size, 1, 'the whole batch holds exactly one lease')
  const [lease] = leases.list()
  assert.equal(lease.scope[0], 'C:/repo/src/a.js')
  assert.equal(lease.childId.startsWith('batch-'), true, 'the owner is the aggregate batch id')
  assert.deepEqual(seen, [1, 1], 'both workers run under the batch lease')
  assert.equal(leases.size, 1, 'one item finishing never releases the batch')

  release()
  const result = await running
  assert.equal(result.agentsStarted, 2)
  assert.equal(leases.size, 0, 'settling the batch released the lease')
})

test('two overlapping batches: the second is refused and starts no worker', async () => {
  const leases = createWriteLeases()
  let releaseFirst
  const gate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const first = trackedSubagents(async () => {
    await gate
    return textResult('first')
  })
  const second = trackedSubagents(async () => textResult('second'))
  const claim = {
    cwd: 'C:/repo',
    writeScope: ['src/a.js'],
    items: [1],
    stages: [{ name: 's', prompt: 'p' }],
  }

  const running = tool(cfg(), first.subagents, leases).execute(claim, exec())
  await waitUntil(() => first.calls.length === 1)

  await assert.rejects(
    () => tool(cfg(), second.subagents, leases).execute(claim, exec()),
    (error) => {
      assert.equal(error.code, WRITE_SCOPE_TOOL_CODES.conflict)
      assert.match(error.message, /写作用域冲突/)
      assert.deepEqual(
        error.details.map(({ path, owner }) => [path, owner.startsWith('batch-')]),
        [['C:/repo/src/a.js', true]],
      )
      assert.equal('label' in error.details[0], true, 'label is present even when unknown')
      assert.equal(error.details[0].label, null)
      return true
    },
  )
  assert.equal(second.calls.length, 0, 'the refused batch started no worker')

  releaseFirst()
  const result = await running
  assert.equal(result.agentsStarted, 1)
  assert.equal(leases.size, 0)
})

test('an unusable declaration is refused before a lease exists or a worker starts', async () => {
  const leases = createWriteLeases()
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  const definition = tool(cfg(), subagents, leases)
  const stages = [{ name: 's', prompt: 'p' }]
  const cases = [
    [[], 'C:/repo', WRITE_SCOPE_TOOL_CODES.invalid],
    [['ok.js', 42], 'C:/repo', WRITE_SCOPE_TOOL_CODES.invalid],
    [{ path: 'src/a.js' }, 'C:/repo', WRITE_SCOPE_TOOL_CODES.invalid],
    // A relative declaration with no `cwd` to resolve against is refused, not guessed.
    [['src/a.js'], undefined, WRITE_SCOPE_TOOL_CODES.cwdMissing],
  ]
  for (const [writeScope, cwd, code] of cases) {
    await assert.rejects(
      () => definition.execute({ cwd, writeScope, items: [1], stages }, exec()),
      (error) => error?.code === code,
      JSON.stringify(writeScope),
    )
  }
  assert.equal(leases.size, 0)
  assert.equal(calls.length, 0)
})

test('an aborted batch still releases its lease', async () => {
  const leases = createWriteLeases()
  const controller = new AbortController()
  const { subagents, calls } = trackedSubagents(async () => new Promise(() => {}))
  const running = tool(cfg(), subagents, leases).execute(
    { cwd: 'C:/repo', writeScope: ['src/a.js'], items: [1], stages: [{ name: 's', prompt: 'p' }] },
    exec(controller.signal),
  )
  await waitUntil(() => calls.length === 1)
  assert.equal(leases.size, 1)

  controller.abort(new Error('user cancelled'))
  await assert.rejects(() => running, /user cancelled/)
  assert.equal(leases.size, 0, 'abort must not leak the batch lease')
})

test('the declared scope reaches the worker prompt but never the result payload', async () => {
  const leases = createWriteLeases()
  const { subagents, calls } = trackedSubagents(async () => textResult('done'))
  const result = await tool(cfg(), subagents, leases).execute(
    {
      cwd: 'C:/repo',
      writeScope: ['src/a.js', 'src/b/'],
      items: [{ id: 'a' }],
      stages: [{ name: 's', prompt: 'p' }],
    },
    exec(),
  )

  const prompt = calls[0].request.prompt[0].text
  assert.match(prompt, /本批次的写作用域/)
  assert.match(prompt, /C:\/repo\/src\/a\.js/)
  assert.match(prompt, /C:\/repo\/src\/b/, 'a directory claim is named as its normalized path')
  assert.match(prompt, /"id":"a"/, 'the item still reaches the worker unchanged')

  // §6.7.2: the declaration is dispatch metadata, not part of the result channel.
  assert.deepEqual(Object.keys(result).sort(), ['agentsStarted', 'errors', 'kind', 'results'])
  assert.equal(JSON.stringify(result).includes('writeScope'), false)
  assert.equal(JSON.stringify(result).includes('src/a.js'), false)
  for (const entry of result.results) {
    assert.deepEqual(Object.keys(entry).sort(), ['index', 'output', 'stopReason'])
  }
})

test('an undeclared batch keeps the old prompt, the old payload and registers no lease', async () => {
  const leases = createWriteLeases()
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  const result = await tool(cfg(), subagents, leases).execute(
    { items: [1, 2], stages: [{ name: 's', prompt: 'p' }] },
    exec(),
  )
  assert.equal(leases.size, 0, 'an undeclared batch claims nothing')
  assert.equal(calls[0].request.prompt[0].text.includes('写作用域'), false)
  assert.deepEqual(result, {
    kind: 'orchestration',
    agentsStarted: 2,
    results: [
      { index: 0, output: 'x', stopReason: 'completed' },
      { index: 1, output: 'x', stopReason: 'completed' },
    ],
    errors: [],
  })
})
