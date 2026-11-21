# 03 Issue #3 分析：调度面板模型列表热更新

> **Issue：** [SShiRkiT/dsh-orchestrator#3](https://github.com/SShiRkiT/dsh-orchestrator/issues/3)，仅分析第一条；图 1 第二条按反馈已解决，不纳入本报告。
> **分析日期：** `2026-11-21`。
> **版本：** 插件 `0.9.1`（[`package.json:3`](../../package.json#L3)），宿主 DSH `0.2.2-rc.5`（本机安装包 `dsh/package.json:4`）。
> **当前模式：** 解决模式 · T5 实施与验收已完成，T6 待用户确认合并。

证据分为三类：**源码事实**是插件或本机宿主安装包可静态复核的实现；**宿主假设**是仍待验证的兼容性和运行时条件；**推断**是对反馈的归因、风险判断和设计提案。宿主锚点以安装包 `dsh/node_modules/` 下的包路径表示，不代表已验证其他宿主版本。

## T1 分诊

- **来源：** Issue #3 第一条：供应商模型配置变化后，调度面板列表未跟随更新。
- **版本 / 宿主：** 插件 `0.9.1` / DSH `0.2.2-rc.5`；不外推其他版本。
- **类别 / 严重度（推断）：** 插件客户端缺陷候选，中。会显示已移除项或漏掉新增项，同一面板两行均受影响；没有证据表明它直接修改已存路由或正在运行的子代理。
- **影响面（源码事实）：** 调度面板中主代理、子代理默认路由的候选组共用 `groups`（[`lib/client.js:1557`](../../lib/client.js#L1557)）。
- **是否可复现：** 待定，`needs-repro`。本轮仅静态核对。归属暂判为插件客户端；若满足 T3 反证条件，转查宿主重载链路。
- **下一步：** 按 T2 同时记录宿主热重载、事件和 RPC 证据，区分「没请求」与「请求仍返回旧目录」，再评审 T4。

## T2 复现与现象

- **环境：** 使用 `0.9.1` + `0.2.2-rc.5`；保持同一个会话、同一页面与同一调度面板挂载实例，避免刷新或切换会话导致重新挂载。
- **配置快照（待采集）：** `enabled`、`allowedTools` 中与委派或编排相关的项、主/子代理默认路由、巡检间隔与次数；保存变更前后 `provider/model` ID 清单和配置重载方式。凭据及其他敏感值不要写入记录。工具白名单和巡检参数仅用于复现环境复核，不假定参与故障。
- **最小步骤（待执行）：**
  1. 打开调度面板，等待首个 `modelCatalog()` 成功返回，记录两行候选目录。
  2. 仅修改同一已有供应商的模型列表，新增一个模型、移除一个非当前选中模型。走宿主正常配置重载流程，不刷新页面。
  3. 分别检查保持面板打开、关闭后再打开时的两行候选目录，并与原版输入框模型选择器对照；检查调度面板是否再次请求 `modelCatalog()`。
  4. 在同一挂载实例中借客户端调试单独发起一次同接口请求作为对照，不把该响应写进组件状态；同时记录时间、返回的组和模型 ID。
- **期望（推断 / 验收目标）：** 宿主目录确已更新后，调度面板两行跟进新增/移除，不需要刷新页面，不自动改写已存路由。
- **实际：** 用户反馈是调度面板列表未更新；源码推断首轮成功后这一实例不再发起该请求。没有本轮运行时结果，频率未知。
- **证据缺口：** 待补 HMR 和配置事件时间线（尤其 `settings/document-updated`）、两次 RPC 的调用与响应、原版和调度面板的对照截图、相关 `orchestrator:` 日志（如有）、运行版本与统计次数。仅观察到旧界面或刷新后恢复，不能独立证明根因。

## T3 根因定位

**结论（源码事实 → 推断）：** 插件把可实时查询的宿主目录当作组件实例的一次性快照；只要实例不卸载且已有成功响应，重新打开后仍不会重新发起模型目录 RPC。这足以解释反馈，但尚未证实线上个案由此引起。

| 环节 | 确定性与源码锚点 |
| --- | --- |
| 注册与请求 | **源码事实：** [`lib/client.js:1598`](../../lib/client.js#L1598) 的 `apply` 把 `RoutePicker` 注册至 `conversation.input.right`；注入参数虽然能拿到 `sessionId`，`loadCatalog: () => ctx.remote.session.modelCatalog()` 不传会话参数（[`lib/client.js:1602`](../../lib/client.js#L1602)、[`lib/client.js:1612`](../../lib/client.js#L1612)）。宿主 RPC 委托 `buildModelCatalog(this.ctx)`（`@deepseek-ai/dsh-api-session-controller/src/index.ts:343-346`），每次从当前 LLM 注册表 `listProviders()`、`listModels()`、`resolveModelInfo()`（`@deepseek-ai/dsh-api-session-controller/src/catalog.ts:20-29`）。这不保证宿主已重载到新配置。 |
| 缓存与关闭 | **源码事实：** `groups` 初始为 `undefined`；Effect 中 `if (!open || groups !== undefined) return undefined`，仅成功时 `setGroups(response.value.groups)`（[`lib/client.js:1440`](../../lib/client.js#L1440)、[`lib/client.js:1451`](../../lib/client.js#L1451)）。关闭只是 `setOpen(false)` 并移除展开内容，不卸载 `RoutePicker` 本身（[`lib/client.js:1515`](../../lib/client.js#L1515)）。首轮失败不会被当作成功快照。 |
| 配置与两行渲染 | **源码事实：** `useScope` 订阅设置镜像并重渲染，但不清空 `groups`（[`lib/client.js:723`](../../lib/client.js#L723)、[`lib/client.js:1447`](../../lib/client.js#L1447)）。两行把同一 `groups` 传给 `RouteRow`，后者生成并渲染候选项（[`lib/client.js:1557`](../../lib/client.js#L1557)、[`lib/client.js:1177`](../../lib/client.js#L1177)、[`lib/client.js:1297`](../../lib/client.js#L1297)）。 |

**反证条件：** 宿主配置更新后，同一挂载实例中再次发起 `modelCatalog()`；若响应本身仍为旧数据，不能用组件缓存解释这次响应，应优先排查宿主配置重载、供应商注册表和 RPC 数据链路。若同实例真实发起新请求、返回新数据但两行仍显示旧项，则需排查响应消费与渲染，不应归结为「没有请求」。

### DSH 原版目录热更新

1. **源码事实：** HMR 监听配置补丁文件（`@deepseek-ai/dsh-hmr/src/index.ts:384-406`）；设置服务订阅 `app-boot/config-reload`，失效后重读相关配置描述，在修订变化时发出 `settings/document-updated`（`@deepseek-ai/dsh-settings/src/index.ts:230-235,279-286,302-338`）。
2. **源码事实：** `@deepseek-ai/dsh-api-remotes/src/index.ts:37-58` 把 Cordis 事件源注册到 Typert Gateway；转发表见 `@deepseek-ai/dsh-api-remotes/src/remote-events.ts:38-55`。
3. **源码事实：** `ctx.modelDirectories` 监听 `llm/adapters-updated`、`llm/models-updated`、`settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated`，使共享目录失效并重拉；`connection/reset` 清理目录连接状态、旧代际值和推理元数据，迟到响应按代际忽略（`@deepseek-ai/dsh-client-ui-model-selection/src/client/service.ts:46-58`、`@deepseek-ai/dsh-client-ui-model-selection/src/client/catalog.ts:47-105`）。
4. **源码事实：** 原版输入框把 `directoryFor(sessionId).store` 注入并由 `useSyncExternalStore` 订阅，不把候选固化到面板状态（`@deepseek-ai/dsh-client-ui-model-selection/src/client/index.ts:169-188`、`@deepseek-ai/dsh-client-ui-model-selection/src/client/ModelSelect.tsx:63-71`）。
5. **源码事实 → 推断：** `registrationFacts()` 比较供应商标识、显示名称和重试策略，不比较模型清单（`@deepseek-ai/dsh-llm-pi-ai/src/index.ts:125-135,316-328`）。仅改已有供应商的模型列表不一定触发 `llm/adapters-updated`，不能只订阅该事件。

## T4 方案评估

以下均为**推断 / 待实施**，不改宿主，也不为刷新链路引入多层嵌套 Hook。首选 A，C 只作兼容降级；待版本探测与用户授权后再实施。

### 选项 A（首选）：订阅 `ctx.modelDirectories`，缺失时降级为 C

- **做法：** 在扩展入口按会话可选解析目录，使用稳定的外部存储订阅读取 `groups`，两行共用同一份目录；目录就绪值由宿主服务刷新，不额外调用 `modelCatalog()`。预计 [`lib/client.js`](../../lib/client.js) 约 20–40 行，另加 [`test/client.test.mjs`](../../test/client.test.mjs) 覆盖。
- **收益与兼容性：** 复用宿主的事件、代际和错误状态，改动最少。**宿主假设：** 最低支持版本 `0.2.2-rc.2` 的服务存在性、时序和契约必须实测（[`package.json:48`](../../package.json#L48)）。不把 `modelDirectories` 加入硬注入，避免缺服务时整块调度面板消失。若宿主包声明确实需要变更，[`package.json`](../../package.json) 是另行评估的可选项，不在本方案拟授权写作用域内。
- **失败模式与降级：** 服务不可见、目标会话无法解析或 store 契约不符时退到 C，可观察降级且避免反复告警。宿主目录正常加载中不降级；短暂错误可保留同代最近成功组并显示错误，重连不继续显示上一代候选。失败不得清空已存路由或影响面板其他控件。

### 选项 B：订阅同组 5 个远程事件，重读现有 RPC

- **做法：** 监听 T3 中同一组事件，用现有 `modelCatalog()` 重读；预计 [`lib/client.js`](../../lib/client.js) 约 35–70 行，另加测试。
- **为何不首选：** 不依赖原版选择器服务，但需自行处理事件合并和防抖、迟到响应、`connection/reset`、卸载清理；按来源/命名空间过滤插件自身工具目录发出的 `settings/document-updated`（[`lib/catalog.js:189`](../../lib/catalog.js#L189)），不能误排真实模型配置更新。
- **失败模式与降级：** 同连接代可保留最后成功组、提示失败并在后续事件或重开重试；重连须使旧结果失效。若远程事件契约不同或缺失，不能声称支持热更新。

### 选项 C（最小改动 / 降级兜底）：每次打开面板重读目录

- **做法：** 每次由关闭变为打开时重新请求目录，保留过期响应保护并重置上次错误；预计 [`lib/client.js`](../../lib/client.js) 约 10–20 行。
- **为何仅作兼容降级：** 没有服务依赖，但每次打开有 RPC；面板持续打开时不会热更新。失败显示错误，允许关闭后重试；不悄悄改写路由。

### 影响面与兼容性

仅改变客户端候选数据源和刷新时机；主代理与子代理两行继续写各自的默认路由，不改变 `configForms` 命名空间、字段、闸门、巡检，也不篡改当前会话投影。已有配置、老会话与已派发子代理不迁移；目录中删除当前模型时，保留已存模型标识并维持不可解析项的提示/展示，不自动选择替代项。文档不以分析结论宣称已修复。

### 写作用域声明

以下是进入解决模式后的**拟授权**写作用域，不是本次分析提交的文件清单。

| 新增 | 修改 | 不修改 |
| --- | --- | --- |
| 无 | [`lib/client.js`](../../lib/client.js)：目录读取、订阅与降级；[`test/client.test.mjs`](../../test/client.test.mjs)：对应回归覆盖 | 其余文件，包括 [`package.json`](../../package.json)、[`lib/catalog.js`](../../lib/catalog.js)、其他 `lib/` 或 `test/` 文件、宿主及已有设置。若 T6 回写或包声明涉及额外文件，另行授权。 |

### 验收标准

- **AC1 · 真实热更新：** `rc.5` 保持原面板打开，宿主更新已有供应商模型列表并重载后，两行均新增/移除对应项，无需刷新页面；对照原版和 RPC，A 不额外发起目录 RPC。关闭、重开结果一致。
- **AC2 · 兼容降级：** 验证 `rc.2`；服务缺失、不可用或会话无法解析时仍展示完整面板，C 每次打开请求一次并可选择有效候选；明确说明打开期间不热更新。
- **AC3 · 回归：** 覆盖快速变更、迟到响应、连接重置、失败后恢复、卸载清理和旧选中值保留；处理同代刷新失败时可见错误，不能用上一连接代结果覆盖新结果。确认不改主/子默认路由写入语义、不可写状态和巡检配置。
- **AC4 · 可复算：** 实施前后分别记录两文件的 `sha256`、字节数、行数；运行 `node --test test/client.test.mjs` 与 `node --test test/`；补隔离宿主截图、请求计数及版本矩阵。当前未执行。

### 回滚方式

实现必须独立提交。若 A 在版本基线、重连或订阅上回归，能继续正常打开面板时可先切换为已验证的 C；否则回滚独立修复提交（`git revert <修复提交>`）。无配置或持久数据迁移需要回退；本报告保留，运行时问题回到 T2 复核。

### 附议：主代理模型双向同步

- **源码事实：原版 → 调度。** 原版 `remote.session.selectModel` 先写当前会话的模型选择，再异步调用 `agentDefaultModel.saveSelection()`（`@deepseek-ai/dsh-api-session-controller/src/commands.ts:166-185`、`@deepseek-ai/dsh-agent-default-model/src/index.ts:82`）。默认值成功持久化后，`settings/document-updated` 触发设置镜像刷新（`@deepseek-ai/dsh-client-ui-settings/src/client/index.ts:36-45`），调度面板通过 `configForms` 和 `useScope` 读到默认值（[`lib/client.js:723`](../../lib/client.js#L723)、[`lib/client.js:1601`](../../lib/client.js#L1601)）。会话写入成功不代表默认值保存也成功。
- **源码事实：调度 → 原版。** 调度面板主代理行走 `saveRoute` 写 `agent-default-model`，不执行会话选模 RPC（[`lib/client.js:1469`](../../lib/client.js#L1469)）。原版优先用会话投影 `next`，即 `pending ?? lastUsed`（`@deepseek-ai/dsh-agent/src/model-selection.ts:72-88`）；仅当没有会话选择时回退到部署默认值（`@deepseek-ai/dsh-client-ui-model-selection/src/client/directory.ts:158-187`）。
- **推断：** 若产品把调度面板主代理行定义为「当前会话模型」，可复用 `directoryFor(sessionId).store` 的 `current` 和 `directory.select()`，或使用 `remote.session.selectModel`，预计一个客户端文件约 30–70 行加测试；无需自建事件或多层 Hook。它把默认路由切换改成会话切换，并且宿主 RPC 可能异步写部署默认值。实施前明确不可写会话、已寻址子代理、模型不可用、会话写成功但默认保存失败的界面与反馈；须与模型列表热更新拆开决策和验收。


## T5 实施与验收

- **实施方案：** 采用选项 A，运行时订阅 `ctx.modelDirectories.directoryFor(sessionId).store` 的宿主目录快照，由宿主负责目录热更新；采用选项 C 作为服务缺失、会话不可解析或 store 契约不可用时的降级路径，每次面板由关闭变为打开时重新调用 `modelCatalog()`。两条路径均保留错误态、旧列表和请求代际保护，组件卸载时清理订阅与异步响应。
- **主代理双向同步决策：** 不实施。调度面板主代理行继续只读写全局默认路由 `agent-default-model`，不调用 `selectModel`，不覆盖当前会话已经选定的原版模型。
- **改动文件：** `lib/client.js`、`test/client.test.mjs`、`README.zh.md`、`README.md`、`docs/zh/03-issue-0003-model-catalog-refresh.md`。
- **未改动约束：** 未修改 `AGENTS.md`、`package.json`、其他 `lib/*.js`、其他测试、宿主文件或 `.gitignore`。
- **改动前指纹基线：** `lib/client.js` 为 `f1784efa403cebb6b9c7b105b2d2489fb5024ba728740d0f0a7859dcf9b5fe92`，1672 行，72851 字节。其余 `lib/*.js` 基线保持原报告记录。
- **改动后指纹：** `lib/client.js` 为 `96221a5070402fb5bc8616ca88aabace0531c14c5e87a2f87b62a4a3e7438e63`，1741 行，76220 字节。其余 `lib/*.js` 的哈希、行数和字节数与基线一致。
- **测试命令：** `node --test test/`。
- **实际输出摘要：** `ℹ tests 424`、`ℹ pass 424`、`ℹ fail 0`、`ℹ cancelled 0`、`ℹ skipped 0`、`ℹ todo 0`。
- **覆盖内容：** 新增选项 A 的目录快照展示、双行同步热更新、已选路由保留和卸载退订测试，新增选项 C 的每次重开刷新、迟到响应保护和失败保留旧列表测试。客户端测试 82 项全部通过。
- **验收结论：** 本地代码、单测与指纹核对通过。

## T6 状态与结论

Issue #3 已完成本地实施和自动化验收，当前分支保持 `issue-0003-model-catalog-refresh`，待用户确认后合并至 `main`。浏览器端旧会话中实时编辑 `cordis.patch.yml` 并观察宿主目录事件到调度面板的端到端验证，待宿主运行环境确认。该项不影响本地代码与单测验收结论。
