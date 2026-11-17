Start from 28th October :
<div align="center">
**DSH Orchestrator**
</div>
<div align="center">

**A powerful model plans, low-cost models do the work — the dispatch mode plugin with hard tool isolation for DeepSeek Harness**

[![version](https://img.shields.io/badge/version-0.8.3-4176E6?style=flat-square)](https://github.com/SShiRkiT/dsh-orchestrator)
[![dsh-plugin](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![platform](https://img.shields.io/badge/platform-Web%20GUI%20%7C%20Desktop-5c6bc0?style=flat-square)](https://github.com/SShiRkiT/dsh-orchestrator)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![module](https://img.shields.io/badge/module-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](package.json)
[![license](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/SShiRkiT/dsh-orchestrator?style=flat-square&logo=github)](https://github.com/SShiRkiT/dsh-orchestrator/stargazers)

[简体中文](README.md) | **English** · [Key differences](#why-use-this-plugin-when-native-subagent-and-agent-team-already-exist) · [Key features](#key-features) · [Installation](#installation) · [Configuration](#configuration)

</div>

---

## Why use this plugin when native `subagent` and `Agent Team` already exist?

DSH includes native `subagent` / `workflow` tools, and the official `@deepseek-ai/dsh-experimental-agent-team-profile` (Agent Team) is also available. However, intensive development still exposes the following pain points — the problems at the heart of **DSH Orchestrator**'s distinctive design:

| Pain point | Native `subagent` / official `Agent Team` | DSH Orchestrator (unique to this plugin) |
| --- | --- | --- |
| **How do you configure models to save money?**<br>*(The key difference)* | **No dedicated subagent panel**: subagents either inherit the expensive main model by default or rely on the main agent to pass a model choice on every call (easy to omit or get wrong, with default changes requiring static configuration edits). | **Two independent model routes in one panel, with a low-cost model enforced**: set the Main Agent to a powerful, expensive model (such as `gemini-4-argon-high`) and lock all Subagents to a fast, low-cost model (such as `gemini-3.8-flash`) directly in the UI. Changes apply to the next delegation. |
| **Does the main agent keep doing the work itself?** | **Relies on compliance with soft prompts**: the main agent / Team Lead still has the full set of tools, including `read`, `edit`, and `bash`. After a few turns, it often starts reading files and running commands itself, quickly filling the main context. | **Whitelist-Driven Hard Gate**: the main agent receives only 12 core planning and delegation tools by default (`allowedTools`). All other host file and terminal tools, plus any future MCP or third-party plugin tools, are automatically hidden and blocked at execution time (including nested calls through `run_code`), **enforcing a Main Agent dedicated entirely to planning and acceptance, with Subagents doing all the execution**. |
| **What if a low-cost model gets stuck or goes off track?** | **Runtime black box**: after dispatch, you can only wait for completion or timeout, or block and poll with `wait_agent`. | **Periodic background inspection of event logs + dynamic correction by the powerful model**: a background timer reads running Workers' session event logs directly (reading and summarizing make no model calls), summarizing elapsed time, rounds, new tool calls, and the latest output. A lightweight notice wakes the main agent when something looks abnormal or takes too long, so the powerful model can assess it and give targeted corrections. |
| **How do you run large batches of similar tasks?** | Native `workflow` asks the model to write arbitrary JavaScript, which can get out of control and does not enforce consistent model routing. | **Declarative `orchestrate` pipelines**: structured `items × stages` fan-out and multistage pipelines, with per-item failure isolation and strict JSON Schema validation. Every Worker is forced onto the low-cost subagent route. |

---

## Key features

### 1. A powerful Main Agent and low-cost Subagents (independent panel, immediate updates)

In the dedicated **Dispatch mode panel** below the composer, the main-agent and subagent model routes are fully independent:
- **Main Agent**: choose your strongest flagship model (such as `gpt-astra-6` or `claude-opus-5.5`) to focus on clarifying requirements, splitting tasks, correcting course, and accepting final results.
- **Subagent**: choose a slightly less capable but very inexpensive model with high throughput (such as `deepseek-v4.1-flash` or `gpt-luna-6`). **Every Worker launched through `delegate` or `orchestrate` must share this low-cost route**, unless the user explicitly names a different model for temporary use in the current message.
- **Cost protection**: dispatch fails with an error if no subagent model is configured; it **never silently falls back to the expensive main-agent model**.

![Dispatch mode panel](docs/images/dispatch-panel.png)

*Dispatch mode panel: on the left, configure the Main Agent (such as `gemini-4-argon-high`) and Subagent (such as `gemini-3.8-flash`) models and reasoning effort independently, along with the inspection interval. On the right, Allowed Tools (whitelist-driven) lists all host tools live, including MCP and other plugin tools. Checked tools are allowed for the main agent; unchecked tools, including tools from newly installed plugins, are disabled by default. No restart is needed; changes apply to the current session on its next message.*

### 2. A hard whitelist gate: the main agent plans and accepts results; subagents execute

Instead of relying on prompts asking the main model to use subagents more often, the plugin installs two guards at DSH's tool-definition outlet (`tools.definitions`) and execution layer (`tools.guard`), using a **whitelist-driven** approach. The definition layer trims the tool table visible to the model in real time, treating global tools and tools in scopes such as `ops_*` equally; the execution layer rejects any calls that slip through. Both layers read the current configuration on every request or call, without creating `tools.restrict` event storms, avoiding tool-visibility churn and prompt-cache invalidation from the official tool-hiding mechanism.
- **Execution tools are removed from the main agent entirely**: `DEFAULT_ALLOWED_TOOLS` permits only 12 planning, delegation, and read-only session tools by default — `delegate`, `orchestrate`, `send_message`, `interrupt_agent`, `todo_write`, `ask_user_question`, `compress`, and five read-only session log tools. All file tools (`read` / `edit` / `write` / `apply_patch`), search tools (`grep` / `glob`), terminals (`bash` / `pwsh`), web fetching, native `subagent` / `workflow`, and any future MCP or third-party plugin tools are automatically hidden and blocked at execution time, including nested calls through `run_code`. To allow additional tools, check them under Allowed Tools on the right of the panel.
- **Subagents retain the full toolchain**: dispatched Workers are exempt from the gate and read or write files, run tests, and inspect errors in their own contexts. When finished, they return only a concise conclusion for the main agent to review.
- **Switch at any time**: when the main agent needs to act directly, turn off Enable dispatch mode in the panel to restore all its tools immediately, without reopening the session.

### 3. Periodic background inspection of event logs and correction by the powerful model

Low-cost Subagents can occasionally get stuck on complex shell escaping or errors. The plugin includes a background inspector driven entirely by logs:
- **Reading the logs makes no model calls**: a background timer directly reads running Workers' session event logs at the configured interval (600 seconds by default), summarizes elapsed time, rounds, new tool calls, and the latest output, then combines them into a notice that wakes the main agent. Reading and summarizing make no LLM requests, but **assessment and correction after the main agent wakes still consume main-agent tokens**. The value is to compress continuous polling into one summary plus one decision, rather than make the entire supervision feature free.
- **The powerful model makes a quick assessment**: after receiving an inspection summary, the main agent needs only a small number of tokens to decide:
  - **A) Progress is normal**: reply with one line, `巡检：正常`, and end the turn while the subagent continues.
  - **B) Correct course**: call `send_message` to inject corrective instructions directly into the running subagent, specifying the right approach or telling it to skip a blocker.
  - **C) Stop wasted work promptly**: call `interrupt_agent` to interrupt a subagent that has gone off track. If it is later reactivated with `send_message`, supervision automatically resumes and resets its notice count.

![Example inspection notice and correction](docs/images/patrol-notice.png)

*Inspection and correction in practice: a low-cost subagent got stuck on shell quotes and backslash escaping. After a scheduled inspection woke the main agent, it supplied the correct syntax directly through `send_message` to get the worker back on track.*

### 4. `delegate` and `orchestrate`, built for dispatch mode

- **`delegate` (asynchronous tasks on demand / parallel fan-out)**:
  Dispatch self-contained, independent tasks (goal + allowed files + acceptance commands + fallback on failure). Multiple calls in the same turn start multiple Workers in parallel. The plugin injects a Simplified Chinese response instruction into every subagent's prompt and requires it to finish with a final summary in its reply, without calling `send_message` to report to its parent; the closing message is delivered to the main agent automatically.
  **`writeScope` (required, `string[]`)**: declare the files or directories this worker may modify. Supported forms are exact files (`src/index.js`), directories (`dir/` or `dir/**`), and the global root (`*`). Relative paths are normalized lexically against `cwd`, with case-insensitive deduplication on Windows. Omitting the field produces `write-scope-missing`; an empty array or invalid path produces `write-scope-invalid`.
- **`orchestrate` (declarative batch pipelines)**:
  Process a batch of items (`items`, 1–64) through a fixed set of stages (`stages`, 1–8), with `maxConcurrency` (1–16, default 4) controlling concurrency. Supports single-stage parallel fan-out and multistage **per-item pipelines without a global barrier**: an item enters stage 2 as soon as its stage 1 finishes, without waiting for slower items. Supports strict stage-level JSON Schema validation and per-item failure isolation.
  **`writeScope` (required, `string[]`)**: one top-level declaration applies to the entire batch, which **holds its write scope atomically**. The normalized scope is injected into each stage's prompt as a boundary reminder.
- **Single-writer exclusion (enforced before dispatch)**: `delegate` holds a lease per subagent; `orchestrate` holds one for the entire batch. Both share a process-wide lease table and check for overlaps across tools. Any overlap raises `write-scope-conflict` **before any subagent starts**, including the conflicting path, lease holder, expiration time, and `agentsStarted: 0`, preventing Workers from overwriting the same file concurrently. Leases are released idempotently on `subagent/end`, `agent/disposed`, in `orchestrate`'s `finally` (including errors and aborts), and when the plugin is unloaded, with a 30-minute TTL as a backstop against leaks.

---

## Requirements

| Item | Requirement |
| --- | --- |
| **Host environment** | DeepSeek Harness Desktop / Web GUI |
| **Node.js** | `>= 22` (bundled with the DSH Desktop runtime) |
| **Plugin form** | Cordis backend service patch (`cordis.patch.yml`) + Web GUI client extension (`lib/client.js`) |
| **UI language** | Adapts to Chinese / English (`zh-CN` / `en-US`) |

### DSH host version compatibility

The plugin depends on host subagent interfaces (the `startActivation` spec shape, the retry delivery entry point, root-agent enumeration, and the tool registry). DSH `0.2.2-rc.2` introduced a breaking change to these interfaces, so **plugin and host versions must be chosen as a pair**:

| Plugin version | Supported DSH host | Notes |
| --- | --- | --- |
| `dsh-orchestrator >= 0.8.3` (starting with this release) | **DSH `>= 0.2.2-rc.2`** | Verified against `0.2.2-rc.2` / `0.2.2-rc.3`. Since `0.2.2-rc.2`, the host has flattened the subagent spec, removed the `Symbol.for('dsh.subagent.deliverPrompt')` delivery entry point and `agents.roots()`, and added the `wait_agent` tool. It is therefore **incompatible with `0.2.2-rc.1` and earlier**. Note: although the host adds `wait_agent`, the plugin **intentionally keeps its default whitelist at 12 tools and excludes `wait_agent`**. Blocking polling can leave the main agent idling and misjudging timeouts; supervision already replaces polling with one summary plus one decision. If needed, manually check `wait_agent` in the panel's `allowedTools` list. |
| `dsh-orchestrator 0.8.0 – 0.8.2` | **DSH `<= 0.2.2-rc.1`** | Tested against `0.2.1-rc.3` and `0.2.2-rc.1`. The `@deepseek-ai/dsh-tools` dependency was introduced in `0.8.0`. |
| `dsh-orchestrator <= 0.7.3` | DSH releases predating plugin `0.8.0` | Early standalone tool-registration architecture, without a dependency on `@deepseek-ai/dsh-tools`. |

> Check the host version before upgrading: see About in DSH or read `package.json` in the installation directory. **Plugin `0.8.3+` with a `0.2.2-rc.1` or older host fails outright when dispatching**; an older plugin with a `0.2.2-rc.2+` host is also unusable. If you cannot upgrade the host yet, stay on plugin `v0.8.2`.

---

## Installation

Select Add from GitHub on the DSH plugin page. All three forms below are accepted; paste one into the input field. The first is recommended because it is the least likely to be misinterpreted by the client:

```text
https://github.com/SShiRkiT/dsh-orchestrator
github:SShiRkiT/dsh-orchestrator#main
SShiRkiT/dsh-orchestrator#main
```

```bash
# Equivalent CLI installation
dsh plugin --profile desktop add https://github.com/SShiRkiT/dsh-orchestrator
```

> After installation, **fully quit and reopen DSH** (client plugins are composed at startup and do not support hot updates). When upgrading, **uninstall the old version** from the plugin page before adding this repository again; two installed copies will compete over the same tool declarations.

---

## Configuration

All configuration fields are volatile (dynamic configuration): changes in the panel take effect immediately, without restarting DSH:

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch for dispatch mode. Turning it off immediately restores all main-agent tools in the current session. |
| `workerProvider` / `workerModel` | `""` | Default subagent model route (required; dispatch fails if unconfigured and never silently inherits the main-agent model). |
| `workerReasoningEffort` | `""` | Subagent reasoning effort. Leave empty to let the selected model use its own default. |
| `allowedTools` | 12 built-in tools | Whitelist-driven: the main agent may use only the listed tools; other host, MCP, and plugin tools are automatically hidden and disabled. Check or uncheck tools under Allowed Tools on the right of the panel to allow or disable them; changes apply on the next message. |
| `superviseEnabled` | `true` | Master switch for background subagent inspection. |
| `superviseIntervalSeconds` | `600` | Inspection interval in seconds, from 10 to 86400. Changes take effect immediately while workers are running. |
| `superviseMaxNoticesPerChild` | `3` | Maximum inspection notices per subagent (0–20). `0` disables inspection; running subagents remain registered, and inspection resumes immediately when the value is raised above 0 or unlimited inspection is enabled. |
| `superviseUnlimited` | `false` | Enables unlimited inspections. Ignores the `superviseMaxNoticesPerChild` limit (including `0`) and continues inspecting at each interval until the subagent stops, delivers, or ends. Notice titles omit the denominator (`第 N 次`). |
| `superviseNotifyOnNoProgress` | `false` | Whether to notify even when the subagent log has no new activity (effectively always enabled when `superviseUnlimited` is on). |

> Note: the main agent's default model is stored in the host's `agent-default-model`, read and written directly by the same Dispatch mode panel, and applies to newly created sessions. Subagent model changes apply to the next delegation.

## License

[MIT](LICENSE) © 2026 [SShiRkiT](https://github.com/SShiRkiT)
