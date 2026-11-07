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

import { DELEGATE_TOOL, ORCHESTRATE_TOOL } from './api.js'

/**
 * Build the rule text. `preferred` names the tool whose description this will open,
 * so each description recommends itself first and the other one second.
 * `allowedTools` is the live whitelist the gate enforces, so the closing sentence
 * names exactly what stays available.
 */
export function mainAgentRule(allowedTools, preferred = DELEGATE_TOOL) {
  const order =
    preferred === ORCHESTRATE_TOOL
      ? 'orchestrate（同构批量）或 delegate（单个任务）'
      : 'delegate（单个任务）或 orchestrate（同构批量）'
  const allowed = [...new Set(allowedTools ?? [])]
  const allowedNames = allowed.join(', ')
  return (
    '主代理规则：主代理只负责规划。一切读/写/编辑/搜索/命令/抓取/检查都只在子代理中通过 ' +
    order +
    '执行；主代理绝不自己调用，也不为试探可用性调用一次（这些工具已被拦截），子代理不受门禁限制。' +
    '独立任务在同一消息内并发派发；新会话或压缩后无需重新确认，直接委派。' +
    '无需并行时等待子代理完成再进行后续操作，不要轮询其状态，也不要为同一任务重复派发。' +
    '主代理可以直接调用 compress。' +
    '子代理中断且没有收尾消息时，插件会在同一会话自动重试：等待重试，期间不要重派或另起子代理；' +
    '结果为空时先确认插件状态，不要立即重派。' +
    '若它在 2 分钟内连续 3 次快速断联（插件自动重试 2 次），插件停止重试并提示' +
    '「【插件重试｜子代理 <id>】它在 2 分钟内连续 3 次快速断联（failed before it finished / It left no closing message），插件已停止自动重试」：' +
    '此时告知用户子代理模型可能不可用，只提供通知中的 A/B 选项（A 派生新子代理重做 / B 更换子代理模型后重试）并等待用户答复；' +
    '不要建议继续唤醒旧子代理，未经用户选择 A 不要另派子代理重复工作，也不要私自换模型重发。' +
    '严禁通过 run_code 触达宿主：禁用 import/require/process/fetch/eval，也禁用 ' +
    'sandbox_permissions/justification；run_code 内只能调用 delegate 和 orchestrate。' +
    '仅当当前用户消息显式点名时才传 provider/model/reasoning_effort，否则三者全部省略（用调度面板路由）；' +
    '点名的模型仅限本次派发，严禁复用历史轮次、历史派发或摘要中的模型，严禁假定未声明的默认模型，不确定先询问。' +
    (allowedNames === ''
      ? ' 当前主代理无可用工具（白名单为空）。'
      : ` 主代理可用工具（白名单驱动，其余全部禁用）: ${allowedNames}。`) +
    ' '
  )
}
