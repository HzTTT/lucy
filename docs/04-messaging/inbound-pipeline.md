<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# 入站消息管道

## 概述

Lucy 的入站消息管道从 NATS 订阅开始，经过 zod schema 校验，然后投递给 OpenClaw runtime 执行模型推理，最后通过机器事件回传结果给 App。本章详解每一步的职责与关键信号。

关键流程图参见 [入站消息时序](../01-overview/diagrams.md#diagram-inbound-sequence)。

---

## 消息路由与订阅主题

### 订阅主题格式

Lucy 通过 JetStream Pull Consumer 订阅以下格式的主题：

```
cephalon.im.npc.<user_id>.<cdi>
```

其中：
- `user_id` — 从 `pollBinding()` 返回的用户 ID（snake_case）
- `cdi` — channel device ID，设备的唯一标识符

构建函数：`buildNpcSubscribeSubject(userId, cdi)`（`src/nats.ts`）

### 发布主题格式

出站消息（Lucy → App）使用以下格式：

```
cephalon.im.user.<user_id>
```

构建函数：`buildNpcPublishSubject(userId)`（`src/nats.ts`）

**注意：** App 负责将用户消息发布到 `cephalon.im.user.<user_id>`；Lucy 只负责订阅并处理来自 `cephalon.im.npc.<user_id>.<cdi>` 的消息。

---

## 消息格式与版本支持

Lucy 支持多个入站消息版本（version 1 ~ 4）。所有版本都通过 zod schema 在 `src/types.ts` 中定义：

### Version 1（已过时）

```typescript
{
  version: 1,
  messageId?: string,           // 19 位雪花 ID
  text: string,                 // 必填
  timestamp?: number,
  metadata?: Record<string, unknown>,
  channelUserKey?: string,      // 用户密钥（cuk）
  channelDeviceId?: string,     // 设备 ID（cdi）
  apiKey?: string,              // 旧别名
  deviceId?: string             // 旧别名
}
```

**LucyInboundMessageV1Schema**（`src/types.ts:81`）

### Version 2

增加媒体支持：

```typescript
{
  version: 2,
  messageId?: string,
  text?: string,                // 可选（需至少有 text 或 media）
  media?: LucyMediaDescriptor,  // 可选媒体
  timestamp?: number,
  metadata?: Record<string, unknown>,
  channelUserKey?: string,
  channelDeviceId?: string,
  apiKey?: string,
  deviceId?: string
}
```

**验证规则：** text 或 media 至少有一个（`src/types.ts:93-115`）

### Version 3（推荐）

增加模型供应支持：

```typescript
{
  version: 3,
  kind: "chat" | "provision_model",  // 消息类型
  messageId?: string,
  text?: string,                      // kind=chat 时需要 text 或 media
  media?: LucyMediaDescriptor,
  provision?: LucyProvisioningPayload, // kind=provision_model 时使用
  timestamp?: number,
  metadata?: Record<string, unknown>,
  channelUserKey?: string,
  channelDeviceId?: string,
  apiKey?: string,
  deviceId?: string
}
```

**LucyInboundMessageV3Schema**（`src/types.ts:126-150`）

### Version 4+

后续扩展版本遵循相同结构。

---

## 入站消息处理流程

### 1. 消息订阅与拉取

`startLucyGateway()`（`src/gateway.ts:590`）调用 `connectLucySdk()` 建立 NATS 连接后，使用以下代码订阅消息：

```typescript
session.subscribeChannel(subject, handler)
```

其中 `handler` 是 `handleLucyInboundMessage()`（`src/gateway.ts:268`）。

### 2. Schema 校验

入站消息首先通过 `LucyInboundMessageSchema.safeParse()` 进行类型检查：

```typescript
const parsed = LucyInboundMessageSchema.safeParse(params.inbound);
if (!parsed.success) {
  // 发送 error 机器事件回传校验错误
  await publishLucyMachineEvent({
    type: "error",
    text: `invalid inbound message: ${parsed.error.issues[0]?.message}`,
  });
  return;
}
```

**代码位置：** `src/gateway.ts:279-293`

### 3. 消息分类处理

#### 模型供应消息（kind=provision_model）

如果消息是 `version=3 / kind=provision_model`，转交给 `handleLucyProvisioningMessage()`（`src/provider-provisioning.ts:305`），详见 [模型下发主流程](../05-model-provisioning/provision-flow.md)。

#### 普通聊天消息（kind=chat 或 version <= 2）

继续以下步骤：

### 4. 媒体下载

如果入站消息包含媒体描述符，使用 `downloadLucyMediaDescriptor()` 将媒体从 Object Store 拉取到本地：

```typescript
const downloaded = await downloadLucyMediaDescriptor({
  descriptor: inbound.media,
  // ...
});
```

**代码位置：** `src/gateway.ts`（搜索 downloadLucyMediaDescriptor）

**相关文档：** [媒体对象存储](../06-media/object-store.md)

### 5. inbound.accepted 信号

消息通过所有验证后立即发送 `inbound.accepted` 机器事件：

```typescript
await publishLucyMachineEvent({
  session: params.session,
  userId: params.userId,
  cuk: params.cuk,
  cdi: params.cdi,
  type: "inbound.accepted",
  sourceMessageId: parsedInbound.messageId,
});
```

**代码位置：** `src/gateway.ts`（搜索 inbound.accepted）

**重要信号：** 如果收不到 `inbound.accepted`，说明：
- 订阅主题不正确
- NATS token 过期或权限不足
- schema 校验失败

### 6. 投递给 OpenClaw Runtime

消息被封装为 `InboundMessage` 后投递给 `channelRuntime.inbound()`：

```typescript
await params.channelRuntime.inbound({
  type: "text",
  text: trimmedText,
  media: uploaded[0],
  attachments: uploaded,
  metadata,
});
```

此时，OpenClaw 的 agent/model 开始执行。

### 7. 流式回复（assistant.* 事件）

Runtime 执行期间会产生以下机器事件：

- `assistant.start` — 模型开始回复
- `assistant.partial` — 部分文本片段（流式 token）
- `assistant.final` — 完整回复结束

所有这些事件都通过 `publishLucyMachineEvent()` 发送回 App。

**代码位置：** `src/send.ts:62`

---

## 故障排查信号

### 收到 inbound.accepted，但无 assistant.* 事件

**原因：** Runtime 启动失败或模型未配置。

**排查步骤：**
1. 检查 `models.providers` 是否包含有效的 provider
2. 检查 `agents.defaults.model.primary` 是否指向已启用的 provider
3. 查看 OpenClaw 日志（`openclaw gateway logs`）

### 没有 inbound.accepted

**原因：** 传输层或 schema 校验问题。

**排查步骤：**
1. 验证 `channelDeviceId` 与 `cdi` 一致（允许旧版别名 `deviceId`）
2. 验证 `channelUserKey` 与 `cuk` 一致（允许旧版别名 `apiKey`）
3. 检查入站消息 schema 版本是否在支持范围内（v1-v4）
4. 验证 NATS 连接是否活跃：`env OPENCLAW_CONFIG_DIR=... docker compose run --rm openclaw-cli channels status --probe`

### assistant.final 返回 HTTP 401 或 auth 错误

**原因：** Lucy 传输健康，但 provider 凭证未配置或已过期。

**排查步骤：**
1. 检查 provider 的 API Key 是否正确
2. 验证 `base_url` 是否指向正确的模型服务
3. 详见 [自动重启与恢复](../05-model-provisioning/auto-restart.md)

---

## 机器事件与消息流控

每个机器事件通过 `publishLucyMachineEvent()`（`src/send.ts:62`）发送，包含以下必填字段：

```typescript
{
  version: 2,
  eventId: string,           // 雪花 ID
  type: LucyMachineEventType, // "inbound.accepted" | "assistant.start" | ...
  timestamp: number,         // Date.now()
  channelUserKey: string,    // cuk
  channelDeviceId: string,   // cdi
  sourceMessageId?: string,  // 关联的入站消息 ID
  // ... 其他类型特定字段
}
```

**完整事件字典参见：** [机器事件字典](./machine-events.md)

---

## 配置参考

入站管道受以下配置影响：

| 配置键 | 类型 | 说明 | 默认值 |
|--------|------|------|--------|
| `channels.lucy.enabled` | bool | 启用 Lucy 插件 | false |
| `channels.lucy.mediaMaxMb` | number | 单个媒体文件大小限制（MB） | 20 |
| `channels.lucy.maxAttachments` | number | 单条消息最大附件数 | 10 |
| `channels.lucy.mediaLocalRoots` | string[] | 出站媒体白名单目录 | ["/home/lucy"] |
| `channels.lucy.dmPolicy` | "allowlist"\|"open"\|"disabled" | DM 策略 | "allowlist" |
| `channels.lucy.allowFrom` | string[] | 白名单用户 ID 列表（dmPolicy=allowlist 时） | [] |

详见 `src/types.ts` 的 `LucyConfigSchema`（`src/types.ts:52-70`）。

---

## 相关文档链接

- [机器事件字典](./machine-events.md) — 完整的事件类型与字段说明
- [执行审批](./exec-approvals.md) — 审批事件的处理流程
- [媒体对象存储](../06-media/object-store.md) — 入站媒体下载
- [调试指南](../08-operations/debugging.md) — 故障排查工具与脚本
