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

/**
 * Build the rule text. `allowedTools` is the live whitelist the gate enforces,
 * so the closing sentence names exactly what stays available.
 */
export function mainAgentRule(allowedTools) {
  const allowed = [...new Set(allowedTools ?? [])]
  const allowedNames = allowed.join(', ')
  return (
    '主代理规则：主代理只负责规划，读/写/编辑/搜索/命令/抓取均通过 delegate 或 orchestrate 交子代理执行，勿试探调用被禁工具。' +
    '新会话或压缩后直接委派，无需重新确认。' +
    '独立任务在同一消息内并发派发，delegate 完成后直接结束回合等待子代理完成，勿轮询状态或为同一任务重复派发。' +
    '子代理无收尾中断时插件会自动重试，期间勿重派；提示停止重试时按通知询问用户。' +
    'provider/model/reasoning_effort 仅在用户当前消息或 AGENTS.md 等工作区指令中显式指定时才传，否则全部省略；当前消息点名仅限本次派发，工作区指令指定的按其持续生效，两者冲突以当前消息为准；严禁复用历史轮次或摘要中的模型。' +
    (allowedNames === ''
      ? '当前主代理无可用工具（白名单为空）。'
      : `主代理可用工具（白名单驱动，其余全部禁用）: ${allowedNames}。`) +
    ' '
  )
}
