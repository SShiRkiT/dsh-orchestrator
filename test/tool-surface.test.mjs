import assert from 'node:assert/strict'
import test from 'node:test'
import { DELEGATE_STATUS_TOOL_NAME, DELEGATE_TOOL, ORCHESTRATE_TOOL } from '../lib/api.js'
import { DEFAULT_ALLOWED_TOOLS, OFFICIAL_SHADOW, installToolSurface } from '../lib/tool-surface.js'

/**
 * The names a host would hand `definitions()`: a mixture of inherited globals and the
 * scope-local tools (`subagent`, the `ops_*` family) that `tools.restrict` cannot hide.
 */
const HOST_SURFACE = [
  'read',
  'glob',
  'grep',
  'write',
  'edit',
  'bash',
  'ops_bash',
  'ops_edit_file',
  'ops_write_file',
  'subagent',
  'workflow',
  'delegate',
  'orchestrate',
  DELEGATE_STATUS_TOOL_NAME,
  'worktree_manage',
  'send_message',
  'todo_write',
  'compress',
]

const ROOT_ONLY = [DELEGATE_STATUS_TOOL_NAME, 'worktree_manage']
const ALLOWED = ['delegate', 'orchestrate', ...ROOT_ONLY, 'send_message', 'todo_write', 'compress']

const mainAgent = { id: 'main', options: {}, session: { header: {} } }
const childAgent = { id: 'child', options: { subagentDepth: 1 }, session: { header: {} } }
const resumedChild = { id: 'resumed', options: {}, session: { header: { delegationDepth: 1 } } }

/** A tools service with the one method the wrapper touches, plus a view of visible names. */
function fakeTools({ names = HOST_SURFACE, known = [], result } = {}) {
  const calls = []
  const service = {
    definitions(scope, toolSet) {
      calls.push([scope, toolSet])
      if (result !== undefined) return result
      return names.map((name) => ({ name }))
    },
    view: () => ({ knownNames: new Set(known), visible: new Map() }),
  }
  return { service, calls }
}

const namesOf = (list) => list.map((definition) => definition.name)
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const CORDIS_CALLER = Symbol.for('cordis.caller')
const SURFACE = Symbol.for('dsh-orchestrator.toolSurface')

/** The Cordis 4.1.0 traced-service path for ordinary methods and symbols. */
function cordisTools(service, useContext = {}) {
  const shadow = (receiver) => new Proxy(receiver, {
    get(target, key, outer) {
      return key === 'ctx' ? useContext : Reflect.get(target, key, outer)
    },
    set(target, key, value, outer) {
      return key !== 'ctx' && Reflect.set(target, key, value, outer)
    },
  })
  // Cordis does not trap getOwnPropertyDescriptor, defineProperty, or deleteProperty.
  return new Proxy(service, {
    get(target, key, receiver) {
      if (key === CORDIS_ORIGINAL) return target
      if (key === CORDIS_CALLER || key === 'ctx') return useContext
      if (typeof key === 'symbol') return Reflect.get(target, key, receiver)
      let descriptor
      for (let owner = target; owner !== null && descriptor === undefined; owner = Object.getPrototypeOf(owner)) {
        descriptor = Object.getOwnPropertyDescriptor(owner, key)
      }
      const callReceiver = shadow(receiver)
      const value = descriptor && 'value' in descriptor ? descriptor.value : Reflect.get(target, key, callReceiver)
      if (typeof value !== 'function') return value
      return new Proxy(value, {
        apply(method, thisArg, args) {
          return Reflect.apply(method, thisArg === receiver ? callReceiver : thisArg, args)
        },
      })
    },
    set(target, key, value, receiver) {
      if (key === CORDIS_ORIGINAL || key === CORDIS_CALLER || key === 'ctx') return false
      if (typeof key === 'symbol') return Reflect.set(target, key, value, receiver)
      return Reflect.set(target, key, value, shadow(receiver))
    },
  })
}

test('a main agent is offered only the live whitelist, own-scope tools included', () => {
  const { service } = fakeTools()
  const dispose = installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(mainAgent))
  assert.deepEqual(names, ALLOWED)
  // Everything a `restrict` could never hide is gone as well.
  for (const name of ['ops_bash', 'ops_edit_file', 'ops_write_file', 'subagent', 'workflow', 'read', 'edit']) {
    assert.equal(names.includes(name), false, name)
  }
  dispose()
})

test('the nine shipped tools exclude session history and keep delegate status and worktree management root-only', () => {
  const expected = [
    'delegate',
    'orchestrate',
    'delegate_status',
    'worktree_manage',
    'send_message',
    'interrupt_agent',
    'todo_write',
    'ask_user_question',
    'compress',
  ]
  const sessionHistory = [
    'session_search',
    'session_trace',
    'session_event_search',
    'session_event_read',
    'session_event_trace',
  ]
  const { service } = fakeTools({ names: [...expected, ...sessionHistory] })
  let allowed = DEFAULT_ALLOWED_TOOLS
  installToolSurface({ tools: service, allowed: () => allowed })
  assert.deepEqual(DEFAULT_ALLOWED_TOOLS, expected)
  assert.deepEqual(namesOf(service.definitions(mainAgent)), expected)
  for (const agent of [childAgent, resumedChild]) {
    const names = namesOf(service.definitions(agent))
    for (const name of ROOT_ONLY) assert.equal(names.includes(name), false, `${name} on ${agent.id}`)
  }

  allowed = [sessionHistory[3]]
  assert.deepEqual(namesOf(service.definitions(mainAgent)), ['session_event_read'])
})

test('run_code survives the filter, because PTC delegates through it', () => {
  const { service } = fakeTools({ names: [...HOST_SURFACE, 'run_code'] })
  installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(mainAgent))
  assert.equal(names.includes('run_code'), true)
  assert.equal(names.includes('edit'), false)
})

test('the whitelist is read per call, so a panel write lands on the next request', () => {
  const { service } = fakeTools()
  let allowed = [...ALLOWED]
  installToolSurface({ tools: service, allowed: () => allowed })
  assert.equal(namesOf(service.definitions(mainAgent)).includes('read'), false)

  allowed = [...ALLOWED, 'read']
  assert.equal(namesOf(service.definitions(mainAgent)).includes('read'), true)

  allowed = []
  assert.deepEqual(namesOf(service.definitions(mainAgent)), [])
})

test('switching off keeps host tools and hides all dispatch and governance tools', () => {
  const { service } = fakeTools()
  let on = false
  installToolSurface({ tools: service, allowed: ALLOWED, enabled: () => on })
  const expectedOff = HOST_SURFACE.filter((name) => ![DELEGATE_TOOL, ORCHESTRATE_TOOL, ...ROOT_ONLY].includes(name))
  const rootNames = namesOf(service.definitions(mainAgent))
  assert.deepEqual(rootNames, expectedOff)
  for (const agent of [childAgent, resumedChild]) {
    assert.deepEqual(namesOf(service.definitions(agent)), expectedOff)
  }
  assert.deepEqual(namesOf(service.definitions()), HOST_SURFACE, 'the global catalog still includes all tools')

  on = true
  assert.deepEqual(namesOf(service.definitions(mainAgent)), ALLOWED)
  const childNames = namesOf(service.definitions(childAgent))
  for (const name of [DELEGATE_TOOL, ORCHESTRATE_TOOL, ...ROOT_ONLY]) {
    assert.equal(childNames.includes(name), false, name)
  }
})

test('custom disabledDeny overrides which names are hidden when the switch is off', () => {
  const { service } = fakeTools()
  installToolSurface({
    tools: service,
    allowed: ALLOWED,
    enabled: () => false,
    disabledDeny: ['delegate'],
  })
  const names = namesOf(service.definitions(mainAgent))
  assert.equal(names.includes('delegate'), false)
  assert.equal(names.includes('orchestrate'), true)
  assert.equal(names.includes('read'), true)
})

test('the context-global view is never filtered, so the panel keeps a complete catalog', () => {
  const { service } = fakeTools()
  installToolSurface({ tools: service, allowed: ALLOWED })
  assert.deepEqual(namesOf(service.definitions()), HOST_SURFACE)
  assert.deepEqual(namesOf(service.definitions(undefined)), HOST_SURFACE)
  assert.deepEqual(namesOf(service.definitions(null)), HOST_SURFACE)
})

test('a child loses the plugin pair and keeps the native and scope-local tools', () => {
  const { service } = fakeTools()
  installToolSurface({ tools: service, allowed: ALLOWED })
  for (const agent of [childAgent, resumedChild]) {
    const names = namesOf(service.definitions(agent))
    assert.equal(names.includes(DELEGATE_TOOL), false)
    assert.equal(names.includes(ORCHESTRATE_TOOL), false)
    for (const name of ['subagent', 'workflow', 'ops_bash', 'ops_edit_file', 'ops_write_file', 'read', 'edit']) {
      assert.equal(names.includes(name), true, `${name} on ${agent.id}`)
    }
  }
})

test('a child is masked even when the whitelist would have allowed the pair', () => {
  const { service } = fakeTools()
  installToolSurface({ tools: service, allowed: [...ALLOWED, 'delegate', 'orchestrate'] })
  const names = namesOf(service.definitions(childAgent))
  assert.equal(names.includes('delegate'), false)
  assert.equal(names.includes('orchestrate'), false)
  assert.equal(names.includes('send_message'), true)
})

test('the leaked official tools are shadowed while their dsh-ops replacement exists', () => {
  // The async hide queue means a request can be assembled between "replacement registered"
  // and "official hidden": the wrapper filters the official name itself, so no request
  // ever sees the pair and the tool table never gains or loses three names.
  const { service } = fakeTools({ names: [...HOST_SURFACE, 'ops_inspect_local_file', 'ops_glob', 'ops_grep'] })
  installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(childAgent))
  for (const [official, replacement] of OFFICIAL_SHADOW) {
    assert.equal(names.includes(official), false, official)
    assert.equal(names.includes(replacement), true, replacement)
  }
})

test('the replacement is also read from the scope view, not only from the list', () => {
  const { service } = fakeTools({ known: ['ops_inspect_local_file'] })
  installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(childAgent))
  assert.equal(names.includes('read'), false, 'read is shadowed through the view')
  assert.equal(names.includes('glob'), true, 'no ops_glob registered, so glob stays')
})

test('without dsh-ops a child keeps the official read/glob/grep', () => {
  const { service } = fakeTools()
  installToolSurface({ tools: service, allowed: ALLOWED })
  const names = namesOf(service.definitions(childAgent))
  for (const name of ['read', 'glob', 'grep']) assert.equal(names.includes(name), true, name)
})

test('a main agent that checked an official tool still loses it to its replacement', () => {
  // `dsh-ops` hides `read` whatever the panel says; shadowing it here is the same answer,
  // so the request cannot see a tool the execution side would refuse anyway.
  const { service } = fakeTools({ names: [...HOST_SURFACE, 'ops_inspect_local_file'] })
  installToolSurface({ tools: service, allowed: [...ALLOWED, 'read'] })
  const names = namesOf(service.definitions(mainAgent))
  assert.equal(names.includes('read'), false)
  assert.equal(names.includes('ops_inspect_local_file'), false, 'not whitelisted')
})

test('custom deny and shadow lists are honoured', () => {
  const { service } = fakeTools()
  installToolSurface({
    tools: service,
    allowed: ALLOWED,
    workerDeny: ['workflow'],
    shadow: [['edit', 'ops_edit_file']],
  })
  const names = namesOf(service.definitions(childAgent))
  assert.equal(names.includes('workflow'), false)
  assert.equal(names.includes('edit'), false, 'the custom shadow pair applies too')
  assert.equal(names.includes('delegate'), true, 'dispatch-tool defaults are replaced, not merged')
  for (const name of ROOT_ONLY) assert.equal(names.includes(name), false, `${name} is root-only`)
})

test('dispose restores the original method and a second install is a no-op', () => {
  const { service, calls } = fakeTools()
  const original = service.definitions
  const dispose = installToolSurface({ tools: service, allowed: ALLOWED })
  assert.notEqual(service.definitions, original)

  const second = installToolSurface({ tools: service, allowed: ['edit'] })
  assert.equal(second, dispose, 'the second install hands back the first disposer')
  assert.equal(namesOf(service.definitions(mainAgent)).includes('read'), false, 'one wrapper only')

  dispose()
  assert.equal(service.definitions, original, 'the original method is back')
  dispose()
  assert.equal(service.definitions, original, 'a second dispose is harmless')
  assert.deepEqual(namesOf(service.definitions(mainAgent)), HOST_SURFACE)
  assert.deepEqual(calls[0], [mainAgent, undefined], 'scope and toolSet pass straight through')
})

test('Cordis proxies share one installation and restore the raw own method on dispose', () => {
  const { service } = fakeTools()
  const tools = cordisTools(service)
  const otherTools = cordisTools(service)
  const rawOriginal = service.definitions
  const originalDescriptor = Object.getOwnPropertyDescriptor(service, 'definitions')
  assert.notEqual(tools.definitions, tools.definitions, 'ordinary gets do not share identity')
  assert.equal(tools[CORDIS_ORIGINAL], service)
  assert.deepEqual(Object.getOwnPropertyDescriptor(tools, 'definitions'), originalDescriptor)

  const dispose = installToolSurface({ tools, allowed: ALLOWED })
  assert.notEqual(service.definitions, rawOriginal)
  assert.equal(Object.getOwnPropertyDescriptor(tools, 'definitions').value, service.definitions)
  assert.equal(tools[SURFACE], service[SURFACE], 'the installation symbol passes through')
  assert.equal(installToolSurface({ tools: otherTools, allowed: ['edit'] }), dispose)
  assert.deepEqual(namesOf(otherTools.definitions(mainAgent)), ALLOWED)

  dispose()
  assert.equal(service.definitions, rawOriginal)
  assert.deepEqual(Object.getOwnPropertyDescriptor(service, 'definitions'), originalDescriptor)
  assert.equal(Object.hasOwn(service, SURFACE), false)
  assert.deepEqual(namesOf(otherTools.definitions(mainAgent)), HOST_SURFACE)
})

test('Cordis hot reload restores all regular tools when dispatch is off and keeps child policy', () => {
  const { service } = fakeTools()
  const toolsA = cordisTools(service)
  const disposeA = installToolSurface({ tools: toolsA, allowed: ALLOWED, enabled: () => true })
  assert.deepEqual(namesOf(toolsA.definitions(mainAgent)), ALLOWED)
  disposeA()

  let on = false
  const toolsB = cordisTools(service)
  const disposeB = installToolSurface({ tools: toolsB, allowed: ['edit'], enabled: () => on })
  const rootOff = HOST_SURFACE.filter((name) => ![DELEGATE_TOOL, ORCHESTRATE_TOOL, ...ROOT_ONLY].includes(name))
  assert.deepEqual(namesOf(toolsB.definitions(mainAgent)), rootOff)
  for (const name of ['read', 'write', 'edit', 'bash', 'glob', 'grep']) {
    assert.ok(rootOff.includes(name), `fixture contains the restored tool ${name}`)
  }
  for (const agent of [childAgent, resumedChild]) {
    assert.deepEqual(namesOf(toolsB.definitions(agent)), rootOff)
  }

  on = true
  assert.deepEqual(namesOf(toolsB.definitions(mainAgent)), ['edit'])
  for (const agent of [childAgent, resumedChild]) {
    assert.deepEqual(namesOf(toolsB.definitions(agent)), rootOff)
  }
  disposeB()
})

test('three Cordis reloads keep the live caller and restore the inherited method without stacking', () => {
  const calls = []
  class Tools {
    definitions(scope, toolSet) {
      calls.push([this.ctx, scope, toolSet])
      return HOST_SURFACE.map((name) => ({ name }))
    }
  }
  const service = new Tools()
  const rawOriginal = Tools.prototype.definitions
  const toolSet = {}
  const reads = []

  for (const [cycle, allowed] of [['A', 'read'], ['B', 'write'], ['C', 'edit']]) {
    const context = { cycle }
    const tools = cordisTools(service, context)
    assert.equal(Object.getOwnPropertyDescriptor(tools, 'definitions'), undefined)
    const dispose = installToolSurface({ tools, allowed: () => { reads.push(cycle); return [allowed] } })
    const otherContext = { cycle, caller: 'host' }
    const callerTools = cordisTools(service, otherContext)
    assert.deepEqual(namesOf(callerTools.definitions(mainAgent, toolSet)), [allowed])
    assert.deepEqual(calls.at(-1), [otherContext, mainAgent, toolSet])
    assert.equal(calls.at(-1)[0], otherContext)
    dispose()
    assert.equal(Object.hasOwn(service, 'definitions'), false, 'no inherited-method shadow remains')
    assert.equal(service.definitions, rawOriginal)
    assert.equal(Object.hasOwn(service, SURFACE), false)
  }
  assert.deepEqual(reads, ['A', 'B', 'C'], 'no previous generation filters a request')
  assert.equal(calls.length, 3, 'one raw call per request')
})

test('disposing beneath a third-party Cordis patch preserves it and lets a later install run', () => {
  const { service, calls } = fakeTools()
  const tools = cordisTools(service)
  const rawOriginal = service.definitions
  const disposeA = installToolSurface({ tools, allowed: ALLOWED })
  const previous = tools.definitions
  const thirdParty = function (scope, toolSet) {
    return [...previous.call(this, scope, toolSet), { name: 'third_party' }]
  }
  tools.definitions = thirdParty
  assert.equal(service.definitions, thirdParty, 'ordinary proxy writes reach the target')
  assert.deepEqual(namesOf(tools.definitions(mainAgent)), [...ALLOWED, 'third_party'])

  disposeA()
  assert.equal(service.definitions, thirdParty)
  assert.equal(Object.hasOwn(service, SURFACE), false)
  const toolSet = {}
  const thirdPartySurface = [...HOST_SURFACE, 'third_party']
  assert.deepEqual(namesOf(tools.definitions(mainAgent, toolSet)), thirdPartySurface)
  assert.deepEqual(calls.at(-1), [mainAgent, toolSet])

  const disposeB = installToolSurface({ tools: cordisTools(service), allowed: ['edit', 'third_party'] })
  disposeA()
  assert.notEqual(service.definitions, thirdParty)
  assert.equal(tools[SURFACE]?.dispose, disposeB, 'the old disposer cannot clear the new owner')
  assert.deepEqual(namesOf(tools.definitions(mainAgent)), ['edit', 'third_party'])
  disposeB()
  assert.equal(service.definitions, thirdParty)
  assert.equal(Object.hasOwn(service, SURFACE), false)
  assert.deepEqual(namesOf(tools.definitions(mainAgent)), thirdPartySurface)

  // A third party can later restore its saved (now disposed) wrapper without reactivating it.
  tools.definitions = previous
  assert.deepEqual(namesOf(tools.definitions(mainAgent)), HOST_SURFACE)
  tools.definitions = rawOriginal
})

test('a non-array result and a service without definitions are passed through safely', () => {
  const { service } = fakeTools({ result: { not: 'a list' } })
  installToolSurface({ tools: service, allowed: ALLOWED })
  assert.deepEqual(service.definitions(mainAgent), { not: 'a list' })

  const empty = installToolSurface({ tools: undefined, allowed: ALLOWED })
  assert.equal(typeof empty, 'function')
  empty()
  const noMethod = installToolSurface({ tools: {}, allowed: ALLOWED })
  assert.equal(typeof noMethod, 'function')
  noMethod()
})

test('an unreadable view never breaks the filter', () => {
  const service = {
    definitions: () => HOST_SURFACE.map((name) => ({ name })),
    view: () => {
      throw new Error('view is gone')
    },
  }
  installToolSurface({ tools: service, allowed: ALLOWED })
  assert.deepEqual(namesOf(service.definitions(mainAgent)), ALLOWED)
})

test('definitions without a name survive the filter instead of crashing it', () => {
  const service = {
    definitions: () => [{ type: 'opaque' }, { name: 'edit' }, { name: 'todo_write' }],
  }
  installToolSurface({ tools: service, allowed: ALLOWED })
  assert.deepEqual(namesOf(service.definitions(mainAgent)), [undefined, 'todo_write'])
})
