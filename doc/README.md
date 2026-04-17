<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# Lucy 文档已迁移

本目录（`doc/`）已弃用。当前 Lucy 文档请改读 [`../docs/`](../docs/README.md)。

AI agent 指引请读 [`../AGENTS.md`](../AGENTS.md)；`src/` 下的模块索引见 [`../src/AGENTS.md`](../src/AGENTS.md)。

## 旧文件 → 新位置对照

| 旧路径（已归档到 git 历史） | 新位置 |
|---|---|
| `doc/app-integration-guide.md` + `doc/app-nats-integration.md` | [`docs/07-integrations/app-integration.md`](../docs/07-integrations/app-integration.md) |
| `doc/auth-binding/binding-startup-flow.md` | [`docs/02-auth-binding/integrated-flow.md`](../docs/02-auth-binding/integrated-flow.md) |
| `doc/auth-binding/user-center-integration.md` | [`docs/02-auth-binding/user-center-integration.md`](../docs/02-auth-binding/user-center-integration.md) |
| `doc/ble-frontend-integration.md` | [`docs/07-integrations/ble-pairing-export.md`](../docs/07-integrations/ble-pairing-export.md) |
| `doc/debugging.md` | [`docs/08-operations/debugging.md`](../docs/08-operations/debugging.md) |
| `doc/sdk-integration-test-report.md` | [`docs/09-testing/sdk-integration-test-report.md`](../docs/09-testing/sdk-integration-test-report.md) |

旧文件已从 worktree 移除；历史版本可通过 `git log --follow -- doc/<文件名>` 查阅。
