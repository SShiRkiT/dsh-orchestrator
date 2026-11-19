## Summary / 变更摘要

<!-- Explain what changed and why. For UI changes, add screenshots or steps to verify the interaction. -->

## Related Issue / 关联 Issue

<!-- Use `Closes #123` when this PR resolves an issue. Otherwise link related discussion or enter N/A. -->

## Type of Change / 变更类型

- [ ] Bug fix / 缺陷修复
- [ ] Feature or enhancement / 新功能或改进
- [ ] Documentation / 文档
- [ ] Refactor, test, or maintenance / 重构、测试或维护
- [ ] Breaking change / 破坏性变更

## Affected Scope / 影响范围

- [ ] Backend services / 后端服务 ([lib/](../lib/))
- [ ] Client UI / 客户端界面 ([lib/client.js](../lib/client.js))
- [ ] Cordis service patch / Cordis 服务补丁 ([cordis.patch.yml](../cordis.patch.yml))
- [ ] Tests / 测试 ([test/](../test/))
- [ ] Documentation / 文档 ([README.zh.md](../README.zh.md), [README.md](../README.md), [docs/adr/](../docs/adr/))

## Checklist / 检查清单

<!-- Explain in the PR if a documentation item is not applicable. -->

- [ ] `npm test` or `node --test` (CI and Node.js 22) passed / 单元测试已通过。
- [ ] `node --check` passed for every file in `lib/*.js` / 已逐一通过语法检查。
- [ ] [README.zh.md](../README.zh.md) and [README.md](../README.md) were updated together for feature, configuration, or UI changes / 功能、配置或界面变更已同步更新中英文说明。
- [ ] The change preserves compatibility with `engines.dsh` (`>=0.2.2-rc.2 <0.2.3-0`) / 变更兼容声明的宿主版本范围。
