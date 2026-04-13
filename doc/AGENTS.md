<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-06 | Updated: 2026-04-06 -->

# doc — Lucy 集成文档

## 用途

本目录包含 Lucy OpenClaw 频道插件的完整集成文档。记录绑定流程、协议契约、认证机制、运行时事件序列，以及跨仓库组件（iOS App、`user-center`、`npc-im-server`、`blue-wifi`）之间的交互边界。

## 关键文件

| 文件 | 描述 |
|------|------|
| `README.md` | 文档索引与推荐阅读顺序 |
| `integrated-flow.md` | Lucy 鉴权绑定的统一说明：术语、模块职责、主流程、时序图、实现约束 |
| `user-center-integration.md` | `user-center` 已落地接口、表结构、响应示例、测试结论 |
| `app-nats-integration.md` | App / SDK 直接接入 Lucy 的对外协议：凭据来源、subject 约定、入站消息格式、machine event、媒体传输 |

## 子目录

| 目录 | 用途 |
|------|------|
| `auth-binding/` | 鉴权绑定专题：`integrated-flow.md`（统一流程）、`user-center-integration.md`（API 落地） |
| `raw-events/` | （暂未使用，预留用于 raw event 样本档案） |

## 对 AI Agent 的指引

### 在此目录工作时

1. **读取优先级**
   - 若不了解 Lucy，先读 `README.md` 的推荐顺序
   - 若做绑定/认证工作，参考 `integrated-flow.md` 的术语和模块职责
   - 若做 `user-center` 集成，看 `user-center-integration.md` 的当前接口
   - 若做 App / SDK，对照 `app-nats-integration.md` 的协议边界
   - 若做 raw event 或 machine event 字段追踪，优先参考 `app-nats-integration.md` 的当前协议说明

2. **验证当前状态**
   - 文档与代码冲突时，以当前代码为准；更新文档而不是反向修改代码
   - 线上协议以 `integrated-flow.md` 和 `app-nats-integration.md` 为准
   - 旧的 `version=1` / `apiKey` / `deviceId` 不再是权威格式

3. **跨仓库同步**
   - 修改协议字段、machine event、绑定流程时，同步更新：
     - `extensions/lucy/src/**` 代码
     - `outside/LucyIOSDemo/**` iOS 客户端
     - `outside/user-center/**` 用户中心
     - `outside/npc-im-server/**` 认证和 presence 服务
     - `outside/blue-wifi/**` BLE 配网
     - 本目录对应文档

4. **文件编辑约束**
   - 这些文档文件内容已经落地验证，修改前确认是真实情况变化，而不是代码同步滞后
   - 新增文档时保持格式一致：
     - 使用中文、markdown、清晰的表格和代码块
     - 避免留下历史样本或废弃字段的参考副本
     - 提供完整的真实响应示例（用脱敏占位符）

5. **调试时的参考**
   - 查看 `app-nats-integration.md` 第 8 节"调试边界"来判断故障层级
   - 查看 `integrated-flow.md` 第 5 节"实现上的关键结论"来避免身份混淆
   - 查看 `app-nats-integration.md` 来识别当前有效的事件字段名和客户端兼容要求

<!-- MANUAL: -->
