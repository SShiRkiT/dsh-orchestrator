import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyProgress, composeNotice, createSupervisor, summarize } from '../lib/supervise.js'
import { normalizeScope } from '../lib/write-scope.js'

const event = (seq, type, data = {}, time = seq * 1_000) => ({ seq, type, data, time })
const call = (seq, name, args, callId) => event(seq, 'tool/call', { name, arguments: args, callId })
const result = (seq, data) => event(seq, 'tool/result', data)

function hostResult(seq, callId, text, isError) {
  return result(seq, {
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      isError,
      content: [{ type: 'text', text }],
    },
  })
}

test('advancing keeps differing tool targets and ordinary text as progress without report tags', () => {
  const events = [
    event(1, 'step/start'),
    call(2, 'read', { path: 'lib/a.js' }, 'first'),
    hostResult(3, 'first', 'Source text includes Error: and FAILED', false),
    call(4, 'read', { path: 'lib/b.js' }, 'second'),
    hostResult(5, 'second', 'Text referenced ENOENT in the documentation', false),
    event(6, 'assistant/message', { message: '已核对两个实现入口，开始比较回归用例。' }),
  ]
  const semantic = classifyProgress(events, { prevSummary: { lastSeq: 1 }, elapsedMs: 900_000 })
  assert.equal(semantic.status, 'advancing')
  assert.equal(semantic.severity, 'normal')
  assert.deepEqual(semantic.metrics, {
    errorStreak: 0,
    repeatStreak: 1,
    scopeViolations: 0,
    toolCallsInWindow: 2,
  })
  assert.deepEqual(summarize(events).semantic, semantic)
})

test('tool_loop uses stable argument signatures and clears an old streak after a new target', () => {
  const events = [
    call(1, 'read', { path: 'lib/a.js', limit: 2 }),
    call(2, 'read', { limit: 2, path: 'lib/a.js' }),
    call(3, 'read', '{"limit":2,"path":"lib/a.js"}'),
  ]
  const semantic = classifyProgress(events)
  assert.equal(semantic.status, 'tool_loop')
  assert.equal(semantic.metrics.repeatStreak, 3)
  assert.deepEqual(semantic.evidence.map(({ seq }) => seq), [1, 2, 3])
  assert.equal(classifyProgress(events, { repeatThreshold: 4 }).status, 'advancing')
  assert.equal(classifyProgress([...events, call(4, 'read', { path: 'lib/b.js' })]).status, 'advancing')
})

test('tool_loop also identifies two repeatedly alternating lookups without new text', () => {
  const events = Array.from({ length: 6 }, (_, index) => index % 2 === 0
    ? call(index + 1, 'read', { path: 'lib/a.js' })
    : call(index + 1, 'grep', { pattern: 'needle' }))
  assert.equal(classifyProgress(events).status, 'tool_loop')
  assert.equal(classifyProgress([...events, event(7, 'assistant/message', { content: '找到入口。' })]).status,
    'advancing')
})

test('error_loop correlates native tool results and detects exit codes and isError without echoing stdout', () => {
  const events = [
    call(1, 'bash', { command: 'npm test' }, 'a'),
    call(2, 'read', { path: 'missing.js' }, 'b'),
    hostResult(3, 'a', '任意输出不应摘要\n[exit code: 1]', false),
    hostResult(4, 'b', 'permission denied', true),
    call(5, 'bash', { command: 'node --test' }, 'c'),
    result(6, { callId: 'c', result: { exit_code: 7 } }),
  ]
  const semantic = classifyProgress(events)
  assert.equal(semantic.status, 'error_loop')
  assert.equal(semantic.severity, 'medium-high')
  assert.equal(semantic.metrics.errorStreak, 3)
  assert.deepEqual(semantic.evidence, [
    { seq: 3, tool: 'bash', marker: '[exit code: 1]' },
    { seq: 4, tool: 'read', marker: '工具错误标记' },
    { seq: 6, tool: 'bash', marker: '[exit code: 7]' },
  ])
  assert.equal(semantic.reason.includes('任意输出'), false)
})

test('error_loop flags three of four with an unrecovered latest failure and clears on a success', () => {
  const events = [
    result(1, { name: 'bash', result: 'Error: not found' }),
    result(2, { name: 'bash', text: '[exit code: 0]' }),
    result(3, { name: 'bash', output: 'tests FAILED' }),
    result(4, { name: 'read', text: 'ENOENT' }),
  ]
  const semantic = classifyProgress(events)
  assert.equal(semantic.status, 'error_loop')
  assert.equal(semantic.metrics.errorStreak, 2)
  assert.match(semantic.reason, /最近 4 次工具结果中 3 次失败/)
  assert.equal(classifyProgress([...events, result(5, { name: 'bash', output: '[exit code: 0]' })]).status,
    'advancing')
})

test('scope_drift flags read-only write attempts, but not read paths or quoted non-redirections', () => {
  const context = { readOnly: true }
  const edit = classifyProgress([call(1, 'edit', { file_path: 'lib/a.js' })], context)
  assert.equal(edit.status, 'scope_drift')
  assert.equal(edit.severity, 'high')
  assert.match(edit.reason, /只读子代理调用了 edit（目标：lib\/a\.js）/)
  assert.equal(classifyProgress([call(1, 'delete')], context).status, 'scope_drift')
  assert.equal(classifyProgress([call(1, 'bash', { command: 'echo data > "out file.txt"' })], context).status,
    'scope_drift')
  assert.equal(classifyProgress([call(1, 'bash', { command: 'touch "out file.txt"' })], context).status,
    'scope_drift')
  assert.equal(classifyProgress([
    call(1, 'read', { path: 'lib/a.js' }),
    call(2, 'bash', { command: 'echo "x > y" 2>&1 > /dev/null' }),
    call(3, 'send_message', { to: 'lead', message: '仍在核对' }),
  ], context).status, 'advancing')
})

test('scope_drift compares file names, directory boundaries and relative traversal on POSIX', () => {
  const context = { cwd: '/work/repo', writeScope: ['lib/**', 'README.md'] }
  const allowed = [call(1, 'edit', { filePath: './lib/a.js' }), call(2, 'write', { target: '/work/repo/README.md' })]
  assert.equal(classifyProgress(allowed, context).status, 'advancing')
  const violation = classifyProgress([...allowed, call(3, 'delete', { path: 'lib/../library/a.js' })], context)
  assert.equal(violation.status, 'scope_drift')
  assert.equal(violation.metrics.scopeViolations, 1)
  assert.equal(violation.evidence[0].target, 'lib/../library/a.js')
  assert.equal(classifyProgress([call(1, 'write', { path: 'dist/out.js' })], { writeScope: ['lib/'] }).status,
    'scope_drift')
  assert.equal(classifyProgress([call(1, 'write', { path: 'lib/a.js' })], { writeScope: ['/work/repo/lib/'] }).status,
    'advancing', 'no absolute comparison is inferred without cwd')
})

test('scope_drift handles Windows mixed separators, folding, different drives and normalized directory entries', () => {
  const cwd = 'C:\\Work\\Repo'
  const entries = normalizeScope(['lib/**', 'README.md'], cwd).entries
  const inScope = [call(1, 'write', { path: 'c:/work/repo/LIB/a.js' }), call(2, 'edit', { target: 'readme.MD' })]
  assert.equal(classifyProgress(inScope, { cwd, writeScope: entries }).status, 'advancing')
  assert.equal(classifyProgress([call(1, 'edit', { path: 'lib\\..\\lib-other\\a.js' })], {
    cwd, writeScope: ['C:\\WORK\\REPO\\lib\\'],
  }).status, 'scope_drift')
  assert.equal(classifyProgress([call(1, 'write', { path: 'D:\\work\\repo\\lib\\a.js' })], {
    cwd, writeScope: entries,
  }).status, 'scope_drift')
})

test('priority is scope_drift, then error_loop, then tool_loop, then stalled', () => {
  const events = Array.from({ length: 3 }, (_, index) => [
    call(index * 2 + 1, 'write', { path: 'dist/out.js' }),
    result(index * 2 + 2, { isError: true }),
  ]).flat()
  const scope = classifyProgress(events, { readOnly: true, now: 1_000_000 })
  assert.equal(scope.status, 'scope_drift')
  assert.equal(scope.metrics.errorStreak, 3)
  assert.equal(scope.metrics.repeatStreak, 3)
  assert.equal(scope.metrics.scopeViolations, 3)
  assert.equal(classifyProgress(events, { now: 1_000_000 }).status, 'error_loop')
  assert.equal(classifyProgress(events.filter(({ type }) => type === 'tool/call'), { now: 1_000_000 }).status,
    'tool_loop')
})

test('stalled disregards log noise and repeated assistant text after the previous inspection', () => {
  const events = [
    event(1, 'assistant/message', { text: '在核对入口。' }),
    event(2, 'checkpoint'),
    event(3, 'assistant/message', { content: [{ type: 'thinking', text: 'internal' }] }),
    event(4, 'assistant/message', { text: ' 在核对入口。 ' }),
  ]
  const context = { prevSummary: { lastSeq: 1 }, elapsedMs: 600_000 }
  assert.equal(classifyProgress(events, context).status, 'stalled')
  assert.equal(classifyProgress(events, { ...context, elapsedMs: 1_000 }).status, 'advancing')
  assert.equal(classifyProgress([...events, event(5, 'step/start')], context).status, 'advancing')
  assert.equal(classifyProgress([], { elapsedMs: 600_000 }).status, 'stalled')
})

test('stalled accounts for a long in-flight call and for actual timestamps', () => {
  const events = [call(1, 'bash', { command: 'npm test' }, 'long')]
  const context = { prevSummary: { lastSeq: 1 }, startedAt: 0, elapsedMs: 600_000 }
  assert.equal(classifyProgress(events, { ...context, now: 601_000 }).status, 'advancing')
  assert.equal(classifyProgress(events, { ...context, now: 1_201_000 }).status, 'stalled')
  assert.equal(classifyProgress([
    ...events,
    { ...hostResult(2, 'long', '[exit code: 0]', false), time: 1_200_000 },
  ], { ...context, now: 1_201_000 }).status, 'advancing')
})

test('supervisor forwards semantic rows to the existing delivery pipeline without any worker report contract', async () => {
  const logs = new Map([
    ['read-only', [call(1, 'edit', { file_path: 'lib/worker.js' })]],
    ['scoped', [call(1, 'write', { target: '..\\outside.js' })]],
    ['normal', [event(1, 'assistant/message', { text: '我正在核对返回值。' })]],
  ])
  const deliveries = []
  const supervisor = createSupervisor({
    config: { intervalSeconds: 10, notifyOnNoProgress: true },
    readEvents: (id) => logs.get(id),
    deliver: (...args) => { deliveries.push(args); return 'queued' },
  })
  const track = (childId, metadata) => supervisor.track({ childId, parentId: 'parent', startedAt: 0, ...metadata })
  track('read-only', { readOnly: true })
  track('scoped', { cwd: 'D:\\Repo', writeScope: ['lib/**'] })
  track('normal')
  await supervisor.tick(10_000)
  assert.equal(deliveries.length, 1)
  const [parent, text, ids, meta] = deliveries[0]
  assert.equal(parent, 'parent')
  assert.deepEqual(ids, ['read-only', 'scoped', 'normal'])
  assert.deepEqual(meta.rows.map(({ semantic }) => semantic.status), ['scope_drift', 'scope_drift', 'advancing'])
  assert.equal(text, composeNotice(meta.rows, meta.composeMeta))
  assert.match(text, /语义诊断：\[越界漂移\] 只读子代理调用了 edit（目标：lib\/worker\.js）/)
  assert.match(text, /语义诊断：\[越界漂移\] write 的写入目标不在声明作用域内/)
  assert.equal((text.match(/语义诊断：/g) ?? []).length, 2)
  assert.doesNotMatch(text, /progress|blocked/)
  await supervisor.tick(20_000)
  assert.equal(deliveries.length, 2)
  assert.match(deliveries[1][1], /语义诊断：\[停滞无进展\]/)
})

test('a cold-resumed worker does not carry pre-interruption diagnostics forward', async () => {
  const old = Array.from({ length: 3 }, (_, index) => call(index + 1, 'write', { path: 'old.js' }))
  const logs = [...old]
  const rows = []
  const supervisor = createSupervisor({
    config: { intervalSeconds: 10 },
    readEvents: () => logs,
    deliver: (_parent, _text, _children, meta) => { rows.push(...meta.rows); return 'queued' },
  })
  supervisor.track({ childId: 'child', parentId: 'parent', readOnly: true, startedAt: 0, resumed: true, sinceSeq: 3 })
  await supervisor.tick(10_000)
  assert.equal(rows.length, 0)
  logs.push({ ...call(4, 'read', { path: 'new.js' }), time: 18_000 })
  await supervisor.tick(20_000)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].semantic.status, 'advancing')
  assert.equal(rows[0].semantic.metrics.toolCallsInWindow, 1)
})
