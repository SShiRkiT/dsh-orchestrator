# 0001 子代理默认路由存在插件配置里，而不是 DSH 设置

## 状态

已决定（2026-10-27）

## 背景

需求是"在 composer 的开关处切换主代理与子代理的模型，新会话继承修改后的值，不要求立即生效"。

DSH 里主代理的默认路由有现成的可写位置：`agent-default-model` 的 `provider` / `model` / `reasoningEffort` 三个字段都是 `volatile`，`ctx.settings.write()` 可写，且只对之后创建的 agent 生效，正好符合"下一轮生效"。

子代理没有对等的位置。`@deepseek-ai/dsh-tool-subagent` 的配置里**没有任何 volatile 字段**（`lib/index.js` 中无 `volatile(` 调用），因此它的 `agentOptions` 无法通过设置写入。`subagent-model-selection-settings` 看似相关，但它的 `enabled` / `allowedModels` 是"授权白名单"，在会话组装时采样一次后冻结，语义是"允许模型选什么"，不是"默认用哪个"。

## 决定

插件自己声明 volatile 配置保存子代理默认路由，并提供一个自己的委派工具：调用时读取当前配置，组装 `agentOptions` 后走 `ctx.subagents.startActivation()`。预设里禁用原生 `tool-subagent`，保证只有这一个委派入口。

## 替代方案与不选的理由

**改写 profile 补丁里预设的 `agentOptions`**：能保留原生工具、不用写新工具。但每次切换都在改用户的配置文件，依赖 config-editor 与预设代际重建，出错时影响面覆盖整个预设（工具可能整个消失），而收益只是省 150 行代码。

**让子代理永远继承主代理**：DSH 原生就是这样（不传 `agentOptions` 时子级继承父级当前路由）。但它无法表达"主 claude + 子 deepseek"，而这正是本项目存在的理由。

**把子代理默认值写进 `subagent-model-selection` 白名单**：白名单只限制模型能选什么，模型不传参数时仍然回退到继承父级，拿不到"默认值"语义。

## 后果

- 切换是"下一次派发生效"，不是当场生效；与用户接受的语义一致。
- 插件多一个工具 schema，每个父级请求都要付这份 token。
- 若上游给 `tool-subagent` 的 `agentOptions` 加上 `volatile`，本决定应被重新评估，届时可退回原生工具。
