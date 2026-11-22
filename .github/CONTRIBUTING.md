# Contributing / 贡献指南

Issues and pull requests are welcome in English or Simplified Chinese. 请遵守 [行为准则](CODE_OF_CONDUCT.md)。

## Project layout / 项目架构

`@sshirkit/dsh-orchestrator` is a DeepSeek Harness plugin that lets the main agent plan work and dispatch it to subagents through delegation or orchestration. The host provides its native `/plan` flow.

- **Backend / 后端** — The Cordis service patch and backend modules implement the main-agent tool whitelist, `delegate`, `orchestrate`, `writeScope` conflict locks, and supervision that reads the session logs of long-running delegated subagents. See [cordis.patch.yml](../cordis.patch.yml) and [lib/](../lib/).
- **Client / 客户端** — The Web GUI client injects the Dispatch panel for configuring dispatch mode, agent routing, allowed tools, and supervision. See [lib/client.js](../lib/client.js).

## Requirements / 环境要求

- **Node.js** `>=22`. The package uses ECMAScript modules (`"type": "module"`).
- **DeepSeek Harness** `>=0.2.2-rc.2 <0.2.3-0` for integration and UI verification. The compatibility range is declared in [`engines.dsh`](../package.json).

## Terminology / 领域术语

Use the canonical definitions in [GLOSSARY.md](../docs/GLOSSARY.md) in code, tests, documentation, and reviews. Use *delegation* (委派) for a task dispatched with `delegate`, *orchestration* (编排) for the declarative item-by-stage operation in `orchestrate`, and *supervision* (巡检) for reading delegated subagents' session logs during execution.

## Local checks / 本地验证

Run the following from the repository root with an up-to-date Node.js 22 or later. The unit tests use the built-in Node.js test runner and inline mocks, so they can run before installing any npm dependencies.

```bash
# Run the same commands as CI.
for file in lib/*.js; do
  node --check "$file" || exit 1
done
node --test
```

`node --check` accepts one script at a time. The loop checks each file in `lib/*.js`. On Node.js versions that accept a directory as a test target, you can also run `npm test` (`node --test test/`). Node.js 22 can find the same tests automatically with `node --test`.

For backend or UI changes involving a running host, include the host version and manual verification results in the PR.

## Documentation rule / 文档同步规范

[README.zh.md](../README.zh.md) is the Simplified Chinese source of truth for user documentation. [README.md](../README.md) is the default English page displayed on GitHub. Every PR that changes a feature, configuration, or UI must update both files together. Update the Chinese README first, then sync the English README in the same PR. Update the relevant architecture decision record in [docs/adr/](../docs/adr/) when an architectural decision changes.

## Submit a pull request / 提交 PR

1. Search the [existing issues](https://github.com/SShiRkiT/dsh-orchestrator/issues) before opening one. Use a [structured issue form](https://github.com/SShiRkiT/dsh-orchestrator/issues/new/choose) for a bug or proposal.
2. Create a focused branch and keep the PR to one coherent change. Add or update tests when behavior changes.
3. Run the local checks and update the applicable documentation.
4. Fill out the [pull request template](PULL_REQUEST_TEMPLATE.md). Summarize the change, identify the affected areas, include verification results, and use `Closes #123` when merging should close the linked issue. UI changes benefit from screenshots and keyboard verification notes.
5. Respond to review feedback in the PR so reviewers can follow decisions and verification results.
