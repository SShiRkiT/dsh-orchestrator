import assert from 'node:assert/strict'
import test from 'node:test'
import { DELEGATE_TOOL, DELEGATION_TOOLS, denyGuard, installGate, isDelegatedChild, mergeDenied, restrictEach } from '../lib/gate.js'

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
    'orchestrator: "edit" is not available to the main agent. The main agent only plans; hand every action to a worker with the delegate or orchestrate tools.',
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

test('the gate lets orchestrate through but never the native workflow', () => {
  assert.equal(DELEGATION_TOOLS.has('delegate'), true)
  assert.equal(DELEGATION_TOOLS.has('orchestrate'), true)
  assert.equal(DELEGATION_TOOLS.has('workflow'), false)
  const guard = denyGuard([...HIDDEN, 'orchestrate', 'workflow'])
  assert.equal(guard({ name: 'orchestrate' }), undefined)
  assert.match(guard({ name: 'workflow' }), /"workflow" is not available/)
  const { agent, getGuard } = fakeAgent()
  const { guarded } = installGate({ agent, names: () => [...HIDDEN, 'orchestrate'], enabled: () => true })
  assert.equal(guarded.includes('orchestrate'), false)
  assert.equal(guarded.includes('workflow'), true)
  assert.notEqual(getGuard()({ name: 'workflow' }), undefined)
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

test('a cold-resumed child is recognised from the persisted header alone', () => {
  // Cold resume rebuilds options as provider/model/effort only, dropping subagentDepth;
  // the session header is then the only depth left. Reading options alone returned false
  // here, so the child got the main agent's gate and could only spawn grandchildren.
  const resumed = { options: { provider: 'p', model: 'm' }, session: { header: { delegationDepth: 1 } } }
  assert.equal(isDelegatedChild(resumed), true)
})

test('a freshly created child is a child through both sources', () => {
  const child = { options: { subagentDepth: 1 }, session: { header: { delegationDepth: 1 } } }
  assert.equal(isDelegatedChild(child), true)
  assert.equal(isDelegatedChild({ options: { subagentDepth: 1 }, session: { header: {} } }), true)
  assert.equal(isDelegatedChild({ options: { subagentDepth: 2 }, session: { header: { delegationDepth: 1 } } }), true)
})

test('the main agent has no depth on either side', () => {
  assert.equal(isDelegatedChild({ options: {}, session: { header: {} } }), false)
  assert.equal(isDelegatedChild({ options: { provider: 'p', model: 'm' }, session: { header: {} } }), false)
})

test('an explicit zero on both sides is still the main agent', () => {
  assert.equal(isDelegatedChild({ options: { subagentDepth: 0 }, session: { header: { delegationDepth: 0 } } }), false)
})

test('the depth is monotonic: the deeper of header and options wins', () => {
  assert.equal(isDelegatedChild({ options: { subagentDepth: 1 }, session: { header: { delegationDepth: 2 } } }), true)
  assert.equal(isDelegatedChild({ options: { subagentDepth: 0 }, session: { header: { delegationDepth: 1 } } }), true)
})

test('a dirty live depth falls back on the header instead of throwing', () => {
  for (const dirty of [-1, 1.5, Number.NaN, '1', null, undefined, {}, []]) {
    const label = String(dirty)
    assert.equal(
      isDelegatedChild({ options: { subagentDepth: dirty }, session: { header: { delegationDepth: 2 } } }),
      true,
      `header 2 with live ${label}`,
    )
    assert.equal(
      isDelegatedChild({ options: { subagentDepth: dirty }, session: { header: {} } }),
      false,
      `no depth with live ${label}`,
    )
  }
})

test('a dirty persisted depth is ignored, not thrown on', () => {
  for (const dirty of [-1, 2.5, Number.NaN, '2', Number.MAX_SAFE_INTEGER + 2, {}, null]) {
    assert.equal(isDelegatedChild({ options: {}, session: { header: { delegationDepth: dirty } } }), false, String(dirty))
  }
  // A dirty header must not block a valid live depth either.
  assert.equal(isDelegatedChild({ options: { subagentDepth: 1 }, session: { header: { delegationDepth: '2' } } }), true)
})

test('a partial agent reads whichever side it has, and never throws', () => {
  assert.equal(isDelegatedChild(undefined), false)
  assert.equal(isDelegatedChild(null), false)
  assert.equal(isDelegatedChild({}), false)
  assert.equal(isDelegatedChild({ options: { subagentDepth: 1 } }), true)
  assert.equal(isDelegatedChild({ session: { header: { delegationDepth: 1 } } }), true)
  assert.equal(isDelegatedChild({ options: null, session: null }), false)
  assert.equal(isDelegatedChild({ options: {}, session: {} }), false)
  assert.equal(isDelegatedChild({ options: {}, session: { header: null } }), false)
})

test('a forked root keeps the gate: parentSession without a depth is not a child', () => {
  // A GUI fork is a new root session: it records where it came from but starts at depth 0.
  const forked = { options: {}, session: { header: { parentSession: 'root-session', delegationDepth: 0 } } }
  assert.equal(isDelegatedChild(forked), false)
  const forkedWithoutDepth = { options: {}, session: { header: { parentSession: 'root-session' } } }
  assert.equal(isDelegatedChild(forkedWithoutDepth), false)
})
