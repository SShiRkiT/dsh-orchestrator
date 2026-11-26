<div align="center">

*Start from 28th October*

<div align="center">

# dsh-orchestrator

</div>

#### **Main-agent model plans, subagent models execute in isolation — the Dispatch · Supervise · Coordinate · Aggregate orchestrator plugin for DeepSeek Harness**

![dsh-orchestrator pixel-art cover](docs/images/hero-banner.png)

[![version](https://img.shields.io/github/v/release/SShiRkiT/dsh-orchestrator?label=version&color=4176E6&style=flat-square)](https://github.com/SShiRkiT/dsh-orchestrator/releases/latest)
[![dsh-plugin](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![platform](https://img.shields.io/badge/platform-Web%20GUI%20%7C%20Desktop-5c6bc0?style=flat-square)](https://github.com/SShiRkiT/dsh-orchestrator)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![module](https://img.shields.io/badge/module-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](package.json)
[![license](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/SShiRkiT/dsh-orchestrator?style=flat-square&logo=github)](https://github.com/SShiRkiT/dsh-orchestrator/stargazers)
[![npm](https://img.shields.io/npm/v/@sshirkit/dsh-orchestrator?color=cb3837)](https://www.npmjs.com/package/@sshirkit/dsh-orchestrator)

**English** | [简体中文](README.zh.md) · [What It Adds](#what-it-adds) · [Core Advantages](#seven-core-advantages) · [Tool Reference](#tool-reference) · [Installation & Compatibility](#installation--requirements) · [Panel & Configuration](#dispatch-panel--configuration) · [Contributing](#contributing--community)

</div>

**dsh-orchestrator** is a main/subagent orchestration plugin for local DeepSeek Harness (DSH) engineering sessions: hard guardrails keep the **main agent** focused on understanding requirements, breaking down tasks, overseeing progress, and final review, while **subagents** handle concrete implementation in parallel and in isolation.

---

 https://github.com/user-attachments/assets/f540b545-c697-4bbc-abb2-d55f74041172

> [▶ Watch Bilibili Version. Really appreciate if hit a like button, if possible ヽ(・∀・)](https://www.bilibili.com/video/BV1b7yBznEM9/)

---

<div align="center">

# What It Adds



It works smoothly alongside DSH's built-in collaboration tools and fills four practical gaps in intensive development:
</div>

**Keep the main model thinking, not doing chores**
> Hides and blocks file and terminal tools on the main agent so your flagship model doesn't drift into reading code or editing files directly.

**Isolated workspaces for every write task — merge only after review**
> Write tasks run in parallel inside separate temporary Git working directories by default, leaving your active checkout untouched and never merging into your main branch without approval.

**Background check-ins during work, explicit review at handoff**
> Periodically watches running subagents in the background so stuck or drifting work can be nudged back on track via `send_message`.
> At handoff, use `worktree_manage` to review changes before deciding whether to merge or discard an isolated Worktree.

**One-shot parallel batches and multi-step pipelines**
> Run repetitive batches or multi-step pipelines without writing custom scripts — list the items and stages to advance automatically up to your concurrency cap, with single-item failures isolated.

---

<div align="center">

# Seven Core Advantages

</div>

### 1. Keep the Main Model Thinking, Not Doing Chores

This plugin puts a double lock on the main model — tools it shouldn't touch are both hidden and blocked, keeping it focused on planning, delegation, tracking, and review.

Hands-on work is left to subagents. Flip the master switch off anytime to restore DSH to normal without restarting the session.

- Allows 9 management actions by default
  > `delegate`, `orchestrate`, `delegate_status`, `worktree_manage`, `send_message`, `interrupt_agent`, `todo_write`, `ask_user_question`, `compress`
- Automatically allows native Agent Teams task-board tools (`team_task_*`) when enabled;
- All other file, search, and terminal tools are hidden by default and can be toggled live in the right-hand panel.

---

### 2. Dedicated Isolated Directory per Task — Merge Only When Satisfied

When multiple subagents edit code at once, the biggest risk is overwriting each other or messing up your active workspace.
Inside a Git repo, the plugin spins up a separate temporary working directory for each write task by default.
Finished work is never merged into your main branch behind your back — you or the main model inspect the changes first, then explicitly merge or discard them.

> Managed via `worktree_manage` to list, inspect diffs, merge (`merge` / `squash` / `ff-only`), discard, or prune;
> Supports switching between auto-isolation, strict isolation, and shared workspace modes. Once a directory is cleaned up or discarded, associated retired subagents are permanently locked so later messages can never write back into your main checkout by mistake.

---

### 3. Coordinate Write Scopes Before Work Starts

In non-Git workspaces and shared mode, the plugin coordinates declared write scopes before a task starts. Each writable subagent declares its `writeScope`. The plugin rejects overlapping claims on the same physical paths. A write lease coordinates declared scopes only. Review deliverables separately after the task ends.

> Use `delegate_status` to see direct delegates' execution and lease states and any Worktrees awaiting review.

---

### 4. Dispatch Mode Panel

In the **Dispatch** panel next to the composer, main-agent and subagent models are configured completely separately:
- Both the default main model and default subagent model can be set explicitly.

> Specify a subagent model for a turn or workspace in your prompt or `AGENTS.md`. The main agent passes `provider` and `model` together and adds `reasoning_effort` only when requested.
> The workspace’s main-agent model can still be switched independently in DSH’s native model selector.

**Set up a tiered model routing table in `AGENTS.md` or your prompt**

Copy the table below into your workspace’s `AGENTS.md` or your prompt. The main agent reads and applies these rules; the plugin does not parse the table. An explicit route in the current message takes precedence over workspace rules. Replace the placeholders with actual provider and model IDs available in DSH. If no rule matches, omit all three route parameters.

| Task type | `provider` | `model` | `reasoning_effort` |
| --- | --- | --- | --- |
| Lightweight tasks (e.g. extraction or classification) | `<light-provider-id>` | `<light-model-id>` | Omit |
| Heavyweight tasks (e.g. architecture analysis or complex review) | `<heavy-provider-id>` | `<heavy-model-id>` | `high` (if supported by the model) |
| Other tasks | Omit | Omit | Omit |

![Dispatch Mode Panel](docs/images/dispatch-panel.png)

---

### 5. Scheduled Background Check-Ins

On long-running tasks, a subagent may occasionally get stuck in an error loop, wander into the wrong directory, or go off on a tangent.
The plugin checks running subagents' activity logs in the background at your configured interval and folds recent progress into a short report for the main model to decide on — nudging drifting workers right back on track via `send_message`.

> Reading logs and summarizing progress spends zero model quota; a small amount of main-model quota is only used when waking the main model to review or steer;
> Steer via `send_message` or stop via `interrupt_agent`; check-in interval, notice cap, and "Unlimited checks" are all adjustable live in the panel, alongside silent Todo list restoration.

![Example inspection notice and correction](docs/images/patrol-notice.png)

---

### 6. Seamless Hot Reloads, Honest Cold-Restart Reconciliation

When the plugin hot-reloads, running subagents stay connected and background check-ins continue. If you fully quit and reopen DSH, the plugin reconciles recorded Worktree, dispatch, and write lease states against the host. It releases leases for workers confirmed to have stopped and keeps protection when their status is uncertain.

> Uses the host's built-in storage for recovery, falling back to in-memory mode when storage is unavailable.
> After a full restart, the plugin does not automatically resume interrupted tasks.

---

### 7. Batch Jobs and Multi-Step Pipelines — List It and Let It Run

For repetitive or multi-step jobs like "inspect → edit → verify across 20 files," you don't need to dispatch tasks one by one. Just provide the item list and stage sequence, and the plugin moves them forward within your concurrency limit: once an item finishes step 1 it jumps straight into step 2 without waiting on slower items, one failure never cancels the rest, and each step can enforce a strict output format.

> Powered by `orchestrate`, supporting 1–64 items × 1–8 stages and 1–16 concurrent workers (default 4), with optional per-stage JSON format checks; in isolated mode each item gets its own working directory reused across stages, excluded from background check-ins.

To explicitly select a model for a stage, pass `provider` and `model` together in that `stages` entry, with optional `reasoning_effort`. Each stage chooses one whole route: **stage override > top-level batch override > panel default worker route**. Routes are never combined, and reasoning effort is not inherited from a fallback route. The panel default is required only when a stage needs it; if it is missing, the batch starts no workers.

---

<div align="center">

# Tool Reference

</div>

The plugin exposes 4 orchestration and review tools exclusively to the main agent (hidden from subagents):

| Tool | What It Does | Common Parameters | Good to Know |
| --- | --- | --- | --- |
| `delegate` | Async task dispatch with reuse first | `prompt`, `description`, `writeScope` (required for writes), `readOnly`, `isolation`, `allowNewReason`, `cwd`, `provider` + `model`, optional `team_task_id` | A reusable inactive child under the same parent blocks new dispatch with `delegate-reuse-required` and `details.candidates`. If a new child is necessary, supply a nonblank `allowNewReason`. Running delegates receive background check-ins. |
| `orchestrate` | Parallel batch & multi-stage pipelines | `items` (1–64), `stages` (1–8, optional `schema`), `maxConcurrency` (1–16, default 4), `writeScope`, `readOnly`, `isolation`, `cwd`, optional top-level `team_task_id`; `provider` + `model` with optional `reasoning_effort` at the top level or per stage | Route priority: stage override > batch override > panel default. Items advance independently, reuse their own isolated directory, and run synchronously without background check-ins |
| `delegate_status` | Query direct delegates or edit the next turn for an inactive direct delegate | `action` (`query` by default or `edit`), `childId` (required for `edit`), `writeScope` / `readOnly` (at least one for `edit`), `includeCompleted` (query default `true`), `limit` (1–64, default 20) | `query` shows execution, lease, and Worktree states. `edit` saves `pendingNextTurn`. Use `send_message` to apply it and wake the same child. |
| `worktree_manage` | List, inspect, merge, discard, or prune isolated directories | `action` (`list`/`inspect`/`merge`/`discard`/`prune`), `worktreeId` / `childId`, `strategy` (`merge`/`squash`/`ff-only`), `autoStageDirty`, `deleteAfterMerge`, `force`, `dryRun` | `inspect` shows the live diff, commits, and dirty state, including untracked paths. Merge conflicts preserve the Worktree for review. Cleaning up or discarding locks retired workers. |

To reuse an inactive child with a different write scope or read-only setting, first call `delegate_status` with `action: "edit"`, then use `send_message`. Before delivery, the plugin calls `replaceOwnerLease` to atomically replace the lease. A conflict prevents delivery, and a confirmed rejection rolls back the swap and restores the pending settings. If delivery is uncertain, the plugin keeps the new lease protection and blocks duplicate wakeups.

`readOnly` is available when **Enable the read-only parameter** is on for the current session. The same setting applies when editing the next turn to be read-only. With the option off, pass `isolation: "shared"` for read-only research, include the required `writeScope`, and explicitly tell the subagent to leave files untouched.

When native Agent Teams is on for the host's root session and dispatch mode permits `team_task_create` in that session, the main agent can create a shared goal before dispatching complex work. Pass the returned `id` as `team_task_id`; subagents (every stage in `orchestrate`) can read the goal with `team_task_get` when available. Keep the task prompt self-contained: the shared goal is a reference, not a substitute for dispatch or write leases.

---

<div align="center">

# Installation & Requirements

</div>

| Item | Requirement |
| --- | --- |
| **Host environment** | DeepSeek Harness Desktop / Web GUI |
| **Host version** | `>= 0.2.2-rc.2 < 0.2.3-0` (verified through **`0.2.2-rc.5`**) |
| **Node.js** | `>= 22` (bundled with the DSH Desktop runtime) |
| **Plugin architecture** | Cordis backend service patch (`cordis.patch.yml`) + Web GUI client extension (`lib/client.js`) |
| **UI language** | Bilingual auto-switching (`zh-CN` / `en-US`) |

<div align="center">

# Version Compatibility

</div>

| npm Package | Plugin Version | Supported DSH Host | Notes |
| --- | --- | --- | --- |
| `@sshirkit/dsh-orchestrator` | `v1.0.0` onward | **DSH `>= 0.2.2-rc.2 < 0.2.3-0`** | Actively maintained; verified through `0.2.2-rc.5`. Incompatible with `0.2.2-rc.1` and earlier. `wait_agent` is intentionally excluded from the default whitelist (event-driven delivery + sidecar supervision replace blocking polling); check it manually in the panel if needed. |
| `dsh-orchestrator` (earlier unscoped package) | `v0.8.0` – `v0.8.2` | **DSH `<= 0.2.2-rc.1`** | Stay on `v0.8.2` if you cannot upgrade the host yet. |

<div align="center">

# Installation

</div>

**Option 1: DSH GUI**

Open the DSH Plugins page, choose **Add Plugin → Install Third-Party Plugin**, and enter any of the following valid specifiers (the first URL or npm package name is recommended):

```text
https://github.com/SShiRkiT/dsh-orchestrator
github:SShiRkiT/dsh-orchestrator#main
@sshirkit/dsh-orchestrator
```

**Option 2: CLI**

```bash
# Install from GitHub
dsh plugin --profile desktop add https://github.com/SShiRkiT/dsh-orchestrator
# Or install from npm
dsh plugin --profile desktop add @sshirkit/dsh-orchestrator
```

> If the **Dispatch** panel does not appear on the right of the composer after first install or a client update, fully quit and restart DSH.

---

<div align="center">

# Dispatch Panel & Configuration

</div>

## Right-Side Composer "Dispatch" Panel

The bilingual panel follows DSH's locale and provides live controls without a restart:

- **Enable dispatch mode** toggles the main-agent whitelist gate for open conversations.
- **Main agent / Subagent default model & reasoning effort** offers a searchable model picker for each route. In global mode, the main-agent default is saved to the host's `agent-default-model`. The worker route applies from the next dispatch unless a task or stage overrides it.
- **Subagent check interval / check count / Unlimited checks** can be adjusted while workers run.
- The **right-hand `Allowed Tools` checklist** lets you search, select tools for the main agent, and reset the list.

Starting with `v1.0.3`, **Only for this session** and **More** sit above a divider at the top of the right column. The switch applies to the entire panel. Turning it on saves a snapshot of the current settings, and subsequent edits stay in this session. The snapshot covers all ten settings: `enabled`, `worktreeIsolationEnabled`, `readOnlyEnabled`, `peerReadOnlyConsultEnabled`, `mainRoute`, `workerRoute`, `superviseIntervalSeconds`, `superviseMaxNoticesPerChild`, `superviseUnlimited`, and `allowedTools`.

Session mode leaves global settings and the host's `agent-default-model` intact. A session-specific main model takes effect on the next model step that has yet to be prepared. Turning **Only for this session** off clears the override and automatically restores the current global default model and settings. If session storage is unavailable, the switch is disabled and explicit global editing is still available.

**More** opens a separate dialog centered in the conversation. Dismiss it with the close button, `Esc`, or a click on the backdrop.

- **Enable Git Worktree isolation by default** (`worktreeIsolationEnabled`, defaults to `true`) controls isolation for Git write tasks using `isolation: "auto"`.
- **Enable the read-only parameter** (`readOnlyEnabled`, defaults to `false`) controls whether `delegate` and `orchestrate` expose and accept `readOnly`. With it off, the model is directed to use `isolation: "shared"` for read-only research that needs no isolation. If you enable it, we recommend also enabling **Allow peer consultation**.
- **Allow peer consultation** (`peerReadOnlyConsultEnabled`, defaults to `false`) lets subagents with the same parent in one session share an index of the files they have read and ask each other about that context via `send_message`. The index contains only paths and locations. The main agent silently filters recognized peer consultation relays.

When the composer is centered on the new-session screen (the Hero layout), the Dispatch panel respects the viewport's safe edges and can open above or below the button to avoid being clipped by the top navigation bar.

## Configuration Reference

All 15 user-configurable fields below are `volatile` (dynamic hot config, no restart required: execution gates reread per call, tool surfaces update on the next request, and worker routes apply on the next dispatch):

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch for dispatch mode. Turning it off restores the native host tool surface; `delegate` / `orchestrate` stay disabled and bound supervision-turn hard locks still take priority. |
| `worktreeIsolationEnabled` | `true` | Controls whether `isolation: "auto"` creates isolated Worktrees for Git write tasks. Non-Git workspaces use shared mode with write leases. |
| `readOnlyEnabled` | `false` | Enables `readOnly` for `delegate` and `orchestrate`. When off, both tools hide and reject the argument, and the model is prompted to use the shared workspace for read-only research. |
| `peerReadOnlyConsultEnabled` | `false` | Lets sibling subagents in one session share a read-file index and consult each other via `send_message`. |
| `allowedTools` | Unset (9 base tools; plus 4 registered native Team tools when `allowAgentTeam: true`) | Explicit main-agent tool whitelist. An explicit array (including `[]`) **replaces** the defaults rather than appending. The panel's `Allowed Tools` checklist updates this field when **Only for this session** is off. |
| `allowAgentTeam` | `true` | Controls only the main agent's access to native task-board tools (`team_task_*`) in dispatch mode; it does not switch host Agent Teams on or off. `false` overrides the session and global whitelists. When the root session has native Agent Teams on and its whitelist permits `team_task_create`, the main agent can create a shared goal and pass its ID as optional `team_task_id` for subagents to read. |
| `workerProvider` | `""` | Default worker route provider. When no explicit override applies, both this and `workerModel` are required; there is no fallback to the main model. |
| `workerModel` | `""` | Default worker route model; same requirement as above. |
| `workerReasoningEffort` | `""` | Default worker reasoning effort; leave empty to let the chosen worker model use its own default. |
| `superviseEnabled` | `true` | Master switch for background sidecar supervision (in the host plugin settings card). |
| `superviseIntervalSeconds` | `600` | Sidecar supervision interval in seconds (`10–86400`); changes apply immediately to running workers. |
| `superviseMaxNoticesPerChild` | `3` | Maximum supervision notices per subagent (`0–20`). When unlimited checks are off, `0` disables supervision. |
| `superviseUnlimited` | `false` | Ignores `superviseMaxNoticesPerChild` (including `0`) and continues checking at each interval until the worker stops, delivers, or ends. |
| `superviseNotifyOnNoProgress` | `false` | Whether to notify even when a worker's log shows no new activity (in the host plugin settings card; effectively always on when `superviseUnlimited` is enabled). |
| `restoreTodoOnSupervision` | `true` | Silently restores Todo UI state via `todo/write` from an eligible snapshot during supervision, with no model history entry and zero token cost (in the host plugin settings card). |

> Note: The config schema also includes `toolCatalog`, an **internal read-only runtime mirror** published automatically by the plugin so the Web panel can render the host's complete registered tool list — no manual editing is needed. The main agent's default model lives in the host's `agent-default-model`, read and written by the same Dispatch panel.

---

<div align="center">

# Contributing & Community

</div>

The Chinese README is maintained first, and this English version is kept in sync. These documents cover terminology, architecture decisions, contribution workflows, and support channels:

- Project glossary [`GLOSSARY.md`](docs/GLOSSARY.md)
- Architecture decision records (ADRs) [`docs/adr/`](docs/adr/)
- Release notes [`docs/releases/`](docs/releases/)
- Contribution guide [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)
- Code of conduct [`.github/CODE_OF_CONDUCT.md`](.github/CODE_OF_CONDUCT.md)
- Security policy and private vulnerability reporting [`.github/SECURITY.md`](.github/SECURITY.md)
- Support and help [`.github/SUPPORT.md`](.github/SUPPORT.md)
- Accessibility statement [`.github/ACCESSIBILITY.md`](.github/ACCESSIBILITY.md)

<div align="center">

# License

</div>

[MIT](LICENSE) © 2026 [SShiRkiT](https://github.com/SShiRkiT)
