<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-06 | Updated: 2026-04-06 -->

# src — Lucy 插件源码

## 用途

Lucy 插件源码目录包含 DM-only NATS 传输层、设备绑定、模型供应、媒体传输和本地通知等核心功能。这是 OpenClaw 与 Lucy 客户端通信的主要实现，负责设备注册、用户绑定、机器事件发布、消息路由和媒体管理。

## 核心模块

### 传输层（NATS 通信）

| 文件 | 描述 |
|------|------|
| `nats.ts` | NATS 连接、主题构建、编码/解码。`buildLucySubjects()` 用 `{prefix}.{userKey}.{deviceId}.{client/machine}` 格式生成主题；`buildLucyDiscoverSubject()` 和 `buildLucyPingSubject()` 管理设备发现和 ping；`connectLucyNats()` 建立连接 |
| `nats-websocket.ts` | WebSocket 传输层，扩展内部 NATS 客户端以支持 WebSocket 连接，允许 Lucy 使用 NATS over WebSocket |
| `send.ts` | 机器事件发布。`buildLucyMachineEvent()` 构建事件，`publishLucyMachineEvent()` 发送事件到 `.machine` 主题 |
| `gateway.ts` | 入站消息管道和运行时事件镜像。处理来自 Lucy 的消息、模型执行、媒体传输、存在发送和重启完成回调 |
| `presence.ts` | 设备存在管理。`startLucyPresenceLoop()` 发送定期心跳和 `_discover` 事件；监听 `ping` 主题以响应 ping 请求 |

### 绑定与认证

| 文件 | 描述 |
|------|------|
| `auth-binding.ts` | 设备注册和绑定同步。`syncLucyBindingState()` 注册设备、轮询绑定状态、持久化 `channelUserKey`；`hydrateLucyAccountFromState()` 将本地状态合并到账户配置 |
| `user-center.ts` | user-center API 调用。`registerLucyDevice()` 创建设备；`fetchLucyDeviceBinding()` 轮询绑定状态；`fetchLucyUserCenterConfig()` 获取模型配置 |
| `auth-qrcode.ts` | 绑定 QR 码生成。`buildLucyAuthQrUri()` 生成 `lucy://bind?channel_device_id=...` URI；`buildLucyAuthQrJson()` 返回 JSON 负载 |
| `config.ts` | Lucy 账户配置解析。`resolveLucyAccount()` 从 OpenClaw 配置读取和验证 Lucy 账户设置 |
| `config-schema.ts` | Zod 验证架构。定义 `LucyChannelConfigSchema`、`LucyAccountConfigSchema` 等，用于配置验证 |

### 模型供应（Cephalon）

| 文件 | 描述 |
|------|------|
| `cephalon-provider.ts` | 嵌入式 Cephalon 模型提供者。`buildLucyCephalonCatalogProvider()` 返回提供者配置；定义 Cephalon 模型列表和默认模型 ID（`kimi-k2.5`） |
| `provider-provisioning.ts` | 模型供应流程。`handleLucyProvisioningMessage()` 处理版本 3 供应消息；写入 `models.providers.cephalon.*` 和更新 `agents.defaults.model.primary`；触发网关重启 |
| `restart-ticket.ts` | 重启跟踪票证。`readLucyRestartTicket()` 和 `writeLucyRestartTicket()` 管理本地供应完成状态；`publishLucyRestartCompletionIfPending()` 发送完成事件 |

### 状态与配置

| 文件 | 描述 |
|------|------|
| `state.ts` | 本地设备状态管理。`loadOrCreateLucyDeviceState()` 持久化 `device-state.json`；支持版本迁移（v1 → v2）；缓存状态 |
| `types.ts` | Zod 架构和类型定义。定义 `LucyDeviceState`、`LucyInboundMessage`、`LucyMachineEvent` 等 |
| `pairing-export.ts` | 配对信息导出。`syncLucyPairingExport()` 生成 `pairing-info.json`，供 BLE Wi-Fi 供应和 iOS 客户端读取 |
| `runtime.ts` | 运行时存储模式。`getLucyRuntime()` / `setLucyRuntime()` 管理全局 `PluginRuntime` 引用 |

### 媒体传输

| 文件 | 描述 |
|------|------|
| `media.ts` | JetStream Object Store 管理。`ensureLucyMediaStore()` 创建/获取对象存储；`uploadLucyMediaFromSource()` 上传媒体；`downloadLucyMediaDescriptor()` 下载 |
| `outbound-media.ts` | 出站媒体加载。`loadLucyOutboundMediaFromUrl()` 从文件 URL 或本地路径读取媒体，支持白名单目录 |

### 本地通知（USB 事件）

| 文件 | 描述 |
|------|------|
| `local-notify.ts` | 本地 USB 通知服务器。`startLucyLocalNotifyServer()` 监听 HTTP，接收 USB 事件，转换为机器事件发布到 NATS |

### 执行批准

| 文件 | 描述 |
|------|------|
| `exec-approvals-handler.ts` | 执行批准处理。延迟加载 `createOperatorApprovalsGatewayClient()`（支持旧 OpenClaw 版本）；订阅和转发批准事件 |
| `exec-approval-helpers.ts` | 批准辅助函数。`buildExecApprovalPendingReplyPayload()` 格式化待批准回复；`resolveExecApprovalCommandDisplay()` 清理命令显示文本 |

### 辅助模块

| 文件 | 描述 |
|------|------|
| `snowflake.ts` | Snowflake ID 生成器。基于时间戳 + worker ID + 序列的分布式 ID 生成，用于事件 ID 和消息 ID |
| `plugin-sdk-compat.ts` | SDK 兼容层。`createPluginRuntimeStore()` 管理运行时存储；`createDefaultChannelRuntimeState()` 初始化通道运行时状态 |
| `command.ts` | CLI 命令集成。`buildLucyBindQrUrl()` 生成绑定 URL；`formatLucyAuthQrReply()` 和 `formatLucyResetStateReply()` 格式化 CLI 输出 |
| `channel-plugin-entry.ts` | 插件入口点。导出 `LucyChannelPluginEntry` 给 OpenClaw 加载器 |

### 测试文件

| 文件 | 描述 |
|------|------|
| `*.test.ts` | 协议检查、状态持久化、主题生成、配对导出、网关事件、媒体传输等的单元测试 |
| `probe-script.test.ts` | 通道探针脚本验证 |
| `sdk-compat.test.ts` | SDK 兼容层和运行时存储测试 |

## 对 AI Agent 的指引

### 在此目录工作时

- **分层验证**：始终从协议和主题逻辑开始（在 `types.ts` 和 `nats.ts` 中测试）。在 Docker 和基础设施测试之前，证明 NATS 消息格式和路由是正确的。

- **守护栏**：
  - 绝不在 Lucy 中硬编码 `prod` / `test` 环境 URLs；`base_url` 必须来自配置或 `user-center` 的 `current-user/model-config` 响应。
  - 模型供应设计**不是**独立的 `cephalon` 插件包。`cephalon` 提供者在 Lucy 内部注册（见 `cephalon-provider.ts` 和 `provider-provisioning.ts`）。
  - 账户启动应在 `abortSignal` 处阻塞。生成后台循环并提前返回会触发 OpenClaw 自动重启和重复入站处理。

- **跨仓库对齐**：协议字段或机器事件更改时，同步更新：
  - `extensions/lucy/src/**`（此目录）
  - `outside/LucyIOSDemo/**`（iOS 客户端验证）
  - `outside/user-center/**`（绑定和模型配置）
  - `outside/npc-im-server/**`（NATS 权限）

### 测试要求

运行测试的推荐命令：

```bash
# 焦点测试（推荐）
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"

# 单个文件
pnpm test -- extensions/lucy/src/nats.test.ts

# 特定测试用例
pnpm test -- extensions/lucy/src/gateway.test.ts -t "inbound message normalization"

# 局部 NATS（可选）
docker compose -f extensions/lucy/docker-compose.nats.yml up -d nats
```

测试应清理定时器、环境、模拟对象、套接字和模块状态，以保持 `--isolate=false` 通过。

### 代码模式

- **TypeScript ESM**：所有相对导入使用明确的 `.js` 后缀。
- **Zod 验证**：配置、消息、事件、状态使用 Zod 架构（见 `types.ts`）。
- **两空格缩进**：保持与 OpenClaw 一致。
- **纯辅助函数**：配置解析、主题逻辑、协议规范化使用小型纯辅助函数，而非重复验证。
- **主体优先**：账户启动应等待 `abortSignal` 而不是返回早期循环。

## 依赖关系

### 内部依赖

- **plugin-sdk**：`openclaw/plugin-sdk` 用于通用 OpenClaw 插件 API（`ChannelPlugin`、`ChannelGatewayContext`、`OpenClawConfig` 等）。
- **跨文件导入**：`gateway.ts` → `auth-binding.ts`、`presence.ts`、`media.ts`、`send.ts`、`nats.ts`、`provider-provisioning.ts`；`auth-binding.ts` → `user-center.ts`、`state.ts`；`send.ts` → `nats.ts`、`snowflake.ts`。
- **外部链接**：代码通过 `outside/` 符号链接引用 `LucyIOSDemo`、`user-center`、`npc-im-server`、`blue-wifi`。

### 外部依赖

- **nats**：NATS 客户端库（连接、消息、Object Store）。
- **ws**：WebSocket 客户端（用于 NATS WebSocket 传输）。
- **zod**：模式验证和类型推导。
- **qrcode-terminal**：QR 码 ASCII 渲染（用于 CLI）。
- **openclaw**：主机 OpenClaw 实例（用于 SDK 兼容层）。

## 常见失败信号

- **`Cannot find module 'nats'`**：运行时打包问题（`node_modules` 可见性）。在容器中检查 `/app/extensions/lucy/node_modules`。
- **没有 `inbound.accepted` 事件**：主题映射、NATS 可达性或通道启动坏了。
- **`inbound.accepted` 出现但没有助手事件**：传输活跃；检查模型执行或上游运行时状态。
- **`assistant.final` 返回认证或提供者错误**：Lucy 在工作；修复提供者凭证或模型配置。
- **重复的 accepted/final 事件**：怀疑网关自动重启和重复监听器注册。
- **`auto-restart attempt N/10`**：账户启动返回太早或在启动期间抛出异常。

<!-- MANUAL: 手动添加的笔记将在重新生成时保留 -->
