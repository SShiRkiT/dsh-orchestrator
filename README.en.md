# DSH Orchestrator

A **DeepSeek Harness** plugin for a planning main agent and delegated workers. It hides write, shell, and native multi-agent tools from the main agent by default, routes work through its own `delegate` and `orchestrate` tools, and lets the main agent and workers use separate default models and reasoning efforts.

[中文](README.md)

## Features

- **Main-agent gate**: hides tools and also refuses denied calls at execution time, including agent-local tools such as native `subagent`.
- **Independent worker route**: every dispatch reads the current configuration, so changes apply from the next dispatch.
- **Two dispatch shapes**: asynchronous `delegate` for one or two dynamic tasks whose next step depends on the previous result; declarative `orchestrate` for batch work that is one list times one fixed set of steps.
- **Declarative orchestration**: single-stage fan-out and multi-stage per-item pipelines with no global barrier; results keep input order, one failed item does not sink the others, and each stage can declare an object schema for structured output.
- **Model picker**: separate main/worker rows, searchable in-place model lists, keyboard selection, and host-theme-aware styling.
- **Stage projection**: derives `idle / clarify / planning / awaiting / executing` from existing session events without storing additional conversation content.
- **No build step**: the loadable `lib/` files are committed, so the repository can be added directly.

By default the main agent may only use `delegate`, `orchestrate`, `send_message`, `todo_write`, and `ask_user_question`. Every other built-in tool (reads, writes, shell, native multi-agent tools, web, scheduled tasks, and 49 in total) is hidden and refused if called; the list is configurable. Native `workflow`, `subagent`, and `subagent_fork` stay denied — see [ADR 0002](docs/adr/0002-declarative-orchestrate-instead-of-native-workflow.md).

## Install

Add `SShiRkiT/dsh-orchestrator#main` from GitHub in the DSH plugin page, or run:

```bash
dsh plugin --profile desktop add SShiRkiT/dsh-orchestrator#main
```

For the web profile:

```bash
dsh plugin --profile web add SShiRkiT/dsh-orchestrator#main
```

From a local directory:

```bash
dsh plugin --profile desktop add "D:\path\to\dsh-orchestrator"
```

Fully quit and reopen DSH after installation; client plugins are composed at startup.

## Use

1. Open the **Dispatch** panel from the composer. The top switch enables or disables the plugin, and the two rows below pick the main-agent and worker default models. The switch is the dispatch mode, independent of the host's **plan mode** (`/plan`); both can be on at once.
2. The main-agent route is read when a new agent is created, so new sessions use the new value.
3. The worker route applies from the next `delegate` or `orchestrate` call; both dispatch tools share the same route. Configure it before the first dispatch: an unconfigured route fails explicitly instead of silently inheriting the main model.
4. Let the main agent dispatch through `delegate` for one or two dynamic tasks, or `orchestrate` for batch work.

The switch also affects open sessions: the guard rereads it on every call, so the next denied call fails immediately, and hidden tools disappear from the tool list on the next step. Turning the switch off restores them.

In either model list, type a provider, model ID, or display name to filter. Use `↑` / `↓`, `Enter`, and `Esc` for keyboard navigation. Changing models clears the previous effort because supported efforts belong to the selected model.

## Batch dispatch (orchestrate)

`orchestrate` handles one list of items times one fixed set of stages: every item runs through all stages independently, and one call returns every result. Use `delegate` instead when the work needs branching, loops, or reshaping from intermediate results.

Input fields:

- `cwd` (optional): worker working directory; defaults to the session working directory.
- `items` (required, 1–64): values to process, as any JSON value (string, number, boolean, null, object, array), numbered in input order.
- `stages` (required, 1–8): each `{name, prompt, schema?}`, applied to every item in order.
- `maxConcurrency` (optional, 1–16, default 4): how many workers may run at once.

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
    { "name": "review", "prompt": "Point out factual problems in the previous draft, or say there are none." }
  ]
}
```

Prompts need no placeholders: the plugin appends the current item (as JSON) and the previous stage output to each stage prompt.

**Structured output**: a stage may declare an object JSON Schema; with one, that stage's `output` is an object that satisfies it rather than free text:

```json
{
  "items": ["alpha", "beta"],
  "stages": [
    {
      "name": "classify",
      "prompt": "Classify this item and briefly justify the choice.",
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

Results and failures:

- Returns `{ kind: "orchestration", agentsStarted, results, errors }`.
- `results` keeps input order: a successful item is `{index, output, stopReason}`; a failed item is `null`.
- Each `errors` entry is `{index, stage, message}`, with `stage` naming the stage. When an item fails at a stage, its remaining stages are skipped and the other items keep running.
- `agentsStarted` counts the workers that actually started across all items and stages; workers that failed to start and stages that were skipped are not counted.
- If the combined result exceeds 50000 characters, the whole call fails with a clear error instead of truncating; split the work into several orchestrations.
- Whole-call errors (invalid input, unconfigured worker route) fail explicitly and return no partial results.

Limits:

- No arbitrary JavaScript and no background mode; one call returns all results.
- Callers cannot pass a provider or model; every worker uses the plugin's worker route.
- Batch work only has the one shape: items times stages. Anything that needs dynamic control flow goes back to `delegate`.

Relation to native `workflow`: native `workflow` stays denied. Its scripts inherit the main model by default and can override the route per call, and they allow arbitrary control flow and background runs, so a gate cannot bound them to enumerable inputs. `orchestrate` removes all three: the route has exactly one source, the result shape is fixed, and failures can be merged deterministically. `subagent`, `subagent_fork`, and `ralph` stay denied as well. See [ADR 0002](docs/adr/0002-declarative-orchestrate-instead-of-native-workflow.md).

## Development

```bash
node --test test/
```

No build or dependency installation is needed for the unit tests. Run the tests after changes, and at least `node --check` every changed JavaScript file. See `CONTEXT.md` and `docs/adr/` for terminology and design decisions.

## Source layout

```text
lib/index.js         host config, stage projection, tool registration, main-agent gate
lib/client.js        model and reasoning-effort picker
lib/delegate.js      worker route lookup and dynamic task dispatch
lib/orchestrate.js   declarative batch dispatch
lib/gate.js          tool hiding and execution-time refusal
lib/stage.js         session-stage reduction
test/                unit tests, no DSH runtime dependency
docs/adr/            design decisions
CONTEXT.md           terminology
cordis.patch.yml     plugin registration entry
```

## Privacy

Only plugin sources, tests, and documentation belong in the repository. Local profiles, credentials, session logs, backups, and offline packages are excluded by `.gitignore`.

## License

MIT © 2026 SShiRkiT
