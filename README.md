# DSH Orchestrator

**DeepSeek Harness 的「调度模式」插件。
** 它把一次会话拆成两层：
主代理只做澄清、规划、切片与验收
每个具体动作都通过 `delegate`（异步、按需）或 `orchestrate`（声明式批量）交给子代理执行。
主代理与子代理的默认模型、思考强度各自独立配置，所有子代理共用同一条子代理路由。

[English](README.en.md)

## 关键特性

- **主代理只规划，闸门强制**：内置一份 49 项的拒绝名单，隐藏并在执行时拒绝读写、shell、web 等工具；主代理只保留 `delegate`、`orchestrate`、`send_message`、`todo_write`、`ask_user_question`。
- **并行派发独立子任务**：互不依赖的子任务在同一回合一起派出；`delegate` 没有插件侧并发上限，`orchestrate` 用 `maxConcurrency`（1–16，默认 4）限制同时存活的 worker 数。
- **声明式编排**：`orchestrate` 支持单阶段扇出和多阶段逐条目流水线（没有全量屏障），结果与输入同序，单项失败不影响其他项，阶段可声明 object schema 拿结构化结果。
- **巡检与纠偏**：`delegate` 派出的 worker 跑久了，插件按其会话日志合并成一条通知唤醒主代理；主代理用 `send_message` 给出具体指令纠偏，或判断无需干预、回一行说明结束回合。
- **结果回收**：`delegate` 立即返回 `{ kind: "activation", subagentId }`，worker 结束时由宿主把结果作为消息投给主代理；`orchestrate` 在工具调用内同步收齐全部结果。
- **零构建导入**：`lib/` 已包含 DSH 加载所需文件，克隆或从 GitHub 添加即可使用。

## 与单代理会话的区别

| | 普通单代理会话 | 调度模式 |
| --- | --- | --- |
| 谁执行 | 主模型自己调工具 | worker 执行，主代理只派发 |
| 上下文 | 工具输出堆在主代理上下文 | worker 各自承担自己的上下文 |
| 并行 | 工具调用依次完成 | 多个 worker 同时跑 |
| 模型 | 一个模型全包 | 主代理、子代理两套路由 |
| 越权 | 靠模型自觉 | 闸门强制拒绝 |

## 安装

在 DSH 插件页选择从 GitHub 添加，或用 CLI：

```text
SShiRkiT/dsh-orchestrator#main
```

```bash
dsh plugin --profile desktop add SShiRkiT/dsh-orchestrator#main
```

装完**完全退出并重新打开 DSH**：客户端插件在启动时组合，不支持热更新。

## 启用

1. 安装重启后调度模式默认已开启（`enabled` 默认 `true`）。
2. 在 composer 的「调度模式」面板里配置 `workerProvider` 与 `workerModel`（必填）、`workerReasoningEffort`（可留空，交给模型决定默认强度）；未配置就派发会直接报错，不会静默继承主代理模型。
3. 取消勾选「启用调度模式」可临时恢复主代理的全部工具，对已打开的会话立即生效。

## 配置

全部字段都是 volatile：宿主保存、插件每次使用时重读，改配置不需要重启。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 调度模式总开关。关闭时撤销隐藏，守卫仍安装但放行。 |
| `deniedTools` | 49 项内置名单 | 主代理不可用的工具；只能追加，不能删减。 |
| `workerProvider` | `""` | 子代理 provider，空表示未配置。 |
| `workerModel` | `""` | 子代理模型，空表示未配置。 |
| `workerReasoningEffort` | `""` | 子代理思考强度，空表示不传，交给模型解析默认值。 |
| `superviseEnabled` | `true` | 巡检总开关。 |
| `superviseIntervalSeconds` | `600` | 巡检间隔（秒），整数 10–86400。 |
| `superviseMaxNoticesPerChild` | `3` | 每个子代理最多通知几次，整数 0–20；`0` 表示不限。 |
| `superviseNotifyOnNoProgress` | `false` | 日志没有新活动时是否也通知。 |

主代理的默认路由不在这份配置里：它写在宿主的 `agent-default-model`（`provider` / `model` / `reasoningEffort`），由同一个面板写入，创建新 agent 时读取。

## 使用

### delegate：一个自包含的动态任务

参数只有 `prompt`（完整任务，必填）、`description`（3–5 个词的展示名，必填）、`cwd`（可选）。worker 看不到主代理的对话，提示词必须自带全部上下文：

```json
{
  "description": "迁移配置读取",
  "prompt": "目标：把配置读取从 config.ts 迁到 settings.ts，行为不变\n允许改的文件：src/config.ts、src/settings.ts\n验收：node --test test/settings.test.mjs\n失败时：不要改公开 API，把原因写进结论并停止"
}
```

提示词含中文时插件会在开头追加 `Reply in Simplified Chinese.`，俄语、日语、韩语同理，其他语言要求与请求同语言。互不依赖的几个任务，在同一条消息里各调用一次 `delegate` 就会同时启动。

### orchestrate：批量派发

「一组条目 × 一套固定步骤」交给 `orchestrate`，一次调用收齐全部结果；需要按中间结果分支、循环或边看结果边改派时改用 `delegate`。只有一个阶段时，每个条目各得一个 worker：

```json
{
  "items": ["alpha", "beta", "gamma"],
  "stages": [
    { "name": "summarize", "prompt": "用一句话概括这个条目。" }
  ],
  "maxConcurrency": 2
}
```

多个阶段按条目依次推进，后一阶段自动拿到同一项前面阶段的输出。`items` 为 1–64、`stages` 为 1–8；返回 `{ kind: "orchestration", agentsStarted, results, errors }`，`results` 与输入同序，失败项为 `null`。

`delegate` 是异步的：没有进度回调，主代理也没有终止 worker 的工具，要停一个 worker 得在宿主侧操作。

## License

MIT © 2026 SShiRkiT
