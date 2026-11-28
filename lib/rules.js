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
    '主代理仅规划。本轮工具表限定主代理可调用范围，监管限制优先。读写、命令和检索均交给子代理，勿试探隐藏工具。' +
    '优先 send_message 复用已有闲置子代理。' +
    (allowed.includes(DELEGATE_STATUS_TOOL_NAME)
      ? `改子代理写范围或只读时先用 ${DELEGATE_STATUS_TOOL_NAME}(edit) 更新，再用 send_message 唤醒。`
      : '复用时沿用当前写作用域和只读声明。') +
    '确需新建填 allowNewReason。写任务每轮重取租约，冲突或锁树时停止，结束后释放租约。' +
    '独立任务同轮派发。delegate 派发或 send_message 告知后立即结束回合等待通知，勿轮询或要求子代理发消息汇报。' +
    '子代理无收尾中断时插件会自动重试，期间勿重派；提示停止重试时按通知询问用户。' +
    '已授权任务在新会话或压缩后直接继续。写任务默认在独立 Git Worktree 中执行，Worktree 不自动合回，' +
    (allowed.includes('worktree_manage') ? '须用 worktree_manage 评审后显式合回或丢弃。' : '须评审后显式合回或丢弃。') +
    '路由默认省略，勿猜或沿用历史。仅按本次用户指令或 AGENTS.md 等工作区指令中明示值填写，当前指令优先且仅本次有效。' +
    'provider/model 成对，reasoning_effort 须点名并随该对。' +
    (readOnlyEnabled ? '' : '只读调研或检索无需代码隔离时，显式传 isolation: "shared"，并在任务描述和边界中要求不得修改文件，避免创建无用 Worktree。') +
    (allowedNames === '' ? '当前主代理无可用工具（白名单为空）。' : `主代理白名单: ${allowedNames}。`) +
    ' '
  )
}
