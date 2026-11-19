# 0003 用“读会话日志 + 唤醒父代理”做子代理巡检

## 状态

已决定（2026-10-29）

## 背景

`delegate` 是异步派发：主代理拿到 `{ kind: 'activation', subagentId }` 后继续自己的回合，worker 在后台跑，结束时才由宿主投递一条结算通知。worker 可能一跑十几分钟，也可能在原地打转，而它不会主动向主代理汇报中间进展。主代理此时既看不到进度，也没有被提醒的时机。

宿主没有“在主代理运行中强行打断它”的机制。可用的投递原语只有 `followup`（空闲时开新回合，忙时排到回合边界）与 `steer`（插进当前回合的下一步）。因此“让主代理定期看一眼 worker”只能做成“在某个时刻给它一条消息”。

## 决定

插件对 `delegate` 派出的 worker 做周期巡检：

- 巡检器读取 worker 会话日志和生成摘要时不调用模型；通知唤醒主代理后的判断与纠偏仍消耗主代理 token。
- 扫描周期固定 5 秒，只做到期时间比较；只有某个 worker 到期时才读它的日志。巡检间隔由配置决定，默认 600 秒（10 分钟），最短 10 秒，可在右下角「调度模式」面板里直接修改。
- 同一父代理名下到期的 worker 合并成一条「【插件巡检…】」通知，经 `followup` 投递给主代理；空闲时立即开新回合，忙时排到当前回合边界。不使用 `steer`。
- 每个 worker 默认最多通知 3 次；未开启 `superviseUnlimited` 时，`superviseMaxNoticesPerChild = 0` 表示关闭；`superviseUnlimited = true` 则忽略预算（含 `0`）持续巡检。
- 只巡检 `delegate` 的 worker；`orchestrate` 的 worker 不巡检。
- 定时器用 `ctx.effect` + `setInterval` 自建，不依赖 `cordis-plugin-timer`。
- 不另造终止原语：宿主 `interrupt_agent` 已在默认白名单中，主代理可按当前 `allowedTools` 使用它中断子代理，或用 `send_message` 纠偏。

## 替代方案与不选的理由

**让 worker 自己定期汇报。** worker 的回复不会自动到达主代理，只能变成一条结算通知；要做到“定期”，就得给 worker 加一个定时器并让它额外调用模型生成汇报。这既增加 token 成本，也仍然依赖 worker 自己愿意汇报——原地打转的 worker 恰恰最不可能汇报。读日志把“是否有进展”变成插件可独立判断的事实。

**用 `steer` 把提醒插进主代理正在跑的回合。** 那会打断用户正在进行的回合，把巡检通知混进用户请求的中间步骤；`followup` 至少在回合边界投递，语义上是“下一件事”。

**每个 worker 单独发一条通知。** 同时跑多个 worker 时会在同一时刻产生多条唤醒，主代理要连续开多个回合处理同一批到期对象。按父代理合并成一条，唤醒次数与父代理数而不是 worker 数成正比。

**默认对每个 worker 无限次通知。** 一个卡死的 worker 会让主代理按巡检间隔无限被唤醒，成本随运行时长线性增长。默认预算约束最坏成本；后续提供 `superviseUnlimited` 供用户显式选择持续巡检，不改变默认取舍。

**使用 `cordis-plugin-timer`。** 那是可选插件，宿主未必挂载；巡检是插件自身能力，不应依赖一个可能不存在的服务。

**把 `orchestrate` 的 worker 也纳入。** `orchestrate` 是同步工具：父代理在工具调用里等全部结果，worker 跑完才返回。等巡检通知到期时，整批任务通常已经结束；把提醒投给一个已经拿到结果的父代理只会造成无意义唤醒。`delegate` 是异步的，父代理已经离开工具调用，提醒才有意义。

## 后果

- 有效通知被消费后会唤醒主代理模型请求；已全失效且无其他实质输入的通知会在 pre-step 拒绝，不发送空巡检请求。默认预算 3 次/worker，可调间隔、调预算、显式开启无限巡检或关闭。
- 通知只在回合边界生效：主代理忙时不会被打断，提醒会晚于到期时间到达。
- 摘要来自会话日志，可能落后于 worker 的真实进度，也可能把“日志很长”误读成“有进展”；主代理仍需自己判断是否纠偏。
- 巡检不改变 worker 的工具权限；主代理可通过默认白名单中的宿主 `interrupt_agent` 停止 worker，执行时仍受当前 `allowedTools` 约束。
- 扫描固定 5 秒、间隔最短 10 秒，意味着巡检的时间精度在秒级；间隔改小后不需要重建定时器，下一次扫描按新间隔重算到期时间即可。
- 本决定描述的是插件侧行为；真实宿主中的端到端表现需另行验证，本文不声称已经完成该验证。

## 演进：2026-11-18 巡检回合门禁、Todo 静默恢复与僵尸撤回

保留读日志、按父代理合并及 `followup` 唤醒的原决策。新约束解决通知排队与主代理继续执行之间的生命周期竞态：

- **按根代理与准确回合绑定。** `agent/pre-step` 在 `step === 1` 的实质输入全为有效巡检通知时调用 `bindTurn`；`todo_write` 硬禁。助手独立输出「巡检：正常」后，同回合后续全部工具（含 PTC 嵌套调用）均拒绝。`installGate` 的 `checkSupervision` 优先于 `enabled()` 与白名单，关闭调度模式或显式放行 `run_code` 也不绕过巡检硬禁。任意步骤收到真实 `source.kind = 'user'` 输入立即解绑并作废旧 Todo 恢复资格；混合结算/重试也解除绑定。绑定不跨回合、代理销毁或插件卸载（`createSupervisionPreStep`，`lib/index.js:392`；`installGate`，`lib/gate.js:198`）。
- **互斥指引与拒绝话术。** `NOTICE_HINT` 的 A/B/C 互斥：A 不调工具，只回复「巡检：正常」并结束；B 纠偏、C 中止/换路时不得声明正常，只使用当前授权的调研、`send_message` 或控制工具。提示本身不含 `delegate`；Todo 禁令、正常声明锁和巡检白名单专用拒绝均不含 `delegate` / `orchestrate` 诱导字眼，普通回合保留原通用拒绝（`lib/supervise.js:79`、`lib/gate.js:41-43`）。
- **PTC 权限边界。** `run_code` 是传输层，可做合法本地计算，并通过 `tools` 调用当前 `allowedTools` 已授权工具，规则不再限于 `delegate` / `orchestrate`。门禁开启且未显式勾选 `run_code` 时，保留宿主访问、提权字段及逃逸标识符的参数检查；显式勾选或关闭门禁是既有参数放行例外，内部工具仍走各自 guard，巡检 Todo 禁令和正常声明锁始终优先。普通回合保留 `runCodeRefusal` 原文；活跃巡检把白名单未命中及非法 PTC 参数改为不诱导新派发的专用提示（`lib/rules.js:41-43`、`lib/gate.js:208-222`、`test/gate.test.mjs:120`、`test/gate.test.mjs:190`）。
- **纯 UI 状态恢复。** `restoreTodoOnSupervision` 默认 `true` 且 `.volatile()`，位于宿主插件设置卡片，不进入输入栏快捷弹层；本轮 `lib/client.js` 无改动。缓存根代理非空 Todo 深拷贝；投影严格为 `null`、快照仍有资格、回合未过时、信号未取消且代理实例仍在本地与宿主注册表时，仅追加 `todo/write` 日志/UI 事件。同一步至多恢复一次，不写入模型历史、不触发额外模型请求；用户输入或显式空清单作废旧资格。此处不承诺 UI 绝无闪烁（`lib/index.js:128`、`createTodoSnapshotTracker`，`lib/index.js:299`；`restoreOnce`，`lib/index.js:416`）。
- **三道防线撤回僵尸巡检。** 第一，惰性消息工厂加载后、`followup` 前复核存活，完整列表写入 `source.childIds`，`pendingNoticeMeta` 保存原行与渲染时间；全失效不投递，部分失效只重编存活行。第二，结算/销毁经去重 `queueMicrotask` 清理两个 inbox 桶；`remove` / `replace` 返回 `false` 最多再复核两次。第三，pre-step 消费前、下游返回后及每次恢复等待后重读最新输入并过滤，部分失效重编正文及列表；全失效且无其他实质输入则清绑定并 `reject`，仅剩 `time-context` / `runtime-context` 也不发送 LLM 请求（`buildNotice`，`lib/index.js:625`；`reconcileInbox`，`lib/index.js:662`；`createSupervisionPreStep`，`lib/index.js:392`）。
- **通知元数据持有。** 同步 `agent/inbox/claimed` 保护 claim 到 pre-step 的窗口；pre-step 外层 `try/finally` 以并发引用计数接管，覆盖下游等待、Todo 恢复、早返回与异常。只转移本批次 claim，最后一个持有者释放后才允许清理；256 条淘汰阈值不驱逐活跃持有者，元数据总数可暂时超过该阈值（`claimNotice` / `retainNotices`，`lib/index.js:584-622`；外层 `finally`，`lib/index.js:453-459`；事件接线，`lib/index.js:1219`）。
- **挂载与事件路由。** `registerRootAgent` 幂等覆盖已有与后续根代理，安装 guard、初始化 Todo 快照并写入 `sessionToRootAgent`。全局 `session/event` 按会话对象 O(1) 精确路由，排除子代理；销毁及卸载同步清理映射与 guard（`registerRootAgent`，`lib/index.js:1100`；`session/event`，`lib/index.js:1221`）。
- **摘要防误读。** 所列子代理标明仍在运行、尚未交付；最后输出标注「仅最新文本前 N 字摘录，不代表最终成败」（`lib/supervise.js:372-378`）。

### 同日后续演进：Todo 恢复来源令牌

早期实现用 `WeakSet` 按 Todo 数组引用识别自身恢复；宿主 `session.append` 复制载荷后，引用不再相同，恢复事件可能重新赋予并发用户已作废的旧清单资格。现已改为每会话独立持有的唯一来源令牌：追加事件携带 `source.kind = 'orchestrator-todo-restoration'` 与随机 `token`，`record` 只忽略本会话仍持有该令牌的自身事件，不再比较数组引用或内容。载荷深复制保留来源信息，同内容的合法新写入仍可更新快照；每次追加的令牌在成功/失败后的 `finally` 释放，并发恢复各自持有令牌（`lib/index.js:301-307`、`lib/index.js:331-358`、`lib/index.js:1224-1225`）。

验收范围：上一实现代理实跑 `node --test test/` 为 424 项通过、0 失败、0 跳过；本轮文档任务未重跑。测试索引包含深复制回流、同内容新写入、并发唯一令牌、未知/已释放令牌及追加失败释放用例（`test/index.test.mjs:2404`、`test/index.test.mjs:2421`、`test/index.test.mjs:2439`、`test/index.test.mjs:2469`、`test/index.test.mjs:2485`）。真实隔离宿主端到端验收尚未完成，单测和源码核对不等同于实际 UI 验收。

### 巡检配置与主代理白名单的现行行为

- **通知预算与无限巡检分开配置。** `superviseMaxNoticesPerChild` 默认值为 `3`。未开启无限巡检时，设为 `0` 即关闭巡检。独立布尔项 `superviseUnlimited` 默认关闭，开启后忽略通知预算（包括 `0`），持续巡检直至子代理停止、交付或结束（[`lib/index.js`](../../lib/index.js#L118-L124)、[`lib/supervise.js`](../../lib/supervise.js#L549-L553)）。
- **主代理可主动止损。** 默认 `allowedTools` 已放行宿主的 `interrupt_agent`。巡检通知唤醒主代理后，若主代理判定子代理失控，可主动调用该工具中断子代理，实际调用仍受当前白名单和巡检回合闸门约束（[`lib/index.js`](../../lib/index.js#L48-L64)、[`lib/gate.js`](../../lib/gate.js#L198)）。
