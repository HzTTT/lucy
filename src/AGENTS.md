<!-- Parent: ../AGENTS.md -->
<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# src — Lucy 插件源码

## 用途

Lucy 插件源码目录包含 DM-only NATS 传输、设备绑定、模型供应、媒体传输和本地通知等核心功能。这是 OpenClaw 与 Lucy 客户端通信的主要实现，负责设备注册、用户绑定、机器事件发布、消息路由和媒体管理。

## 核心模块分类

### 传输层与消息收发

| 文件 | 用途 | 关键导出 |
|------|------|--------|
| `nats.ts` | NATS 主题构建与编码/解码 | `buildNpcSubscribeSubject(userId, cdi)`、`buildNpcPublishSubject(userId)` — 生成入站/出站主题（格式：`cephalon.im.npc.<user_id>.<cdi>` / `cephalon.im.user.<user_id>`） |
| `gateway.ts` | 入站消息管道和运行时事件镜像 | `startLucyGateway(config)`（启动网关）、JetStream consumer 设置、消息路由到模型执行和媒体处理 |
| `send.ts` | 机器事件发布到 NATS | `sendLucyMachineEvent(payload)`、事件版本化（v2/v3/v4）、Snowflake ID 生成 |

**参考：** `docs/03-transport/nats-subjects.md`、`docs/03-transport/jetstream-consumer.md`

### 绑定与认证

| 文件 | 用途 | 关键导出 |
|------|------|--------|
| `auth-binding.ts` | 设备注册和绑定同步 | `syncLucyBindingWithSdk(config)`（调用 SDK init/preBind/pollBinding）、本地状态持久化 |
| `user-center.ts` | user-center API 调用 | `registerLucyDevice()`、`fetchLucyDeviceBinding()`、`fetchLucyUserCenterConfig()`（模型配置获取） |
| `auth-qrcode.ts` | 绑定 QR 码生成 | `buildLucyAuthQrUri(cdi)`、`buildLucyAuthQrJson(cdi)` |
| `config.ts` | Lucy 账户配置解析 | `resolveLucyAccount(config)` — 从 OpenClaw 配置读取 Lucy 设置 |
| `config-schema.ts` | Zod 验证架构 | `LucyChannelConfigSchema`、`LucyAccountConfigSchema` — 配置验证 |
| `pairing-ipc-client.ts` | BLE/前端启动 OTP 接口（811 行，关键） | `sendLucyPairingMessage(type, payload)`、`waitLucyPairingResponse(type, timeout)` — IPC socket 通信 |
| `pairing-ipc-types.ts` | 配对 IPC 协议类型声明 | Zod schemas for `bind.request`、`otp.issued`、`otp.verified` 消息 |

**参考：** `docs/02-auth-binding/integrated-flow.md`、`docs/02-auth-binding/user-center-integration.md`

### 模型供应与重启

| 文件 | 用途 | 关键导出 |
|------|------|--------|
| `cephalon-provider.ts` | 嵌入式 Cephalon provider 注册 | `buildLucyCephalonCatalogProvider()` — 返回 provider 配置、模型列表、默认 model ID（`kimi-k2.5`） |
| `provider-provisioning.ts` | 模型供应流程（version 3 消息处理） | `handleLucyProvisioningMessage(payload)` — 写入 `models.providers.cephalon.*`、更新 `agents.defaults.model.primary`、触发 gateway 重启 |
| `restart-ticket.ts` | 重启跟踪票证（120 行） | `readLucyRestartTicket()`、`writeLucyRestartTicket()`、`publishLucyRestartCompletionIfPending()` — 本地供应完成状态管理 |

**参考：** `docs/05-model-provisioning/cephalon-provider.md`、`docs/05-model-provisioning/provision-flow.md`、`docs/05-model-provisioning/auto-restart.md`

### 状态与配置

| 文件 | 用途 | 关键导出 |
|------|------|--------|
| `state.ts` | 本地设备状态管理 | `loadOrCreateLucyDeviceState(path)` — 持久化 `device-state.json`、版本迁移（v1 → v2）、状态缓存 |
| `types.ts` | Zod schemas 和协议类型 | `LucyDeviceState`、`LucyInboundMessage`、`LucyMachineEvent`、`LucyControlMessage` — 完整类型模型 |
| `runtime.ts` | 运行时存储引用 | `getLucyRuntime()`、`setLucyRuntime()` — 管理全局 `PluginRuntime` 引用 |

**参考：** `docs/01-overview/architecture.md`

### 媒体传输

| 文件 | 用途 | 关键导出 |
|------|------|--------|
| `media.ts` | JetStream Object Store 管理 | `ensureLucyMediaStore()`、`uploadLucyMediaFromSource()`、`downloadLucyMediaDescriptor()` — 对象存储创建、媒体 CRUD |
| `outbound-media.ts` | 出站媒体加载（200 行） | `loadLucyOutboundMediaFromUrl(url)` — 文件 URL 或本地路径读取、白名单目录检查、MIME 类型判断 |

**参考：** `docs/06-media/object-store.md`、`docs/06-media/outbound-sources.md`

### 本地通知（USB 事件）

| 文件 | 用途 | 关键导出 |
|------|------|--------|
| `local-notify.ts` | 本地 USB 通知 HTTP 服务器 | `startLucyLocalNotifyServer(config)` — 监听 HTTP、接收 USB 事件、转换为机器事件发布到 NATS；事件码映射：1=插入、2=同步中、3=完成、4=失败、5=拔出 |

**参考：** `docs/07-integrations/usb-local-notify.md`

### 执行审批

| 文件 | 用途 | 关键导出 |
|------|------|--------|
| `exec-approvals-handler.ts` | 执行审批处理 | `createOperatorApprovalsGatewayClient()`（延迟加载以支持旧版 OpenClaw）、订阅并转发审批事件 |
| `exec-approval-helpers.ts` | 审批辅助函数 | `buildExecApprovalPendingReplyPayload()`、`resolveExecApprovalCommandDisplay()` — pending 回复格式化、命令显示清理 |

**参考：** `docs/04-messaging/exec-approvals.md`

### 辅助与入口

| 文件 | 用途 | 关键导出 |
|------|------|--------|
| `snowflake.ts` | Snowflake ID 生成（分布式 ID） | 基于时间戳 + worker ID + 序列的 ID 生成，用于事件 ID 和消息 ID |
| `plugin-sdk-compat.ts` | SDK 兼容层 | `createPluginRuntimeStore()`、`createDefaultChannelRuntimeState()` — 运行时存储和通道状态初始化 |
| `command.ts` | CLI 命令集成 | `buildLucyBindQrUrl()`、`formatLucyAuthQrReply()`、`formatLucyResetStateReply()` — CLI 输出格式化 |
| `channel-plugin-entry.ts` | 插件入口点 | 导出 `LucyChannelPluginEntry` 给 OpenClaw 加载器 |
| `pairing-export.ts` | 配对信息导出 | `syncLucyPairingExport(state)` — 生成 `pairing-info.json` 供 BLE Wi-Fi 供应和 iOS 客户端读取 |

**参考：** `docs/07-integrations/ble-pairing-export.md`、`docs/08-operations/cli-commands.md`

### 测试

| 文件 | 用途 |
|------|------|
| `*.test.ts` | 协议检查、状态持久化、主题生成、配对导出、网关事件、媒体传输单元测试 |
| `probe-script.test.ts` | 通道探针脚本验证 |
| `sdk-compat.test.ts` | SDK 兼容层和运行时存储测试 |

**参考：** `docs/09-testing/test-strategy.md`

## 对 AI Agent 的指引

### 在此目录工作时

- **分层验证**：从协议和主题逻辑开始（在 `types.ts` 和 `nats.ts` 中测试）。在 Docker 和基础设施测试之前，证明 NATS 消息格式和路由是正确的

- **守护栏**：
  - 绝不在 Lucy 中硬编码 `prod` / `test` 环境 URLs；`base_url` 必须来自配置或 `user-center` 的 `current-user/model-config` 响应
  - 模型供应设计**不是**独立的 `cephalon` 插件包。`cephalon` provider 在 Lucy 内部注册（见 `cephalon-provider.ts` 和 `provider-provisioning.ts`）
  - 账户启动应在 `abortSignal` 处阻塞。生成后台循环并提前返回会触发 OpenClaw 自动重启和重复入站处理
  - `pairing-ipc-client.ts` 是 BLE/前端启动 OTP 的关键，常被漏掉；修改绑定流程时必须同步验证

- **跨仓库对齐**：协议字段或机器事件改动时同步更新 `extensions/lucy/src/**`、`outside/LucyIOSDemo/**`、`outside/user-center/**`

---

**最后核对**：2026-04-16，以 `src/` 为事实源
