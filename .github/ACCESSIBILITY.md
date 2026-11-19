# Accessibility Statement / 无障碍声明

## Accessibility commitment / 无障碍承诺

We aim to make the `@sshirkit/dsh-orchestrator` Dispatch panel usable in the DeepSeek Harness Web GUI and its Desktop client. We welcome reports about barriers to keyboard navigation, assistive technology, or access to localized controls.

## Supported interactions / 支持的交互

- The panel offers keyboard-focusable form controls. Use Tab or Shift+Tab to move through focusable controls, and Space to toggle checkboxes and the dispatch switch.
- The UI uses semantic DOM buttons and native checkboxes, with accessible names and state where applicable.
- The panel automatically selects English or Simplified Chinese strings through the host's locale service.

## Known limitations / 已知限制

The panel inherits theme and baseline accessibility support from the DeepSeek Harness rendering container. Contrast, focus presentation, and assistive-technology behavior can vary with the host version, theme, and Web or Desktop environment.

## Report an accessibility barrier / 反馈无障碍障碍

Open the [Bug Report form](https://github.com/SShiRkiT/dsh-orchestrator/issues/new?template=bug_report.yml) and apply the `accessibility` label if you have permission. Otherwise mention `accessibility` in the report so a maintainer can label it.

Include the panel control or action involved, your host version and theme, the environment and any assistive technology used, and steps to reproduce the barrier. Describe what you expected and what happened. Reports are welcome in English and Simplified Chinese.
