import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRetry,
  isMissingClosingMessage,
  MAX_RETRIES,
  retryFailedNotice,
  retryPromptText,
  RETRY_SOURCE_KIND,
  RETRY_WINDOW_MS,
  unavailableNotice,
} from '../lib/retry.js'

/** A policy wired to recorders, with an injectable clock. */
function harness({ windowMs = RETRY_WINDOW_MS, maxRetries = MAX_RETRIES, maxRecords, deliver, wake, logger } = {}) {
  const clock = { now: 0 }
  const prompts = []
  const notices = []
  const warnings = []
  const retry = createRetry({
    deliverPrompt:
      deliver ??
      (async (parentId, childId, text) => {
        prompts.push({ parentId, childId, text })
      }),
    wakeParent:
      wake ??
      (async (parentId, text, childIds) => {
        notices.push({ parentId, text, childIds })
      }),
    logger: logger ?? { warn: (message) => warnings.push(message) },
    now: () => clock.now,
    windowMs,
    ...(maxRecords === undefined ? {} : { maxRecords }),
  })
  return { retry, clock, prompts, notices, warnings }
}

/** The settlement a child that died before writing anything produces. */
const SILENT_FAILURE = { stopReason: 'error', output: [] }

test('the retry budget is the documented one', () => {
  assert.equal(RETRY_WINDOW_MS, 120000)
  assert.equal(MAX_RETRIES, 2)
  assert.equal(RETRY_SOURCE_KIND, 'orchestrator-retry')
})

test('only an errored child that left no text is a silent failure', () => {
  assert.equal(isMissingClosingMessage(SILENT_FAILURE), true)
  // The lifecycle event carries the same output under its own name.
  assert.equal(isMissingClosingMessage({ stopReason: 'error' }), true)
  assert.equal(isMissingClosingMessage({ stopReason: 'error', lastAssistantMessage: [] }), true)
  // A closing message reached the parent, so a retry would duplicate the work.
  assert.equal(isMissingClosingMessage({ stopReason: 'error', output: [{ type: 'text', text: 'done' }] }), false)
  assert.equal(isMissingClosingMessage({ stopReason: 'error', output: [{ type: 'text', text: '' }] }), true)
  // A child that completed, was stopped, or ran out of room is not this failure.
  assert.equal(isMissingClosingMessage({ stopReason: 'completed', output: [] }), false)
  assert.equal(isMissingClosingMessage({ stopReason: 'aborted', output: [] }), false)
  assert.equal(isMissingClosingMessage({ stopReason: 'max-tokens', output: [] }), false)
  assert.equal(isMissingClosingMessage(undefined), false)
  assert.equal(isMissingClosingMessage(null), false)
})

test('an untracked child is never retried', async () => {
  const { retry, prompts } = harness()
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'untracked')
  assert.equal(prompts.length, 0)
})

test('a child that finished normally releases its record without a retry', async () => {
  const { retry, prompts, notices } = harness()
  assert.equal(retry.track('child-1', { parentId: 'parent-1', label: 'a task' }), true)
  assert.equal(retry.has('child-1'), true)
  assert.equal(await retry.settle('child-1', { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), 'settled')
  assert.equal(retry.has('child-1'), false)
  assert.equal(prompts.length, 0)
  assert.equal(notices.length, 0)
})

test('a silent failure is retried once, on the same child, with its own id in the prompt', async () => {
  const { retry, prompts } = harness()
  retry.track('child-1', { parentId: 'parent-1', label: 'a task' })
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].parentId, 'parent-1')
  assert.equal(prompts[0].childId, 'child-1')
  assert.match(prompts[0].text, /插件自动重试（第 1 次）/)
  assert.ok(prompts[0].text.includes('"child-1"'))
  assert.doesNotMatch(prompts[0].text, /用 send_message 把结论发给父代理/)
  assert.match(prompts[0].text, /主代理会自动接收你的收尾消息，无需额外调用 send_message 汇报/)
  // The record survives, so the next settlement is still actionable.
  assert.equal(retry.has('child-1'), true)
})

test('two fast failures exhaust the budget and the parent is asked, not retried again', async () => {
  const { retry, prompts, notices } = harness()
  retry.track('child-1', { parentId: 'parent-1', label: 'a task' })
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'unavailable')
  assert.equal(prompts.length, 2)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].parentId, 'parent-1')
  assert.deepEqual(notices[0].childIds, ['child-1'])
  assert.match(notices[0].text, /子代理 child-1/)
  assert.match(notices[0].text, /2 分钟内连续 3 次快速断联/)
  assert.ok(notices[0].text.includes('A) 派生一个新的子代理重做，还是 B) 更换子代理模型后重试'))
  // The budget is spent: a fourth settlement does nothing at all.
  assert.equal(retry.has('child-1'), false)
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'untracked')
})

test('a run longer than the window resets the streak and earns fresh retries', async () => {
  const { retry, clock, prompts, notices } = harness()
  retry.track('child-1', { parentId: 'parent-1' })
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  // The child then works for longer than the window before it dies again: the streak
  // restarts, so this failure is the first of a new one and buys a fresh pair of retries.
  clock.now = RETRY_WINDOW_MS + 1
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  assert.match(prompts[1].text, /第 1 次/)
  // Two more fast failures inside the new window are still allowed.
  clock.now = RETRY_WINDOW_MS + 1000
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  assert.match(prompts[2].text, /第 2 次/)
  clock.now = RETRY_WINDOW_MS + 2000
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'unavailable')
  assert.equal(prompts.length, 3)
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /3 次快速断联/)
})

test('a duplicated settlement event is ignored', async () => {
  const { retry, prompts } = harness()
  retry.track('child-1', { parentId: 'parent-1' })
  assert.equal(await retry.settle('child-1', SILENT_FAILURE, 'run-1'), 'retry')
  assert.equal(await retry.settle('child-1', SILENT_FAILURE, 'run-1'), 'duplicate')
  assert.equal(prompts.length, 1)
})

test('a retry prompt that cannot be delivered wakes the parent with the reason', async () => {
  const { retry, notices, warnings } = harness({
    deliver: async () => {
      throw new Error('the host does not expose dsh.subagent.deliverPrompt')
    },
  })
  retry.track('child-1', { parentId: 'parent-1' })
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry-failed')
  assert.equal(retry.has('child-1'), false)
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /无法把重试提示送到它：the host does not expose dsh.subagent.deliverPrompt/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^orchestrator: retry: cannot wake subagent child-1: /)
})

test('a host without the prompt entry is reported, never thrown', async () => {
  const { retry, notices } = harness({ deliver: null })
  const bare = createRetry({ wakeParent: async (parentId, text, childIds) => notices.push({ parentId, text, childIds }) })
  assert.equal(bare.track('child-1', { parentId: 'parent-1' }), true)
  assert.equal(await bare.settle('child-1', SILENT_FAILURE), 'retry-failed')
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /宿主没有提供投递子代理提示的通道/)
  // The recorder harness is unaffected by the bare policy.
  assert.equal(retry.size, 0)
})

test('a parent that cannot be woken is not an exception', async () => {
  const { retry } = harness({
    wake: async () => {
      throw new Error('the main agent parent-1 is not live')
    },
  })
  retry.track('child-1', { parentId: 'parent-1' })
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'unavailable')
})

test('a missing wake adapter still settles the decision', async () => {
  const retry = createRetry({ deliverPrompt: async () => {} })
  retry.track('child-1', { parentId: 'parent-1' })
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry')
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'unavailable')
})

test('a logger that throws cannot change a decision', async () => {
  const retry = createRetry({
    deliverPrompt: async () => {
      throw new Error('nope')
    },
    logger: {
      warn: () => {
        throw new Error('the logger itself is broken')
      },
    },
  })
  retry.track('child-1', { parentId: 'parent-1' })
  assert.equal(await retry.settle('child-1', SILENT_FAILURE), 'retry-failed')
})

test('tracking needs both ids, and the memory of children is bounded', () => {
  const { retry } = harness({ maxRecords: 4 })
  assert.equal(retry.track('child-1', {}), false)
  assert.equal(retry.track('', { parentId: 'parent-1' }), false)
  assert.equal(retry.track(undefined, { parentId: 'parent-1' }), false)
  for (let index = 0; index < 6; index += 1) {
    assert.equal(retry.track('child-' + String(index), { parentId: 'parent-1' }), true)
  }
  assert.equal(retry.size, 4)
  // The oldest records were evicted, so their settlements are no longer actionable.
  assert.equal(retry.has('child-0'), false)
  assert.equal(retry.has('child-5'), true)
  retry.forget('child-5')
  assert.equal(retry.has('child-5'), false)
})

test('the notices say what the main agent must ask the user', () => {
  assert.match(unavailableNotice('child-1', 3, RETRY_WINDOW_MS), /插件已停止自动重试，判定子代理模型可能不可用/)
  assert.match(unavailableNotice('child-1', 3, RETRY_WINDOW_MS), /请告知用户/)
  assert.match(unavailableNotice('child-1', 3, 30000), /1 分钟内连续 3 次/)
  assert.match(retryFailedNotice('child-1', 'boom'), /请告知用户/)
  assert.match(retryPromptText('child-1', 2), /第 2 次/)
})
