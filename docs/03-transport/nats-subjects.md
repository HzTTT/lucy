<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# NATS 主题与消息约定

Lucy 使用 NATS JetStream 作为唯一的传输通道。本章解释主题命名规则、消息序列化格式和版本协议。

## 主题命名

Lucy 的主题采用分层命名，以便 NATS 可以对消息进行路由、存储和消费。

### 订阅主题（App → Lucy）

**函数**：`buildNpcSubscribeSubject(userId, cdi)`（nats.ts:3）

**格式**：
```
cephalon.im.npc.<user_id>.<cdi>
```

**参数**：
- `user_id`：绑定后的用户 ID（如 `user-20240101-abcdef123456`）
- `cdi`：设备 ID（如 `device-20240416-xyz789`）

**示例**：
```
cephalon.im.npc.user-20240101-abcdef123456.device-20240416-xyz789
```

**含义**：
- App 向此主题发布用户消息（用户在 App 中输入的文本、语音、或选择的操作）
- Lucy 的 JetStream Pull Consumer 订阅此主题
- 确保 Lucy 只收到发给自己的消息（分设备隔离）

### 发布主题（Lucy → App）

**函数**：`buildNpcPublishSubject(userId)`（nats.ts:7）

**格式**：
```
cephalon.im.user.<user_id>
```

**参数**：
- `user_id`：绑定的用户 ID

**示例**：
```
cephalon.im.user.user-20240101-abcdef123456
```

**含义**：
- Lucy 发布所有出站事件到此主题
- App 订阅此主题接收 assistant 回复、机器事件、审批通知等
- 多个设备可能都给同一用户发消息（例如，同一用户的多个设备同时连接）

### Presence 主题（由 SDK 内部管理）

SDK 自动订阅特殊的 `_discover` 主题以接收在线/离线通知。插件不直接处理。

---

## 消息序列化格式

所有消息（入站和出站）都序列化为 JSON，并遵循统一的 envelope 结构。

### 入站消息（InboundMessage）

App 发往 `cephalon.im.user.<user_id>` 的消息格式：

```json
{
  "version": 2 | 3 | 4,
  "kind": "user_message" | "provision_model" | "control_message",
  "messageId": "msg-20240416-abcdef1234567890",
  "timestamp": 1713307200000,
  "channel_user_key": "key-xyz789",
  "channel_device_id": "device-20240416-xyz789",
  "attachments": [
    {
      "media_descriptor": {
        "bucket": "lucy-media",
        "name": "message-msg-xxx/photo.jpg",
        "size": 102400,
        "contentType": "image/jpeg"
      }
    }
  ],
  "text": "用户输入的文本",
  "metadata": {
    "client_version": "1.2.3",
    "platform": "ios"
  }
}
```

**必需字段**：
- `version`：协议版本（2, 3, 或 4）
  - v2：基础消息格式
  - v3：添加 `provision_model` kind（模型供应）
  - v4：添加 `control_message` kind（扩展消息）
- `kind`：消息类型
- `messageId`：App 生成的唯一消息 ID
- `timestamp`：毫秒时间戳
- `channel_user_key`：用户密钥（用于 Lucy 校验）
- `channel_device_id`：发送设备的 ID

**可选字段**：
- `attachments`：附件列表（如果有）
- `text`：消息文本内容
- `metadata`：客户端元数据（App 版本、平台等）

**Lucy 侧处理**（gateway.ts:200+）：
1. 反序列化 JSON
2. 校验 `channel_user_key` 与本地 `cuk` 是否匹配
3. 若不匹配 → 拒绝，发送 `inbound.rejected` 事件
4. 解码附件描述符，从 Object Store 下载
5. 投递给 OpenClaw runtime

### 出站消息（MachineEvent）

Lucy 发往 `cephalon.im.user.<user_id>` 的消息格式：

```json
{
  "version": 4,
  "eventId": "evt-20240416-1234567890abcdef",
  "type": "assistant.start" | "assistant.partial" | "assistant.final" | 
          "approval.pending" | "approval.resolved" |
          "inbound.accepted" | "inbound.rejected" | "inbound.error" |
          "config.updated" | "config.error" |
          "restart.scheduled" | "restart.completed" |
          "usb.inserted" | "usb.syncing" | "usb.synced" | "usb.failed" | "usb.removed",
  "timestamp": 1713307200000,
  "channel_user_key": "key-xyz789",
  "channel_device_id": "device-20240416-xyz789",
  "sourceMessageId": "msg-20240416-abcdef1234567890",
  "runId": "run-abc123xyz",
  "text": "模型或系统的回复文本",
  "media": [
    {
      "bucket": "lucy-media",
      "name": "message-msg-xxx/output.png",
      "size": 204800,
      "contentType": "image/png"
    }
  ],
  "metadata": {
    "model": "claude-opus-4",
    "provider": "cephalon",
    "tokens": {
      "input": 150,
      "output": 250
    }
  }
}
```

**必需字段**：
- `version`：固定为 4
- `eventId`：Lucy 生成的唯一事件 ID（Snowflake ID）
- `type`：事件类型
- `timestamp`：毫秒时间戳
- `channel_user_key`：用户密钥（App 侧校验）
- `channel_device_id`：设备 ID（回显）

**可选字段**：
- `sourceMessageId`：原入站消息 ID（若是对某消息的回复）
- `runId`：run ID（若与 OpenClaw run 相关）
- `text`：事件文本内容
- `media`：附件列表
- `metadata`：事件元数据

**事件类型详解**：

| 类型 | 描述 | 发送方 |
|------|------|--------|
| `assistant.start` | 模型开始回复 | OpenClaw runtime → send.ts |
| `assistant.partial` | 流式回复中间片段 | OpenClaw runtime → send.ts |
| `assistant.final` | 模型回复完成 | OpenClaw runtime → send.ts（或本地通知） |
| `approval.pending` | 需要用户审批高危命令 | OpenClaw → exec-approvals-handler.ts |
| `approval.resolved` | 审批结果 | exec-approvals-handler.ts |
| `inbound.accepted` | 入站消息已接收 | gateway.ts → send.ts |
| `inbound.rejected` | 入站消息被拒（channel_user_key 不匹配） | gateway.ts → send.ts |
| `inbound.error` | 入站消息处理出错 | gateway.ts → send.ts |
| `config.updated` | 模型配置已更新 | provider-provisioning.ts → send.ts |
| `config.error` | 模型配置更新失败 | provider-provisioning.ts → send.ts |
| `restart.scheduled` | 重启已安排 | provider-provisioning.ts → send.ts |
| `restart.completed` | 重启完成 | provider-provisioning.ts → send.ts（新进程） |
| `usb.inserted` / ... | USB 事件 | local-notify.ts → send.ts |

### Snowflake ID（eventId 和 messageId）

Lucy 使用 Snowflake ID 算法生成唯一 ID（snowflake.ts）：

```typescript
// 结构：
// | timestamp (41 bits) | worker_id (10 bits) | sequence (12 bits) |
// 
// 优点：
// - 时间序列有序（便于日志排序和追踪）
// - 分布式生成（无需中央序列号服务）
// - 高吞吐（单机每毫秒可生成 4096 个 ID）

function generateSnowflakeId(): string {
  const timestamp = Date.now();
  const workerId = getWorkerId(); // 0-1023
  const sequence = incrementSequence();
  
  const id = (timestamp << 22) | (workerId << 12) | sequence;
  return `msg-${id.toString(36)}`;  // 或 `evt-${...}`
}
```

---

## 版本协议

Lucy 支持多个消息格式版本，以便在演进过程中保持向后兼容性。

### 版本历史

| 版本 | 引入时间 | 新增字段/类型 | 说明 |
|------|---------|---------------|------|
| v2 | 2024-01 | 基础 | 初始版本，支持 `user_message` |
| v3 | 2024-02 | `provision_model` kind | 添加模型配置下发 |
| v4 | 2024-03 | `control_message` kind | 添加通用控制消息 |

### 版本协商

- **App → Lucy**：App 在 `version` 字段声明支持的版本
- **Lucy → App**：Lucy 固定使用 v4（最新版本）
- **向后兼容**：Lucy 支持 v2、v3、v4 的入站消息

**示例**：
```json
{
  "version": 2,  // 旧 App 只能发 v2
  "kind": "user_message",
  ...
}
```

Lucy 接收到 v2 消息后：
1. 识别为 `user_message`（v2 仅有此类型）
2. 处理消息，生成出站事件
3. 使用 v4 发送出站消息

---

## 主题订阅与消费

### Lucy 的订阅方式

Lucy 使用 NATS JetStream Pull Consumer 订阅入站主题：

```typescript
// 来自 sdk/src/natsConn.ts（由 SDK 管理）
const consumer = await js.consumers.add(stream, {
  name: "npc-" + cdi,        // durable name
  filter_subject: buildNpcSubscribeSubject(userId, cdi),
  ack_policy: AckPolicy.Explicit,
  max_ack_pending: 10,
  deliver_policy: DeliverPolicy.New  // 仅接收连接后的消息
});

while (true) {
  const msg = await consumer.next();
  try {
    await handleLucyInboundMessage(JSON.parse(msg.data));
    msg.ack();  // 显式确认，消息从队列移除
  } catch (err) {
    msg.nak();  // 否认，消息重新入队后续重试
  }
}
```

**关键参数**：
- `name: "npc-<cdi>"`：durable consumer 名称（persistent across reconnects）
- `filter_subject`：精确订阅该设备的主题
- `ack_policy: Explicit`：必须显式确认，否则重试
- `max_ack_pending: 10`：最多同时处理 10 条消息
- `deliver_policy: New`：仅交付连接后的新消息（不重放历史）

### App 的订阅方式

App 通过相同的 SDK 接口订阅出站主题：

```typescript
// 来自 lucy-im-sdk-kotlin / lucy-im-sdk-swift
session.subscribeChannel(buildNpcPublishSubject(userId), handler);
```

---

## 故障与重试

### 消息丢失

**症状**：Lucy 接收不到 App 发送的消息。

**检查清单**：
1. 订阅主题是否正确（`cephalon.im.npc.<user_id>.<cdi>`）？
2. JetStream consumer 是否已创建（`pnpm exec tsx scripts/e2e-probe.mjs | grep consumer`）？
3. App 是否真的发布消息到 `cephalon.im.user.<user_id>`？

### 消息重复

**症状**：同一消息处理两次。

**根因**：Lucy 在处理消息期间崩溃，未能 ACK，连接恢复后重新投递。

**处理**：
- 入站消息本身包含 `messageId`，App 可根据 ID 去重
- Lucy 侧无需做重复检查（幂等性由 OpenClaw runtime 保证）

### 消息顺序

**保证**：Pull Consumer 以 FIFO 顺序投递消息（单条 subject 内）。

**限制**：若多个设备同时给同一用户发消息，顺序由 NATS 决定（通常先到先得）。

---

## 监控与调试

### 检查主题内容

```bash
# 列出 stream 中所有消息
nats stream view IM_NPC

# 查看特定主题的消息
nats stream view IM_NPC --filter "cephalon.im.npc.user-xyz.*"

# 监听实时消息
nats sub "cephalon.im.npc.user-xyz.device-abc" &
```

### 检查 Consumer 状态

```bash
# 列出所有 consumer
nats consumer list IM_NPC

# 查看特定 consumer 的统计信息
nats consumer info IM_NPC npc-device-xyz
```

---

## 与其他章节的关系

- **出站路径**：详见[第 4 章 - 入站消息管道](../04-messaging/inbound-pipeline.md)
- **时序图**：详见[入站消息时序](../01-overview/diagrams.md#diagram-inbound-sequence)
- **JetStream 消费者**：详见[下节 - JetStream 消费者](./jetstream-consumer.md)
