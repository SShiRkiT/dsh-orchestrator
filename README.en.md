# DSH Orchestrator

A **DeepSeek Harness** plugin for a planning main agent and delegated workers. It hides write, shell, and native multi-agent tools from the main agent by default, routes work through its own `delegate` tool, and lets the main agent and workers use separate default models and reasoning efforts.

[中文](README.md)

## Features

- **Main-agent gate**: hides tools and also refuses denied calls at execution time, including agent-local tools such as native `subagent`.
- **Independent worker route**: reads the current worker route on every `delegate`, so changes apply from the next delegation.
- **Model picker**: separate main/worker rows, searchable in-place model lists, keyboard selection, and host-theme-aware styling.
- **Stage projection**: derives `idle / clarify / planning / awaiting / executing` from existing session events without storing additional conversation content.
- **No build step**: the loadable `lib/` files are committed, so the repository can be added directly.

The default denied tools are `edit`, `write`, `str_replace_editor`, `subagent`, `subagent_fork`, `workflow`, `ralph`, `ops_bash`, and `pwsh`. They are configurable.

## Install

Add `SShiRkiT/dsh-orchestrator#main` from GitHub in the DSH plugin page, or run:

```bash
dsh plugin --profile desktop add SShiRkiT/dsh-orchestrator#main
```

For the web profile:

```bash
dsh plugin --profile web add SShiRkiT/dsh-orchestrator#main
```

Fully quit and reopen DSH after installation; client plugins are composed at startup.

## Use

Open the **Orchestrator** panel from the composer model button. The main-agent route is read when a new agent is created; the worker route applies from the next `delegate` call.

The worker route is intentionally empty by default. Configure it before the first delegation: an unconfigured route fails explicitly instead of silently inheriting the main model.

In either model list, type a provider, model ID, or display name to filter. Use `↑` / `↓`, `Enter`, and `Esc` for keyboard navigation. Changing models clears the previous effort because supported efforts belong to the selected model.

## Development

```bash
node --test test/
```

No build or dependency installation is needed for the unit tests. See `CONTEXT.md` and `docs/adr/` for terminology and design decisions.

## Privacy

Only plugin sources, tests, and documentation belong in the repository. Local profiles, credentials, session logs, backups, and offline packages are excluded by `.gitignore`.

## License

MIT © 2026 SShiRkiT
