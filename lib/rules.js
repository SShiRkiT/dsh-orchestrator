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
export function mainAgentRule(allowedTools) {
  const allowed = [...new Set(allowedTools ?? [])]
  const allowedNames = allowed.join(', ')
  return (
    '主代理规则：主代理只负责规划，读/写/编辑/搜索/命令/抓取均通过 delegate 或 orchestrate 交子代理执行，勿试探调用被禁工具。' +
    '同任务报错重试、参数纠偏、小幅返工或追问，优先用 send_message 复用原代理；仅在 writeScope 需变更、Worktree 已锁定、原上下文严重跑偏或无法继续时才新开 delegate。' +
    '已结束的写任务续跑前重抢原写租约并拍新基线，租约冲突或工作树已锁定时拒绝投递；本轮结束后写审计并再次释放租约。' +
    '新会话或压缩后直接推进，无需重新确认。' +
    '独立任务在同一消息内并发派发，delegate 完成后直接结束回合等待子代理完成，勿空转轮询状态。' +
    '子代理完成通知只代表执行结束，不等于写作用域审计通过。' +
    (allowed.includes(DELEGATE_STATUS_TOOL_NAME)
      ? `若未见同帧审计通过确认，验收前按需调用一次 ${DELEGATE_STATUS_TOOL_NAME} 核验审计状态（pending / passed / failed）；只有 passed 才确认通过，勿盲等或循环轮询。`
      : '') +
    'Git 仓库的写任务默认在独立 Git Worktree 中执行，用 git diff / git log 审计；非 Git 目录自动降级为逻辑写后审计。可用 isolation: "auto" | "worktree" | "shared" 覆盖。' +
    'Worktree 不自动合回；执行结束、写审计通过、主代理合回是三步。' +
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
