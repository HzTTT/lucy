<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# App 接入指南

本文档面向 iOS/Android 客户端开发者。它详述了 Lucy 与 App 之间的整体接入流程、NATS 主题契约、消息信封格式、机器事件类别，以及媒体附件字段的完整参考。

## 整体接入流程

App 通过以下步骤与 Lucy 建立通信：

1. **获取配对信息**：通过 BLE（蓝牙）从 `lucy_pairing_info` 特性读取或直接扫描 QR 码，获取 `cdi`（channel device ID）。
2. **注册设备与绑定**：调用 `user-center` 的 `/v1/devices/new` 注册，然后轮询 `/v1/channels/lucy/devices/device-bindings` 直到绑定状态变为 `bound`，获得 `cuk`（channel user key）和 `user_id`。
3. **交换 NATS 凭证**：调用 `lucy-server` 的 NATS token 端点，用 Ed25519 签名换取 NATS 连接令牌。
4. **连接 NATS JetStream**：使用令牌连接到 NATS 集群，订阅 App 接收主题和发布主题。
5. **消息交互**：App 向 `cephalon.im.user.<user_id>` 发送用户消息，Lucy 从 `cephalon.im.npc.<user_id>.<cdi>` 拉取应答，并持续接收流式 `assistant.*` 事件。

```mermaid
sequenceDiagram
    participant APP as App (iOS/Android)
    participant BLUE as BLE / lucy-im-sdk
    participant UC as user-center
    participant NATS as NATS JetStream
    participant LUCY as Lucy Plugin

    APP->>BLUE: 读配对信息或扫 QR
    BLUE-->>APP: { cdi, ... }
    APP->>UC: POST /v1/devices/new (cdi)
    UC-->>APP: device_info
    APP->>UC: GET /v1/channels/lucy/devices/device-bindings
    loop 轮询绑定
        UC-->>APP: { status: pending / bound }
    end
    APP->>LUCY: 申请 NATS token (Ed25519 签名)
    LUCY-->>APP: { token, server, ... }
    APP->>NATS: 连接并认证
    NATS-->>APP: OK
    APP->>NATS: subscribe cephalon.im.npc.&lt;user_id&gt;.&lt;cdi&gt;
    NATS->>LUCY: (JetStream 消费者)
    APP->>NATS: publish 到 cephalon.im.user.&lt;user_id&gt;
    NATS->>LUCY: (JetStream 投递)
    LUCY->>LUCY: 处理消息 → 运行模型
    LUCY->>NATS: publish 流式事件
    NATS-->>APP: assistant.start / partial / final
```

## NATS 主题契约

Lucy 与 App 通过固定的 JetStream 主题进行双向通信。所有主题遵循 `cephalon.im.*` 命名空间。

| 方向 | 主题 | 说明 | 消息来源 | 消费方 |
|------|------|------|---------|--------|
| 入站（User → NPC） | `cephalon.im.user.<user_id>` | App 发送用户消息和命令 | App | Lucy Plugin（通过 SDK subscribe） |
| 出站（NPC → User） | `cephalon.im.npc.<user_id>.<cdi>` | Lucy 回复机器事件和流式响应 | Lucy Plugin（通过 SDK publish） | App（通过 JetStream Pull Consumer） |
| 现身状态（可选） | `_discover.online` / `_discover.offline` | 设备上线/离线事件 | lucy-im-sdk 内部 | 其他订阅方 |

**关键约定：**
- `<user_id>`：绑定后从 `user-center` 获得，用于身份隔离。
- `<cdi>`（channel device ID）：设备唯一标识，用于多设备场景区分。
- 所有 JetStream 消息必须使用已认证的 NATS token。token 由 lucy-server 通过 Ed25519 签名颁发。

## 消息信封格式

### 入站消息（App → Lucy）

App 向 `cephalon.im.user.<user_id>` 发布的消息，遵循以下 JSON 格式（`src/types.ts` 中 `LucyInboundMessageSchema`）：

```json
{
  "version": 2,
  "kind": "text",
  "channel_user_key": "<cuk>",
  "text": "用户输入的消息文本",
  "attachments": [
    {
      "id": "attachment_id_1",
      "mime": "image/jpeg",
      "descriptor": {
        "bucket": "media-bucket",
        "name": "object-key",
        "size": 51200
      }
    }
  ]
}
```

**字段说明：**
- `version`（必须）：消息版本，当前支持 2、3、4。新 App 推荐使用 `version: 3`。
- `kind`（必须）：消息类型，当前只支持 `"text"`。
- `channel_user_key`（必须）：绑定时从 `user-center` 获得的 `cuk`，用于服务端身份验证。
- `text`（必须）：消息主体，UTF-8 编码的纯文本或 Markdown。
- `attachments`（可选）：附件列表，每个附件包含 JetStream Object Store descriptor。

### 出站事件（Lucy → App）

Lucy 向 `cephalon.im.npc.<user_id>.<cdi>` 发布的事件，遵循以下 JSON 格式（`src/types.ts` 中 `LucyMachineEventSchema`）：

```json
{
  "type": "assistant.start",
  "event_id": "evt_123",
  "timestamp_ms": 1639900000000
}
```

完整的机器事件类别详见下节 "机器事件类别索引"。

## 机器事件类别索引

Lucy 发出的所有事件都遵循统一的信封结构，包含 `type`、`event_id` 和 `timestamp_ms`。事件类型由 `src/types.ts` 中的 `LucyMachineEventType` 枚举定义。

| 事件类型 | 说明 | 关键字段 | 典型场景 |
|---------|------|---------|--------|
| `assistant.start` | 模型开始生成 | 无额外字段 | 用户消息被 Lucy 接收并开始投喂模型 |
| `assistant.partial` | 模型输出流式片段 | `text`: 本次 token 或句子 | 流式气泡逐字显示 |
| `assistant.final` | 模型输出完成 | `text`: 完整回复；`media`: 附件列表 | 一轮对话完成 |
| `inbound.accepted` | 入站消息被确认 | 无额外字段 | 消息格式正确、签名验证通过 |
| `inbound.rejected` | 入站消息被拒绝 | `reason`: 拒绝原因（文本） | 格式错误、签名失败、超时 |
| `approval.pending` | 需要用户审批高危命令 | `approval_id`、`approval_slug`、`approval_command` | 模型要执行 `sudo` 等 |
| `approval.resolved` | 审批决定已处理 | `approval_decision`: "allow-once" \| "allow-always" \| "deny" | 用户在 UI 上确认审批 |
| `config.updated` | 配置已更新 | `config_type`: 配置类别 | 模型供应完成 |
| `config.error` | 配置应用失败 | `error_message`: 错误信息 | 非法的提供者 ID 或模型配置 |
| `restart.scheduled` | 重启已计划 | `restart_id`: 票据 ID | 模型供应后等待 gateway 重启 |
| `restart.completed` | 重启已完成 | 无额外字段 | 新配置已生效 |
| `usb.inserted` | USB 设备插入 | `device`: 设备名称（文本） | 本地通知事件 |
| `usb.syncing` | USB 同步中 | `device` | 本地通知事件 |
| `usb.synced` | USB 同步完成 | `device` | 本地通知事件 |
| `usb.failed` | USB 同步失败 | `device`、`error_message` | 本地通知事件 |
| `usb.removed` | USB 设备移除 | `device` | 本地通知事件 |

关键事件的详细文档，请参考 [机器事件详解](../04-messaging/machine-events.md)。

## 媒体附件字段

### 出站附件（Lucy 发往 App）

当 Lucy 的模型回复中包含文件时，`assistant.final` 事件的 `media` 字段会包含附件列表：

```json
{
  "type": "assistant.final",
  "text": "这是一个图表:",
  "media": [
    {
      "id": "attachment_id",
      "mime": "image/png",
      "descriptor": {
        "bucket": "lucy-media-store",
        "name": "image_12345.png",
        "size": 102400,
        "uploaded_at_ms": 1639900000000
      },
      "suggested_filename": "chart.png"
    }
  ]
}
```

**字段说明：**
- `id`：附件的唯一标识符（UUID 或自定义 ID）。
- `mime`：MIME 类型（例如 `image/jpeg`、`application/pdf`、`text/plain`）。
- `descriptor.bucket`：JetStream Object Store 的 bucket 名称（当前固定为 `lucy-media-store`）。
- `descriptor.name`：Object Store 中的对象名称（键），唯一标识一个文件。
- `descriptor.size`：文件大小（字节）。
- `descriptor.uploaded_at_ms`：上传时间戳（毫秒）。
- `suggested_filename`：建议的本地存储文件名（含扩展名）。

App 收到 descriptor 后，需要用 NATS JetStream Object Store API 使用相同的 bucket 和 name 来下载文件。

### 入站附件（App 发往 Lucy）

App 上传的附件，必须先通过 JetStream Object Store 上传，再在消息中引用 descriptor：

```json
{
  "version": 2,
  "kind": "text",
  "channel_user_key": "<cuk>",
  "text": "这是一张截图",
  "attachments": [
    {
      "id": "user_upload_1",
      "mime": "image/jpeg",
      "descriptor": {
        "bucket": "lucy-media-store",
        "name": "screenshot_abc123.jpg",
        "size": 51200
      }
    }
  ]
}
```

Lucy 在收到消息时，会调用 `downloadLucyMediaDescriptor()` 从 Object Store 下载字节，然后把本地路径交给 OpenClaw runtime 处理。

## 接入自检清单

完成以下检查，确保 App 与 Lucy 的集成正确：

- [ ] **配对阶段**
  - [ ] 通过 BLE 或 QR 码成功获取 `cdi`
  - [ ] 向 `user-center` 注册设备，获得 device_info
  - [ ] 轮询绑定 API 直到状态为 `bound`，获得 `cuk` 和 `user_id`

- [ ] **NATS 连接**
  - [ ] 从 lucy-server 成功申请 NATS token（Ed25519 签名验证通过）
  - [ ] 使用 token 连接到 NATS JetStream 集群
  - [ ] 成功订阅 `cephalon.im.npc.<user_id>.<cdi>` 主题
  - [ ] 能够发布到 `cephalon.im.user.<user_id>` 主题

- [ ] **消息格式**
  - [ ] 入站消息包含 `version`、`kind`、`channel_user_key`、`text` 字段
  - [ ] 出站事件 JSON 可被正确解析，包含 `type`、`event_id`、`timestamp_ms`
  - [ ] 能够处理 `assistant.start`、`assistant.partial`、`assistant.final` 的流式序列

- [ ] **附件处理**
  - [ ] 能够上传文件到 JetStream Object Store（与 Lucy 共用同一 bucket）
  - [ ] 能够下载 Lucy 回复的附件（使用 descriptor 的 bucket 和 name）
  - [ ] 正确处理 `suggested_filename` 和 MIME 类型

- [ ] **特殊事件**
  - [ ] 能够接收并展示 `approval.pending` 和 `approval.resolved`
  - [ ] 能够接收并响应 `config.updated`、`config.error`、`restart.scheduled`、`restart.completed`
  - [ ] 能够接收 USB 本地通知事件（`usb.inserted` 等）并展示给用户

- [ ] **错误处理**
  - [ ] 处理 `inbound.rejected` 事件（签名失败、格式错误）
  - [ ] 处理 NATS 连接断开和重连
  - [ ] 处理超时和网络错误的重试逻辑

## 相关文档

- [NATS 主题与 JetStream 详解](../03-transport/nats-subjects.md)
- [机器事件详解](../04-messaging/machine-events.md)
- [媒体对象存储](../06-media/object-store.md)
- [BLE 配对信息导出](./ble-pairing-export.md)
