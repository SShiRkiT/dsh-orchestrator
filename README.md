# DSH Orchestrator

**DeepSeek Harness 的「调度模式」插件。** 它把一次会话拆成两层：主代理（面对用户的那一个）只做澄清、规划、切片与验收，不读文件、不跑命令、不抓网页；每个具体动作都通过 `delegate`（异步、按需）或 `orchestrate`（声明式批量）交给子代理执行。主代理与子代理的默认模型、思考强度各自独立配置，所有子代理共用同一条子代理路由。

[English](README.en.md)

## 调度模式：主代理只规划，动作全部派发

### 为什么拆成两层

普通单代理会话里，读文件、跑命令、抓网页的输出全部堆进同一个上下文：模型既要决策又要搬运细节，工具输出一多就挤占推理空间，而且所有工作串行。调度模式把「想」和「做」分开：

- 主代理的上下文只留计划、任务卡、worker 汇报与结论；
- worker 在各自独立的会话里消耗自己的上下文，看不到主代理的对话；
- 多个 worker 可以同时跑，互不阻塞；
- 模型可以分工：主代理用强模型规划，worker 用便宜模型执行（反之亦可）；
- 越权不靠提示词自觉，而由插件闸门强制执行。

代价同样明确：worker 看不到主对话，任务卡必须自包含；派发与汇总本身要花 token；异步结果需要主代理在后续回合接住。

### 闸门：主代理拿不到执行工具

默认拒绝 49 个内置工具：读、写、编辑、shell（`ops_bash` / `pwsh` / `bash` / `shell`）、原生多代理（`subagent`、`subagent_fork`、`workflow`、`ralph`）、web、计划任务、会话检索、目标、技能、上下文压缩、`interrupt_agent` 等。保留 `delegate`、`orchestrate`、`send_message`、`todo_write`、`ask_user_question`。

闸门由两层组成，缺一不可：

- `tools.restrict` 从工具列表里隐藏全局工具；
- `tools.guard` 在执行时再拒一次，覆盖注册在 agent 自身作用域的原生 `subagent`（`restrict` 对它抛错），也覆盖 `run_code` 内部发起的工具调用。

`run_code` 本身不在拒绝名单里，但它发起的被拒工具调用会逐个被守卫拦下。子代理不会被套上闸门：是否为主代理按会话头里持久化的 `delegationDepth` 判定，冷恢复也不会把子代理误当主代理。开关热生效——守卫每次调用重读 `enabled`，关掉立即撤销隐藏。

### 并行派发

`delegate` 声明为并发安全，互不依赖的子任务应在同一条消息里一起派出，而不是等一个回来再派下一个。工具描述里写明的规则：

- 若干独立子任务：同一回合全部起；
- 只有非常简单的任务才用一个 worker；
- 大量同构条目交给 `orchestrate`；
- 两个 worker 不要改同一个文件。

`delegate` 没有插件侧的并发上限，并发度就是主代理一次派发多少个；`orchestrate` 用 `maxConcurrency`（1–16，默认 4）限制同时存活的 worker 数，槽位从启动之前一直占到结果读完、子代理释放。

### 巡检与纠偏

`delegate` 是异步的：主代理拿到 id 就继续自己的回合。跑得久的 worker 由插件按间隔读取会话日志，把同一父代理名下到期的 worker 合并成一条通知唤醒主代理（机制见[巡检循环](#巡检循环)）。主代理据此决定：用 `send_message` 给某个 worker 具体纠偏，或判断无需干预、回一行说明结束回合。已经完工的 worker 也可以用 `send_message` 续用，它在原会话里接着执行，沿用同一条 worker 路由与工具权限。

### 结果回收

- `delegate` 立即返回 `{ kind: "activation", subagentId }`；worker 结束时由宿主把结果作为消息投给主代理（`delivery: "parent"`）。
- `orchestrate` 在工具调用内同步等全部结果，返回 `{ kind: "orchestration", agentsStarted, results, errors }`，`results` 与输入同序。

### 与普通单代理会话的区别

| | 普通单代理会话 | 调度模式 |
| --- | --- | --- |
| 谁执行 | 主模型自己调工具 | worker 执行，主代理只派发 |
| 上下文 | 工具输出堆在主代理上下文 | worker 各自承担自己的上下文 |
| 并行 | 工具调用依次完成 | 多个 worker 同时跑 |
| 模型 | 一个模型全包 | 主代理、子代理两套路由 |
| 越权 | 靠模型自觉 | 闸门强制拒绝 |
| 进度 | 主模型自然知道 | 巡检按间隔唤醒，`send_message` 纠偏 |
| 成本 | 无派发开销 | 多一次派发与汇总；任务卡必须自包含 |

## 功能

- **主代理闸门**：同时隐藏工具并在执行时拒绝越权调用，覆盖原生 `subagent` 这类 agent 局部工具；`deniedTools` 与内置名单取并集，配置只能加不能减。
- **独立子代理路由**：每次派发都读取当前配置，模型或思考强度的修改从下一次派发生效。
- **两种派发**：一两个、且下一步取决于上一步结果的动态任务交给异步的 `delegate`；「一个清单 × 一套固定步骤」的批量任务交给声明式 `orchestrate`。
- **声明式编排**：单阶段扇出，多阶段逐条目流水线（没有全量屏障）；结果与输入同序，单项失败不拖垮其他项；每个阶段可声明 object schema 以获取结构化结果。
- **子代理巡检**：`delegate` 派出的子代理运行过久时，按配置间隔读其会话日志，合并成一条通知唤醒主代理；不打断子代理，巡检本身不调用模型。
- **续用已完工子代理**：`delegate` 返回后仍可用 `send_message` 让同一个 worker 在原会话里继续。
- **模型选择面板**：composer 右侧的「调度模式」面板可开关插件、分别选主代理与子代理的模型与思考强度、修改巡检间隔；模型列表支持搜索、键盘选择、暗色主题。
- **会话阶段投影**：从已有会话事件推导 `idle / clarify / planning / awaiting / executing`（分叉会话报 `na`），不额外保存会话内容。`orchestrate` 计入「执行」，单独的 `delegate` 目前不计入。
- **「计划」按钮**：插件在 composer 注入一个调用宿主 `/plan`（`/plan off`）的开关，悬停标题附带当前会话阶段；它只管宿主的计划模式，与本插件的调度开关互相独立，两者可同时开启。
- **零构建导入**：`lib/` 已包含 DSH 加载所需文件，克隆或从 GitHub 添加后即可使用。

原生 `workflow`、`subagent`、`subagent_fork`、`ralph` 不在放行之列，理由见 [ADR 0002](docs/adr/0002-declarative-orchestrate-instead-of-native-workflow.md)。

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

## 启用与首次配置

1. 安装并重启后调度模式默认已开启（`enabled` 默认 `true`），主代理看不到上面那 49 个工具。
2. 在 composer 的「调度模式」面板里配置子代理路由：`workerProvider` 与 `workerModel` 必填，`workerReasoningEffort` 可留空（留空则由模型决定默认强度）。未配置就派发会直接报错：`orchestrator: the worker route is not configured (set workerProvider and workerModel)`，不会静默继承主代理模型。
3. 需要临时恢复主代理的全部工具时，取消勾选面板里的「启用调度模式」；它对已打开的会话立即生效。

## 配置参考

全部字段都是 volatile：宿主保存、插件每次使用时重读，改配置不需要重启。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 调度模式总开关。开启时隐藏并拒绝 `deniedTools`；关闭时撤销隐藏（守卫仍安装，只是放行）。 |
| `deniedTools` | 49 项内置名单 | 主代理不可用的工具。与内置名单取并集，只能加不能减；`delegate` / `orchestrate` 写进来也不会被守卫拒绝。 |
| `workerProvider` | `""` | 子代理 provider，空表示未配置。 |
| `workerModel` | `""` | 子代理模型，空表示未配置。 |
| `workerReasoningEffort` | `""` | 子代理思考强度；空表示不传，交给模型解析默认值。 |
| `superviseEnabled` | `true` | 巡检总开关；关闭后不再扫描、不再发送通知。 |
| `superviseIntervalSeconds` | `600` | 巡检间隔，单位秒，整数 10–86400；600 秒即 10 分钟。 |
| `superviseMaxNoticesPerChild` | `3` | 每个子代理最多通知几次，整数 0–20；`0` 表示不限。发满后该子代理在下一次到期时移出跟踪。 |
| `superviseNotifyOnNoProgress` | `false` | 日志没有新活动时是否也通知；开启会多花模型回合。 |

主代理的默认路由不在这份配置里：它写在宿主的 `agent-default-model`（`provider` / `model` / `reasoningEffort`），由同一个面板写入，在创建新 agent 时读取。

## 使用

1. 点 composer 里的「调度模式」按钮：顶部复选框启用/停用插件，下面两行分别选主代理和子代理的默认模型与思考强度，底部可改子代理巡检间隔。这个开关与宿主自带的**计划模式（plan，`/plan`）**互相独立，两者可以同时开。
2. 主代理的改动在之后创建 agent 时读取，因此新会话使用新值；子代理的改动从下一次 `delegate` 或 `orchestrate` 生效，两类派发共用同一条路由。
3. 模型列表中可以直接输入 provider、模型 ID 或显示名进行筛选。`↑` / `↓` 移动，`Enter` 选择，`Esc` 收起列表。切换模型会清空旧模型的思考强度，以免把不支持的值带给新模型。
4. 让主代理通过 `delegate` 派发动态任务，或通过 `orchestrate` 派发批量任务，然后按需处理巡检通知与 worker 结果。

开关对**已经打开的会话**也生效：守卫每次调用都重读开关，打开后主代理的下一次越权调用会被立即拒绝；被隐藏的工具从下一步起从工具列表中消失。

### delegate：一个自包含的动态任务

`delegate` 的参数只有三个：`prompt`（必填，完整任务）、`description`（必填，3–5 个词的展示名）、`cwd`（可选，worker 的初始工作目录）。worker 看不到主代理的对话，提示词必须自带全部上下文，通常写成一张任务卡：

```text
目标：把配置读取从 config.ts 迁到 settings.ts，行为不变
允许改的文件：src/config.ts、src/settings.ts、test/settings.test.mjs
验收：node --test test/settings.test.mjs
失败时：不要改公开 API，把失败原因写进结论并停止
```

```json
{ "description": "迁移配置读取", "prompt": "……（上面那张任务卡）", "cwd": "D:\\repo" }
```

worker 的回复语言跟随提示词：提示词含中文时插件在开头追加 `Reply in Simplified Chinese.`，俄语、日语、韩语同理，其他语言则要求与请求同语言。

### 并行 delegate

互不依赖的几个任务，在同一条消息里各调用一次 `delegate`：

```text
delegate：给 api/ 下的处理器补单元测试     （只改 test/api/）
delegate：更新 README 里的安装命令         （只改 README.md）
delegate：把 CI 的 node 版本升到 22        （只改 .github/workflows/ci.yml）
```

三者会同时启动。worker 之间不共享上下文，每个提示词都要自包含；也不要让两个 worker 改同一个文件。

### send_message：纠偏与续用

`send_message` 是插件留给主代理的唯一「行动」通道：它不执行任务，只对已有 worker 说话。

- 巡检发现某个 worker 跑偏或原地打转时，给它具体指令，而不是泛泛提醒——指出该改哪个文件、该跑哪条命令、验收标准是什么；
- worker 已完工但仍需在同一上下文里补一步时，也可以直接续用，省去重新派发、再补一遍上下文的开销；
- 消息不打断 worker 当前的步骤：工作中的 worker 在下一步收到它，空闲的 worker 以它开一个新回合。

```text
send_message(agent_id: "session-3f9c…", message: "不要动 src/api/*；先把 test/api/ 里失败的用例列出来，改完只跑那一个文件。")
```

### orchestrate：批量派发

`orchestrate` 处理「一组条目 × 一套固定步骤」：每个条目独立走完全部阶段，一次调用收齐全部结果。需要按中间结果分支、循环，或边看结果边改派时，改用 `delegate`。

输入字段：

- `cwd`（可选）：worker 的工作目录，缺省为会话工作目录。
- `items`（必填，1–64）：待处理条目，可以是任意 JSON 值（字符串、数字、布尔、null、对象、数组），按输入顺序编号。
- `stages`（必填，1–8）：每项 `{name, prompt, schema?}`，按顺序施加到每个条目。
- `maxConcurrency`（可选，1–16，默认 4）：同时存活的 worker 上限。

未知字段直接报错（包括 `provider` / `model`：路由只能来自插件配置）。

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

提示词里不需要写占位符：插件会把当前条目（JSON）、阶段序号和上一阶段输出自动附加到本阶段提示词后面。

**结构化结果**：阶段可选声明一个 object 的 JSON Schema；声明后该阶段的 `output` 是满足它的对象，而不是自由文本：

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

声明 schema 时提示词会要求 worker 优先调用 `structured_output`，该工具不可用时只返回符合 schema 的 JSON 文本；这种文本回退在 `completed` 和 `error` 两种结束原因下都做完整 schema 校验，其他结束原因（aborted、max-tokens、refusal 等）一律不回退。worker 返回的 `structured` 值优先于文本，且校验不过时整条阶段失败，不会退化成文本。

schema 只接受一个子集：必须 object 根；节点支持 object / array / 标量类型、`oneOf`、`enum`、`const`，外加 `description` / `title` / `default` / `examples`；未知关键字、`required` 里未在 `properties` 声明的属性、`oneOf` 旁的兄弟约束，都会在启动任何 worker 之前报错。

返回与失败：

- 返回 `{ kind: "orchestration", agentsStarted, results, errors }`。
- `results` 与输入同序：成功的条目是 `{index, output, stopReason}`，失败的条目是 `null`。
- `errors` 每项 `{index, stage, message}`，`stage` 是阶段名；某个条目在某阶段失败后，它后面的阶段跳过，其他条目继续。`errors` 按条目序号、阶段顺序排序。
- `agentsStarted` 是成功启动的 worker 总数，覆盖所有条目和阶段；未能启动的 worker 和被跳过的阶段不计入。
- 总结果超过 50000 字符时整次调用显式报错，不静默截断；超限请拆成多批编排。
- 输入校验失败、worker 路由未配置这类整体错误直接报错，不返回部分结果。

限制：

- 没有任意 JavaScript，没有后台模式；一次调用同步返回全部结果。
- 调用方不能指定 provider / model，所有 worker 使用插件的子代理默认路由。
- 批量任务只有「条目 × 阶段」一种形状；需要动态控制流时回到 `delegate`。

与原生 `workflow` 的关系：原生 `workflow` 仍被拒绝。它的脚本在缺省情况下继承主代理模型，又能逐次覆盖路由；还允许任意控制流与后台运行，闸门无法把范围限定在可枚举的输入内。`orchestrate` 用声明式输入去掉这三点：路由只有插件配置一个来源，结果形状固定，失败可归并。`subagent`、`subagent_fork`、`ralph` 同样保持拒绝。详见 [ADR 0002](docs/adr/0002-declarative-orchestrate-instead-of-native-workflow.md)。

## 巡检循环

「插件巡检」不是用户消息：它由插件生成，经 `followup` 投递给主代理。

- **扫描**：定时器固定每 5 秒 tick 一次（不随配置变化），只比较到期时间；某个子代理到期时才去读它的会话日志。
- **读取**：直接读子代理会话的事件日志（`seq` / `time` / `type` / `data`），不调用模型，不产生 token。
- **摘要**：轮次、步骤、自上次巡检以来新增的工具调用次数、最近工具、最后输出（最多 300 字符）；并在最近 20 次工具调用里找「同一工具 + 同一参数」的最长连续重复，达到 3 次就标注「可能原地打转」。
- **合并**：同一父代理名下所有到期的子代理合成一条通知；父代理已有一条未消费的巡检通知时，整批跳过且不消耗预算。
- **投递**：用 `followup` 而不是 `steer`——主代理空闲时立即开新回合，忙时排到当前回合边界。
- **无进展**：日志没有新事件、也没检测到循环时默认不发通知（`superviseNotifyOnNoProgress` 可改），只把下次到期时间往后推。
- **预算**：每个子代理默认最多 3 条；发满后该子代理移出跟踪。
- **长度**：通知整体不超过 2000 字符；超长时先压缩每个子代理的「最后输出」，仍不够则从尾部丢弃子代理并注明还有几个未列出。
- **生命周期**：子代理结束、或父代理已不在时移出跟踪。巡检登记表只在内存里，插件进程重启后清空。
- **改间隔**：面板里改完立即生效，下一个 tick 按新间隔重算到期时间，不重建定时器；输入留空保存会回到 600 秒。
- **范围**：只巡检 `delegate` 派出的子代理。`orchestrate` 的 worker 在工具调用内同步等待，等通知到期时任务早已结束。

示意：

```text
【插件巡检｜第 2/3 次】以下内容由 dsh-orchestrator 自动生成，不是用户消息。
1) 子代理 session-xxxx
   任务：迁移配置读取
   已运行 12m30s ｜ 轮次 8 ｜ 步骤 21
   自上次巡检新增工具调用 4 次 ｜ 最近工具：edit
   最后输出：……
```

通知末尾会要求主代理逐个决定：方向正确则不干预；跑偏或打转就用 `send_message` 给具体指令；判断该停下时说明原因——主代理本身没有终止工具（`interrupt_agent` 在拒绝名单里），真正停下 worker 需要用户在宿主侧操作。若无需干预，只回一行「巡检：正常」并结束回合，不调用工具。

成本：每次通知都会唤醒主代理一次完整模型请求。默认每个子代理最多 3 次；可以调大间隔、减小预算，或直接关闭。巡检本身只读会话日志，不产生模型调用。

## 已知限制

- `orchestrate` 只有「条目 × 阶段」一种形状，没有任意 JavaScript，也没有后台模式；单次结果超过 50000 字符整体报错；失败项只给 `null` 与 `errors`，不会自动重试。
- `delegate` 是异步的：没有进度回调，只能靠巡检；也不提供终止能力——`interrupt_agent` 默认在拒绝名单里，要停一个 worker 得在宿主侧操作。
- 巡检读的是日志：摘要可能落后于 worker 的真实进度，也可能把「日志很长」误读成「有进展」；主代理忙时通知会晚于到期时间送达。
- 闸门依赖宿主的 `tools.restrict` 与 `tools.guard`：全局工具靠隐藏，scope-local 工具靠执行时拒绝；守卫安装失败只记一条 warn，此时闸门不完整，`restrict` 失败的名字会被跳过并记日志。
- `deniedTools` 只能加不能减（内置 49 项始终并入）；要整体停用闸门请用 `enabled`，不要靠删名单。
- 主代理与 worker 不共享上下文：任务卡缺目标、可改文件或验收命令时，worker 会自己猜。
- 子代理路由未配置时派发失败；路由改动只从下一次派发生效，不会回填正在运行的 worker。
- 会话阶段投影不单列「验收」；分叉会话报「不适用」；`delegate` 目前不计入「执行」阶段，只有 `orchestrate` 会。
- 客户端面板在启动时组合：安装或升级插件后必须完全退出并重开 DSH。

## 目录

```text
lib/index.js         宿主侧配置、阶段投影、工具注册、巡检接线与主代理闸门
lib/client.js        模型与巡检间隔面板、「计划」按钮
lib/delegate.js      子代理路由读取与动态任务派发
lib/orchestrate.js   声明式批量派发
lib/gate.js          工具隐藏及执行时拒绝
lib/stage.js         会话阶段归约
lib/supervise.js     子代理巡检的纯逻辑（到期、合并、预算、通知文案）
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
