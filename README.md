# DSH Orchestrator

为 **DeepSeek Harness** 提供“主代理规划、子代理执行”的插件：主代理默认隐藏写入、shell 和原生多代理工具，只能通过插件提供的 `delegate` 与 `orchestrate` 派发任务；主代理与子代理的默认模型、思考强度可以分别切换。

[English](README.en.md)

## 功能

- **主代理闸门**：同时隐藏工具并在执行时拒绝越权调用，覆盖原生 `subagent` 这类 agent 局部工具。
- **独立子代理路由**：每次派发都读取当前配置，模型或思考强度的修改从下一次派发生效。
- **两种派发**：一两个、且下一步取决于上一步结果的动态任务交给异步的 `delegate`；“一个清单 × 一套固定步骤”的批量任务交给声明式的 `orchestrate`。
- **声明式编排**：单阶段扇出，多阶段逐条目流水线（没有全量屏障）；结果与输入同序，单项失败不拖垮其他项；每个阶段可声明 object schema 以获取结构化结果。
- **模型选择面板**：主代理、子代理各自选择模型；行内模型列表支持搜索、键盘选择、暗色主题。
- **阶段投影**：从已有会话事件推导 `idle / clarify / planning / awaiting / executing`，不额外保存会话内容。
- **零构建导入**：`lib/` 已包含 DSH 加载所需文件，克隆或从 GitHub 添加后即可使用。

默认只允许主代理使用 `delegate`、`orchestrate`、`send_message`、`todo_write`、`ask_user_question`，其余内置工具（读、写、shell、原生多代理、web、计划任务等 49 个）全部隐藏并在调用时兜底拒绝；可在插件配置中调整。原生 `workflow`、`subagent`、`subagent_fork` 不在放行之列，理由见 [ADR 0002](docs/adr/0002-declarative-orchestrate-instead-of-native-workflow.md)。

## 安装

### 从 GitHub

在 DSH 插件页选择从 GitHub 添加，使用：

```text
SShiRkiT/dsh-orchestrator#main
```

也可以使用 CLI：

```bash
dsh plugin --profile desktop add SShiRkiT/dsh-orchestrator#main
```

Web profile：

```bash
dsh plugin --profile web add SShiRkiT/dsh-orchestrator#main
```

### 从本地目录

```bash
dsh plugin --profile desktop add "D:\path\to\dsh-orchestrator"
```

安装后**完全退出并重新打开 DSH**。客户端插件在启动时组合，不支持热更新。

## 使用

1. 点 composer 里的 **调度模式** 按钮：顶部开关启用/停用本插件，下面两行分别选主代理和子代理的默认模型。开关是“调度模式”，与宿主自带的**计划模式（plan，`/plan`）**互相独立，两者可以同时开。
2. 在“主代理”行选择默认模型与思考强度；该默认值在之后创建 agent 时读取，因此新会话使用新值。
3. 在“子代理”行选择 worker 模型与思考强度；该值从下一次 `delegate` 或 `orchestrate` 开始生效，两类派发共用同一条路由。
4. 让主代理通过 `delegate`（一两个动态任务）或 `orchestrate`（批量任务）派发。

开关对**已经打开的会话**也生效：守卫每次调用都会重读开关，因此打开后主代理的下一次越权调用会被立即拒绝；被隐藏的工具从下一步起从工具列表中消失。关闭开关会撤销这些隐藏。

子代理路由默认留空，避免把某个账号的 provider 或模型假设强加给其他环境。首次派发前必须先配置；未配置时插件会明确报错，不会静默继承主代理模型。

模型列表中可以直接输入 provider、模型 ID 或显示名进行筛选。`↑` / `↓` 移动，`Enter` 选择，`Esc` 收起当前列表。切换模型会清空旧模型的思考强度，以免把不支持的值带给新模型。

## 批量派发（orchestrate）

`orchestrate` 处理“一组条目 × 一套固定步骤”：每个条目独立走完全部阶段，一次调用收齐全部结果。需要按中间结果分支、循环，或边看结果边改派时，改用 `delegate`。

输入字段：

- `cwd`（可选）：worker 的工作目录，缺省为会话工作目录。
- `items`（必填，1–64）：待处理条目，可以是任意 JSON 值（字符串、数字、布尔、null、对象、数组），按输入顺序编号。
- `stages`（必填，1–8）：每项 `{name, prompt, schema?}`，按顺序施加到每个条目。
- `maxConcurrency`（可选，1–16，默认 4）：同时运行的 worker 上限。

**扇出**：只有一个阶段时，每个条目各得到一个 worker：

```json
{
  "items": ["alpha", "beta", "gamma"],
  "stages": [
    { "name": "summarize", "prompt": "用一句话概括这个条目。" }
  ],
  "maxConcurrency": 2
}
```

**流水线**：多个阶段按条目依次推进，没有全量屏障——条目 A 进入第二阶段时，条目 B 可以还在第一阶段。后一阶段会自动拿到同一条目前面阶段的输出：

```json
{
  "items": ["alpha", "beta"],
  "stages": [
    { "name": "draft", "prompt": "为这个条目写一段说明。" },
    { "name": "review", "prompt": "指出上一阶段说明里的事实问题；没有就说明没有。" }
  ]
}
```

提示词里不需要写占位符：插件会把当前条目（JSON）和上一阶段输出自动附加到本阶段提示词后面。

**结构化结果**：阶段可选声明一个 object 的 JSON Schema；声明后该阶段的 `output` 是满足它的对象，而不是自由文本：

声明 schema 时提示词会要求 worker 优先调用 `structured_output`，该工具不可用时只返回符合 schema 的 JSON 文本；这种文本回退在 `completed` 和 `error` 两种结束原因下都做完整 schema 校验，其他结束原因（aborted、max-tokens、refusal 等）一律不回退。

```json
{
  "items": ["alpha", "beta"],
  "stages": [
    {
      "name": "classify",
      "prompt": "判断条目属于哪一类，并简短说明理由。",
      "schema": {
        "type": "object",
        "properties": {
          "category": { "type": "string" },
          "reason": { "type": "string" }
        },
        "required": ["category"],
        "additionalProperties": false
      }
    }
  ]
}
```

返回与失败：

- 返回 `{ kind: "orchestration", agentsStarted, results, errors }`。
- `results` 与输入同序：成功的条目是 `{index, output, stopReason}`，失败的条目是 `null`。
- `errors` 每项 `{index, stage, message}`，`stage` 是阶段名；某个条目在某阶段失败后，它后面的阶段跳过，其他条目继续。
- `agentsStarted` 是成功启动的 worker 总数，覆盖所有条目和阶段；未能启动的 worker 和被跳过的阶段不计入。
- 总结果超过 50000 字符时整次调用显式报错，不静默截断；超限请拆成多批编排。
- 输入校验失败、worker 路由未配置这类整体错误直接报错，不返回部分结果。

限制：

- 没有任意 JavaScript，没有后台模式；一次调用同步返回全部结果。
- 调用方不能指定 provider / model，所有 worker 使用插件的子代理默认路由。
- 批量任务只有“条目 × 阶段”一种形状；需要动态控制流时回到 `delegate`。

与原生 `workflow` 的关系：原生 `workflow` 仍被拒绝。它的脚本在缺省情况下继承主代理模型，又能逐次覆盖路由；还允许任意控制流与后台运行，闸门无法把范围限定在可枚举的输入内。`orchestrate` 用声明式输入去掉这三点：路由只有插件配置一个来源，结果形状固定，失败可归并。`subagent`、`subagent_fork`、`ralph` 同样保持拒绝。详见 [ADR 0002](docs/adr/0002-declarative-orchestrate-instead-of-native-workflow.md)。

## 目录

```text
lib/index.js         宿主侧配置、阶段投影、工具注册与主代理闸门
lib/client.js        模型与思考强度选择面板
lib/delegate.js      子代理路由读取与动态任务派发
lib/orchestrate.js   声明式批量派发
lib/gate.js          工具隐藏及执行时拒绝
lib/stage.js         会话阶段归约
test/                无 DSH 运行时依赖的单元测试
docs/adr/            关键设计决策
CONTEXT.md           项目术语
cordis.patch.yml     插件注册入口
```

## 开发

无需构建，也无需安装依赖即可运行单元测试：

```bash
node --test test/
```

修改后请运行测试，并至少对修改过的 JavaScript 文件执行 `node --check`。

## 隐私

仓库只包含插件源码、测试和文档。本地测试产生的 profile、凭据、会话日志、备份及离线安装包均由 `.gitignore` 排除。

## License

MIT © 2026 SShiRkiT
