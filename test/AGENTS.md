<!-- Parent: ../AGENTS.md -->
<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# test — Lucy 测试组织

## 用途

此目录包含 Vitest 全局设置。仅有 `setup.ts` 一个文件，设置 `VITEST=true` 环境变量以供测试代码检查。

## 文件清单

| 文件 | 描述 |
|------|------|
| `setup.ts` | Vitest 全局设置入口，设置 `process.env.VITEST = "true"`；用于测试代码区分运行环境 |
| `e2e/` | 端到端测试（Docker 验证）；见 `docs/09-testing/test-strategy.md` |

## 运行测试

```bash
# 聚焦 src/ 单元测试
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"

# 跑 test/e2e/ 验证
pnpm test:docker:lucy-e2e
```

## 添加新测试

- 单元测试：在 `src/` 旁新增 `*.test.ts`（协议、状态、主题、导出）
- 集成测试：在 `test/e2e/` 下新增测试文件；见 `docs/09-testing/test-strategy.md` 了解测试策略

**守护栏**：不要在测试中硬编码 `cdi`、`user_id` 或 `cuk` 值；用占位符和状态文件读取。

---

**参考：** `docs/09-testing/test-strategy.md`
