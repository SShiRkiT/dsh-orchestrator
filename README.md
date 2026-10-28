# DSH Orchestrator

为 **DeepSeek Harness** 提供“主代理规划、子代理执行”的插件：主代理默认隐藏写入、shell 和原生多代理工具，只能通过插件提供的 `delegate` 工具派发任务；主代理与子代理的默认模型、思考强度可以分别切换。

[English](README.en.md)

## 功能

- **主代理闸门**：同时隐藏工具并在执行时拒绝越权调用，覆盖原生 `subagent` 这类 agent 局部工具。
- **独立子代理路由**：每次 `delegate` 时读取当前配置，模型或思考强度的修改从下一次派发生效。
- **模型选择面板**：主代理、子代理各自选择模型；行内模型列表支持搜索、键盘选择、暗色主题。
- **阶段投影**：从已有会话事件推导 `idle / clarify / planning / awaiting / executing`，不额外保存会话内容。
- **零构建导入**：`lib/` 已包含 DSH 加载所需文件，克隆或从 GitHub 添加后即可使用。

默认只允许主代理使用 `delegate`、`send_message`、`todo_write`、`ask_user_question`，其余内置工具（读、写、shell、原生多代理、web、计划任务等 49 个）全部隐藏并在调用时兜底拒绝；可在插件配置中调整。

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

1. 点 composer 里的 **规划模式** 按钮：顶部开关启用/停用本插件，下面两行分别选主代理和子代理的默认模型。
2. 在“主代理”行选择默认模型与思考强度；该默认值在之后创建 agent 时读取，因此新会话使用新值。
3. 在“子代理”行选择 worker 模型与思考强度；该值从下一次 `delegate` 开始生效。
4. 让主代理通过 `delegate` 派发任务。

子代理路由默认留空，避免把某个账号的 provider 或模型假设强加给其他环境。首次委派前必须先配置；未配置时插件会明确报错，不会静默继承主代理模型。

模型列表中可以直接输入 provider、模型 ID 或显示名进行筛选。`↑` / `↓` 移动，`Enter` 选择，`Esc` 收起当前列表。切换模型会清空旧模型的思考强度，以免把不支持的值带给新模型。

## 目录

```text
lib/index.js       宿主侧配置、阶段投影、工具注册与主代理闸门
lib/client.js      模型与思考强度选择面板
lib/delegate.js    子代理路由读取与任务派发
lib/gate.js        工具隐藏及执行时拒绝
lib/stage.js       会话阶段归约
test/              无 DSH 运行时依赖的单元测试
docs/adr/          关键设计决策
CONTEXT.md         项目术语
cordis.patch.yml   插件注册入口
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
