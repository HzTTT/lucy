<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-06 | Updated: 2026-04-06 -->

# test — Lucy 测试设置和配置

## 用途

此目录包含 Vitest 测试框架的全局设置文件。仅设置环境变量 `VITEST=true`，用于控制测试运行时行为。

## 关键文件

| 文件 | 描述 |
|------|------|
| `setup.ts` | Vitest 全局设置入口，设置 `process.env.VITEST = "true"` 以供测试代码检查。 |

## 对 AI Agent 的指引

### 在此目录工作时

- **最小化修改**：此目录只有一个极小的设置文件。除非明确需要添加全局测试钩子（如模拟、清理或初始化逻辑），否则不应修改此文件。

- **环境标记**：`VITEST` 环境变量用于在代码中区分测试运行和生产运行。修改前检查 `src/` 中是否有代码引用 `process.env.VITEST`。

- **测试运行**：使用 `pnpm test` 或 `vitest` 运行 Lucy 测试。Vitest 会自动应用此设置。

<!-- MANUAL: -->
