# dsh-orchestrator 中文文档（导航）

本目录是 `dsh-orchestrator` 的**中文流程说明**：讲清楚它做什么、由哪些部分组成、一次派发在运行时里怎么走、出问题时该看哪个文件，以及 Issue 从分诊到关闭的标准流程。

文档面向**维护者**，不是安装教程。安装与配置项速查见根目录的中文主真源 [`README.zh.md`](../../README.zh.md) 与 GitHub 默认英文页 [`README.md`](../../README.md)。

## 这套文档回答什么问题

| 你想知道 | 读哪一篇 |
| --- | --- |
| 这个插件到底解决什么问题、边界在哪 | [01 架构与机制](./01-architecture.md) |
| 巡检回合为什么禁 Todo、何时解锁、如何撤回通知并跨 claim/等待保留元数据 | [01 巡检门禁与三道防线](./01-architecture.md#641-巡检回合门禁与三道撤回防线2026-11-18) + [02 过期通知排查](./02-runbook.md#214-已结束子代理仍被巡检--只剩时间块却请求模型) |
| Todo 如何静默恢复、来源令牌如何识别深复制后的自身事件 | [01 已知边界](./01-architecture.md#8-已知边界与风险位与-issue-的关系) + [02 Todo 排查](./02-runbook.md#213-巡检后-todo-消失或旧清单复活) |
| 某个功能是哪个文件实现的、改它会影响什么 | [01 架构与机制](./01-architecture.md) + [02 任务索引](./02-runbook.md) |
| 线上出现某个症状，先看哪里 | [02 任务索引](./02-runbook.md) |
| Issue #1（并发写冲突 / 写作用域 / 指纹）；当前进度为「已实施，验收通过，待合并」 | [03 Issue #1 分析](./03-issue-0001-write-scope.md)（T5 验收见 §12，T6 结论见 §13） |
| Issue #2（适配新版 DSH `0.2.2-rc.2`/`rc.3`）；当前进度为「已实施，T5 验收通过，T6 文档已回写，待合并」 | [03 Issue #2 分析](./03-issue-0002-adapt-to-new-version-of-dsh.md)（根因见 §3，方案见 §6，T5 验收见 §12，T6 结论见 §13） |
| 来了一个新 Issue，我该怎么处理、怎么记录 | [04 Issue 处理流程](./04-issue-workflow.md) |
| 为什么当初这样设计（历史决策） | [`docs/adr/`](../adr/) 三篇 ADR |

## 文档地图

| 编号 | 文件 | 内容 | 稳定度 |
| --- | --- | --- | --- |
| — | `docs/zh/README.md` | 本导航、文档约定、维护规则 | 稳定 |
| 01 | [`01-architecture.md`](./01-architecture.md) | 目标/非目标、组件表、关键数据流、Mermaid 流程图、术语表 | 随代码演进 |
| 02 | [`02-runbook.md`](./02-runbook.md) | 按任务与按症状的文件索引、测试地图、验证命令 | 随代码演进 |
| 03 | [`03-issue-0001-write-scope.md`](./03-issue-0001-write-scope.md) | Issue #1 的症状/根因/风险/建议/待验证，附源码证据；含 6.7 接口集成草案（`writeScope` 字段、`orchestrate` 聚合语义、`write-scope-conflict` 错误结构、两阶段接入顺序），以及 12/13 的 T5 验收记录与 T6 结论 | 随 Issue 状态更新；当前：已实施，验收通过，待合并 |
| 03 | [`03-issue-0002-adapt-to-new-version-of-dsh.md`](./03-issue-0002-adapt-to-new-version-of-dsh.md) | Issue #2 的适配分析：DSH `0.2.2-rc.2`/`rc.3` 破坏性升级导致的 P0 派发全挂（`startActivation` spec 扁平化）、P1 重试投递与 `agents.roots()` 失效、P2 工具面漂移（`wait_agent`）；含隔离复现证据、R1–R4 根因、选项 A/B/C 取舍与写作用域声明，以及 12/13 的 T5 验收记录与 T6 结论 | 随 Issue 状态更新；当前：已实施，T5 验收通过，T6 文档已回写，待合并 |
| 03 | [03-issue-0003-model-catalog-refresh.md](./03-issue-0003-model-catalog-refresh.md) | Issue #3 调度面板模型列表热更新分析与双向同步评估 | 随 Issue 状态更新 |
| 04 | [`04-issue-workflow.md`](./04-issue-workflow.md) | 后续 Issue 的处理流程与可复制模板 | 稳定 |

相关但不在本目录的文档：

- [`CONTEXT.md`](../../CONTEXT.md)：**词汇表**，只定义术语，不写实现决策。本套文档的术语以它为准。
- [`docs/adr/`](../adr/)：三篇架构决策记录（0001 子代理路由；0002 声明式 orchestrate；0003 读日志巡检）。
- 面向用户的功能与配置说明见中文主真源 [`README.zh.md`](../../README.zh.md) 与 GitHub 默认英文页 [`README.md`](../../README.md)。

## 文档约定

1. **事实优先于叙述。** 凡是"实现是这样的"陈述，尽量给出 `lib/<文件>.js:行号` 锚点；无法从源码确认的内容写进"待验证"，不写成结论。
2. **术语跟 `CONTEXT.md` 走。** 主代理、子代理、委派、编排、巡检、条目、编排阶段、闸门、任务卡，这些词不要自造同义词。
3. **行号是快照。** 本导航与 01/02 的行号依据 `0.8.5` 的 `supervisor-improvement` 工作区历史快照（2026-11-18；424 项测试为上一实现代理实跑，当时只核对源码与文档；方案 B 的历史隔离验证不代表本次增强已完成真实隔离宿主端到端验证）。代码改动后若行号漂移，以函数名/导出名为准检索，并顺手修正锚点；历史 `03-issue-*` 报告保留各自的分析快照。
4. **区分三种确定性：**
   - 「源码事实」：可在本仓库直接读到；
   - 「宿主假设」：依赖 DSH 宿主行为（如 `tools.definitions`、`subagents.startActivation`、`followup`），仓库内无法自证；
   - 「待验证」：Issue 结论、复现条件、上游能力，需要实验或外部信息。
5. **只写文档。** 本套文档不包含源码修改；任何方案落地都属于独立变更，走 [04](./04-issue-workflow.md) 的流程。

## 维护规则（改代码时顺手做什么）

改动面向用户的配置项、工具白名单或界面行为时，先更新中文主真源 [`README.zh.md`](../../README.zh.md)，再将同等内容同步到 GitHub 默认英文页 [`README.md`](../../README.md)。

| 代码变化 | 必须更新的文档 |
| --- | --- |
| 新增/删除 `lib/*.js` 模块 | 01 的组件表；02 的模块索引与测试地图 |
| 改 `Config` 字段（`lib/index.js`） | 01 的配置表；02 的"改配置"条目；先更新中文 README 配置表，再同步英文版 |
| 改工具参数或返回结构（`delegate` / `orchestrate`） | 01 的数据结构表；03 的相关证据（若涉及写作用域） |
| 改闸门/工具面（`gate.js` / `tool-surface.js`） | 01 的"每请求工具面"流程；02 的"主代理还能写文件"条目 |
| 改巡检/重试（`supervise.js` / `retry.js`） | 01 的巡检与重试时序；02 的巡检症状条目 |
| 关闭/新增 Issue 结论 | 03 的状态、04 的归档记录 |
| 引入或推翻一项架构决策 | 新增 ADR，并在 01 的"目标/非目标"与 ADR 索引互相引用 |

## 快照信息

| 项 | 值 |
| --- | --- |
| 当前版本 | `0.8.7`（`package.json`） |
| 文档与验收快照 | `0.8.5` 的 `supervisor-improvement` 工作区 |
| 模块 | `wc -l lib/*.js` 本轮实际统计：`lib/` 18 个文件，7703 行（`index.js` 1251 行）；含巡检门禁、Todo 快照与来源令牌、通知重编/有界复核、同步 claim 保护、并发元数据持有及根代理事件路由 |
| 测试 | `wc -l test/*.mjs` 本轮实际统计：`test/` 13 个文件，8691 行（`index.test.mjs` 2666 行）；与源码合计 16394 行。上一实现代理实跑 `node --test test/` 为 424 项通过，0 failed、0 skipped、0 cancelled、0 todo；本轮未重跑。覆盖 claim 到 pre-step 窗口、等待/异常/重入、活跃元数据保留、恢复后复验，以及深复制回流、同内容新写入、并发来源令牌与释放 |
| 运行时 | Node.js `>= 22`，ESM，Cordis 后端补丁 + Web 客户端扩展 |
| 宿主依赖 | `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`（peer）；`@deepseek-ai/dsh-llm` 为可选 peer，惰性动态导入；`zod` peer 已随会话阶段投影移除 |
| 巡检增强状态 | 当前停在 `supervisor-improvement`，未提交；step 1 纯巡检绑定，任意步骤用户输入解绑并作废 Todo 资格。双刀硬门禁优先于开关/白名单，覆盖 PTC；A/B/C 互斥，巡检拒绝不诱导新派发。三道撤回防线、同步 `agent/inbox/claimed` 与 pre-step 外层 `try/finally` 引用计数保留原行元数据，覆盖并发、等待、早返回与异常。恢复后复验，同一步至多恢复一次；全失效且仅剩辅助上下文时拒绝 LLM 请求。`restoreTodoOnSupervision` 默认 true、`.volatile()`，位于宿主设置卡；严格核实 null 投影与根实例，仅补 `todo/write` 日志/UI 事件、不进模型历史、不触发额外模型请求、不进快捷弹层，`lib/client.js` 本轮无改动。 |
| Todo 来源与待验边界 | 已用每会话持有的唯一来源令牌替代早期 `WeakSet` 引用识别（`lib/index.js:301-358`）。深复制自身事件不重赋已作废旧资格，同内容合法新写入不误拦，追加成功/失败释放令牌。宿主需保留 `source` 并在追加结算前发布事件；本轮真实隔离端到端与 UI 表现尚未验收，不承诺绝无闪烁。详见 [01 已知边界](./01-architecture.md#8-已知边界与风险位与-issue-的关系) 与 [02 Todo 排查](./02-runbook.md#213-巡检后-todo-消失或旧清单复活)。 |
| 方案 B 历史状态 | 已移除客户端专属计划按钮和会话阶段投影；保留宿主计划模式、右侧调度面板及模型目录；历史 350 项单测和 DSH `0.2.2-rc.3` 隔离验收与本次增强分开记录 |
| 宿主版本 | 适配范围 DSH `>= 0.2.2-rc.2 < 0.2.3-0`（已有验证为 `0.2.2-rc.2` / `0.2.2-rc.3`；`<= 0.2.2-rc.1` 需插件 `<= 0.8.2`）；历史适配证据见 [03 Issue #2](./03-issue-0002-adapt-to-new-version-of-dsh.md) |
