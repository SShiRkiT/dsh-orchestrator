import assert from 'node:assert/strict'
import test from 'node:test'
import { DELEGATE_TOOL, denyGuard, installGate, mergeDenied, restrictEach } from '../lib/gate.js'

const HIDDEN = ['edit', 'write', 'str_replace_editor', 'subagent', 'subagent_fork', 'workflow', 'ralph', 'ops_bash', 'pwsh']

/** A stand-in agent: only `globals` may be restricted, as DSH allows only global tools. */
function fakeAgent({ globals = ['edit', 'write', 'str_replace_editor'], guardError } = {}) {
  const restricted = []
  let recorded
  return {
    restricted,
    getGuard: () => recorded,
    agent: {
      id: 'main',
      ctx: {
        tools: {
          restrict({ deny }) {
            const [tool] = deny
            if (!globals.includes(tool)) throw new Error(`tools.restrict() names unknown global tool "${tool}"`)
            restricted.push(tool)
            return () => {
              const at = restricted.indexOf(tool)
              if (at !== -1) restricted.splice(at, 1)
            }
          },
          guard(fn) {
            if (guardError !== undefined) throw new Error(guardError)
            recorded = fn
          },
        },
      },
    },
  }
}

test('denyGuard denies a listed name and lets anything else through', () => {
  const guard = denyGuard(HIDDEN)
  assert.equal(
    guard({ name: 'edit' }),
    'orchestrator: "edit" is not available to the main agent. The main agent only plans; hand every action to a worker with the delegate tool.',
  )
  assert.equal(guard({ name: 'write' }).startsWith('orchestrator: "write"'), true)
  assert.equal(guard({ name: 'todo_write' }), undefined)
  assert.equal(guard({ name: 'read' }), undefined)
})

test('denyGuard never denies delegate, even when the config lists it', () => {
  const guard = denyGuard([...HIDDEN, DELEGATE_TOOL])
  assert.equal(guard({ name: DELEGATE_TOOL }), undefined)
  assert.notEqual(guard({ name: 'subagent' }), undefined)
})

test('denyGuard tolerates an execution without a name', () => {
  const guard = denyGuard(HIDDEN)
  assert.equal(guard(undefined), undefined)
  assert.equal(guard(null), undefined)
  assert.equal(guard({}), undefined)
  assert.equal(guard({ name: 42 }), undefined)
})

test('restrictEach keeps going after one name is refused and reports it in skipped', () => {
  const { agent, restricted } = fakeAgent()
  const { applied, skipped } = restrictEach(agent, ['edit', 'subagent', 'write'])
  assert.deepEqual(applied, ['edit', 'write'])
  assert.deepEqual(restricted, ['edit', 'write'])
  assert.equal(skipped.length, 1)
  assert.match(skipped[0], /^subagent \(/)
  assert.match(skipped[0], /unknown global tool "subagent"/)
})

test('installGate hides global tools and refuses a scope-local one through the guard', () => {
  const { agent, restricted, getGuard } = fakeAgent()
  const { applied, skipped, guarded, guardError } = installGate({ agent, names: () => HIDDEN, enabled: () => true })
  assert.deepEqual(applied, ['edit', 'write', 'str_replace_editor'])
  assert.deepEqual(restricted, applied)
  assert.equal(skipped.length, 6)
  assert.match(skipped.join('\n'), /subagent \(.*unknown global tool/)
  assert.equal(guardError, undefined)
  assert.notEqual(getGuard()({ name: 'subagent' }), undefined)
  assert.notEqual(getGuard()({ name: 'ops_bash' }), undefined)
  assert.equal(getGuard()({ name: DELEGATE_TOOL }), undefined)
  assert.deepEqual(guarded, HIDDEN.filter((name) => name !== DELEGATE_TOOL))
})

test('installGate reports a guard failure instead of throwing', () => {
  const { agent } = fakeAgent({ guardError: 'guard is not available here' })
  const result = installGate({ agent, names: () => ['edit', 'subagent'], enabled: () => true })
  assert.equal(result.guardError, 'guard is not available here')
  assert.deepEqual(result.applied, ['edit'])
  assert.equal(result.skipped.length, 1)
})

test('installGate follows the switch: off hides nothing, on hides and denies, off again lifts it', () => {
  const { agent, restricted, getGuard } = fakeAgent({ globals: ['edit'] })
  let on = false
  const names = ['edit', 'subagent']
  const result = installGate({ agent, names: () => names, enabled: () => on })
  assert.deepEqual(result.applied, [])
  assert.deepEqual(restricted, [])
  assert.equal(getGuard()({ name: 'edit' }), undefined)

  on = true
  assert.notEqual(getGuard()({ name: 'edit' }), undefined)
  assert.deepEqual(restricted, ['edit'])
  assert.notEqual(getGuard()({ name: 'subagent' }), undefined)

  on = false
  assert.equal(getGuard()({ name: 'edit' }), undefined)
  assert.deepEqual(restricted, [])
})

test('installGate reads the denied list per call, so a config edit reaches a live agent', () => {
  const { agent, getGuard } = fakeAgent({ globals: [] })
  const names = ['edit', 'subagent']
  installGate({ agent, names: () => names, enabled: () => true })
  assert.notEqual(getGuard()({ name: 'edit' }), undefined)
  assert.equal(getGuard()({ name: 'todo_write' }), undefined)
  names.push('todo_write')
  assert.notEqual(getGuard()({ name: 'todo_write' }), undefined)
})

test('mergeDenied keeps the shipped defaults when a profile lists only a few', () => {
  const merged = mergeDenied(['edit', 'read', 'pwsh'], ['edit', 'write'])
  for (const name of ['edit', 'read', 'pwsh', 'write']) assert.ok(merged.includes(name), name)
  assert.equal(merged.length, 4)
})

test('mergeDenied tolerates a missing list on either side', () => {
  assert.deepEqual(mergeDenied(['read'], undefined), ['read'])
  assert.deepEqual(mergeDenied(undefined, ['read']), ['read'])
  assert.deepEqual(mergeDenied(undefined, undefined), [])
})
