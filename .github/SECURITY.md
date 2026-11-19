# Security Policy / 安全政策

## Supported versions / 受支持版本

| Version | Security updates |
| --- | --- |
| `0.8.x` | Supported |
| `<= 0.7.x` | Unsupported |

## Security-sensitive areas / 安全关注点

- The main agent's `allowedTools` whitelist determines which tools it can access when dispatch mode is enabled. Changes to tool visibility and execution checks should preserve that boundary.
- The supervision-turn tool lock restricts which tools the main agent can use during a supervision turn.
- The `writeScope` conflict locks coordinate concurrent subagent write scopes and prevent overlapping write scopes from being held at the same time.
- The injected Web GUI Dispatch settings panel updates plugin settings through the host. Report unexpected access to or unauthorized changes of those settings.

## Report a vulnerability / 私密报告漏洞

Please do not disclose vulnerabilities through a public GitHub issue or pull request. Submit a report through GitHub [Private Vulnerability Reporting](https://github.com/SShiRkiT/dsh-orchestrator/security/advisories/new).

Include the affected plugin and host versions, a minimal reproduction, the observed impact, and any relevant sanitized logs. Remove credentials, API keys, and unrelated personal information. The maintainer will acknowledge the report within **72 hours** and coordinate follow-up privately.

请通过上述私密渠道报告漏洞。维护者会在 **72 小时**内确认收到报告。
