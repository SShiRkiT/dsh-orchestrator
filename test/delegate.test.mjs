import assert from 'node:assert/strict'
import test from 'node:test'
import { DELEGATE_TOOL, buildActivation, createDelegateTool, languageNote, readRoute } from '../lib/delegate.js'
import { mainAgentRule } from '../lib/rules.js'
import { createWriteLeases } from '../lib/write-lease.js'

const cfg = (provider, model, effort = '') => ({
  workerProvider: { get: () => provider },
  workerModel: { get: () => model },
  workerReasoningEffort: { get: () => effort },
})

/** An absolute declaration, so no test needs a `cwd` to resolve it. */
const SCOPE = ['C:/repo/src/a.js']

/** A fresh lease table per tool: the tool now refuses a dispatch that declares nothing. */
const leases = () => createWriteLeases()

test('readRoute returns provider and model, and omits an empty effort', () => {
  assert.deepEqual(readRoute(cfg('nexus-deepseek', 'deepseek-v4.1-flash')), {
    provider: 'nexus-deepseek',
    model: 'deepseek-v4.1-flash',
  })
})

test('readRoute carries a named effort and trims whitespace', () => {
  assert.deepEqual(readRoute(cfg(' nexus-claude ', ' claude-opus-5.5 ', ' high ')), {
    provider: 'nexus-claude',
    model: 'claude-opus-5.5',
    reasoningEffort: 'high',
  })
})

test('readRoute refuses an unconfigured route instead of inheriting the parent silently', () => {
  assert.throws(() => readRoute(cfg('', 'm')), /worker route is not configured/)
  assert.throws(() => readRoute(cfg('p', '  ')), /worker route is not configured/)
})

test('buildActivation shapes the spawn request with the route and parent delivery', () => {
  const parent = { id: 'main' }
  const signal = new AbortController().signal
  const route = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  const spec = buildActivation({ args: { description: 'fix parser', prompt: 'do it' }, parent, route, maxDepth: 2, signal })
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'fix parser')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.signal, signal)
  // DSH >= 0.2.2-rc.2 reads every field from the top level of the spec: there is no
  // `request` wrapper any more, and `name` is never set (the host assigns `agent-N`).
  assert.deepEqual(spec.prompt, [{ type: 'text', text: languageNote('do it') + 'do it' }])
  assert.equal(spec.parent, parent)
  assert.deepEqual(spec.agentOptions, route)
  assert.equal(spec.maxDepth, 2)
  assert.equal('cwd' in spec, false)
  assert.equal('request' in spec, false)
  assert.equal('name' in spec, false)
})

test('buildActivation passes cwd through and leaves out an undefined depth', () => {
  const spec = buildActivation({ args: { description: 'd', prompt: 'p', cwd: 'sub' }, parent: {}, route: {}, maxDepth: undefined })
  assert.equal(spec.cwd, 'sub')
  assert.equal('maxDepth' in spec, false)
  assert.equal('request' in spec, false)
})

test('the worker header asks for a final summary instead of a send_message report', () => {
  const header = languageNote('把这段代码重构一下')
  assert.match(header, /^用中文回复。/)
  assert.match(header, /完成任务时直接在回复中输出最终总结并结束本回合/)
  assert.match(header, /禁止调用 send_message 向父代理发送完成汇报/)
  assert.match(header, /主代理会自动接收你的收尾消息/)
  // The wording no longer depends on the request, so any prompt gets the same header.
  assert.equal(languageNote('do it'), header)
})

test('the tool is concurrency-safe, named delegate, and takes optional route overrides', () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config: cfg('p', 'm'), leases: leases() })
  assert.equal(tool.name, DELEGATE_TOOL)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(tool.parameters).sort(), [
    'cwd',
    'description',
    'expectedFingerprints',
    'expectedTargets',
    'isolation',
    'model',
    'prompt',
    'provider',
    'readOnly',
    'reasoning_effort',
    'team_task_id',
    'writeScope',
  ])
  // The author dialect spells requiredness per property, not as a `required` array.
  assert.equal(tool.parameters.prompt.required, true)
  assert.equal(tool.parameters.description.required, true)
  assert.equal('required' in tool.parameters.cwd, false)
  // The schema allows omission only because execute also supports explicit read-only mode.
  assert.equal('required' in tool.parameters.writeScope, false)
  assert.equal(tool.parameters.writeScope.type, 'array')
  assert.equal(tool.parameters.writeScope.items.type, 'string')
  assert.equal('default' in tool.parameters.writeScope, false)
  assert.equal(tool.parameters.readOnly.default, false)
  assert.match(tool.parameters.writeScope.description, /^非只读任务必填/)
  assert.match(tool.parameters.writeScope.description, /write-scope-conflict/)
  for (const key of ['provider', 'model', 'reasoning_effort']) {
    assert.equal('required' in tool.parameters[key], false)
  }
  for (const key of ['provider', 'model']) {
    assert.match(tool.parameters[key].description, /仅当用户显式点名/)
  }
  assert.match(tool.parameters.reasoning_effort.description, /仅当用户点名时才设置/)
})

test('execute rejects a missing prompt or description before touching the route', async () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config: cfg('p', 'm'), leases: leases() })
  await assert.rejects(
    () => tool.execute({ description: 'x', writeScope: SCOPE }, { agent: {} }),
    /non-empty prompt/,
  )
  await assert.rejects(
    () => tool.execute({ prompt: 'x', writeScope: SCOPE }, { agent: {} }),
    /non-empty description/,
  )
})

test('execute refuses a missing writeScope with write-scope-missing and starts nothing', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    leases: leases(),
  })
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  for (const args of [
    { description: 'a', prompt: 'x' },
    { description: 'a', prompt: 'x', writeScope: null },
  ]) {
    await assert.rejects(
      () => tool.execute(args, exec),
      (error) => error?.code === 'write-scope-missing',
      JSON.stringify(args),
    )
  }
  assert.equal(started, false, 'no worker may start without a declaration')
})

test('execute refuses an empty or malformed writeScope without a lease or a worker', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    leases: leases(),
  })
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  for (const writeScope of [[], ['ok.js', 42], { path: 'src/a.js' }]) {
    await assert.rejects(
      () => tool.execute({ description: 'a', prompt: 'x', writeScope }, exec),
      (error) => error?.code === 'write-scope-invalid',
      JSON.stringify(writeScope),
    )
  }
  assert.equal(started, false)
})

test('execute reads the route per call, so a changed route applies to the next delegation', async () => {
  const seen = []
  let route = ['nexus-deepseek', 'deepseek-v4.1-flash']
  const config = {
    workerProvider: { get: () => route[0] },
    workerModel: { get: () => route[1] },
    workerReasoningEffort: { get: () => '' },
  }
  const subagents = {
    resolveMaxDepth: () => 2,
    startActivation: async (spec) => {
      seen.push(spec.agentOptions)
      return { childId: 'child-' + seen.length }
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config, leases: leases() })
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  const first = await tool.execute({ description: 'a', prompt: 'x', writeScope: SCOPE }, exec)
  route = ['nexus-claude', 'claude-opus-5.5']
  await tool.execute({ description: 'b', prompt: 'y', writeScope: ['C:/repo/src/b.js'] }, exec)
  assert.equal(first.kind, 'activation')
  assert.equal(first.subagentId, 'child-1')
  assert.deepEqual(first.writeScope.scope, SCOPE)
  assert.equal(typeof first.writeScope.leaseId, 'string')
  assert.equal(seen[0].model, 'deepseek-v4.1-flash')
  assert.equal(seen[1].model, 'claude-opus-5.5')
})

test('execute fails loudly without a calling agent and does not start anything', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm'), leases: leases() })
  await assert.rejects(
    () => tool.execute({ description: 'a', prompt: 'x', writeScope: SCOPE }, { signal: new AbortController().signal }),
    /requires a calling agent/,
  )
  assert.equal(started, false)
})

test('an aborted signal stops execute before a worker is started', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm'), leases: leases() })
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () => tool.execute({ description: 'a', prompt: 'x', writeScope: SCOPE }, { agent: {}, signal: ac.signal }),
  )
  assert.equal(started, false)
})

test('a successful start reports the child and its declared scope', async () => {
  const seen = []
  const started = { childId: 'child-9', result: Promise.resolve('done') }
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => started }
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    leases: leases(),
    onStarted(parent, child, args) {
      seen.push({ parent, child, args })
    },
  })
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  const value = await tool.execute({ description: 'a', prompt: 'x', writeScope: SCOPE }, exec)
  assert.deepEqual(Object.keys(value).sort(), ['kind', 'subagentId', 'writeScope'])
  assert.equal(value.kind, 'activation')
  assert.equal(value.subagentId, 'child-9')
  assert.deepEqual(value.writeScope.scope, SCOPE)
  assert.equal(typeof value.writeScope.leaseId, 'string')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].parent, exec.agent)
  assert.equal(seen[0].child, started)
  assert.equal(seen[0].args.description, 'a')
})

test('a broken onStarted cannot affect dispatch or its result', async () => {
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => ({ childId: 'child-1' }) }
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  const claim = { description: 'a', prompt: 'x', writeScope: SCOPE }

  const throwing = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    leases: leases(),
    onStarted() {
      throw new Error('supervision is broken')
    },
  })
  const thrown = await throwing.execute(claim, exec)
  assert.equal(thrown.subagentId, 'child-1')
  assert.deepEqual(thrown.writeScope.scope, SCOPE)

  // An async callback that rejects is also swallowed, so it cannot surface later.
  const rejecting = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    leases: leases(),
    onStarted: async () => {
      throw new Error('async supervision is broken')
    },
  })
  const rejected = await rejecting.execute(claim, exec)
  assert.equal(rejected.subagentId, 'child-1')
  assert.deepEqual(rejected.writeScope.scope, SCOPE)
  await new Promise((resolve) => setTimeout(resolve, 0))
})

const exec = () => ({ agent: { id: 'main' }, signal: new AbortController().signal })

/** A delegate tool whose subagent service records the route every worker starts on. */
function recordingTool(config) {
  const seen = []
  const subagents = {
    resolveMaxDepth: () => 1,
    startActivation: async (spec) => {
      seen.push(spec.agentOptions)
      return { childId: 'child-' + seen.length }
    },
  }
  return { seen, tool: createDelegateTool({ defineTool: (d) => d, subagents, config, leases: leases() }) }
}

test('without an override the configured route is used unchanged', async () => {
  const { seen, tool } = recordingTool(cfg('nexus-deepseek', 'deepseek-v4.1-flash', 'high'))
  await tool.execute({ description: 'a', prompt: 'x', writeScope: SCOPE }, exec())
  assert.deepEqual(seen, [
    { provider: 'nexus-deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  ])
})

test('an explicit provider and model replace the configured route for that worker', async () => {
  // An empty configured route would throw if it were read, so the override must short-circuit it.
  const { seen, tool } = recordingTool(cfg('', ''))
  await tool.execute(
    { description: 'a', prompt: 'x', writeScope: SCOPE, provider: 'nexus-claude', model: 'claude-opus-5.5' },
    exec(),
  )
  assert.deepEqual(seen, [{ provider: 'nexus-claude', model: 'claude-opus-5.5' }])
})

test('provider and model must be given together, and nothing starts', async () => {
  const { seen, tool } = recordingTool(cfg('nexus-deepseek', 'deepseek-v4.1-flash'))
  for (const args of [
    { provider: 'nexus-claude' },
    { model: 'claude-opus-5.5' },
    { provider: 'nexus-claude', model: '  ' },
    { reasoning_effort: 'high' },
  ]) {
    await assert.rejects(
      () => tool.execute({ description: 'a', prompt: 'x', writeScope: SCOPE, ...args }, exec()),
      /"provider" and "model" must be given together/,
    )
    assert.equal(seen.length, 0, JSON.stringify(args))
  }
})

test('a non-string override field is refused instead of coerced', async () => {
  const { seen, tool } = recordingTool(cfg('p', 'm'))
  await assert.rejects(
    () => tool.execute({ description: 'a', prompt: 'x', writeScope: SCOPE, provider: 7, model: 'm' }, exec()),
    /"provider" must be a string/,
  )
  assert.equal(seen.length, 0)
})

test('reasoning_effort passes through with the override and is trimmed', async () => {
  const { seen, tool } = recordingTool(cfg('', ''))
  await tool.execute(
    {
      description: 'a',
      prompt: 'x',
      writeScope: SCOPE,
      provider: ' nexus-claude ',
      model: ' claude-opus-5.5 ',
      reasoning_effort: ' high ',
    },
    exec(),
  )
  assert.deepEqual(seen, [
    { provider: 'nexus-claude', model: 'claude-opus-5.5', reasoningEffort: 'high' },
  ])
})

test('the description keeps the main-agent rule, the whitelist and the execute contract', () => {
  // The rule names exactly what the gate lets through, so the test drives it with a
  // whitelist rather than a deny list: every other tool is blocked by not being named.
  const allowed = ['delegate', 'orchestrate', 'delegate_status', 'todo_write']
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents: {},
    config: cfg('p', 'm'),
    leases: leases(),
    allowedTools: allowed,
  })
  assert.equal(tool.description.startsWith(mainAgentRule(allowed)), true)
  assert.match(tool.description, /主代理可用工具（白名单驱动，其余全部禁用）: delegate, orchestrate, delegate_status, todo_write。/)
  // The planning-only rule, in one dense Chinese paragraph.
  assert.match(tool.description, /主代理规则：主代理只负责规划/)
  assert.match(tool.description, /通过 delegate 或 orchestrate 交子代理执行/)
  assert.match(tool.description, /勿试探调用被禁工具/)
  assert.match(tool.description, /同任务报错重试、参数纠偏、小幅返工或追问，优先用 send_message 复用原代理；仅在 writeScope 需变更、Worktree 已锁定、原上下文严重跑偏或无法继续时才新开 delegate。/)
  assert.match(tool.description, /已结束的写任务续跑前重抢原写租约并拍新基线，租约冲突或工作树已锁定时拒绝投递；本轮结束后写审计并再次释放租约。/)
  assert.match(tool.description, /新会话或压缩后直接推进，无需重新确认/)
  assert.match(tool.description, /独立任务在同一消息内并发派发，delegate 完成后直接结束回合等待子代理完成，勿空转轮询状态。/)
  assert.ok(tool.description.indexOf('优先用 send_message') < tool.description.indexOf('并发派发'))
  assert.match(tool.description, /子代理完成通知只代表执行结束，不等于写作用域审计通过。/)
  assert.match(tool.description, /若未见同帧审计通过确认，验收前按需调用一次 delegate_status 核验审计状态（pending \/ passed \/ failed）；只有 passed 才确认通过，勿盲等或循环轮询。/)
  // The retry contract.
  assert.match(tool.description, /子代理无收尾中断时插件会自动重试，期间勿重派/)
  assert.match(tool.description, /提示停止重试时按通知询问用户/)
  // The route override contract and removed clauses.
  assert.match(tool.description, /AGENTS\.md/)
  assert.match(tool.description, /严禁复用历史轮次或摘要中的模型/)
  assert.match(tool.description, /当前消息点名仅限本次派发，工作区指令指定的按其持续生效，两者冲突以当前消息为准/)
  assert.equal(tool.description.includes('run_code'), false)
  assert.equal(tool.description.includes('可直接调用 compress'), false)
  // Separator space between rule and body when enabled.
  assert.equal(tool.description.includes('。 把一个自包含任务'), true)
  // The body's handoff contract.
  assert.match(tool.description, /prompt 须写清目标、允许修改的文件、验收命令与兜底方案。非只读任务必填 writeScope/)
  assert.match(tool.description, /逻辑写后审计而非物理隔离/)
  assert.match(tool.description, /立即返回子代理 ID 及宿主提供的 agentName，二者均可填 send_message\.agent。结束时自动通知/)
  assert.match(tool.description, /严禁要求子代理用 send_message 汇报/)
  assert.match(tool.description, /独立 Worktree 交付物须经 worktree_manage 评审、合回或丢弃/)
  assert.match(tool.description, /多个独立任务在同一轮并发发起；同构批量请用 orchestrate/)
  // The route parameters carry the same one-line condition, where a model would be typed.
  for (const param of ['provider', 'model']) {
    const description = tool.parameters[param].description
    assert.match(description, /AGENTS\.md/, param)
    assert.match(description, /省略走 worker 路由/, param)
  }
})

test('the description only recommends delegate_status while it is on the live whitelist', () => {
  let allowed = ['delegate', 'delegate_status']
  const tool = createDelegateTool({
    defineTool: (definition) => definition,
    subagents: {},
    config: cfg('p', 'm'),
    leases: leases(),
    allowedTools: () => allowed,
  })

  assert.match(tool.description, /按需调用一次 delegate_status/)
  allowed = ['delegate']
  assert.doesNotMatch(tool.description, /delegate_status/)
  assert.match(tool.description, /子代理完成通知只代表执行结束，不等于写作用域审计通过。/)
})

test('a delegated child no longer sees this tool, so there is no worker variant', () => {
  // `lib/index.js` restricts the pair away from a child; the description is written for
  // the planner only and has no role-neutral twin.
  const tool = createDelegateTool({
    defineTool: (definition) => definition,
    subagents: {},
    config: cfg('p', 'm'),
    leases: leases(),
    allowedTools: ['delegate', 'orchestrate'],
  })
  assert.match(tool.description, /主代理规则：主代理只负责规划/)
  assert.equal('workerText' in tool, false)
  for (const key of ['provider', 'model']) {
    assert.match(tool.parameters[key].description, /仅当用户显式点名/)
  }
})

test('when dispatch mode is off, delegate drops the main-agent rule and refuses execution', async () => {
  let enabled = false
  let started = false
  const leaseTable = leases()
  const subagents = {
    resolveMaxDepth: () => 1,
    startActivation: async () => {
      started = true
      return { childId: 'child-1' }
    },
  }
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: { ...cfg('p', 'm'), enabled: { get: () => enabled } },
    leases: leaseTable,
    allowedTools: ['delegate', 'orchestrate'],
  })

  assert.equal(tool.description.includes('主代理规则：主代理只负责规划'), false)
  assert.equal(tool.description.includes('主代理可用工具'), false)
  assert.match(tool.description, /^把一个自包含任务交给子代理执行/)

  await assert.rejects(
    () => tool.execute({ description: 'a', prompt: 'x', writeScope: SCOPE }, exec()),
    /"delegate" is disabled while dispatch mode is off/,
  )
  assert.equal(started, false)
  assert.equal(leaseTable.size, 0)

  enabled = true
  assert.match(tool.description, /^主代理规则：主代理只负责规划/)
})
