/**
 * Automatic retry of a delegated child that failed without a closing message.
 *
 * Why this exists: a worker that dies before it writes anything leaves the main
 * agent only the host's own settlement notice ("failed before it finished" /
 * "It left no closing message"), which says nothing about the work already done in
 * the workspace. Most such failures are a transient model or transport fault, so the
 * same child — which keeps its own context and its own files — is worth waking again
 * instead of starting a fresh worker from scratch.
 *
 * The budget is deliberately narrow. Only a child that dies again *quickly* counts
 * against it: a run longer than `windowMs` proves the child model can work, so that
 * failure resets the counter and the child earns a fresh pair of retries. Two retries
 * that both die inside the window are the signal that the route itself is unusable;
 * retrying further only burns tokens, so the parent is woken to ask the user whether
 * to start a fresh worker or to switch the worker model.
 *
 * Dependency-free: delivery of the retry prompt and waking the parent are injected,
 * so the whole policy is testable without the DSH runtime.
 */

/** A failure inside this window counts as a fast failure. */
export const RETRY_WINDOW_MS = 120000

/** Retries granted before one fast-failure streak is judged unusable. */
export const MAX_RETRIES = 2

/** `source.kind` of the prompt the plugin injects into a retried child. */
export const RETRY_SOURCE_KIND = 'orchestrator-retry'

/** Bound on remembered children, so a long-lived host never grows without end. */
const MAX_RECORDS = 128

/** Bound on remembered run ids, used only to drop a duplicate settlement event. */
const MAX_RUNS = 256

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a settlement is the failure this module retries: the child stopped with
 * `error` and left no non-empty text block behind.
 *
 * Both shapes are accepted because the same predicate is applied to the host's
 * lifecycle event (`{ stopReason, lastAssistantMessage }`) and to a receipt result
 * (`{ stopReason, output }`); the host omits the output field entirely when the child
 * produced none.
 */
export function isMissingClosingMessage(settlement) {
  if (settlement === null || typeof settlement !== 'object') return false
  if (settlement.stopReason !== 'error') return false
  const output = Array.isArray(settlement.output)
    ? settlement.output
    : Array.isArray(settlement.lastAssistantMessage)
      ? settlement.lastAssistantMessage
      : []
  return !output.some(
    (block) =>
      block !== null &&
      typeof block === 'object' &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.length > 0,
  )
}

/** The prompt injected into the child for one retry. */
export function retryPromptText(childId, attempt) {
  return (
    '插件自动重试（第 ' +
    String(attempt) +
    ' 次）：你上一次执行在没有给出收尾消息的情况下异常中断了。' +
    '请先检查工作区当前状态，判断原任务进行到了哪一步，然后继续把它做完；' +
    '如果其实已经完成，就用 send_message 把结论发给父代理并结束本回合。' +
    '你的子代理 id 是 ' +
    JSON.stringify(childId) +
    '。'
  )
}

/** The notice that wakes the main agent once the retry budget is spent. */
export function unavailableNotice(childId, attempts, windowMs) {
  const minutes = Math.max(1, Math.round(windowMs / 60000))
  return (
    '【插件重试｜子代理 ' +
    childId +
    '】它在 ' +
    String(minutes) +
    ' 分钟内连续 ' +
    String(attempts) +
    ' 次快速断联（failed before it finished / It left no closing message），' +
    '插件已停止自动重试，判定子代理模型可能不可用。请告知用户，并询问：' +
    'A) 派生一个新的子代理重做，还是 B) 更换子代理模型后重试？' +
    '在用户答复之前不要再对这个子代理自动重试，也不要自己换一个模型悄悄重发。'
  )
}

/** The notice used when the retry prompt itself cannot be delivered. */
export function retryFailedNotice(childId, reason) {
  return (
    '【插件重试｜子代理 ' +
    childId +
    '】它断联后插件无法把重试提示送到它：' +
    reason +
    '。请告知用户，并询问：是否派生一个新的子代理重做，或更换子代理模型后重试？'
  )
}

/**
 * Build the retry policy.
 *
 * @param deliverPrompt - `(parentId, childId, text) => Promise` that queues one new turn
 *   on the child, cold-resuming it when it is no longer resident.
 * @param wakeParent - `(parentId, text, childIds) => Promise` that queues a notice on the
 *   main agent; the supervision adapter already has exactly this shape.
 * @param logger - optional `{ warn }`; a logger failure never breaks a decision.
 * @param now - injectable clock, for tests.
 * @param windowMs - fast-failure window; a longer run resets the budget.
 * @param maxRetries - retries per fast-failure streak.
 * @param maxRecords - bound on remembered children.
 * @returns `{ track, settle, forget, has, size }`.
 */
export function createRetry({
  deliverPrompt,
  wakeParent,
  logger,
  now = () => Date.now(),
  windowMs = RETRY_WINDOW_MS,
  maxRetries = MAX_RETRIES,
  maxRecords = MAX_RECORDS,
} = {}) {
  const records = new Map()
  const seenRuns = new Set()

  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // A logger must never change a decision.
    }
  }

  const rememberRun = (runId) => {
    seenRuns.add(runId)
    while (seenRuns.size > MAX_RUNS) seenRuns.delete(seenRuns.values().next().value)
  }

  const remember = (childId, record) => {
    records.delete(childId)
    records.set(childId, record)
    while (records.size > maxRecords) records.delete(records.keys().next().value)
  }

  /** One notice on the parent; a missing adapter or a failure is reported, never thrown. */
  const wake = async (parentId, text, childId) => {
    if (typeof wakeParent !== 'function') return 'unavailable'
    try {
      return await wakeParent(parentId, text, [childId])
    } catch (error) {
      warn('orchestrator: retry: cannot wake the main agent: ' + messageOf(error))
      return 'unavailable'
    }
  }

  return {
    /**
     * Remember a freshly dispatched child. The record is what makes a later settlement
     * actionable: an unknown child is never retried, so a worker started by the host's
     * own `subagent` tool is left alone.
     */
    track(childId, { parentId, label } = {}) {
      if (typeof childId !== 'string' || childId === '') return false
      if (typeof parentId !== 'string' || parentId === '') return false
      remember(childId, { parentId, label, attemptStartedAt: now(), retries: 0, fastFailures: 0 })
      return true
    },

    has(childId) {
      return records.has(childId)
    },

    get size() {
      return records.size
    },

    forget(childId) {
      records.delete(childId)
    },

    /**
     * Apply one settlement.
     *
     * @param childId - the durable child the record was opened for.
     * @param settlement - `{ stopReason, output | lastAssistantMessage }`.
     * @param runId - optional activation identity, so a duplicated event is ignored.
     * @returns `'untracked'` | `'duplicate'` | `'settled'` | `'retry'` |
     *   `'retry-failed'` | `'unavailable'`.
     */
    async settle(childId, settlement, runId) {
      const record = records.get(childId)
      if (record === undefined) return 'untracked'
      if (typeof runId === 'string' && runId !== '') {
        if (seenRuns.has(runId)) return 'duplicate'
        rememberRun(runId)
      }
      // A completed child, or one that left a closing message, is done: its work reached
      // the parent, and a retry would duplicate it.
      if (!isMissingClosingMessage(settlement)) {
        records.delete(childId)
        return 'settled'
      }

      const at = now()
      const fast = at - record.attemptStartedAt < windowMs
      // A run longer than the window proves the route works, so the budget restarts.
      record.fastFailures = fast ? record.fastFailures + 1 : 1
      if (!fast) record.retries = 0

      if (record.fastFailures > maxRetries) {
        records.delete(childId)
        await wake(record.parentId, unavailableNotice(childId, record.fastFailures, windowMs), childId)
        return 'unavailable'
      }

      record.retries += 1
      record.attemptStartedAt = at
      const attempt = record.fastFailures
      if (typeof deliverPrompt !== 'function') {
        records.delete(childId)
        await wake(record.parentId, retryFailedNotice(childId, '宿主没有提供投递子代理提示的通道'), childId)
        return 'retry-failed'
      }
      try {
        await deliverPrompt(record.parentId, childId, retryPromptText(childId, attempt))
        return 'retry'
      } catch (error) {
        records.delete(childId)
        warn('orchestrator: retry: cannot wake subagent ' + childId + ': ' + messageOf(error))
        await wake(record.parentId, retryFailedNotice(childId, messageOf(error)), childId)
        return 'retry-failed'
      }
    },
  }
}
