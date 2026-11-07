import assert from 'node:assert/strict'
import test from 'node:test'
import { ORCHESTRATE_TOOL } from '../lib/api.js'
import {
  DELEGATE_TOOL,
  allowGuard,
  effectiveAllowed,
  hiddenTools,
  installGate,
  isDelegatedChild,
  restrictEach,
} from '../lib/gate.js'

/** The whitelist a test installs; short on purpose, since the real one is a dozen names. */
const ALLOWED = [DELEGATE_TOOL, ORCHESTRATE_TOOL, 'todo_write', 'compress']

/** Every name a host could register, the reserved transport included. */
const HOST_TOOLS = [
  'edit',
  'read',
  'write',
  'grep',
  'glob',
  'ops_bash',
  'subagent',
  'workflow',
  'ralph',
  'mcp_custom_tool',
  'run_code',
]

/** What a whitelist of ALLOWED hides: every host name but the allowed ones and `run_code`. */
const HIDDEN = HOST_TOOLS.filter((name) => name !== 'run_code')

const CATALOG = [...ALLOWED, ...HOST_TOOLS]

/** The one home for the refusal text; a copy here is what keeps the wording honest. */
const refusal = (tool) =>
  `orchestrator: "${tool}" is not available to the main agent. The main agent only plans; hand every action to a worker with the delegate or orchestrate tools.`

/**
 * A stand-in agent whose `restrict` behaves like the host's (only inherited names, unknown
 * ones throw), so the `restrictEach` helper stays covered. The gate itself must never call
 * it: `restricted` is asserted empty by every installGate test.
 */
function fakeAgent({ globals = ['edit', 'write', 'str_replace_editor'], scope = [], guardError } = {}) {
  const restricted = []
  const guards = []
  const agent = {
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
          guards.push(fn)
          let live = true
          return () => {
            if (!live) return
            live = false
            const at = guards.indexOf(fn)
            if (at !== -1) guards.splice(at, 1)
          }
        },
        view() {
          return { knownNames: new Set(scope), visible: new Map() }
        },
      },
    },
  }
  return { agent, restricted, guards, getGuard: () => guards[guards.length - 1] }
}

// ---- effectiveAllowed ------------------------------------------------------------------

test('an unconfigured whitelist falls back on the shipped defaults, deduped', () => {
  assert.deepEqual(effectiveAllowed(undefined, ['edit', 'read']), ['edit', 'read'])
  assert.deepEqual(effectiveAllowed(null, ['edit', 'read']), ['edit', 'read'])
  assert.deepEqual(effectiveAllowed(undefined, ['edit', 'edit', 'read', 'edit']), ['edit', 'read'])
  // No defaults at all is an empty whitelist, not a throw.
  assert.deepEqual(effectiveAllowed(undefined), [])
  assert.deepEqual(effectiveAllowed(undefined, undefined), [])
})

test('a configured whitelist replaces the defaults instead of extending them', () => {
  // The whole point of a whitelist: what it does not name is not allowed, so the shipped
  // list must never leak into a configured one.
  assert.deepEqual(effectiveAllowed(['delegate'], ['edit', 'read']), ['delegate'])
  assert.deepEqual(effectiveAllowed(['delegate', 'edit', 'delegate'], ['read']), ['delegate', 'edit'])
})

test('an empty whitelist means "allow nothing", not "fall back to the defaults"', () => {
  // Unchecking every box in the panel must disable every tool; reverting to the shipped
  // list here would silently re-arm the main agent.
  assert.deepEqual(effectiveAllowed([], ['edit', 'read']), [])
  assert.deepEqual(effectiveAllowed([], ['edit']), [])
})

test('a dirty whitelist drops junk instead of throwing', () => {
  // A hand-edited profile can hold anything; an entry that is not a non-empty string is
  // dropped rather than handed to `tools.restrict`, which would throw on it.
  assert.deepEqual(effectiveAllowed(['edit', '', 7, null, undefined, 'read'], ['fallback']), ['edit', 'read'])
  assert.deepEqual(effectiveAllowed(['edit', 'edit'], ['fallback']), ['edit'])
  // An empty iterable is an empty whitelist, like the empty array.
  assert.deepEqual(effectiveAllowed(new Set(), ['fallback']), [])
  assert.deepEqual(effectiveAllowed(new Set(['edit', 'edit']), ['fallback']), ['edit'])
})

// ---- hiddenTools -----------------------------------------------------------------------

test('the hidden set is the catalog minus the whitelist and the run_code transport', () => {
  const hidden = hiddenTools(CATALOG, ALLOWED)
  assert.deepEqual(hidden, HIDDEN)
  for (const name of ALLOWED) assert.equal(hidden.includes(name), false, name)
  // `tools.restrict` refuses to hide `run_code` (it would hide `tools.delegate` too), so
  // the gate must never name it; the guard covers it by its arguments instead.
  assert.equal(hidden.includes('run_code'), false)
  assert.equal(hidden.includes('mcp_custom_tool'), true, 'a tool no shipped list knows is hidden')
})

test('an empty whitelist hides the whole catalog, the transport excepted', () => {
  const hidden = hiddenTools(CATALOG, [])
  assert.deepEqual(hidden, CATALOG.filter((name) => name !== 'run_code'))
  assert.equal(hidden.includes('run_code'), false)
})

test('hiddenTools dedupes and tolerates junk on both sides', () => {
  assert.deepEqual(hiddenTools(['edit', 'edit', '', 7, null, 'read'], ['read']), ['edit'])
  assert.deepEqual(hiddenTools(['edit'], ['edit', 'edit', '', 7]), [])
  assert.deepEqual(hiddenTools(undefined, ALLOWED), [])
  assert.deepEqual(hiddenTools(null, null), [])
  assert.deepEqual(hiddenTools([], ALLOWED), [])
})

// ---- allowGuard ------------------------------------------------------------------------

test('allowGuard lets an allowed name through and refuses every other one', () => {
  const guard = allowGuard(ALLOWED)
  for (const name of ALLOWED) assert.equal(guard({ name }), undefined, name)
  assert.equal(guard({ name: 'read' }), refusal('read'))
  assert.equal(guard({ name: 'edit' }), refusal('edit'))
  // A tool a plugin or MCP server registered later is refused like any other: the guard
  // is driven by the whitelist, not by a list of known bad names.
  assert.equal(guard({ name: 'mcp_custom_tool' }), refusal('mcp_custom_tool'))
})

test('allowGuard refuses a name nobody has heard of, so a new tool is blocked by default', () => {
  const guard = allowGuard(ALLOWED)
  assert.equal(guard({ name: 'ops_brand_new_tool' }), refusal('ops_brand_new_tool'))
  assert.match(guard({ name: 'subagent' }), /"subagent" is not available to the main agent/)
})

test('allowGuard tolerates an execution without a name', () => {
  const guard = allowGuard(ALLOWED)
  assert.equal(guard(undefined), undefined)
  assert.equal(guard(null), undefined)
  assert.equal(guard({}), undefined)
  assert.equal(guard({ name: '' }), undefined)
  assert.equal(guard({ name: 42 }), undefined)
})

test('allowGuard reads a dirty whitelist without throwing', () => {
  for (const allowed of [undefined, null, [], ['edit', '', 7]]) {
    assert.doesNotThrow(() => allowGuard(allowed)({ name: 'read' }))
  }
  const empty = allowGuard([])
  assert.equal(empty({ name: 'read' }), refusal('read'))
  assert.equal(empty({ name: 'todo_write' }), refusal('todo_write'))
})

test('run_code outside the whitelist stays callable, but only for a legal program', () => {
  const guard = allowGuard(ALLOWED)
  const program = (code, extra = {}) => ({ name: 'run_code', arguments: { code, description: 'x', ...extra } })

  // The normal case: a delegation program is exactly what the transport is for.
  assert.equal(
    guard(
      program('await tools.delegate({ description: "w", prompt: `write a script that calls import("node:fs") and process.env` })'),
    ),
    undefined,
  )
  assert.equal(guard(program('await tools.orchestrate({ items: [1], stages: [{ name: "s", prompt: "x" }] })')), undefined)

  // The two escapes the transport cannot be hidden for: a widened sandbox mode, and a
  // program that reaches the Node.js runtime instead of going through `tools.*`.
  assert.match(guard(program('return 1', { sandbox_permissions: 'danger-full-access' })), /sandbox escalation is not available to the main agent/)
  assert.match(guard(program('return 1', { justification: 'push it' })), /sandbox escalation is not available/)
  assert.match(guard(program('const fs = await import("node:fs/promises")')), /"run_code" cannot reach the Node\.js or host runtime \("import"\)/)
  assert.match(guard(program('process.getBuiltinModule("fs")')), /\("process"\)/)
  assert.match(guard(program('await fetch("https://example.com")')), /\("fetch"\)/)
})

test('run_code checked in the whitelist is allowed outright, arguments and all', () => {
  // An explicit check is the user saying "the transport itself is fine", so the gate stops
  // second-guessing the program.
  const guard = allowGuard([...ALLOWED, 'run_code'])
  assert.equal(guard({ name: 'run_code', arguments: { code: 'await import("node:fs")' } }), undefined)
  assert.equal(
    guard({ name: 'run_code', arguments: { code: 'return 1', sandbox_permissions: 'danger-full-access' } }),
    undefined,
  )
  // Everything outside the whitelist is still refused in the same breath.
  assert.equal(guard({ name: 'read' }), refusal('read'))
})

// ---- restrictEach ----------------------------------------------------------------------

test('restrictEach keeps going after one name is refused and reports it in skipped', () => {
  const { agent, restricted } = fakeAgent()
  const { applied, skipped } = restrictEach(agent, ['edit', 'subagent', 'write'])
  assert.deepEqual(applied, ['edit', 'write'])
  assert.deepEqual(restricted, ['edit', 'write'])
  assert.equal(skipped.length, 1)
  assert.match(skipped[0], /^subagent \(/)
  assert.match(skipped[0], /unknown global tool "subagent"/)
})

// ---- installGate -----------------------------------------------------------------------

test('installGate arms the guard and never restricts a single tool', () => {
  // The mask storm is gone: a restriction would announce `tools/change`, and dsh-ops
  // answers that by tearing down and re-adding its official shadows.
  const { agent, restricted, getGuard } = fakeAgent()
  const gate = installGate({ agent, allowed: () => ALLOWED, enabled: () => true })
  assert.deepEqual(restricted, [], 'the gate must not call tools.restrict')
  assert.deepEqual(gate.allowed, ALLOWED)
  assert.equal(gate.guardError, undefined)

  const guard = getGuard()
  for (const name of ALLOWED) assert.equal(guard({ name }), undefined, name)
  assert.equal(guard({ name: 'read' }), refusal('read'))
  // A scope-local name is covered too, which `restrict` could never do.
  assert.equal(guard({ name: 'subagent' }), refusal('subagent'))
  assert.equal(guard({ name: 'ops_bash' }), refusal('ops_bash'))
})

test('installGate reports a guard failure instead of throwing', () => {
  const { agent, restricted } = fakeAgent({ guardError: 'guard is not available here' })
  const gate = installGate({ agent, allowed: [], enabled: () => true })
  assert.equal(gate.guardError, 'guard is not available here')
  assert.deepEqual(restricted, [])
  assert.deepEqual(gate.allowed, [])
})

test('the guard reads the whitelist and the switch per call, so nothing is reinstalled', () => {
  const { agent, restricted, getGuard } = fakeAgent()
  let allowed = [...ALLOWED]
  let on = true
  const gate = installGate({ agent, allowed: () => allowed, enabled: () => on })
  const guard = getGuard()
  assert.equal(guard({ name: 'read' }), refusal('read'))

  // A panel write only rewrites the config: the next call already sees it.
  allowed = [...ALLOWED, 'read']
  assert.equal(guard({ name: 'read' }), undefined)

  // The switch is read on the same call, so flipping it needs no event either.
  on = false
  assert.equal(guard({ name: 'edit' }), undefined, 'off lets every call through')
  on = true
  assert.equal(guard({ name: 'edit' }), refusal('edit'))

  assert.deepEqual(restricted, [], 'no restriction was installed along the way')
  assert.deepEqual(gate.allowed, ALLOWED, 'allowed is the snapshot from install time')
})

test('dispose unregisters the guard, and a second dispose is harmless', () => {
  const { agent, guards, restricted } = fakeAgent()
  const gate = installGate({ agent, allowed: ALLOWED })
  assert.equal(guards.length, 1)
  gate.dispose()
  assert.equal(guards.length, 0)
  gate.dispose()
  assert.equal(guards.length, 0, 'a second dispose must not throw or unregister again')
  assert.deepEqual(restricted, [])
})

test('an empty whitelist refuses everything but keeps the transport callable', () => {
  const { agent, getGuard } = fakeAgent()
  installGate({ agent, allowed: [], enabled: () => true })
  const guard = getGuard()
  // `run_code` is transport, not a granted capability: a legal program still runs.
  assert.equal(guard({ name: 'run_code', arguments: { code: 'return 1' } }), undefined)
  assert.equal(guard({ name: DELEGATE_TOOL }), refusal(DELEGATE_TOOL))
})

/**
 * A nested call from inside `run_code` reaches the same registry pipeline as a
 * model-direct one: the transport builds its sub-dispatch with the SAME `agent` and a
 * `parent` execution token, then runs it through `prepareExecution` -> `guardReason`.
 * The guard therefore decides on the name alone and must NOT treat a `parent` token as an
 * exemption, or every whitelist miss becomes callable from inside a program.
 */
test('a run_code sub-dispatch is refused by name, exactly like a direct call', () => {
  const { agent, getGuard } = fakeAgent()
  installGate({ agent, allowed: ALLOWED, enabled: () => true })
  const guard = getGuard()
  const nested = (name) => ({
    name,
    agent,
    parent: Symbol('parent-execution'),
    callId: 'call:ptc:1',
    rootCallId: 'call',
    arguments: {},
  })
  for (const name of ['edit', 'read', 'ops_bash', 'subagent', 'mcp_custom_tool']) {
    assert.equal(guard(nested(name)), refusal(name), name)
  }
  // An allowed tool stays callable through the same nested shape: no over-blocking.
  for (const name of ALLOWED) assert.equal(guard(nested(name)), undefined, name)
})

test('a refusal is decided before the body runs, so the nested call has no effect', () => {
  const { agent, getGuard } = fakeAgent()
  installGate({ agent, allowed: ALLOWED, enabled: () => true })
  const guard = getGuard()
  const ran = []
  const dispatch = (exec) => {
    const reason = guard(exec)
    if (reason !== undefined) return { denied: reason }
    ran.push(exec.name)
    return { ok: true }
  }
  const outcome = dispatch({ name: 'write', agent, parent: Symbol('parent-execution'), arguments: { path: 'x' } })
  assert.equal(outcome.denied, refusal('write'))
  assert.deepEqual(ran, [], 'a refused body must never run')
  assert.equal(dispatch({ name: 'todo_write', agent, parent: Symbol('parent-execution') }).ok, true)
  assert.deepEqual(ran, ['todo_write'])
})

// ---- isDelegatedChild ------------------------------------------------------------------

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
