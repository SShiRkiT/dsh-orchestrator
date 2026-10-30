# DSH Orchestrator

**A "dispatch mode" plugin for DeepSeek Harness.** It splits a session into two layers: the main agent (the one that faces the user) only clarifies, plans, slices work, and accepts results — it does not read files, run commands, or fetch pages; every concrete action is handed to subagents through `delegate` (asynchronous, on demand) or `orchestrate` (declarative batch). The main agent and the subagents have separately configured default models and reasoning efforts, and all subagents share the same subagent route.

[中文](README.md)

## Dispatch mode: the main agent plans, every action is dispatched

### Why two layers

In an ordinary single-agent session, the output of reading files, running commands, and fetching pages all piles into the same context: the model has to make decisions and carry details at once, tool output crowds out reasoning room as soon as there is much of it, and all work is serial. Dispatch mode separates "thinking" from "doing":

- the main agent's context holds only plans, task cards, worker reports, and conclusions;
- workers consume their own context in their own sessions and never see the main agent's conversation;
- several workers can run at once without blocking each other;
- the models can be split by role: a strong model plans in the main agent while a cheap model executes in workers (or the other way round);
- going out of bounds does not rely on the prompt being obeyed — the plugin gate enforces it.

The cost is equally clear: workers cannot see the main conversation, so a task card has to be self-contained; dispatching and merging themselves cost tokens; and asynchronous results have to be caught by the main agent on a later turn.

### The gate: the main agent gets no execution tools

By default it denies 49 built-in tools: read, write, edit, shell (`ops_bash` / `pwsh` / `bash` / `shell`), the native multi-agent tools (`subagent`, `subagent_fork`, `workflow`, `ralph`), web, scheduled tasks, session search, goals, skills, context compression, `interrupt_agent`, and so on. It keeps `delegate`, `orchestrate`, `send_message`, `todo_write`, and `ask_user_question`.

The gate has two layers, and both are required:

- `tools.restrict` hides the global tools from the tool list;
- `tools.guard` refuses a second time at execution time, which covers the native `subagent` registered in the agent's own scope (`restrict` throws for it) and also covers tool calls issued from inside `run_code`.

`run_code` itself is not on the deny list, but the denied tool calls it issues are stopped one by one by the guard. Subagents are never gated: whether an agent is the main agent is decided by the `delegationDepth` persisted in the session header, so a cold resume does not mistake a subagent for the main agent either. The switch applies live — the guard rereads `enabled` on every call, and turning it off revokes the hiding immediately.

### Parallel dispatch

`delegate` is declared concurrency-safe; independent subtasks should be dispatched together in the same message instead of waiting for one to return before starting the next. The rules stated in the tool description:

- several independent subtasks: start them all in the same turn;
- only very simple tasks get a single worker;
- many homogeneous items go to `orchestrate`;
- two workers must not change the same file.

`delegate` has no plugin-side concurrency cap; concurrency is simply how many the main agent dispatches at once. `orchestrate` limits live workers with `maxConcurrency` (1–16, default 4), and a slot is held from before the worker starts until its result has been read and the subagent released.

### Supervision and correction

`delegate` is asynchronous: the main agent gets an id back and continues its own turn. For workers that run long, the plugin reads the session log at the configured interval and merges the due workers under the same parent into one notice that wakes the main agent (the mechanism is in [Supervision loop](#supervision-loop)). On that basis the main agent decides: give a specific correction to a worker with `send_message`, or judge that no intervention is needed and end the turn with a one-line note. A finished worker can also be reused with `send_message`; it keeps executing in its original session under the same worker route and tool permissions.

### Collecting results

- `delegate` returns `{ kind: "activation", subagentId }` immediately; when the worker finishes, the host delivers its result to the main agent as a message (`delivery: "parent"`).
- `orchestrate` waits synchronously for all results inside the tool call and returns `{ kind: "orchestration", agentsStarted, results, errors }`, with `results` in input order.

### How it differs from a plain single-agent session

| | Plain single-agent session | Dispatch mode |
| --- | --- | --- |
| Who executes | the main model calls tools itself | workers execute; the main agent only dispatches |
| Context | tool output piles up in the main context | each worker carries its own context |
| Parallelism | tool calls complete one after another | several workers run at once |
| Models | one model does everything | two routes, main agent and subagent |
| Boundaries | the model is expected to comply | the gate refuses by force |
| Progress | the main model simply knows | supervision wakes at the interval, `send_message` corrects |
| Cost | no dispatch overhead | one extra dispatch and merge; task cards must be self-contained |

## Features

- **Main-agent gate**: hides tools and also refuses out-of-bounds calls at execution time, covering agent-local tools such as the native `subagent`; `deniedTools` is unioned with the built-in list, so configuration can only add, never remove.
- **Independent subagent route**: every dispatch reads the current configuration, so a model or reasoning-effort change applies from the next dispatch.
- **Two dispatch shapes**: one or two dynamic tasks whose next step depends on the previous result go to the asynchronous `delegate`; batch work that is "one list × one fixed set of steps" goes to the declarative `orchestrate`.
- **Declarative orchestration**: single-stage fan-out, multi-stage per-item pipelines (with no global barrier); results keep input order, one failed item does not sink the others; each stage can declare an object schema to get structured results.
- **Subagent supervision**: when a `delegate` worker runs too long, the plugin reads its session log at the configured interval and merges the findings into one notice that wakes the main agent; it never interrupts the worker and the check itself makes no model call.
- **Reusing finished subagents**: after `delegate` returns, `send_message` can still make the same worker continue in its original session.
- **Model picker panel**: the "Dispatch mode" panel to the right of the composer toggles the plugin, picks the main-agent and subagent models and reasoning efforts separately, and changes the supervision interval; the model list supports search, keyboard selection, and the dark theme.
- **Session stage projection**: derives `idle / clarify / planning / awaiting / executing` from existing session events (forked sessions report `na`) without storing extra conversation content. `orchestrate` counts as "executing"; a lone `delegate` currently does not.
- **"Plan" button**: the plugin injects a switch into the composer that calls the host's `/plan` (`/plan off`), whose hover title carries the current session stage; it only controls the host's plan mode and is independent of this plugin's dispatch switch, so both can be on at once.
- **Zero-build import**: `lib/` already contains the files DSH needs to load, so the plugin works right after cloning it or adding it from GitHub.

The native `workflow`, `subagent`, `subagent_fork`, and `ralph` tools are not among the released ones; the reasoning is in [ADR 0002](docs/adr/0002-declarative-orchestrate-instead-of-native-workflow.md).

## Install

### From GitHub

In the DSH plugin page choose to add from GitHub, using:

```text
SShiRkiT/dsh-orchestrator#main
```

You can also use the CLI:

```bash
dsh plugin --profile desktop add SShiRkiT/dsh-orchestrator#main
```

For the web profile:

```bash
dsh plugin --profile web add SShiRkiT/dsh-orchestrator#main
```

### From a local directory

```bash
dsh plugin --profile desktop add "D:\path\to\dsh-orchestrator"
```

After installing, **fully quit and reopen DSH**. Client plugins are composed at startup and are not hot-updated.

## Enabling and first-time configuration

1. Dispatch mode is already on after installing and restarting (`enabled` defaults to `true`), and the main agent cannot see those 49 tools.
2. Configure the subagent route in the composer's "Dispatch mode" panel: `workerProvider` and `workerModel` are required, while `workerReasoningEffort` may stay empty (when empty, the model resolves its default effort). Dispatching without configuration fails outright: `orchestrator: the worker route is not configured (set workerProvider and workerModel)` — it never silently inherits the main-agent model.
3. To temporarily restore all main-agent tools, clear "Enable dispatch mode" in the panel; it applies to already-open sessions immediately.

## Configuration reference

Every field is volatile: the host stores it and the plugin re-reads it on each use, so changing the configuration needs no restart.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for dispatch mode. When on it hides and refuses `deniedTools`; when off it revokes the hiding (the guard stays installed and simply lets calls through). |
| `deniedTools` | 49 built-ins | Tools the main agent may not use. Unioned with the built-in list, so it can only add; putting `delegate` / `orchestrate` in it does not make the guard refuse them. |
| `workerProvider` | `""` | Subagent provider; empty means unconfigured. |
| `workerModel` | `""` | Subagent model; empty means unconfigured. |
| `workerReasoningEffort` | `""` | Subagent reasoning effort; empty means it is not passed and the model resolves its default. |
| `superviseEnabled` | `true` | Master switch for supervision; when off nothing is scanned and no notice is sent. |
| `superviseIntervalSeconds` | `600` | Supervision interval in seconds, an integer 10–86400; 600 seconds is 10 minutes. |
| `superviseMaxNoticesPerChild` | `3` | Most notices per subagent, an integer 0–20; `0` means unlimited. Once spent, the subagent is removed from tracking at its next due time. |
| `superviseNotifyOnNoProgress` | `false` | Whether to also notify when the log shows no new activity; turning it on costs extra model turns. |

The main agent's default route is not part of this configuration: it lives in the host's `agent-default-model` (`provider` / `model` / `reasoningEffort`), is written by the same panel, and is read when a new agent is created.

## Usage

1. Click the "Dispatch mode" button in the composer: the checkbox at the top enables or disables the plugin, the two rows below pick the main agent's and the subagent's default model and reasoning effort, and the bottom changes the subagent supervision interval. This switch is independent of the host's built-in **plan mode (`/plan`)**; both can be on at once.
2. Main-agent changes are read when an agent is created, so new sessions use the new values; subagent changes apply from the next `delegate` or `orchestrate`, and both kinds of dispatch share one route.
3. In the model list you can type a provider, a model ID, or a display name to filter. `↑` / `↓` moves, `Enter` chooses, `Esc` collapses the list. Switching models clears the previous model's reasoning effort so that an unsupported value is not carried over to the new model.
4. Let the main agent dispatch dynamic tasks through `delegate`, or batch tasks through `orchestrate`, then handle supervision notices and worker results as needed.

The switch also affects **already-open sessions**: the guard rereads the switch on every call, so after turning it on the main agent's next out-of-bounds call is refused immediately, and hidden tools disappear from the tool list from the next step.

### delegate: one self-contained dynamic task

`delegate` has only three parameters: `prompt` (required, the complete task), `description` (required, a 3–5 word display name), and `cwd` (optional, the worker's initial working directory). The worker cannot see the main agent's conversation, so the prompt has to carry all the context itself, usually written as one task card:

```text
Goal: move config loading from config.ts to settings.ts without changing behaviour
Files you may change: src/config.ts, src/settings.ts, test/settings.test.mjs
Acceptance: node --test test/settings.test.mjs
On failure: do not change the public API; write the reason into the conclusion and stop
```

```json
{ "description": "move config loading", "prompt": "……(the task card above)", "cwd": "D:\\repo" }
```

The language of a worker's reply follows its prompt: when the prompt contains Chinese, the plugin prepends `Reply in Simplified Chinese.`; Russian, Japanese, and Korean work the same way, and any other language is answered in the same language as the request.

### Parallel delegate

For several independent tasks, call `delegate` once each in the same message:

```text
delegate: add unit tests for the handlers under api/   (change only test/api/)
delegate: update the install commands in README        (change only README.md)
delegate: bump the CI node version to 22               (change only .github/workflows/ci.yml)
```

All three start at once. Workers do not share context, so every prompt must be self-contained; also do not let two workers change the same file.

### send_message: correction and reuse

`send_message` is the only "action" channel the plugin leaves to the main agent: it does not run a task, it only talks to an existing worker.

- when supervision finds a worker drifting or going in circles, give it a concrete instruction rather than a vague reminder — name the file to change, the command to run, and the acceptance criterion;
- when a worker has finished but still needs one more step in the same context, reuse it directly, saving a fresh dispatch and the effort of restating the context;
- a message does not interrupt the worker's current step: a working worker receives it at its next step, and an idle worker starts a new turn with it.

```text
send_message(agent_id: "session-3f9c…", message: "Leave src/api/* alone; first list the failing cases in test/api/, then run only that one file after the fix.")
```

### orchestrate: batch dispatch

`orchestrate` handles "one set of items × one fixed set of stages": each item goes through all stages independently and one call collects every result. Use `delegate` instead when you need to branch on intermediate results, loop, or reshape the dispatch while reading results.

Input fields:

- `cwd` (optional): the workers' working directory, defaulting to the session working directory.
- `items` (required, 1–64): the items to process — any JSON value (string, number, boolean, null, object, array) — numbered in input order.
- `stages` (required, 1–8): each `{name, prompt, schema?}`, applied to every item in order.
- `maxConcurrency` (optional, 1–16, default 4): the live worker cap.

Unknown fields fail outright (including `provider` / `model`: the route can only come from the plugin configuration).

**Fan-out**: with a single stage, every item gets its own worker:

```json
{
  "items": ["alpha", "beta", "gamma"],
  "stages": [
    { "name": "summarize", "prompt": "Summarize this item in one sentence." }
  ],
  "maxConcurrency": 2
}
```

**Pipeline**: with several stages, items advance one by one and there is no global barrier — item A may be in its second stage while item B is still in its first. A later stage automatically receives the earlier output of the same item:

```json
{
  "items": ["alpha", "beta"],
  "stages": [
    { "name": "draft", "prompt": "Write a short description of this item." },
    { "name": "review", "prompt": "Point out factual problems in the previous stage's description; say there are none if there are none." }
  ]
}
```

Prompts need no placeholders: the plugin appends the current item (as JSON), the stage index, and the previous stage output to the end of the stage prompt.

**Structured results**: a stage may declare an object JSON Schema; once declared, that stage's `output` is an object that satisfies it rather than free text:

```json
{
  "items": ["alpha", "beta"],
  "stages": [
    {
      "name": "classify",
      "prompt": "Decide which category this item belongs to and briefly justify it.",
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

When a schema is declared, the prompt asks the worker to prefer calling `structured_output`, and to return only JSON text conforming to the schema when that tool is unavailable; this text fallback is fully schema-validated under both the `completed` and `error` stop reasons, and no fallback happens for any other stop reason (aborted, max-tokens, refusal, and so on). The `structured` value returned by the worker takes precedence over text, and a failed validation fails the whole stage instead of degrading to text.

A schema accepts only a subset: the root must be an object; nodes support object / array / scalar types, `oneOf`, `enum`, `const`, plus `description` / `title` / `default` / `examples`; unknown keywords, properties in `required` that are not declared in `properties`, and sibling constraints next to `oneOf` all fail before any worker starts.

Results and failures:

- Returns `{ kind: "orchestration", agentsStarted, results, errors }`.
- `results` keeps input order: a successful item is `{index, output, stopReason}`, a failed item is `null`.
- Each `errors` entry is `{index, stage, message}` where `stage` is the stage name; after an item fails at a stage, its later stages are skipped and the other items keep going. `errors` is sorted by item index and then by stage order.
- `agentsStarted` is the total number of workers that started successfully across all items and stages; workers that failed to start and skipped stages are not counted.
- When the combined result exceeds 50000 characters the whole call fails with an explicit error instead of truncating silently; split the work into several orchestrations when that happens.
- Whole-call errors such as failed input validation or an unconfigured worker route fail outright and return no partial results.

Limits:

- No arbitrary JavaScript and no background mode; one call returns all results synchronously.
- Callers cannot specify a provider / model; every worker uses the plugin's subagent default route.
- Batch work only has the one shape, "items × stages"; anything that needs dynamic control flow goes back to `delegate`.

Relation to native `workflow`: native `workflow` stays denied. Its scripts inherit the main-agent model by default and can also override the route per call, and they allow arbitrary control flow and background runs, so the gate cannot bound them to enumerable inputs. `orchestrate` removes all three through declarative input: the route has exactly one source, the result shape is fixed, and failures can be merged. `subagent`, `subagent_fork`, and `ralph` likewise stay denied. See [ADR 0002](docs/adr/0002-declarative-orchestrate-instead-of-native-workflow.md).

## Supervision loop

"Plugin supervision" is not a user message: it is generated by the plugin and delivered to the main agent through `followup`.

- **Scan**: the timer ticks every 5 seconds (fixed, independent of configuration) and only compares due times; a subagent's session log is read only when that subagent comes due.
- **Read**: it reads the subagent session's event log directly (`seq` / `time` / `type` / `data`), with no model call and no tokens.
- **Summarize**: turns, steps, the number of new tool calls since the last check, the latest tool, and the last output (at most 300 characters); it also looks for the longest run of "same tool + same arguments" in the latest 20 tool calls and flags "possibly going in circles" once that run reaches 3.
- **Merge**: all due subagents under the same parent are merged into one notice; when the parent already has an unconsumed supervision notice, the whole batch is skipped and consumes no budget.
- **Deliver**: with `followup` rather than `steer` — an idle main agent starts a new turn immediately, and a busy one gets the notice at the current turn boundary.
- **No progress**: when the log has no new events and no loop was detected, no notice is sent by default (`superviseNotifyOnNoProgress` changes this) and only the next due time is pushed back.
- **Budget**: 3 notices per subagent by default; once they are spent, that subagent is removed from tracking.
- **Length**: the whole notice stays within 2000 characters; when it is too long, each subagent's "last output" is shortened first, and if that is still not enough, subagents are dropped from the end with a line saying how many were left out.
- **Lifecycle**: a subagent is untracked when it ends or when its parent is gone. The registry lives only in memory and is cleared when the plugin process restarts.
- **Changing the interval**: a change in the panel applies immediately — the next tick recomputes due times with the new interval and does not rebuild the timer; saving an empty field goes back to 600 seconds.
- **Scope**: only subagents dispatched by `delegate` are supervised. `orchestrate` workers are awaited synchronously inside the tool call, so by the time a notice came due the task would long be over.

Example:

```text
【插件巡检｜第 2/3 次】以下内容由 dsh-orchestrator 自动生成，不是用户消息。
1) subagent session-xxxx
   Task: move config loading
   Running 12m30s ｜ turns 8 ｜ steps 21
   New tool calls since the last check: 4 ｜ latest tool: edit
   Last output: ……
```

The notice itself is emitted in Chinese, so the header line above is the literal string the plugin prints (`【插件巡检｜第 N/M 次】 …`); the rows are translated here for readability.

The notice ends by asking the main agent to decide for each subagent: if the direction is right, do not intervene; if it has drifted or is going in circles, give a concrete instruction with `send_message`; if it should stop, say why — the main agent itself has no termination tool (`interrupt_agent` is on the deny list), so actually stopping a worker takes a host-side action by the user. When no intervention is needed, reply with a single line 「巡检：正常」 and end the turn without calling any tools.

Cost: every notice wakes the main agent for one full model request. By default each subagent gets at most 3; you can raise the interval, lower the budget, or simply turn it off. The supervision itself only reads session logs and makes no model call.

## Known limitations

- `orchestrate` has only the "items × stages" shape, no arbitrary JavaScript, and no background mode; a single result over 50000 characters fails the whole call; a failed item only produces `null` and an `errors` entry and is never retried automatically.
- `delegate` is asynchronous: there is no progress callback and only supervision; it also offers no termination — `interrupt_agent` is on the deny list by default, so stopping a worker takes a host-side action.
- Supervision reads logs: the summary can lag behind a worker's real progress, and a "long log" can be mistaken for "progress"; when the main agent is busy, a notice arrives later than its due time.
- The gate depends on the host's `tools.restrict` and `tools.guard`: global tools are hidden, scope-local tools are refused at execution time; a failed guard installation only logs one warning, in which case the gate is incomplete, and names that `restrict` fails on are skipped and logged.
- `deniedTools` can only add (the 49 built-ins are always unioned in); to disable the gate altogether use `enabled` rather than deleting names.
- The main agent and workers do not share context: when a task card lacks a goal, the files that may be changed, or an acceptance command, the worker guesses.
- Dispatching fails while the subagent route is unconfigured; a route change applies only from the next dispatch and never back-fills a running worker.
- Session stage projection has no separate "acceptance" stage; forked sessions report "not applicable"; `delegate` currently does not count towards the "executing" stage — only `orchestrate` does.
- The client panel is composed at startup: after installing or upgrading the plugin you must fully quit and reopen DSH.

## Layout

```text
lib/index.js         host configuration, stage projection, tool registration, supervision wiring, main-agent gate
lib/client.js        model and supervision-interval panel, "Plan" button
lib/delegate.js      worker route lookup and dynamic task dispatch
lib/orchestrate.js   declarative batch dispatch
lib/gate.js          tool hiding and execution-time refusal
lib/stage.js         session stage reduction
lib/supervise.js     pure supervision logic (due times, batching, budget, notice text)
test/                unit tests with no DSH runtime dependency
docs/adr/            key design decisions
CONTEXT.md           project terminology
cordis.patch.yml     plugin registration entry
```

## Development

No build and no dependency installation are needed to run the unit tests:

```bash
node --test test/
```

Run the tests after changes, and at least `node --check` every changed JavaScript file.

## Privacy

The repository contains only plugin source, tests, and documentation. Profiles, credentials, session logs, backups, and offline installers produced by local tests are all excluded by `.gitignore`.

## License

MIT © 2026 SShiRkiT
