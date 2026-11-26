/**
 * The main-agent rule, rendered into the opening of `delegate`'s description. It
 * lives apart from `gate.js` so the prompt and the enforcement read from the same
 * allow list and cannot drift: the allowed tools named in the text are exactly the
 * ones the gate lets through, and every other tool is blocked.
 *
 * The text is Chinese and deliberately dense: it is carried in the tool schema of
 * every request, so each sentence has to earn its tokens. `orchestrate` does not
 * repeat it, and a delegated child no longer sees either tool at all (it keeps the
 * native `subagent` and `workflow`), so the rule can assume a main-agent reader.
 */

import { DELEGATE_STATUS_TOOL_NAME } from './api.js'

export const TEAM_SHARED_GOAL_RULE =
  '复杂多步或需多子代理协同的任务，先用 team_task_create 建立共享目标，将返回的 id（任务 ID）作为 team_task_id 传给 delegate 或 orchestrate。' +
  '共享目标只用于对齐，仍由 delegate / orchestrate 派发并管理写租约；任务说明必须自包含。'

export function teamTaskPromptNote(teamTaskId) {
  const id = JSON.stringify(teamTaskId)
  return `关联的共享目标（team_task_id）：${id}。` +
    `若 team_task_get 可用，先调用 team_task_get({ task_id: ${id} })，只读查看共享目标作为对齐参考。` +
    '除非任务明确要求更新进度，否则不要改写共享任务状态。若工具不可用或读取失败，按本提示中的完整自包含任务说明继续。'
}

/**
 * Build the rule text. `allowedTools` is the live whitelist the gate enforces,
 * so the closing sentence names exactly what stays available.
 */
export function mainAgentRule(allowedTools, { readOnlyEnabled = false } = {}) {
  const allowed = [...new Set(allowedTools ?? [])]
  const allowedNames = allowed.join(', ')
  return (
    '主代理规则：主代理只负责规划，读/写/编辑/搜索/命令/抓取均通过 delegate 或 orchestrate 交子代理执行，勿试探调用被禁工具。' +
    '优先用 send_message 复用当前会话中已有且闲置（inactive）的子代理，例如重试、纠偏、返工或追问。' +
    (allowed.includes(DELEGATE_STATUS_TOOL_NAME)
      ? `需调整该子代理下一轮的 writeScope 或 readOnly 时，先调用 ${DELEGATE_STATUS_TOOL_NAME}({ action: 'edit', childId, writeScope, readOnly }) 更新待应用声明，再用 send_message 唤醒。`
      : '复用时沿用当前写作用域和只读声明。') +
    '仅在 Worktree 已锁定或合回、原上下文跑偏，或确需并行处理互不干扰的独立任务时，才通过 delegate 的 allowNewReason 说明原因后新建。' +
    '恢复写任务前按下一轮声明重新获取写租约，租约冲突或工作树已锁定时拒绝投递；本轮结束后释放租约。' +
    '新会话或压缩后直接推进，无需重新确认。' +
    '确需并行的独立任务在同一消息内派发，delegate 返回后直接结束回合等待子代理完成，勿空转轮询状态。' +
    'Git 仓库中的写任务默认在独立 Git Worktree 中执行，非 Git 目录使用写租约协调声明范围内的写入。可用 isolation: "auto" | "worktree" | "shared" 覆盖隔离模式。' +
    (readOnlyEnabled ? '' : '只读调研或检索无需代码隔离时，显式传 isolation: "shared"，并在任务描述和边界中要求不得修改文件，避免创建无用 Worktree。') +
    'Worktree 不自动合回；子代理交付后由主代理评审并决定是否合回。' +
    (allowed.includes('worktree_manage')
      ? '用 worktree_manage（list / inspect / merge / discard / prune）显式评审、合回或清理。'
      : '') +
    '子代理无收尾中断时插件会自动重试，期间勿重派；提示停止重试时按通知询问用户。' +
    'provider/model/reasoning_effort 仅在用户当前消息或 AGENTS.md 等工作区指令中显式指定时才传，否则全部省略；当前消息点名仅限本次派发，工作区指令指定的按其持续生效，两者冲突以当前消息为准；严禁复用历史轮次或摘要中的模型。' +
    (allowedNames === ''
      ? '当前主代理无可用工具（白名单为空）。'
      : `主代理可用工具（白名单驱动，其余全部禁用）: ${allowedNames}。`) +
    ' '
  )
}
