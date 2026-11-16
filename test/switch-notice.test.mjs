/**
 * The deferred dispatch-switch notice: a panel write is recorded, never delivered at the
 * moment it happens, and handed to the agent at the start of its next turn.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SWITCH_SOURCE_KIND, createSwitchNotices, switchNoticeText } from '../lib/switch-notice.js'

/** A switch the test drives by hand. */
function switchOf(initial) {
  let value = initial
  return { read: () => value, set: (next) => { value = next } }
}

test('the first observation is a baseline, not a change', () => {
  const sw = switchOf(false)
  const notices = createSwitchNotices({ readEnabled: sw.read })
  notices.observe('a')
  assert.equal(notices.hasPending('a'), false)
  assert.equal(notices.take('a'), undefined)
})

test('a flip after the baseline is recorded and handed over once', () => {
  const sw = switchOf(true)
  const notices = createSwitchNotices({ readEnabled: sw.read })
  notices.observe('a')
  sw.set(false)
  notices.observe('a')
  assert.equal(notices.hasPending('a'), true)

  const notice = notices.take('a')
  assert.equal(notice.enabled, false)
  assert.equal(notice.text, switchNoticeText(false))
  // Consumed on read: a later turn must not repeat it.
  assert.equal(notices.take('a'), undefined)
})

test('a round trip leaves no notice behind', () => {
  const sw = switchOf(true)
  const notices = createSwitchNotices({ readEnabled: sw.read })
  notices.observe('a')
  sw.set(false)
  notices.observe('a')
  sw.set(true)
  notices.observe('a')
  assert.equal(notices.hasPending('a'), false)
  assert.equal(notices.take('a'), undefined)
})

test('three flips before the next turn yield one notice describing the final state', () => {
  const sw = switchOf(true)
  const notices = createSwitchNotices({ readEnabled: sw.read })
  notices.observe('a')
  for (const next of [false, true, false]) {
    sw.set(next)
    notices.observe('a')
  }
  const notice = notices.take('a')
  assert.equal(notice.enabled, false)
})

test('agents are tracked independently', () => {
  const sw = switchOf(true)
  const notices = createSwitchNotices({ readEnabled: sw.read })
  notices.observe('a')
  notices.observe('b')
  sw.set(false)
  notices.observe('a')
  notices.observe('b')
  assert.equal(notices.take('a').enabled, false)
  assert.equal(notices.take('b').enabled, false)
})

test('an agent created after the flip gets no notice for it', () => {
  const sw = switchOf(true)
  const notices = createSwitchNotices({ readEnabled: sw.read })
  notices.observe('a')
  sw.set(false)
  notices.observe('a')
  // A brand-new agent starts with the current state as its baseline.
  notices.observe('b')
  assert.equal(notices.hasPending('b'), false)
})

test('forget drops both the baseline and a pending notice', () => {
  const sw = switchOf(true)
  const notices = createSwitchNotices({ readEnabled: sw.read })
  notices.observe('a')
  sw.set(false)
  notices.observe('a')
  notices.forget('a')
  assert.equal(notices.hasPending('a'), false)
  // A re-created agent re-baselines instead of inheriting the old record.
  notices.observe('a')
  assert.equal(notices.hasPending('a'), false)
})

test('an unreadable switch is reported and records nothing', () => {
  const warnings = []
  const notices = createSwitchNotices({
    readEnabled: () => {
      throw new Error('boom')
    },
    logger: { warn: (message) => warnings.push(message) },
  })
  notices.observe('a')
  assert.equal(notices.hasPending('a'), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /cannot read the switch/)
})

test('a logger failure cannot escape observe', () => {
  const notices = createSwitchNotices({
    readEnabled: () => {
      throw new Error('boom')
    },
    logger: {
      warn: () => {
        throw new Error('logger down')
      },
    },
  })
  assert.doesNotThrow(() => notices.observe('a'))
})

test('a missing or empty agent id is ignored', () => {
  const notices = createSwitchNotices({ readEnabled: () => true })
  assert.doesNotThrow(() => notices.observe(undefined))
  assert.doesNotThrow(() => notices.observe(''))
  assert.equal(notices.take(undefined), undefined)
  assert.equal(notices.take(''), undefined)
})

test('the notice names the tools that changed hands', () => {
  const on = switchNoticeText(true)
  assert.match(on, /开启/)
  assert.match(on, /delegate/)
  assert.match(on, /orchestrate/)

  const off = switchNoticeText(false)
  assert.match(off, /关闭/)
  assert.match(off, /read/)
  assert.match(off, /write/)
  assert.match(off, /不要再调用 delegate/)
})

test('the source kind is stable and distinct from supervision and retry', () => {
  assert.equal(SWITCH_SOURCE_KIND, 'orchestrator-switch')
})
