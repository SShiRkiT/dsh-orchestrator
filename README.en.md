# DSH Orchestrator

**A "dispatch mode" plugin for DeepSeek Harness.** It splits a session into two layers: the main agent (the one that faces the user) only clarifies, plans, slices work, and accepts results — it does not read files, run commands, or fetch pages; every concrete action is handed to subagents through `delegate` (asynchronous, on demand) or `orchestrate` (declarative batch). The main agent and the subagents have separately configured default models and reasoning efforts, and all subagents share the same subagent route.

[中文](README.md)

## Key features

- **The main agent only plans, enforced by a gate**: a built-in deny list of 49 tools hides and refuses read, write, shell, web, and the rest at execution time; the main agent keeps only `delegate`, `orchestrate`, `send_message`, `todo_write`, and `ask_user_question`.
- **Parallel dispatch of independent subtasks**: independent subtasks go out together in the same turn; `delegate` has no plugin-side concurrency cap, while `orchestrate` limits live workers with `maxConcurrency` (1–16, default 4).
- **Declarative orchestration**: `orchestrate` does single-stage fan-out and multi-stage per-item pipelines (no global barrier); results keep input order, one failed item does not sink the others, and a stage can declare an object schema for structured results.
- **Supervision and correction**: when a `delegate` worker runs long, the plugin merges its session log into one notice that wakes the main agent; the main agent corrects it with a concrete `send_message`, or decides no intervention is needed and ends the turn with a one-line note.
- **Collecting results**: `delegate` returns `{ kind: "activation", subagentId }` immediately and the host delivers the worker's result to the main agent as a message when it finishes; `orchestrate` collects every result synchronously inside the tool call.
- **Zero-build import**: `lib/` already contains the files DSH needs to load, so the plugin works right after cloning it or adding it from GitHub.

## How it differs from a plain single-agent session

| | Plain single-agent session | Dispatch mode |
| --- | --- | --- |
| Who executes | the main model calls tools itself | workers execute; the main agent only dispatches |
| Context | tool output piles up in the main context | each worker carries its own context |
| Parallelism | tool calls complete one after another | several workers run at once |
| Models | one model does everything | two routes, main agent and subagent |
| Boundaries | the model is expected to comply | the gate refuses by force |

## Install

Add it from GitHub in the DSH plugin page, or use the CLI:

```text
SShiRkiT/dsh-orchestrator#main
```

```bash
dsh plugin --profile desktop add SShiRkiT/dsh-orchestrator#main
```

After installing, **fully quit and reopen DSH**: client plugins are composed at startup and are not hot-updated.

## Enable

1. Dispatch mode is already on after installing and restarting (`enabled` defaults to `true`).
2. Configure `workerProvider` and `workerModel` (required) and `workerReasoningEffort` (may stay empty, letting the model resolve its default) in the composer's "Dispatch mode" panel; dispatching without a route fails outright instead of silently inheriting the main-agent model.
3. Clear "Enable dispatch mode" to temporarily restore all main-agent tools; it applies to already-open sessions immediately.

## Configuration

Every field is volatile: the host stores it and the plugin re-reads it on each use, so changing the configuration needs no restart.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for dispatch mode. When off it revokes the hiding; the guard stays installed and lets calls through. |
| `deniedTools` | 49 built-ins | Tools the main agent may not use; it can only add, never remove. |
| `workerProvider` | `""` | Subagent provider; empty means unconfigured. |
| `workerModel` | `""` | Subagent model; empty means unconfigured. |
| `workerReasoningEffort` | `""` | Subagent reasoning effort; empty means it is not passed and the model resolves its default. |
| `superviseEnabled` | `true` | Master switch for supervision. |
| `superviseIntervalSeconds` | `600` | Supervision interval in seconds, an integer 10–86400. |
| `superviseMaxNoticesPerChild` | `3` | Most notices per subagent, an integer 0–20; `0` means unlimited. |
| `superviseNotifyOnNoProgress` | `false` | Whether to also notify when the log shows no new activity. |

The main agent's default route is not part of this configuration: it lives in the host's `agent-default-model` (`provider` / `model` / `reasoningEffort`), is written by the same panel, and is read when a new agent is created.

## Usage

### delegate: one self-contained dynamic task

It has only three parameters: `prompt` (the complete task, required), `description` (a 3–5 word display name, required), and `cwd` (optional). The worker cannot see the main agent's conversation, so the prompt has to carry all the context itself:

```json
{
  "description": "move config loading",
  "prompt": "Goal: move config loading from config.ts to settings.ts without changing behaviour\nFiles you may change: src/config.ts, src/settings.ts\nAcceptance: node --test test/settings.test.mjs\nOn failure: do not change the public API; write the reason into the conclusion and stop"
}
```

The language of a worker's reply follows its prompt: a prompt containing Chinese gets `Reply in Simplified Chinese.` prepended, Russian, Japanese, and Korean work the same way, and any other language is answered in the same language as the request. For several independent tasks, call `delegate` once each in the same message and they all start at once.

### orchestrate: batch dispatch

"One set of items × one fixed set of stages" goes to `orchestrate`, and one call collects every result; use `delegate` instead when you need to branch on intermediate results, loop, or reshape the dispatch while reading results. With a single stage, every item gets its own worker:

```json
{
  "items": ["alpha", "beta", "gamma"],
  "stages": [
    { "name": "summarize", "prompt": "Summarize this item in one sentence." }
  ],
  "maxConcurrency": 2
}
```

With several stages, items advance one by one and a later stage automatically receives the earlier output of the same item. `items` is 1–64 and `stages` is 1–8; the call returns `{ kind: "orchestration", agentsStarted, results, errors }`, with `results` in input order and `null` for a failed item.

`delegate` is asynchronous: there is no progress callback, and the main agent has no tool to stop a worker — stopping one takes a host-side action.

## License

MIT © 2026 SShiRkiT
