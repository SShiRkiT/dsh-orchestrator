import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// A tiny hook runtime for one self-contained component: rendering is synchronous, state
// setters re-render, and effects run after each commit. Components render as plain trees.
let hookOwner = null

function sameDeps(a, b) {
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((dep, i) => Object.is(dep, b[i]))
}

function useState(initial) {
  if (hookOwner === null) return [typeof initial === 'function' ? initial() : initial, () => {}]
  const owner = hookOwner
  const index = owner.index++
  if (!(index in owner.states)) owner.states[index] = typeof initial === 'function' ? initial() : initial
  return [
    owner.states[index],
    (next) => {
      const value = typeof next === 'function' ? next(owner.states[index]) : next
      if (Object.is(value, owner.states[index])) return
      owner.states[index] = value
      owner.dirty = true
      if (!owner.rendering) owner.render()
    },
  ]
}

function useReducer(reducer, initial) {
  if (hookOwner === null) return [initial, () => {}]
  const owner = hookOwner
  const index = owner.index++
  if (!(index in owner.states)) owner.states[index] = initial
  return [
    owner.states[index],
    (action) => {
      const value = reducer(owner.states[index], action)
      if (Object.is(value, owner.states[index])) return
      owner.states[index] = value
      owner.dirty = true
      if (!owner.rendering) owner.render()
    },
  ]
}

function useRef(initial) {
  if (hookOwner === null) return { current: initial }
  const owner = hookOwner
  const index = owner.index++
  if (!(index in owner.refs)) owner.refs[index] = { current: initial }
  return owner.refs[index]
}

const React = {
  useState,
  useReducer,
  useRef,
  useEffect: (fn, deps) => {
    if (hookOwner !== null) hookOwner.effects.push({ fn, deps })
  },
  createElement: (type, props, ...kids) => ({ type, props, kids }),
}

/** Render a component with the hook runtime above; effects are committed after each pass. */
function mount(component, props) {
  const owner = { states: [], refs: [], effects: [], committed: [], index: 0, dirty: false, rendering: false, tree: null }
  const commitEffects = () => {
    const previous = owner.committed
    const next = owner.effects
    for (let i = 0; i < next.length; i += 1) {
      const old = previous[i]
      if (old !== undefined && sameDeps(old.deps, next[i].deps)) {
        next[i].cleanup = old.cleanup
        continue
      }
      if (typeof old?.cleanup === 'function') old.cleanup()
      const cleanup = next[i].fn()
      next[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    for (let i = next.length; i < previous.length; i += 1) {
      if (typeof previous[i]?.cleanup === 'function') previous[i].cleanup()
    }
    owner.committed = next
  }
  const render = () => {
    if (owner.rendering) {
      owner.dirty = true
      return owner.tree
    }
    owner.rendering = true
    try {
      for (let pass = 0; pass < 100; pass += 1) {
        owner.index = 0
        owner.dirty = false
        owner.effects = []
        hookOwner = owner
        try {
          owner.tree = component(props)
        } finally {
          hookOwner = null
        }
        commitEffects()
        if (!owner.dirty) break
      }
    } finally {
      owner.rendering = false
    }
    return owner.tree
  }
  owner.render = render
  render()
  return {
    get tree() {
      return owner.tree
    },
    unmount() {
      for (const effect of owner.committed) {
        if (typeof effect?.cleanup === 'function') effect.cleanup()
      }
    },
  }
}

/** Every host element in a rendered tree. */
function nodes(tree, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const child of tree) nodes(child, out)
    return out
  }
  out.push(tree)
  for (const child of tree.kids ?? []) nodes(child, out)
  return out
}

function mountField(scope) {
  const view = mount(mod.__test.SuperviseIntervalField, { scope, t })
  return {
    view,
    input: () => nodes(view.tree).find((node) => node.type === 'input'),
    alert: () => nodes(view.tree).find((node) => node.props?.role === 'alert'),
  }
}

let mod
const timers = []
vm.runInNewContext(src, {
  window: {
    __ModuleLoader__: {
      load: (def) => {
        mod = def.factory((id) => {
          if (id === 'react') return React
          throw new Error('unexpected require ' + id)
        })
      },
    },
  },
  // The field schedules its transient warning; tests drive the timer by hand.
  setTimeout: (fn, ms) => {
    const timer = { fn, ms }
    timers.push(timer)
    return timer
  },
  clearTimeout: () => {},
})
const T = mod.__test
const t = (k) => k
// Values built inside the vm context have another Object.prototype; compare them as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v))

test('route keys round-trip, including ids with slashes, and reject junk', () => {
  const key = T.routeKey('nexus-claude', 'claude/opus:5.5')
  assert.deepEqual(plain(T.parseRouteKey(key)), { provider: 'nexus-claude', model: 'claude/opus:5.5' })
  assert.equal(T.parseRouteKey('not json'), undefined)
  assert.equal(T.parseRouteKey('[1,2]'), undefined)
  assert.equal(T.parseRouteKey('{}'), undefined)
})

test('routeOf reads the two stored shapes and treats missing fields as empty', () => {
  assert.deepEqual(plain(T.routeOf(T.MAIN.fields, { provider: 'p', model: 'm', reasoningEffort: 'high' })), {
    provider: 'p',
    model: 'm',
    effort: 'high',
  })
  assert.deepEqual(plain(T.routeOf(T.WORKER.fields, { workerProvider: 'w', workerModel: 'x' })), {
    provider: 'w',
    model: 'x',
    effort: '',
  })
  assert.deepEqual(plain(T.routeOf(T.MAIN.fields, undefined)), { provider: '', model: '', effort: '' })
})

test('routeOps sets provider and model, and sets or unsets the effort', () => {
  assert.deepEqual(plain(T.routeOps(T.WORKER.fields, { provider: 'p', model: 'm', effort: 'high' })), [
    { op: 'set', path: ['workerProvider'], value: 'p' },
    { op: 'set', path: ['workerModel'], value: 'm' },
    { op: 'set', path: ['workerReasoningEffort'], value: 'high' },
  ])
  const cleared = T.routeOps(T.MAIN.fields, { provider: 'p', model: 'm', effort: '' })
  assert.deepEqual(plain(cleared[2]), { op: 'unset', path: ['reasoningEffort'] })
})

test('findModel matches provider and model together', () => {
  const groups = [
    { id: 'a', models: [{ id: 'x' }] },
    { id: 'b', models: [{ id: 'x', reasoning: { efforts: [] } }] },
  ]
  assert.equal(T.findModel(groups, { provider: 'b', model: 'x' }), groups[1].models[0])
  assert.equal(T.findModel(groups, { provider: 'a', model: 'nope' }), undefined)
  assert.equal(T.findModel(groups, { provider: 'zzz', model: 'x' }), undefined)
})

/** A fake config scope that applies set/unset ops to a plain object. */
function fakeScope({ writable = true, status = 'ready', reject, drop, inherited = {}, initial = {} } = {}) {
  let revision = 1
  let value = { ...initial }
  const calls = []
  const listeners = new Set()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    calls,
    // `unset` only removes the user's override, so an inherited layer shows through again.
    getSnapshot: () => ({ status, writable, revision, value: { ...inherited, ...value } }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (ops, expected) => {
      calls.push({ ops, expected })
      if (reject) throw new Error(reject)
      const next = { ...value }
      for (const op of ops) {
        const key = op.path[0]
        if (drop === key) continue
        if (op.op === 'set') next[key] = op.value
        else delete next[key]
      }
      value = next
      revision += 1
      notify()
    },
    /** Simulate the same field changing elsewhere: another panel, the config file, the host. */
    externalSet: (patch) => {
      value = { ...value, ...patch }
      revision += 1
      notify()
    },
  }
}

test('saveRoute writes with the snapshot revision and reports success', async () => {
  const scope = fakeScope()
  const failure = await T.saveRoute(scope, T.WORKER.fields, { provider: 'p', model: 'm', effort: 'high' }, t)
  assert.equal(failure, null)
  assert.equal(scope.calls[0].expected, 1)
  assert.deepEqual(plain(T.routeOf(T.WORKER.fields, scope.getSnapshot().value)), { provider: 'p', model: 'm', effort: 'high' })
})

test('saveRoute clears a stored effort when the new choice is the model default', async () => {
  const scope = fakeScope()
  await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: 'high' }, t)
  const failure = await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t)
  assert.equal(failure, null)
  assert.equal('reasoningEffort' in scope.getSnapshot().value, false)
})

test('clearing the subagent effort must beat the value the plugin bundle ships with', async () => {
  // The bundled patch ships workerReasoningEffort: high. Unsetting the override would
  // reveal that again, so the effort has to be stored as an explicit empty string.
  const scope = fakeScope({ inherited: { workerReasoningEffort: 'high' } })
  const failure = await T.saveRoute(scope, T.WORKER.fields, { provider: 'p', model: 'm', effort: '' }, t)
  assert.equal(failure, null)
  assert.equal(plain(scope.getSnapshot().value).workerReasoningEffort, '')
})

test('clearing the main agent effort removes the override, since that field has no empty value', async () => {
  const scope = fakeScope()
  await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: 'high' }, t)
  assert.equal(await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), null)
  assert.equal('reasoningEffort' in plain(scope.getSnapshot().value), false)
})

test('saveRoute refuses an unwritable or unready scope without calling mutate', async () => {
  for (const scope of [fakeScope({ writable: false }), fakeScope({ status: 'loading' })]) {
    assert.equal(await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), 'route.readonly')
    assert.equal(scope.calls.length, 0)
  }
})

test('saveRoute surfaces a rejected write and a write that did not land', async () => {
  const rejected = fakeScope({ reject: 'settings changed since it was read' })
  assert.match(await T.saveRoute(rejected, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), /settings changed/)
  const dropped = fakeScope({ drop: 'model' })
  assert.equal(await T.saveRoute(dropped, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), 'route.saveFailed')
})

test('apply puts the toggle in the left slot and the picker in input.right', () => {
  const regs = []
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {} },
    configForms: { get: (ns) => ({ ns }) },
    remote: { commands: { execute: async () => ({ ok: true, value: 'x' }) }, session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) } },
    slots: { inject: (_n, cb) => cb(), register: (opts, comp) => regs.push({ opts, comp }) },
  }
  mod.apply(ctx)
  assert.deepEqual(regs.map((r) => [r.opts.name, r.opts.id, r.opts.order]), [
    ['conversation.input.left', 'orchestrator-plan-toggle', 20],
    ['conversation.input.right', 'orchestrator-route-picker', 11],
  ])
  const props = regs[1].opts.inject('S1')
  assert.deepEqual([props.scopes.main.ns, props.scopes.worker.ns, props.scopes.orch.ns], ['agent-default-model', 'orchestrator', 'orchestrator'])
  assert.equal(props.setPlan, undefined)
  assert.deepEqual(plain(mod.inject), ['slots', 'locale', 'remote', 'remote.commands', 'remote.session', 'configForms'])
})

test('filterGroups matches provider names wholesale and model ids or names otherwise', () => {
  const groups = [
    {
      id: 'nexus-deepseek',
      name: 'Nexus DeepSeek',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'Flash' },
        { id: 'deepseek-v4.1-pro', name: 'Pro' },
      ],
    },
    { id: 'nexus-claude', name: 'Nexus Claude', models: [{ id: 'claude/opus:5.5', name: 'Opus 5.5' }] },
  ]
  assert.equal(plain(T.filterGroups(groups, '   ')).length, 2)
  // A provider hit keeps every model that provider offers.
  const byProvider = plain(T.filterGroups(groups, 'claude'))
  assert.deepEqual(byProvider.map((g) => g.id), ['nexus-claude'])
  assert.equal(byProvider[0].models.length, 1)
  // A model hit keeps only the matching models and drops providers left empty.
  const byModel = plain(T.filterGroups(groups, 'PRO'))
  assert.deepEqual(byModel.map((g) => g.id), ['nexus-deepseek'])
  assert.deepEqual(byModel[0].models.map((m) => m.id), ['deepseek-v4.1-pro'])
  // Display names count too, and nothing matching is an empty catalog, not the full one.
  assert.deepEqual(plain(T.filterGroups(groups, 'opus')).map((g) => g.id), ['nexus-claude'])
  assert.deepEqual(plain(T.filterGroups(groups, 'zzz')), [])
})


test('countModels sums the models each provider offers', () => {
  assert.equal(T.countModels([]), 0)
  assert.equal(T.countModels([{ models: [{ id: 'a' }, { id: 'b' }] }, { models: [{ id: 'c' }] }]), 3)
})

test('the supervision interval field shows the stored value, or 600 when it is absent or malformed', () => {
  const cases = [
    [{}, '600'],
    [{ superviseIntervalSeconds: 1200 }, '1200'],
    [{ superviseIntervalSeconds: 0 }, '600'],
    [{ superviseIntervalSeconds: 'abc' }, '600'],
    [{ superviseIntervalSeconds: null }, '600'],
    [{ superviseIntervalSeconds: 12.5 }, '600'],
  ]
  for (const [initial, shown] of cases) {
    const field = mountField(fakeScope({ initial }))
    const input = field.input()
    assert.equal(input.props.value, shown)
    // Text plus a numeric keypad keeps "abc" observable; a number input would blank it.
    assert.equal(input.props.type, 'text')
    assert.equal(input.props.inputMode, 'numeric')
    assert.equal(input.props.min, 10)
    assert.equal(input.props.max, 86400)
    assert.equal(input.props.step, 1)
    assert.equal(input.props['aria-label'], 'supervise.label')
    field.view.unmount()
  }
})

test('invalid interval input is rejected, restored, and explained', async () => {
  for (const bad of ['9', '86401', '12.5', '1e3', 'abc']) {
    const scope = fakeScope({ initial: { superviseIntervalSeconds: 900 } })
    const field = mountField(scope)
    field.input().props.onChange({ target: { value: bad } })
    await field.input().props.onBlur()
    assert.equal(scope.calls.length, 0, bad)
    assert.equal(field.input().props.value, '900', bad)
    assert.equal(field.alert().kids[0], 'supervise.invalid', bad)
    field.view.unmount()
  }
})

test('a valid interval is written on blur with the snapshot revision', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: ' 900 ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseIntervalSeconds'], value: 900 }])
  assert.equal(scope.calls[0].expected, 1)
  assert.equal(scope.getSnapshot().value.superviseIntervalSeconds, 900)
  assert.equal(field.input().props.value, '900')
  assert.equal(field.alert(), undefined)
})

test('Enter also commits a valid interval', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '1800' } })
  await field.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseIntervalSeconds'], value: 1800 }])
})

test('an empty interval writes the 600 default, since a number field cannot clear to an empty string', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 1200 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '   ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseIntervalSeconds'], value: 600 }])
  assert.equal(field.input().props.value, '600')
})

test('an unchanged interval does not mutate the config', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: ' 600 ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 0)
  assert.equal(field.input().props.value, '600')
  assert.equal(field.alert(), undefined)
})

test('Escape abandons the edit and restores the stored interval', () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '9000' } })
  field.input().props.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.equal(scope.calls.length, 0)
  assert.equal(field.input().props.value, '600')
  assert.equal(field.alert(), undefined)
})

test('a rejected interval write is caught and shown without crashing', async () => {
  const scope = fakeScope({ reject: 'settings changed since it was read', initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '900' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.equal(field.alert().kids[0], 'supervise.saveFailed')
  assert.equal(field.input().props.value, '600')
})

test('the invalid-input hint disappears when its timer fires', async () => {
  const scope = fakeScope()
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '9' } })
  await field.input().props.onBlur()
  assert.ok(field.alert())
  const timer = timers[timers.length - 1]
  timer.fn()
  assert.equal(field.alert(), undefined)
})

test('the interval field follows a value changed elsewhere', () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  scope.externalSet({ superviseIntervalSeconds: 1200 })
  assert.equal(field.input().props.value, '1200')
})
