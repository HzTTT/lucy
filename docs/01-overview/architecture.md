<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# Lucy 系统架构

Lucy 是 OpenClaw 的 DM 专用通道插件，通过 NATS JetStream 连接 iOS/Android 客户端。本章讲清楚 Lucy 与 OpenClaw 各层之间的职责边界，以及为什么要这样分工。

## 架构分层

Lucy 的完整系统由以下几层组成：

### 上层：应用客户端（App / iOS / Android）
- 应用通过 `lucy-im-sdk-kotlin` 或 `lucy-im-sdk-swift` 与 Lucy 进行双向通信
- 负责绑定、OTP 扫码、NATS token 交换等客户端逻辑
- 所有消息走 NATS 主题 `cephalon.im.*`

### 中层：lucy-im-sdk-nodejs（git submodule）
Lucy 插件依赖的 SDK，封装了以下职责：
- **设备身份**：生成 Ed25519 密钥对，向 user-center 注册设备获得 `cdi`（channel device ID）
- **绑定流程**：轮询 `/v1/channels/lucy/devices/device-bindings` 直到获得 `cuk`（channel user key）和 `user_id`
- **NATS 连接**：用 Ed25519 签名向 lucy-server 换取 NATS token，通过 WebSocket 连接 NATS
- **Presence**：自动发送心跳、处理 `_discover` 在线/离线事件
- **JetStream**：维护 Pull Consumer（stream `IM_NPC`、durable `npc-<cdi>`）

插件永远不直接处理 WebSocket、Ed25519 签名或 JetStream 连接——这些都由 SDK 内部完成。

### 核心层：@hzttt/lucy-ai-npc 插件（本仓库 src/）

#### 整体流程（图解见 [系统分层架构](./diagrams.md#diagram-system-layers)）

```
index.ts (默认导出)
  ↓
defineLucyChannelPluginEntry()（channel-plugin-entry.ts:28）
  ├─ channel.ts：lucyPlugin 通道定义
  │   └─ startLucyGateway()：主要运行时程序
  ├─ command.ts：OpenClaw CLI 命令注册
  └─ cephalon-provider.ts：嵌入式模型供应商
```

**关键职责划分：**

| 模块 | 位置 | 职责 |
|------|------|------|
| **入站 → 运行时** | `gateway.ts:handleLucyInboundMessage()` | 验证 `channel_user_key`、解码附件、投递给 OpenClaw runtime |
| **运行时 → 出站** | `send.ts:publishLucyMachineEvent()` | 序列化机器事件（assistant.start/partial/final 等）、发往 NATS |
| **媒体上传** | `outbound-media.ts:loadLucyOutboundMediaFromUrl()` | 读取 file:// URL、检查白名单、上传到 JetStream Object Store |
| **媒体下载** | `media.ts:downloadLucyMediaDescriptor()` | 从 Object Store 拉取附件字节 |
| **模型供应** | `provider-provisioning.ts:handleLucyProvisioningMessage()` | 解析 `version=3/kind=provision_model` 消息、写入 `models.providers.cephalon.*` |
| **自动重启** | `restart-ticket.ts:writeLucyRestartTicket()` | 记录重启票据、触发 `openclaw gateway restart` |
| **审批事件** | `exec-approvals-handler.ts:LucyExecApprovalHandler` | 把 `exec.approval.requested` 转成 `approval.pending` 机器事件 |
| **BLE 配对导出** | `pairing-export.ts:buildLucyPairingInfoExport()` | 生成 `pairing-info.json` 供 blue-wifi BLE 读取 |
| **本地通知** | `local-notify.ts:startLucyLocalNotifyServer()` | HTTP 端点接收 USB 事件、转成 `assistant.final` |

### 后端服务层

#### user-center
- **设备注册**：`POST /v1/devices/new` → 注册 Ed25519 公钥 → 返回 `cdi`
- **绑定查询**：`GET /v1/channels/lucy/devices/device-bindings` → 返回 `{ user_id, cuk }`（SDK 轮询调用）
- **模型配置**：`GET /v1/channels/lucy/current-user/model-config` → 返回 `{ providerId, modelId, apiKey, base_url }`

#### lucy-server
- **OTP 签名**：验证 Ed25519 签名
- **设备绑定状态**：查询绑定是否完成
- **NATS token 交换**：生成临时 token

#### npc-im-server（NATS 基础设施）
- **auth-callout**：验证 NATS token、分配权限
- **presence-bridge**：聚合 `client.status.report` 和 `$SYS.ACCOUNT.>` 转成 `_discover` 事件

### 传输层：NATS JetStream

- **stream `IM_NPC`**：双向消息流（App ↔ Lucy）
- **durable consumer `npc-<cdi>`**：Pull Consumer，SDK 创建与管理
- **主题约定**：
  - 订阅：`cephalon.im.npc.<user_id>.<cdi>`（App → Lucy）
  - 发布：`cephalon.im.user.<user_id>`（Lucy → App）
- **Object Store**：媒体附件存储

### 本地持久化

```
~/.lucy/identity/
├─ bootstrap_token/          # Ed25519 密钥对（由 SDK 管理）
└─ channel_ids/              # cdi、cuk、user_id（由 SDK 管理）

~/.openclaw/config.toml      # OpenClaw 配置（插件写入 models.providers.cephalon.*）
restart-ticket.json          # 重启票据（插件写入）
pairing-info.json            # BLE 配对导出（插件生成）
```

## 主要导出函数清单

### 入口点

| 函数 | 文件 | 行号 | 说明 |
|------|------|------|------|
| `defineLucyChannelPluginEntry()` | channel-plugin-entry.ts | 28 | 插件 entry 钩子，注册 channel、命令、provider |
| `startLucyGateway()` | gateway.ts | 590 | 主运行时程序，阻塞直到 abortSignal |
| `buildLucyCephalonProvider()` | cephalon-provider.ts | 55 | 构造嵌入式 cephalon 模型供应商 |

### 认证与绑定

| 函数 | 文件 | 行号 | 说明 |
|------|------|------|------|
| `syncLucyBindingWithSdk()` | auth-binding.ts | 14 | 同步绑定状态（初始化、轮询、连接） |
| `connectLucySdk()` | auth-binding.ts | 83 | 建立 NATS 连接 |
| `buildLucyAuthQrUri(cdi, otp?)` | auth-qrcode.ts | 21–30 | 构造 `lucy://bind?channel_device_id=<cdi>&otp=<otp>` URI（otp 可选） |
| `buildLucyAuthQrJson(cdi, otp?)` | auth-qrcode.ts | 33–38 | 构造 JSON 格式 QR 数据（otp 可选） |
| `buildLucyAuthQrPayload(cdi, otp?)` | auth-qrcode.ts | 9–19 | 构造 `{ channel: "lucy", channel_device_id, otp? }` payload（otp 可选） |

### NATS 主题

| 函数 | 文件 | 行号 | 说明 |
|------|------|------|------|
| `buildNpcSubscribeSubject()` | nats.ts | 3 | 生成订阅主题 `cephalon.im.npc.<user_id>.<cdi>` |
| `buildNpcPublishSubject()` | nats.ts | 7 | 生成发布主题 `cephalon.im.user.<user_id>` |

### 入站处理

| 函数 | 文件 | 行号 | 说明 |
|------|------|------|------|
| `handleLucyInboundMessage()` | gateway.ts | 200+ | JetStream 消息回调，校验并交给 OpenClaw runtime |

### 出站发布

| 函数 | 文件 | 行号 | 说明 |
|------|------|------|------|
| `publishLucyMachineEvent()` | send.ts | 62 | 序列化机器事件并发往 NATS |

### 媒体传输

| 函数 | 文件 | 行号 | 说明 |
|------|------|------|------|
| `loadLucyOutboundMediaFromUrl()` | outbound-media.ts | 40+ | 读取附件 URL、检查白名单、返回字节 |
| `uploadLucyMediaFromSource()` | media.ts | 80+ | 上传到 JetStream Object Store |
| `downloadLucyMediaDescriptor()` | media.ts | 120+ | 从 Object Store 下载附件 |

### 模型供应与重启

| 函数 | 文件 | 行号 | 说明 |
|------|------|------|------|
| `handleLucyProvisioningMessage()` | provider-provisioning.ts | 70+ | 处理 `version=3/kind=provision_model` 消息 |
| `writeLucyRestartTicket()` | restart-ticket.ts | 40 | 写入重启票据 |
| `readLucyRestartTicket()` | restart-ticket.ts | 80 | 读取重启票据 |
| `publishLucyRestartCompletionIfPending()` | provider-provisioning.ts | 405 | 新进程启动后发送 `restart.completed` 事件 |

### 配对与本地通知

| 函数 | 文件 | 行号 | 说明 |
|------|------|------|------|
| `buildLucyPairingInfoExport()` | pairing-export.ts | 60 | 生成 `pairing-info.json` |
| `startLucyLocalNotifyServer()` | local-notify.ts | 174 | 启动本地 HTTP 服务接收 USB 事件 |

## 设计原则

**1. 职责分明**  
- SDK 处理加密、绑定、连接——插件不碰
- 插件处理 OpenClaw 运行时集成——SDK 不碰
- user-center 持有身份真相——插件只读

**2. 阻塞式启动**  
- `startLucyGateway()` 必须阻塞直到 abortSignal
- 若提前返回，OpenClaw 会自动重启（导致 "configured, works, stopped"）

**3. 无状态消息分发**  
- 所有入站消息都校验 `channel_user_key`
- 所有出站消息都带 `channel_device_id` 和 `timestamp`
- 不依赖内存中的会话状态

**4. 媒体白名单**  
- 出站只允许 file:// URL 或指定白名单目录
- 防止任意本地文件泄露

**5. 环境驱动配置**  
- `base_url` 不写死；必须跟随 user-center 响应
- `LUCY_HOME`、`LUCY_USER_CENTER_DOMAIN` 等由 OpenClaw 配置提供

## 与其他组件的关系

详见下列链接：
- [系统分层流程图](./diagrams.md#diagram-system-layers)
- [插件生命周期](./diagrams.md#diagram-plugin-lifecycle)
- [入站消息时序](../03-transport/jetstream-consumer.md)（第 3 章）
- [模型供应与重启](../05-model-provisioning/auto-restart.md)（第 5 章）
