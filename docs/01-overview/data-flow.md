<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# Lucy 数据流概览

Lucy 系统有六条主要的数据流。本章用白话描述每条流的起点、终点、经过的函数和关键决策点，使新开发者快速理解信息如何在 App、插件、运行时、供应商之间流动。

## 1. 入站消息流（App → Lucy）

**流程简述**：App 向 `cephalon.im.user.<user_id>` 发布用户消息 → NATS JetStream 投递给 Lucy 订阅端 → Lucy 校验并交给 OpenClaw runtime → runtime 调用模型 → 产生回复。

**关键函数**：
- 订阅主题构造：`buildNpcSubscribeSubject(userId, cdi)`（nats.ts:3）
- 入站消息处理：`handleLucyInboundMessage()`（gateway.ts:200+）
- 校验：检查 `channel_user_key` 匹配、解码附件列表

**数据形状**（InboundMessage）：
```json
{
  "version": 2 | 3 | 4,
  "kind": "user_message" | "provision_model" | "control_message",
  "channel_user_key": "cuk (channel_user_key)",
  "channel_device_id": "cdi (channel_device_id)",
  "messageId": "自生成 snowflake ID",
  "timestamp": 1713307200000,
  "attachments": [ { "media_descriptor": {...} } ]
}
```

**故障检查**：
- 若 `channel_user_key` 不匹配 → 日志记录、事件 `inbound.rejected`
- 若附件下载失败 → 事件 `inbound.attachment_error`，但仍投递 message
- 若 runtime 异常 → 事件 `inbound.error`，App 可重试

**详见**：[第 3 章 - JetStream 消费者](../03-transport/jetstream-consumer.md)、[第 4 章 - 入站处理](../04-messaging/inbound-pipeline.md)

---

## 2. 出站事件流（Lucy → App）

**流程简述**：OpenClaw runtime 产生 assistant 事件（start / partial / final）→ Lucy 订阅并转为 MachineEvent → 序列化为 JSON → 发往 `cephalon.im.user.<user_id>` → App 订阅接收。

**关键函数**：
- 发布主题构造：`buildNpcPublishSubject(userId)`（nats.ts:7）
- 事件发布：`publishLucyMachineEvent()`（send.ts:62）
- 序列化：events 转为 JSON（带版本、时间戳、eventId）

**数据形状**（MachineEvent）：
```json
{
  "version": 4,
  "eventId": "自生成 snowflake ID",
  "type": "assistant.start" | "assistant.partial" | "assistant.final",
  "timestamp": 1713307200000,
  "channel_user_key": "cuk",
  "channel_device_id": "cdi",
  "text": "模型回复",
  "media": [ { "bucket": "lucy-media", "name": "..." } ],
  "sourceMessageId": "原入站消息 ID"
}
```

**流式处理**：
- `assistant.start` → App 创建新气泡、显示输入状态
- `assistant.partial` (text chunk) → 追加文本、流式渲染
- `assistant.final` → 标记完成、关闭输入状态

**详见**：[第 3 章 - NATS 主题](../03-transport/nats-subjects.md)、[第 4 章 - 机器事件字典](../04-messaging/machine-events.md)

---

## 3. 模型供应流（user-center → Lucy → OpenClaw）

**流程简述**：App 从 user-center 获取 `model-config` API → 发送 `version=3/kind=provision_model` 消息 → Lucy 解析并更新本地 OpenClaw 配置 → 写入 `models.providers.cephalon.*` → 触发 gateway 重启。

**关键函数**：
- 模型配置接口：`fetchLucyUserCenterConfig()`（user-center.ts:100+）
- 消息处理：`handleLucyProvisioningMessage()`（provider-provisioning.ts:70+）
- 配置写入：`applyLucyProvisioningConfig()`（provider-provisioning.ts:150+）
- 重启：`writeLucyRestartTicket()` + `runCommandWithTimeout("openclaw gateway restart")`

**关键决策点**：
- 若供应商 ID ≠ "cephalon" → 拒绝，发送 `config.error`
- 若 `restartRequested = false` → 仅更新配置，不重启
- 若重启触发 → 新进程读取 ticket、发送 `restart.completed`

**数据形状**（来自 user-center `current-user/model-config`）：
```json
{
  "providerId": "cephalon",
  "modelId": "claude-opus-4",
  "apiKey": "sk-...",
  "base_url": "https://api.anthropic.com"
}
```

**详见**：[第 5 章 - 模型供应与重启](../05-model-provisioning/auto-restart.md)

---

## 4. 媒体上传流（Lucy → App，出站附件）

**流程简述**：OpenClaw runtime 产生带附件的回复（file:// URL）→ Lucy 加载文件字节 → 检查白名单 → 上传到 JetStream Object Store → 生成 descriptor → 塞入出站事件。

**关键函数**：
- 文件加载：`loadLucyOutboundMediaFromUrl()`（outbound-media.ts:40+）
- 白名单检查：`isLucyMediaUrlAllowed()`（outbound-media.ts:200+）
- 上传：`uploadLucyMediaFromSource()`（media.ts:80+）
- descriptor 构造：包含 bucket、name、size、contentType

**关键决策点**：
- 若 URL 协议 ≠ file:// → 拒绝
- 若路径不在白名单中（默认 `/tmp`、`~/.openclaw/workspace` 等）→ 拒绝、发送错误日志
- 若上传失败 → 附件丢失，仍发送文本回复，但不包含 media 字段

**数据形状**（Object Store Descriptor）：
```json
{
  "bucket": "lucy-media",
  "name": "message-{messageId}/{filename}.{ext}",
  "size": 102400,
  "contentType": "image/png"
}
```

**详见**：[第 6 章 - 媒体传输](../06-media/object-store.md)

---

## 5. 媒体下载流（App → Lucy，入站附件）

**流程简述**：App 发送消息并附上 descriptor → Lucy 入站处理 → 从 Object Store 下载字节 → 保存到临时位置 → 交给 runtime 处理。

**关键函数**：
- descriptor 下载：`downloadLucyMediaDescriptor()`（media.ts:120+）
- 校验：Object Store 中确实存在该对象
- 临时文件：保存到 `~/.openclaw/workspace/lucy-attachments/{messageId}/`

**故障检查**：
- 若 Object Store 不存在该对象 → 错误日志，但仍投递消息（仅文本）
- 若网络超时 → 重试 3 次，然后放弃

**详见**：[第 6 章 - 媒体传输](../06-media/object-store.md)

---

## 6. 审批事件流（OpenClaw → App）

**流程简述**：OpenClaw runtime 需要高危命令审批 → 推送 `exec.approval.requested` → Lucy Handler 转为 `approval.pending` 机器事件 → 发给 App → 用户选择 allow/deny → runtime 收到决定。

**关键函数**：
- Handler：`LucyExecApprovalHandler`（exec-approvals-handler.ts:50）
- 文本生成：`buildExecApprovalPendingReplyPayload()`（exec-approval-helpers.ts:50+）
- 事件发送：`publishLucyMachineEvent()` with `type=approval.pending`

**事件生命周期**：
1. runtime → `exec.approval.requested` {id, command, expiresAtMs}
2. Handler → `approval.pending` {approvalId, approvalSlug, allowedDecisions}
3. App 渲染提示 + 审批按钮
4. 用户点击 → App 发回决定
5. runtime → `exec.approval.resolved` {id, decision, resolvedBy}
6. Handler → `approval.resolved` {approvalDecision}
7. App 标记气泡为已处理

**详见**：[第 4 章 - 审批事件](../04-messaging/exec-approvals.md)

---

## 7. USB 本地通知流（机器守护进程 → App）

**流程简述**：本机守护进程（U 盘监听器等）POST 到 Lucy 本地 HTTP 端点 → 校验 payload → 转为 `assistant.final` 事件 → 发给 App。

**关键函数**：
- HTTP 服务器：`startLucyLocalNotifyServer()`（local-notify.ts:174）
- 文案映射：`buildLucyLocalNotifyText()`（local-notify.ts:120+）
- 事件发送：`publishLucyMachineEvent()` with `type=assistant.final`

**事件代码 → 文案映射**：
- code=1 → "U 盘已插入"（usb.inserted）
- code=2 → "U 盘同步中"（usb.syncing）
- code=3 → "U 盘同步完成"（usb.synced）
- code=4 → "U 盘同步失败"（usb.failed）
- code=5 → "U 盘已拔出"（usb.removed）

**关键守护栏**：
- payload 大小限制 64KB（防止 DoS）
- 仅监听 127.0.0.1（本机）
- 非法 code 或格式 → 400/405 错误

**详见**：[第 7 章 - USB 本地通知](../07-integrations/usb-local-notify.md)

---

## 流程概览图

详见：
- [系统分层架构](./diagrams.md#diagram-system-layers) — 整体层级关系
- [入站消息时序](./diagrams.md#diagram-inbound-sequence) — 流 1 的完整时序
- [模型供应与自动重启](./diagrams.md#diagram-provisioning-restart) — 流 3 的重启流程
- [媒体上下行](./diagrams.md#diagram-media-transfer) — 流 4 和 5 的并行处理
- [USB 本地通知](./diagrams.md#diagram-usb-local-notify) — 流 7 的端到端
- [审批事件](./diagrams.md#diagram-exec-approval) — 流 6 的状态机

---

## 交叉关切

**Presence（在线状态）**：不单独成流，由 SDK 内部处理。App 会收到 `_discover` 事件（通过 NATS presence），Lucy 插件无需显式处理。

**重新连接**：若 NATS 连接丢失，SDK 自动重连并重新订阅。插件无需手动干预。

**错误处理**：每条流的故障都会发送事件给 App（例如 `inbound.error`、`config.error` 等），App 端可根据事件类型决定重试或展示错误提示。

详见[第 8 章 - 排障指南](../08-operations/debugging.md)。
