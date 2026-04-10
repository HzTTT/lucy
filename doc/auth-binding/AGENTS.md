<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-06 | Updated: 2026-04-06 -->

# auth-binding — 鉴权绑定文档

## 用途

记录 Lucy 设备注册、用户绑定、模型配置下发的完整鉴权流程。包含统一术语、模块职责划分、主流程时序图，以及 `user-center` 已落地接口的实现细节和测试结论。

## 关键文件

| 文件 | 描述 |
|------|------|
| `integrated-flow.md` | 鉴权绑定统一说明：术语定义、模块职责（Lucy 插件 / user-center / auth-callout / iOS）、主流程、模型配置下发与自动重启补充链路、时序图、实现约束 |
| `user-center-integration.md` | `user-center` 已落地接口、数据库表结构、API 响应示例、测试验证结论 |

## 对 AI Agent 的指引

### 在此目录工作时

- **阅读顺序**：先读 `integrated-flow.md` 获取全貌，再查 `user-center-integration.md` 了解具体 API 细节。
- **代码为准**：当文档与 `src/auth-binding.ts`、`src/user-center.ts` 或 `outside/user-center` 代码不一致时，以代码为准并同步更新文档。
- **术语一致**：始终使用 `channel_user_key`、`channel_device_id`、`bootstrap_token`，不要引入替代命名。
- **跨仓库同步**：修改绑定语义时需同步检查 `outside/user-center` 和 `outside/LucyIOSDemo` 中的对应实现。

<!-- MANUAL: -->
