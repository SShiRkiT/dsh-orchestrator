import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { createDelegateTool } from '../lib/delegate.js'
import { createOrchestrateTool } from '../lib/orchestrate.js'
import { SESSION_TOOLS_NAMESPACE } from '../lib/session-tools.js'

// Load the real plugin assembly without requiring the desktop host packages.
const modules = {
  '@deepseek-ai/schemastery': `
    const chain = () => Object.fromEntries(['default', 'volatile', 'description', 'min', 'max', 'step']
      .map((key) => [key, chain]))
    export default { object: chain, boolean: chain, string: chain, number: chain, array: chain }
  `,
  '@deepseek-ai/dsh-tools': 'export const defineTool = (spec) => spec',
}
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!Object.hasOwn(modules, specifier)) return nextResolve(specifier, context)
    return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true }
  },
})
const { apply } = await import('../lib/index.js')
hook.deregister()

const TEAM_CREATE = 'team_task_create'
const GUIDE = /先用 team_task_create 建立共享目标.*team_task_id/
const toolsWithTeam = ['delegate', 'orchestrate', TEAM_CREATE]

function declarations(t, { agentTeams, sessionStorage = false } = {}) {
  const root = { id: 'root', session: { id: 'root', header: {} } }
  const other = { id: 'other', session: { id: 'other', header: {} } }
  const agents = new Map([[root.id, root], [other.id, other]])
  const registered = new Map([[TEAM_CREATE, { name: TEAM_CREATE, description: 'Host Team creation' }]])
  const services = new Map()
  const disposers = []
  const config = { allowedTools: [...toolsWithTeam], superviseEnabled: false }
  if (agentTeams !== undefined) services.set('agentTeams', agentTeams)
  if (sessionStorage) {
    services.set('typert', { register: () => () => {} })
    services.set('storageDomain', {
      async open(spec) {
        const tables = new Map()
        return {
          table(name) {
            if (!tables.has(name)) tables.set(name, new Map())
            const rows = tables.get(name)
            return {
              entries: () => rows.entries(),
              async put(key, value) { rows.set(key, value) },
              async delete(key) { return rows.delete(key) },
            }
          },
          getGlobal: () => spec.global?.initial,
          async close() {},
        }
      },
    })
  }
  const ctx = {
    get: (name) => services.get(name),
    provide(name, service) {
      services.set(name, service)
      return () => services.delete(name)
    },
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    sessions: { get: (id) => agents.get(id)?.session },
    sessionProjections: {},
    subagents: {},
    tools: {
      register: (spec) => { registered.set(spec.name, spec) },
      view: () => ({ knownNames: [...registered.keys()] }),
      definitions: (_scope, toolSet) => [...registered.values()]
        .filter(({ name }) => toolSet?.has(name) ?? true),
    },
    effect: (setup) => disposers.push(setup()),
    on() {},
    logger: { info() {}, warn() {} },
  }
  apply(ctx, config)
  t.after(async () => {
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') await dispose()
    }
  })
  const description = (name, scope, toolSet) => ctx.tools.definitions(scope, toolSet)
    .find((tool) => tool.name === name)?.description
  return { config, root, other, description, remote: services.get(SESSION_TOOLS_NAMESPACE) }
}

test('the root Team mode controls shared-goal guidance live without changing native settings', (t) => {
  const enabled = new Set(['root'])
  const reads = []
  const writes = []
  const team = {
    isEnabled(agent) {
      assert.equal(this, team)
      reads.push(agent)
      return enabled.has(agent.session.id)
    },
    setEnabled(...args) { writes.push(args) },
  }
  const { root, other, description } = declarations(t, { agentTeams: team })
  const base = description('delegate')
  assert.doesNotMatch(base, GUIDE)
  assert.match(description('delegate', root), GUIDE)
  assert.match(description('delegate', root), /仍由 delegate \/ orchestrate 派发并管理写租约/)
  assert.doesNotMatch(description('orchestrate', root), GUIDE)
  assert.doesNotMatch(description('delegate', other), GUIDE)
  enabled.delete(root.id)
  assert.doesNotMatch(description('delegate', root), GUIDE)
  assert.equal(description('delegate'), base)
  assert.equal(reads[0], root)
  assert.ok(reads.includes(other))
  assert.deepEqual(writes, [])
})

test('an absent Team service or unavailable live Team root never breaks declarations', (t) => {
  const missing = declarations(t)
  assert.doesNotMatch(missing.description('delegate', missing.root), GUIDE)
  const unavailable = declarations(t, {
    agentTeams: { isEnabled() { throw Object.assign(new Error('no live root'), { code: 'UNAUTHORIZED' }) } },
  })
  assert.doesNotMatch(unavailable.description('delegate', unavailable.root), GUIDE)
})

test('the plugin gate and actual tool admission both suppress shared-goal guidance', (t) => {
  const { root, config, description } = declarations(t, { agentTeams: { isEnabled: () => true } })
  assert.doesNotMatch(description('delegate', root, new Set(['delegate', 'orchestrate'])), GUIDE)
  config.allowAgentTeam = false
  assert.doesNotMatch(description('delegate', root), GUIDE)
  assert.equal(description(TEAM_CREATE, root), undefined)
  config.allowAgentTeam = true
  assert.equal(description(TEAM_CREATE, root), 'Host Team creation')
  assert.match(description('delegate', root), GUIDE)
})

test('a session override suppresses guidance only for that root and can guide through orchestrate alone', async (t) => {
  const { root, other, remote, description } = declarations(t, {
    agentTeams: { isEnabled: () => true },
    sessionStorage: true,
  })
  const before = await remote.get(root.session.id)
  assert.equal(before.storageReady, true)
  const withoutCreate = await remote.set(root.session.id, ['delegate', 'orchestrate'], before.revision)
  assert.equal(withoutCreate.enabled, true)
  assert.doesNotMatch(description('delegate', root), GUIDE)
  assert.match(description('delegate', other), GUIDE)

  const batchOnly = await remote.set(root.session.id, ['orchestrate', TEAM_CREATE], withoutCreate.revision)
  assert.equal(batchOnly.enabled, true)
  assert.equal(description('delegate', root), undefined)
  assert.match(description('orchestrate', root), GUIDE)
  assert.doesNotMatch(description('orchestrate'), GUIDE)

  const cleared = await remote.clear(root.session.id, batchOnly.revision)
  assert.equal(cleared.enabled, false)
  assert.match(description('delegate', root), GUIDE)
})

function dispatchers() {
  const launches = []
  const dependencies = {
    defineTool: (spec) => spec,
    subagents: {
      resolveMaxDepth: () => 2,
      async startActivation(spec) {
        launches.push(spec)
        return {
          childId: `child-${launches.length}`,
          result: Promise.resolve({ stopReason: 'completed', output: '阶段产出' }),
        }
      },
    },
  }
  const exec = { agent: { id: 'root' }, signal: new AbortController().signal }
  const route = { provider: 'test', model: 'test', readOnly: true }
  const delegate = createDelegateTool(dependencies)
  const orchestrate = createOrchestrateTool(dependencies)
  return {
    launches,
    delegate: (args) => delegate.execute({ ...route, description: '单个任务', prompt: '完整委派说明', ...args }, exec),
    orchestrate: (args) => orchestrate.execute({
      ...route,
      items: ['原始输入'],
      stages: [{ name: 'prepare', prompt: '首阶段指令' }, { name: 'verify', prompt: '次阶段指令' }],
      ...args,
    }, exec),
  }
}

function assertReadOnlyReference(text) {
  assert.match(text, /共享目标（team_task_id）："t-7"/)
  assert.match(text, /若 team_task_get 可用，先调用 team_task_get\(\{ task_id: "t-7" \}\)/)
  assert.match(text, /只读查看共享目标作为对齐参考/)
  assert.match(text, /除非任务明确要求更新进度，否则不要改写共享任务状态/)
  assert.match(text, /若工具不可用或读取失败，按本提示中的完整自包含任务说明继续/)
}

test('delegate appends the trimmed Team goal after the unchanged self-contained prompt', async () => {
  const { launches, delegate } = dispatchers()
  await delegate()
  await delegate({ team_task_id: '  t-7\t' })
  const [plain, linked] = launches.map((spec) => spec.prompt[0].text)
  assert.match(plain, /完整委派说明/)
  assert.doesNotMatch(plain, /team_task_id|team_task_get/)
  assert.ok(linked.startsWith(`${plain}\n\n`))
  assertReadOnlyReference(linked)
})

test('orchestrate appends the Team goal to every stage without replacing input or previous output', async () => {
  const { launches, orchestrate } = dispatchers()
  await orchestrate()
  await orchestrate({ team_task_id: '  t-7\n' })
  const [first, second, linkedFirst, linkedSecond] = launches.map((spec) => spec.prompt[0].text)
  assert.match(first, /首阶段指令/)
  assert.match(second, /次阶段指令/)
  assert.match(second, /阶段产出/)
  for (const [plain, linked] of [[first, linkedFirst], [second, linkedSecond]]) {
    assert.match(plain, /原始输入/)
    assert.doesNotMatch(plain, /team_task_id|team_task_get/)
    assert.ok(linked.startsWith(`${plain}\n\n`))
    assertReadOnlyReference(linked)
  }
})

for (const name of ['delegate', 'orchestrate']) {
  test(`${name} rejects empty or non-string Team IDs without launching workers`, async () => {
    const { launches, [name]: dispatch } = dispatchers()
    const error = new RegExp(`${name}: "team_task_id" must be a non-empty string when provided`)
    for (const value of ['', ' \n\t', 23, null, {}]) {
      await assert.rejects(dispatch({ team_task_id: value }), error)
    }
    assert.deepEqual(launches, [])
  })
}
