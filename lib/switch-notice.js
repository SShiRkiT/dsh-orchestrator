/**
 * Deferred dispatch-switch notices.
 *
 * The panel writes `enabled` as volatile config, and the loader announces the change on
 * `loader/volatile-update`. The plugin could push a notice the moment the switch flips,
 * but that would splice a message into a turn the user is still reading — the same reason
 * supervision uses `followup` instead of `steer`.
 *
 * This module records the change and holds it until the next user turn begins. The notice
 * then rides along with that turn, so the main agent learns the new state at the exact
 * moment it starts planning again, and the conversation gains no extra bubble.
 *
 * One record per agent: a user who flips the switch three times before typing gets one
 * notice describing the final state, not three describing the path it took.
 */

/** The durable `source.kind` a switch notice carries, so it is distinguishable in the log. */
export const SWITCH_SOURCE_KIND = 'orchestrator-switch'

/**
 * The notice text for one switch state.
 *
 * It names the tools that changed hands, because that is what the main agent has to act
 * on: with dispatch on it must delegate, with dispatch off it must work directly. The
 * wording deliberately avoids "you may" — the gate is not advisory.
 */
export function switchNoticeText(enabled) {
  if (enabled) {
    return (
      '【插件状态变更】调度模式已切换为「开启」。' +
      '你现在只负责规划：一切读/写/编辑/搜索/命令/抓取/检查都通过 delegate（单个任务）或 orchestrate（同构批量）交给子代理执行，' +
      '主代理不再直接调用常规工具（它们已被拦截）。'
    )
  }
  return (
    '【插件状态变更】调度模式已切换为「关闭」。' +
    '你现在可以直接使用 read / write / edit / bash / glob / grep 等常规工具执行任务，' +
    '不要再调用 delegate、orchestrate、delegate_status 或 worktree_manage（它们已被拦截）。'
  )
}

/**
 * Track the switch state per agent and hand back one notice per pending change.
 *
 * `readEnabled()` is the live switch reader (`isDispatchEnabled(config)`), called on every
 * check so the record always compares against the value the gate will enforce.
 *
 * The first observation of an agent is a baseline, not a change: an agent created while
 * dispatch is off must not receive a "switched to off" notice for a switch nobody flipped.
 */
export function createSwitchNotices({ readEnabled, logger } = {}) {
  /**
   * agentId -> the switch state the agent last knew.
   *
   * This is the baseline a pending notice is measured against, not a record of the previous
   * observation. Keeping it that way is what makes a round trip (on -> off -> on) leave no
   * trace: the agent is back where it started, so there is nothing to announce.
   */
  const baseline = new Map()
  /** agentId -> the state a pending notice should describe. */
  const pending = new Map()

  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // A logger must never break a turn.
    }
  }

  /**
   * Record the current switch state for one agent.
   *
   * Called from `loader/volatile-update` (the panel wrote the switch) and from
   * `agent/created` (a new agent needs a baseline). A change is only recorded when the
   * agent already had a baseline, so a fresh agent never inherits a phantom notice.
   */
  const observe = (agentId) => {
    if (typeof agentId !== 'string' || agentId === '') return
    let current
    try {
      current = readEnabled(agentId) === true
    } catch (error) {
      warn(`orchestrator: switch notice: cannot read the switch: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!baseline.has(agentId)) {
      baseline.set(agentId, current)
      return
    }
    if (baseline.get(agentId) === current) {
      // Back to the state the agent already knows: drop any pending notice.
      pending.delete(agentId)
      return
    }
    pending.set(agentId, current)
  }

  /**
   * Take the pending notice for one agent, if any.
   *
   * Returns `undefined` when nothing changed. The record is consumed on read: the notice
   * describes a transition, and repeating it on every later turn would be noise.
   */
  const take = (agentId) => {
    if (typeof agentId !== 'string' || agentId === '') return undefined
    if (!pending.has(agentId)) return undefined
    const enabled = pending.get(agentId)
    pending.delete(agentId)
    // The agent is about to be told, so this becomes the state it knows: a later flip back
    // is measured against it, and the same notice is never produced twice.
    baseline.set(agentId, enabled)
    return { enabled, text: switchNoticeText(enabled) }
  }

  /** Drop every record for an agent that went away. */
  const forget = (agentId) => {
    baseline.delete(agentId)
    pending.delete(agentId)
  }

  /** Test seam: whether a notice is waiting for this agent. */
  const hasPending = (agentId) => pending.has(agentId)

  return { observe, take, forget, hasPending }
}
