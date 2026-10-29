# 0002 批量派发用声明式 `orchestrate`，不放行原生 `workflow`

## 状态

已决定（2026-10-29）

## 背景

[0001](./0001-subagent-route-lives-in-plugin-config.md) 把子代理的默认路由收进插件配置：worker 只有一个路由来源，切换只对下一次派发生效。现在主代理需要“一个清单 × 一套固定步骤”的批量执行，原生 `workflow`（workflowEngine）恰好能做这件事。

但 `workflow` 的运行方式与 0001 的前提直接冲突：

- **路由**：脚本里 `agent(prompt)` 不传选项就继承父级（主代理）的路由；传了 `provider` / `model` 又逐次覆盖。两条路都绕过“worker 只有一个默认路由”。
- **控制流**：脚本是任意 JavaScript，可以分支、循环、后台运行（`run_in_background`），闸门无法只靠输入把可做的事限定在可枚举的范围内。
- **结果**：后台模式下主代理当下拿不到结果；前台脚本的结果形状也由脚本作者决定，没有“与输入同序、单项失败隔离”的保证。

## 决定

新增声明式工具 `orchestrate`，并继续拒绝原生 `workflow` / `subagent` / `subagent_fork` / `ralph`（拒绝名单可配置）。`orchestrate` 的形状：

- 输入：`cwd?`、`items`（1–64，任意 JSON 值）、`stages`（1–8，每项 `{name, prompt, schema?}`）、`maxConcurrency`（1–16，默认 4）。
- 单阶段是扇出；多阶段是逐条目的流水线，没有全量屏障。
- 所有 worker 使用插件的子代理默认路由；调用方不能指定 provider / model。`orchestrate` 和 `delegate` 一样是派发工具，因此也参与会话阶段投影。
- 阶段可声明 object 的 JSON Schema，拿到结构化 `output`。
- 返回 `{kind: 'orchestration', agentsStarted, results, errors}`：`results` 与输入同序，成功项 `{index, output, stopReason}`，失败项 `null`；单项失败不影响其他项；总结果超过 50000 字符显式报错。
- 没有任意 JavaScript，没有后台模式。

## 替代方案与不选的理由

**放行原生 `workflow`。** 能力最全、零新代码。代价是上面三条同时失守：不传选项的 `agent()` 让 worker 悄悄跑在主模型上，脚本又能把它指到任意模型；脚本还能把任务转成后台，主代理得在后续轮次里自己拼结果、自己归并失败项。补这些缺口只能改上游或再加一层包装，成本高于写一个受限工具。

**只靠并行 `delegate`。** 主代理可以一次发多个 `delegate`，但每个都要单独写提示词，结果是异步通知，顺序、去重、失败归并都得主代理自己做；条目一多，提示词与 token 随条目线性膨胀。

**让 `orchestrate` 接受 provider / model。** 灵活，但等于把 0001 收掉的路由决定权又交回调用方，与“所有 worker 共用一条路由”的产品承诺冲突。

## 后果

- 批量任务只有一种形状：条目 × 阶段。需要分支、循环、按中间结果改派时，只能回到 `delegate` 逐项处理，或由主代理重新规划。
- 主代理多一个工具 schema，每个父级请求都要付这份 token。
- 50000 字符上限让“一次汇总大量结果”不成立；超限必须拆成多批编排。
- 会话阶段要把编排视为执行（术语见 `CONTEXT.md`）。
- 若上游 `workflow` 支持“固定 worker 路由 + 禁止脚本覆盖路由”，本决定应重新评估。
