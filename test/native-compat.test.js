import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  DEFAULT_BLOCKED_NATIVE_TOOLS,
  NATIVE_TEAM_TOOLS,
  installGate,
  resolveEffectiveAllowedTools,
} from '../lib/gate.js'
import { mainAgentRule } from '../lib/rules.js'
import * as surface from '../lib/tool-surface.js'

const TEAM = ['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']
const BLOCKED = ['subagent_fork', 'workflow']
const BASE = ['delegate', 'orchestrate']
const HOST = [...BASE, ...TEAM, ...BLOCKED, 'run_code', 'run_workflow']

function setup(options = {}, names = HOST) {
  let guard
  const tools = {
    definitions: () => names.map((name) => ({ name })),
    guard(callback) {
      guard = callback
    },
  }
  const root = { ctx: { tools } }
  const child = { options: { subagentDepth: 1 } }
  const gate = installGate({ agent: root, ...options })
  assert.equal(gate.guardError, undefined)
  surface.installToolSurface({ tools, ...options })
  return { root, child, guard, namesOf: (scope) => tools.definitions(scope).map(({ name }) => name) }
}

function assertNativeDenial(name, reason) {
  assert.match(reason, new RegExp(`"${name}"`))
  assert.match(reason, /ADR-0004 默认禁用/)
  assert.match(reason, name === 'subagent_fork' ? /缓存失效/ : /双编排体系冲突/)
  assert.match(reason, /请改用 delegate \/ orchestrate/)
}

test('原生兼容精确匹配宿主注册名，并由工具面重新导出共享定义', () => {
  assert.deepEqual(NATIVE_TEAM_TOOLS, TEAM)
  assert.deepEqual(DEFAULT_BLOCKED_NATIVE_TOOLS, BLOCKED)
  assert.equal(surface.NATIVE_TEAM_TOOLS, NATIVE_TEAM_TOOLS)
  assert.equal(surface.DEFAULT_BLOCKED_NATIVE_TOOLS, DEFAULT_BLOCKED_NATIVE_TOOLS)
  assert.equal(surface.resolveEffectiveAllowedTools, resolveEffectiveAllowedTools)
})

test('未传基础白名单时，独立工具面与守卫都只放行 Team 及 PTC 传输', () => {
  const { root, child, guard, namesOf } = setup()
  assert.deepEqual(namesOf(root), [...TEAM, 'run_code'])
  assert.deepEqual(namesOf(), HOST, '全局目录不受主代理限制')
  for (const name of BASE) assert.match(guard({ name }), /not available to the main agent/, name)
  for (const name of TEAM) {
    assert.equal(guard({ name }), undefined, name)
    assert.ok(namesOf(child).includes(name), name)
  }
  const older = setup({}, ['delegate', 'run_code'])
  assert.deepEqual(older.namesOf(older.root), ['run_code'])
  assert.deepEqual(resolveEffectiveAllowedTools(undefined, { defaults: BASE, availableTools: [] }), BASE)
  assert.deepEqual(resolveEffectiveAllowedTools(undefined, { defaults: BASE }), [...BASE, ...TEAM])
})

test('入口提供基础白名单时，工具面与守卫放行基础工具及宿主已注册的 Team 工具', () => {
  const defaults = surface.DEFAULT_ALLOWED_TOOLS
  assert.equal(defaults.length, 9)
  assert.equal(defaults[defaults.indexOf('delegate_status') + 1], 'worktree_manage')
  const availableTools = [...defaults, TEAM[0], ...BLOCKED, 'run_code']
  const allowed = () => resolveEffectiveAllowedTools(undefined, { defaults, availableTools })
  const { root, guard, namesOf } = setup({ allowed }, availableTools)

  const expected = [...defaults, TEAM[0]]
  assert.deepEqual(allowed(), expected)
  assert.deepEqual(namesOf(root), [...expected, 'run_code'])
  for (const name of expected) assert.equal(guard({ name }), undefined, name)
  for (const name of TEAM.slice(1)) assert.match(guard({ name }), /not available to the main agent/, name)
})

test('关闭调度后，根代理禁用四个调度与治理工具，子代理也不声明', () => {
  const { root, child, guard, namesOf } = setup(
    { allowed: [], enabled: () => false },
    [...new Set([...HOST, 'delegate', 'orchestrate', 'delegate_status', 'worktree_manage'])],
  )
  for (const name of ['delegate', 'orchestrate', 'delegate_status', 'worktree_manage']) {
    assert.ok(!namesOf(root).includes(name), name)
    assert.match(guard({ name, agent: root }), /disabled while dispatch mode is off/, name)
    assert.ok(!namesOf(child).includes(name), name)
  }
})

test('调度规则区分 Worktree 隔离、显式合回和回收，并禁止复用已回收的 childId', () => {
  const rule = mainAgentRule(surface.DEFAULT_ALLOWED_TOOLS)
  assert.match(rule, /独立 Git Worktree.*非 Git 目录使用写租约/)
  assert.match(rule, /isolation: "auto" \| "worktree" \| "shared"/)
  assert.match(rule, /Worktree 不自动合回；子代理交付后由主代理评审并决定是否合回/)
  assert.match(rule, /worktree_manage（list \/ inspect \/ merge \/ discard \/ prune）/)
  assert.match(rule, /Worktree 已锁定或合回.*allowNewReason/)
  assert.match(rule, /租约冲突或工作树已锁定时拒绝投递/)
  assert.doesNotMatch(mainAgentRule([]), /worktree_manage/, '不要求调用白名单之外的工具')
})

test('关闭 Team 后过滤并拒绝四个工具；开关动态生效且不限制子代理', () => {
  let allowAgentTeam = true
  const { root, child, guard, namesOf } = setup({ allowed: [...BASE, ...TEAM], allowAgentTeam: () => allowAgentTeam })
  assert.deepEqual(namesOf(root), [...BASE, ...TEAM, 'run_code'])
  allowAgentTeam = false
  assert.deepEqual(namesOf(root), [...BASE, 'run_code'])
  for (const name of TEAM) {
    assert.match(guard({ name }), /allowAgentTeam: false/, name)
    assert.equal(guard({ name, agent: child }), undefined, name)
    assert.ok(namesOf(child).includes(name), name)
  }
  allowAgentTeam = true
  assert.deepEqual(namesOf(root), [...BASE, ...TEAM, 'run_code'])
  assert.equal(guard({ name: TEAM[0] }), undefined)
})

test('不从缺省名单启用 fork 或 workflow；显式白名单和关闭调度仍可共存', () => {
  assert.deepEqual(resolveEffectiveAllowedTools(undefined, { defaults: [...BASE, ...BLOCKED] }), [...BASE, ...TEAM])
  let allowed
  let enabled = true
  const { root, child, guard, namesOf } = setup({ allowed: () => allowed, enabled: () => enabled })
  for (const name of BLOCKED) {
    assert.ok(!namesOf(root).includes(name), name)
    assertNativeDenial(name, guard({ name }))
    assert.ok(namesOf(child).includes(name), name)
    assert.equal(guard({ name, agent: child }), undefined, name)
  }
  assert.doesNotMatch(guard({ name: 'run_workflow' }), /ADR-0004/)
  allowed = [...BASE, ...BLOCKED]
  assert.deepEqual(namesOf(root), [...BASE, ...BLOCKED, 'run_code'])
  for (const name of BLOCKED) assert.equal(guard({ name }), undefined, name)
  allowed = BASE
  enabled = false
  for (const name of BLOCKED) {
    assert.ok(namesOf(root).includes(name), name)
    assert.equal(guard({ name }), undefined, name)
  }
})

test('run_code 保留词法防护，嵌套执行仍以同一白名单守卫拦截', async () => {
  let allowed = resolveEffectiveAllowedTools(undefined, { defaults: BASE })
  const { root, guard } = setup({ allowed: () => allowed })
  const ran = []
  const parent = Symbol('模拟宿主 PTC 父调用')
  const tools = Object.fromEntries(HOST.map((name) => [name, (args) => {
    const denied = guard({ name, agent: root, parent, arguments: args })
    if (denied !== undefined) return { denied }
    ran.push(name)
    return { ok: true }
  }]))
  const execute = async (code, name) => {
    const denied = guard({ name: 'run_code', agent: root, arguments: { code } })
    if (denied !== undefined) return { denied }
    return runInNewContext(`(async () => { ${code} })()`, { tools, name })
  }
  assert.equal((await execute('return await tools.delegate({})')).ok, true)
  assert.equal((await execute('return await tools.team_task_list({})')).ok, true)
  for (const name of BLOCKED) {
    assertNativeDenial(name, (await execute(`return await tools.${name}({})`)).denied)
    assertNativeDenial(name, (await execute('return await tools[name]({})', name)).denied)
  }
  assert.match((await execute('return process.pid')).denied, /cannot reach the Node\.js or host runtime/)
  assert.deepEqual(ran, ['delegate', 'team_task_list'])

  allowed = [...allowed, 'run_code']
  for (const name of BLOCKED) {
    assertNativeDenial(name, (await execute('return await tools[name]({})', name)).denied)
  }
  allowed = [...allowed, ...BLOCKED]
  for (const name of BLOCKED) assert.equal((await execute('return await tools[name]({})', name)).ok, true)
})

test('显式空白名单保留拒绝语义，以及 run_code 传输例外', () => {
  const allowed = resolveEffectiveAllowedTools([], { defaults: BASE })
  const { root, guard, namesOf } = setup({ allowed })
  assert.deepEqual(allowed, [])
  assert.deepEqual(namesOf(root), ['run_code'])
  for (const name of [...BASE, ...TEAM]) assert.match(guard({ name }), /not available to the main agent/, name)
  assert.equal(guard({ name: 'run_code', arguments: { code: 'return 1' } }), undefined)
})

function clientHelpers() {
  let exported
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => {
          exported = factory((name) => {
            if (name === 'react') return { createElement: () => {} }
            throw new Error(`Unexpected client dependency: ${name}`)
          })
        },
      },
    },
  })
  return exported.__test
}

test('Web 客户端的工具副本与后端一致，已注册工具仅缺省启用 Team', () => {
  const client = clientHelpers()
  assert.deepEqual([...client.NATIVE_TEAM_TOOLS], NATIVE_TEAM_TOOLS)
  assert.deepEqual([...client.DEFAULT_BLOCKED_NATIVE_TOOLS], DEFAULT_BLOCKED_NATIVE_TOOLS)
  assert.equal(client.ALLOW_AGENT_TEAM_KEY, 'allowAgentTeam')
  const toolCatalog = [...TEAM.slice(0, 2), ...BLOCKED]
  const defaults = surface.DEFAULT_ALLOWED_TOOLS
  assert.deepEqual([...client.DEFAULT_ALLOWED_TOOLS], defaults)
  assert.ok(TEAM.every((name) => !client.toolListOf({}).includes(name)))
  assert.ok(toolCatalog.every((name) => client.toolListOf({ toolCatalog }).includes(name)))
  for (const value of [
    {},
    { allowAgentTeam: false },
    { allowedTools: [] },
    { allowedTools: [...TEAM, ...BLOCKED] },
    { allowedTools: [...TEAM, ...BLOCKED], allowAgentTeam: false },
  ]) {
    const expected = resolveEffectiveAllowedTools(value.allowedTools, {
      defaults,
      availableTools: toolCatalog,
      allowAgentTeam: value.allowAgentTeam,
    })
    assert.deepEqual([...client.allowedSetOf({ ...value, toolCatalog })], expected)
  }
})

test('Web 复选框回到动态默认时不固定名单；关闭 Team 时保留显式配置', () => {
  const client = clientHelpers()
  const defaults = [...client.DEFAULT_ALLOWED_TOOLS]
  const toolCatalog = [...TEAM, ...BLOCKED]
  const plain = (value) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(client.allowOps([...defaults, ...TEAM], { toolCatalog })), [
    { op: 'unset', path: ['allowedTools'] },
  ])
  assert.deepEqual(plain(client.allowOps([...defaults, ...TEAM, 'workflow'], { toolCatalog })), [
    { op: 'set', path: ['allowedTools'], value: [...defaults, ...TEAM, 'workflow'] },
  ])
  assert.deepEqual(plain(client.allowOps(defaults, { allowAgentTeam: false, allowedTools: [TEAM[0]], toolCatalog })), [
    { op: 'set', path: ['allowedTools'], value: [...defaults, TEAM[0]] },
  ])
})
