/**
 * Declarative fan-out / pipeline orchestration. Dependency-free: `defineTool` and
 * the subagent service are passed in, so scheduling and result shaping are unit
 * testable without the DSH runtime.
 *
 * One worker call per item and stage; stages of one item are strictly sequential,
 * different items are independent (no global stage barrier). Every worker uses the
 * same route — the configured one, unless this call carries an explicit
 * provider/model override the user asked for — `delivery: 'caller'` and, when the
 * stage declares one, `outputSchema`.
 *
 * A batch always declares one top-level `writeScope`; the whole batch then holds a single
 * lease from before the first worker starts until its last worker settles. A conflict
 * with another writer refuses the batch atomically (no worker starts) instead of
 * trimming items — see `docs/zh/03-issue-0001-write-scope.md` §6.7.2.
 */

import { DELIVERY, LIMITS, ORCHESTRATE_TOOL, ORCHESTRATION_KIND, disabledToolMessage } from './api.js'
import { assertObjectSchema, isJsonValue, validateJsonSchemaValue } from './schema.js'
import { buildSpawnActivation, isDispatchEnabled, readRoute, readRouteOverride } from './worker.js'
import { claimWriteScope, releaseWriteScope, requireWriteScope, writeScopeNotice } from './write-scope-tool.js'

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(message) {
  throw new Error(`orchestrate: ${message}`)
}

function within(value, bounds) {
  return value >= bounds.min && value <= bounds.max
}

const ARGUMENT_KEYS = Object.freeze([
  'cwd',
  'items',
  'stages',
  'maxConcurrency',
  'provider',
  'model',
  'reasoning_effort',
  'writeScope',
])
const STAGE_KEYS = Object.freeze(['name', 'prompt', 'schema'])

/**
 * Reject fields the tool does not implement. Silently ignoring a typo (or a
 * route override placed on a stage instead of the call) would run workers with a
 * different configuration than the caller believes, so unknown keys fail up front.
 */
function rejectUnknownKeys(value, allowed, at) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    fail(`${at} has unknown field "${key}" (allowed: ${allowed.join(', ')})`)
  }
}

/**
 * Validate and normalise `execute` arguments. Everything that can fail globally
 * (shape, unknown fields, limits, stage schema) fails here, before any worker starts.
 */
export function parseOrchestrateArgs(args) {
  if (!isPlainObject(args)) fail('arguments must be an object')
  rejectUnknownKeys(args, ARGUMENT_KEYS, 'arguments')

  if (!Array.isArray(args.items)) fail('"items" must be a JSON array')
  if (!within(args.items.length, LIMITS.items)) {
    fail(`"items" must contain ${LIMITS.items.min}..${LIMITS.items.max} entries (got ${args.items.length})`)
  }
  args.items.forEach((item, index) => {
    if (!isJsonValue(item)) fail(`item ${index + 1} is not a lossless JSON value`)
  })

  if (!Array.isArray(args.stages)) fail('"stages" must be an array')
  if (!within(args.stages.length, LIMITS.stages)) {
    fail(`"stages" must contain ${LIMITS.stages.min}..${LIMITS.stages.max} stages (got ${args.stages.length})`)
  }
  const stages = args.stages.map((stage, index) => {
    const at = `stage ${index + 1}`
    if (!isPlainObject(stage)) fail(`${at} must be an object`)
    rejectUnknownKeys(stage, STAGE_KEYS, at)
    if (typeof stage.name !== 'string' || stage.name.trim() === '') fail(`${at} requires a non-empty "name"`)
    if (typeof stage.prompt !== 'string' || stage.prompt.trim() === '') fail(`${at} requires a non-empty "prompt"`)
    if (stage.schema !== undefined) {
      try {
        assertObjectSchema(stage.schema, `${at}.schema`)
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    }
    return {
      name: stage.name,
      prompt: stage.prompt,
      ...(stage.schema === undefined ? {} : { schema: stage.schema }),
    }
  })

  if (args.maxConcurrency !== undefined) {
    if (!Number.isInteger(args.maxConcurrency) || !within(args.maxConcurrency, LIMITS.maxConcurrency)) {
      fail(
        `"maxConcurrency" must be an integer in ${LIMITS.maxConcurrency.min}..${LIMITS.maxConcurrency.max} (got ${JSON.stringify(args.maxConcurrency)})`,
      )
    }
  }

  let cwd
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== 'string') fail('"cwd" must be a string')
    cwd = args.cwd.trim()
    if (cwd === '') fail('"cwd" must be a non-empty string when provided')
  }

  // `writeScope` is carried, not interpreted: the scope layer validates its contents and
  // reports `write-scope-*`, the one code both tools show. The field is required by the
  // schema and checked by `execute` before this parser runs, so the plan always carries it.
  const { writeScope } = args

  return {
    cwd,
    items: args.items,
    stages,
    maxConcurrency: args.maxConcurrency ?? LIMITS.maxConcurrency.default,
    writeScope,
  }
}

/**
 * A worker-visible prompt: stage instruction, original item and previous output.
 *
 * `writeScope` is the batch's normalized scope and is always appended as a constraint
 * paragraph: every batch declares one, so there is no undeclared variant to preserve.
 */
export function buildStagePrompt({
  stage,
  stageIndex,
  stageCount,
  item,
  itemIndex,
  itemCount,
  previous,
  writeScope,
}) {
  const lines = [
    stage.prompt.trim(),
    '',
    '你在批处理任务中负责其中一个阶段，看不到父会话，所需信息都在下面。',
    '',
    `阶段 "${stage.name}"（${stageIndex + 1}/${stageCount}），条目 ${itemIndex + 1}/${itemCount}。`,
    '',
    '原始条目 (JSON):',
    JSON.stringify(item),
    '',
  ]
  if (previous === undefined) {
    lines.push('这是第一个阶段，请直接产出该条目在本阶段的结果。')
  } else {
    lines.push(`上一阶段 "${previous.stageName}" 输出 (JSON):`)
    lines.push(JSON.stringify(previous.output))
    lines.push('')
    lines.push('在此基础上继续，产出该条目在本阶段的结果。')
  }
  if (stage.schema !== undefined) {
    lines.push('')
    lines.push(
      '本阶段返回一个 JSON 对象：优先调用一次 structured_output 工具，把最终对象传给它，不要用文本作答。',
    )
    lines.push(
      '若 structured_output 不可用，则只输出符合阶段 schema 的 JSON 对象，不要解释、不要 Markdown、不要代码块。',
    )
  }
  // Unlike a single delegation, a batch has no per-worker description carrying the
  // declaration, so the constraint always travels with the prompt.
  lines.push('')
  lines.push(writeScopeNotice(writeScope))
  return lines.join('\n')
}

/** Text parts of a worker's content output, concatenated in order. */
export function collectText(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  let text = ''
  for (const part of output) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      text += part.text
    }
  }
  return text
}

/**
 * Turn one settled worker result into the stage output.
 *
 * `run.result.structured` is authoritative when present: an invalid structured
 * value fails the stage and is never replaced by the text.
 *
 * A schema stage may also be recovered from text. A host that never dispatches
 * `structured_output` ends a text answer as `error` even though the worker
 * finished, so for schema stages `completed` and `error` are both accepted; any
 * other stop reason (aborted, max-tokens, refusal, ...) is never recovered. The
 * concatenated text must be one strict JSON document that fully validates; the
 * text itself is never echoed, only the schema violations.
 */
export function readStageOutput(stage, result) {
  if (result === null || typeof result !== 'object') throw new Error('worker returned no result')
  const schema = stage.schema
  const recoverable = result.stopReason === 'completed' || (schema !== undefined && result.stopReason === 'error')
  if (!recoverable) {
    throw new Error(`worker stopped with reason "${String(result.stopReason)}" before finishing the stage`)
  }
  const text = collectText(result.output)

  if (schema === undefined) return text

  if (Object.hasOwn(result, 'structured') && result.structured !== undefined) {
    const violations = validateJsonSchemaValue(schema, result.structured)
    if (violations.length > 0) {
      throw new Error(`structured result does not match the stage schema: ${violations.join('; ')}`)
    }
    return result.structured
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      'stage schema requires a structured result, but the worker returned text that is not strictly JSON (or no text)',
    )
  }
  const violations = validateJsonSchemaValue(schema, parsed)
  if (violations.length > 0) {
    throw new Error(`text result does not match the stage schema: ${violations.join('; ')}`)
  }
  return parsed
}

function abortReason(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  if (reason !== undefined) return new Error(String(reason))
  const error = new Error('orchestrate was aborted')
  error.name = 'AbortError'
  return error
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bounded worker slots. A slot is held from just before `startActivation` until
 * the worker's result has been read and the child disposed, so the cap bounds
 * live workers rather than just calls in flight.
 */
function createLimiter(limit) {
  let active = 0
  const waiters = []
  return {
    get active() {
      return active
    },
    acquire(signal) {
      signal?.throwIfAborted()
      if (active < limit) {
        active += 1
        return Promise.resolve()
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: undefined }
        waiter.onAbort = () => {
          const at = waiters.indexOf(waiter)
          if (at !== -1) waiters.splice(at, 1)
          reject(abortReason(signal))
        }
        signal?.addEventListener('abort', waiter.onAbort, { once: true })
        waiters.push(waiter)
      })
    },
    release() {
      const waiter = waiters.shift()
      if (waiter === undefined) {
        active -= 1
        return
      }
      // The slot moves to the next waiter; `active` stays the same.
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    },
  }
}

/**
 * Run the plan. Returns the unified result, or throws for a global failure
 * (abort, oversized result, an internal error outside per-item isolation).
 *
 * `writeScope` is the batch's normalized scope, already leased by the caller; it only
 * reaches the worker prompts, never the result payload. It is required: every batch
 * declares one.
 */
export async function runOrchestration({
  plan,
  parent,
  route,
  maxDepth,
  subagents,
  signal,
  writeScope,
}) {
  const { cwd, items, stages, maxConcurrency } = plan
  const limiter = createLimiter(maxConcurrency)
  const results = new Array(items.length).fill(null)
  const errors = []
  const active = new Set()
  const disposals = new Map()
  let agentsStarted = 0

  // A handle disposed before its result is read would otherwise leave a rejected
  // result promise unhandled; consume it best effort.
  const observeResult = (handle) => {
    const result = handle.result
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(undefined, () => {})
    }
  }

  const dispose = (handle) => {
    if (handle === null || typeof handle !== 'object' || typeof handle.dispose !== 'function') {
      return Promise.resolve()
    }
    const known = disposals.get(handle)
    if (known !== undefined) return known
    // Disposal is best effort: a worker that already finished needs no cleanup,
    // and an abort must not be blocked by a failing teardown.
    const pending = Promise.resolve()
      .then(() => {
        observeResult(handle)
        return handle.dispose()
      })
      .catch(() => {})
    disposals.set(handle, pending)
    return pending
  }

  const onAbort = () => {
    for (const handle of active) void dispose(handle)
  }
  if (signal.aborted) throw abortReason(signal)
  signal.addEventListener('abort', onAbort, { once: true })

  const runStage = async ({ stage, stageIndex, prompt, itemIndex }) => {
    let acquired = false
    let started
    try {
      await limiter.acquire(signal)
      acquired = true
      if (signal.aborted) throw abortReason(signal)
      const spec = buildSpawnActivation({
        cwd,
        prompt,
        label: `orchestrate ${stage.name} (item ${itemIndex + 1}/${items.length}, stage ${stageIndex + 1}/${stages.length})`,
        parent,
        route,
        maxDepth,
        signal,
        outputSchema: stage.schema,
        delivery: DELIVERY.orchestrate,
      })
      // Race the start itself against abort: a hanging startActivation must not
      // delay cancellation. A handle that only resolves after the abort is
      // disposed on arrival and is never dispatched.
      const startPromise = Promise.resolve().then(() => subagents.startActivation(spec))
      const settledStart = startPromise.then(
        (handle) => ({ handle }),
        (error) => ({ error }),
      )
      started = await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        settledStart.then((outcome) => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) {
            // Late handle: clean it up without dispatching its worker.
            if (outcome.handle !== undefined) void dispose(outcome.handle)
            reject(abortReason(signal))
            return
          }
          if (Object.hasOwn(outcome, 'error')) reject(outcome.error)
          else resolve(outcome.handle)
        })
      })
      if (
        started === null ||
        typeof started !== 'object' ||
        started.result === undefined ||
        typeof started.result.then !== 'function'
      ) {
        throw new Error('subagent startActivation did not return a result promise')
      }
      if (signal.aborted) throw abortReason(signal)
      // Count only handles that are valid and not already aborted, so a late
      // start never appears in agentsStarted.
      agentsStarted += 1
      active.add(started)
      // Race the worker against the abort signal: cancellation must not wait for a
      // worker that ignores its own signal, and the handle is disposed in `finally`.
      const result = await new Promise((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal))
        signal.addEventListener('abort', onAbort, { once: true })
        started.result.then(
          (value) => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          (error) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        )
      })
      if (signal.aborted) throw abortReason(signal)
      return readStageOutput(stage, result)
    } finally {
      if (started !== undefined) {
        active.delete(started)
        await dispose(started)
      }
      if (acquired) limiter.release()
    }
  }

  const runItem = async (item, index) => {
    let previous
    let output
    let stopReason = 'completed'
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      if (signal.aborted) throw abortReason(signal)
      const stage = stages[stageIndex]
      const prompt = buildStagePrompt({
        stage,
        stageIndex,
        stageCount: stages.length,
        item,
        itemIndex: index,
        itemCount: items.length,
        previous,
        writeScope,
      })
      try {
        output = await runStage({ stage, stageIndex, prompt, itemIndex: index })
        previous = { stageName: stage.name, output }
        stopReason = 'completed'
      } catch (error) {
        // An abort of the whole call is not the failure of one item.
        if (signal.aborted) throw abortReason(signal)
        errors.push({ index, stage: stage.name, stageIndex, message: messageOf(error) })
        return null
      }
    }
    return { index, output, stopReason }
  }

  try {
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        results[index] = await runItem(item, index)
      }),
    )
    if (signal.aborted) throw abortReason(signal)
    const rejected = settled.find((entry) => entry.status === 'rejected')
    if (rejected !== undefined) throw rejected.reason
  } finally {
    signal.removeEventListener('abort', onAbort)
    await Promise.all([...disposals.values()])
  }

  errors.sort((a, b) => a.index - b.index || a.stageIndex - b.stageIndex)
  const payload = {
    kind: ORCHESTRATION_KIND,
    agentsStarted,
    results,
    errors: errors.map(({ index, stage, message }) => ({ index, stage, message })),
  }
  const serialized = JSON.stringify(payload)
  if (serialized.length > LIMITS.serializedResultChars) {
    fail(
      `serialized result is ${serialized.length} characters, above the ${LIMITS.serializedResultChars} character limit; reduce items, stages or output size`,
    )
  }
  return payload
}

/**
 * The aggregate owner id of one batch. A batch is one write unit, so the lease table
 * records it like a child: `batch-<parent>-<n>` is what `details[].owner` names and what
 * `release` frees at the end.
 *
 * The counter is module-level on purpose. A batch keeps this id for its whole life, so two
 * tool instances in the same process must not mint the same identity — doing so would make
 * the table merge their leases (`childId` is the one-lease-per-child key) instead of
 * refusing the second batch.
 */
let batchSequence = 0
function nextBatchId(parent) {
  batchSequence += 1
  return `batch-${String(parent?.id ?? 'parent')}-${String(batchSequence)}`
}

export function createOrchestrateTool({ defineTool, subagents, config, leases }) {
  // This description does not repeat `mainAgentRule`: only `delegate` opens with it.
  // The plumbing still accepts the whitelist fields a shared factory passes down so a
  // caller does not have to branch, but they are unused here.
  const enabled = () => isDispatchEnabled(config)
  const ruleLead = '主代理规则同 delegate。'
  const body =
    '按 item 派发子代理：单 stage 即批量扇出；多 stage 时各 item 独立走完阶段，无全局屏障，每阶段自动附带指令、原始 item 与上阶段输出。' +
    '声明 schema 的阶段输出校验过的 JSON，否则为文本；单 item 失败置为 null 并记入 errors。' +
    'maxConcurrency 限制并发数；调用必填 writeScope，整批共享一个写租约，冲突时整批失败不排队。' +
    '无关批次可并发调用；单任务请用 delegate。'
  const descriptionOf = () => (enabled() ? ruleLead + body : body)

  const tool = defineTool({
    name: ORCHESTRATE_TOOL,
    description: descriptionOf(),
    parameters: {
      cwd: {
        type: 'string',
        description: '初始工作目录（相对路径基于当前目录）；省略则继承。',
      },
      writeScope: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        // Required, with no default and no minItems — the same conventions as `delegate`:
        // omitting the field is `write-scope-missing`, an empty array is invalid.
        description:
          '必填：允许写入的文件/目录清单（至少一项），整批共享一个写租约。' +
          '派发前与在租作用域求交，冲突则整批失败并报 write-scope-conflict。' +
          '相对路径基于 cwd；目录用 "/" 或 "/**"；不推荐 "*"。仅声明，不扩大权限也不阻止越界写入。',
      },
      items: {
        type: 'array',
        required: true,
        description: `JSON 条目数组（${LIMITS.items.min}..${LIMITS.items.max}），每项对应独立任务。`,
        items: { type: 'json' },
      },
      stages: {
        type: 'array',
        required: true,
        description: `顺序执行的阶段（${LIMITS.stages.min}..${LIMITS.stages.max}），单阶段即扇出。`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              required: true,
              description: '阶段名称，用于错误标识。',
            },
            prompt: {
              type: 'string',
              required: true,
              description: '阶段指令，自动附带原始条目与上阶段输出。',
            },
            schema: {
              type: 'object',
              additionalProperties: true,
              description:
                '可选对象根 JSON Schema（支持 type/properties/required/additionalProperties/items/enum/const/oneOf）。',
            },
          },
        },
      },
      maxConcurrency: {
        type: 'integer',
        description: `并发子代理上限（${LIMITS.maxConcurrency.min}..${LIMITS.maxConcurrency.max}，默认 ${LIMITS.maxConcurrency.default}）。`,
      },
      provider: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名（当前消息或 AGENTS.md 等工作区指令）时与 model 同传；省略走 worker 路由。',
      },
      model: {
        type: 'string',
        description:
          '可选路由覆盖：仅当用户显式点名（当前消息或 AGENTS.md 等工作区指令）时与 provider 同传；省略走 worker 路由。',
      },
      reasoning_effort: {
        type: 'string',
        description: '可选推理强度：仅当用户点名时才设置，须与 provider/model 同传。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: ORCHESTRATION_KIND },
          agentsStarted: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    index: { type: 'integer' },
                    output: { type: 'json' },
                    stopReason: { type: 'string' },
                  },
                },
              ],
            },
          },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                stage: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `orchestration finished: ${value.results.filter((entry) => entry !== null).length}/${value.results.length} items, ` +
            `${value.errors.length} errors, ${value.agentsStarted} workers started`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!enabled()) throw new Error(disabledToolMessage(ORCHESTRATE_TOOL))
      const parent = exec?.agent
      if (!parent) throw new Error('orchestrate requires a calling agent (exec.agent was undefined)')
      // A batch must declare its write scope: refuse the call before parsing, reading a
      // route or starting any worker, rather than falling back to the old undeclared path.
      requireWriteScope(args, ORCHESTRATE_TOOL)
      // Parse first: bad input or schema must fail before any worker starts.
      const plan = parseOrchestrateArgs(args)
      const signal = exec.signal
      if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
        throw new Error('orchestrate requires a cancellation signal')
      }
      signal.throwIfAborted()
      // An explicit per-call override wins and is never read from config; otherwise the
      // route is read at call time, so a changed route applies from this orchestration on.
      const route = readRouteOverride(args, ORCHESTRATE_TOOL) ?? readRoute(config)
      const maxDepth = subagents.resolveMaxDepth(undefined)
      signal.throwIfAborted()
      // One lease for the whole batch, claimed before the first worker exists. A conflict
      // is a global pre-dispatch failure like a bad argument, so it throws the same
      // `write-scope-conflict` error `delegate` throws and no worker starts (AC1's
      // orchestrate form): the batch is refused atomically rather than trimmed.
      const held = claimWriteScope({
        args,
        exec,
        parent,
        leases,
        childId: nextBatchId(parent),
        tool: 'orchestrate',
      })
      try {
        return await runOrchestration({
          plan,
          parent,
          route,
          maxDepth,
          subagents,
          signal,
          writeScope: held.scope,
        })
      } finally {
        // The batch owns the lease until its last worker settles — including a thrown
        // failure or an abort — so no other writer can slip in between stages.
        releaseWriteScope(leases, held)
      }
    },
  })
  // The host reads `description` while it builds a request; keep it a live getter for the
  // same reason as `delegate`, even though this text no longer depends on the whitelist.
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: descriptionOf,
  })
  return tool
}
