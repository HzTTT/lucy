<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# 机器事件字典

## 概述

Lucy 通过机器事件向 App 报告系统状态与执行进度。所有事件以 JSON 格式通过 NATS JetStream 主题 `cephalon.im.user.<user_id>` 发送。本章列出所有事件类型及其字段。

事件发送函数：`publishLucyMachineEvent()`（`src/send.ts:62`）

事件构造函数：`buildLucyMachineEvent()`（`src/send.ts:34`）

---

## 事件基础结构

所有机器事件都包含以下必填字段（zod schema：`LucyMachineEvent`，`src/types.ts`）：

```typescript
{
  version: 2,                      // 事件格式版本
  eventId: string,                 // 19 位雪花 ID，唯一标识事件
  type: LucyMachineEventType,      // 事件类型枚举
  timestamp: number,               // 发送时间（ms）
  channelUserKey: string,          // 用户密钥（cuk）
  channelDeviceId: string,         // 设备 ID（cdi）
  
  // 可选关联字段
  sourceMessageId?: string,        // 关联的入站消息 ID
  runId?: string,                  // 执行 run ID
  sessionKey?: string,             // 会话标识
  
  // 类型特定字段（下列各事件详述）
  // ...
}
```

---

## 入站信号

### inbound.accepted

**含义：** 入站消息通过 schema 校验并被接受。

**发送时机：** 在消息投递给 OpenClaw runtime 之前。

**字段：**

```typescript
{
  type: "inbound.accepted",
  sourceMessageId: string,  // 对应的入站消息 ID
  // 无其他类型特定字段
}
```

**消费方：** App 用于确认消息已被服务端接收。

**代码位置：** `src/gateway.ts`（搜索 inbound.accepted）

---

## 助手事件（Assistant）

这组事件追踪模型执行的完整生命周期。

### assistant.start

**含义：** 模型开始生成回复。

**字段：**

```typescript
{
  type: "assistant.start",
  sourceMessageId: string,    // 关联的用户消息 ID
  runId?: string,             // 执行 ID
  // 无其他字段
}
```

**消费方：** App 显示"助手正在回复"加载提示。

### assistant.partial

**含义：** 模型产生部分文本（流式 token）。

**字段：**

```typescript
{
  type: "assistant.partial",
  sourceMessageId: string,
  runId?: string,
  text: string,              // 此次 chunk 的文本内容
  toolName?: string,         // 如果是工具调用的中间结果，工具名
  metadata?: Record<string, unknown>  // 工具特定元数据
}
```

**消费方：** App 逐步追加文本到气泡中，形成打字效果。

### assistant.final

**含义：** 模型回复完成（包含流式完成与非流式响应）。

**字段：**

```typescript
{
  type: "assistant.final",
  sourceMessageId: string,
  runId?: string,
  text?: string,             // 完整回复文本（可能为空如纯媒体）
  media?: LucyMediaDescriptor,    // 生成的单个媒体（如图片）
  attachments?: LucyMediaDescriptor[],  // 多个附件
  toolName?: string,
  metadata?: Record<string, unknown>,
  
  // 审批相关（若为审批确认消息）
  approvalId?: string,
  approvalSlug?: string,
  approvalCommand?: string,
  approvalCwd?: string,
  approvalHost?: string,
  approvalExpiresAtMs?: number,
  approvalAllowedDecisions?: string[]
}
```

**消费方：** App 渲染最终气泡，如包含媒体则从 Object Store 下载。

---

## 配置 & 重启事件

### config.updated

**含义：** 模型配置已更新（通常由模型下发触发）。

**字段：**

```typescript
{
  type: "config.updated",
  text?: string,             // 确认文案，例如 "模型已更新为 kimi-k2.5"
  metadata?: {
    providerId?: string,
    modelId?: string,
    baseUrl?: string
  }
}
```

**消费方：** App 可选地显示确认提示。

**代码位置：** `src/provider-provisioning.ts`（搜索 config.updated）

### config.error

**含义：** 配置更新失败。

**字段：**

```typescript
{
  type: "config.error",
  text: string,              // 错误说明，例如 "unsupported provider: xyz"
  metadata?: {
    errorCode?: string,
    reason?: string
  }
}
```

**消费方：** App 显示错误提示。

### restart.scheduled

**含义：** 网关重启已排期。

**字段：**

```typescript
{
  type: "restart.scheduled",
  text?: string,             // 例如 "网关即将重启以应用新配置"
  metadata?: {
    ticketId?: string,
    estimatedDelayMs?: number
  }
}
```

**消费方：** App 可显示重启倒计时提示。

**代码位置：** `src/provider-provisioning.ts:369`

### restart.completed

**含义：** 网关重启后成功重新连接，配置已生效。

**字段：**

```typescript
{
  type: "restart.completed",
  text?: string,             // 例如 "网关已重启，新配置已生效"
  metadata?: {
    ticketId?: string,
    modelId?: string,
    providerId?: string,
    reconnectDurationMs?: number
  }
}
```

**消费方：** App 清除重启提示，确认新配置已激活。

**代码位置：** `src/provider-provisioning.ts:405` 调用 `publishLucyRestartCompletionIfPending()`

---

## USB 本地通知事件

这组事件由本地 HTTP 端点 `/usb-events` 接收，用于系统级提示（不经过 OpenClaw runtime）。

### usb.inserted

**含义：** USB 设备已插入。

**字段：**

```typescript
{
  type: "assistant.final",  // 使用 assistant.final 类型
  text: "U盘已插入<extra_data from input>",
  metadata?: Record<string, unknown>
}
```

**映射代码：** `code: 1` → `buildLucyLocalNotifyText()`（`src/local-notify.ts:174`）

### usb.syncing

**含义：** USB 设备同步中。

**映射代码：** `code: 2`

### usb.synced

**含义：** USB 设备同步完成。

**映射代码：** `code: 3`

### usb.failed

**含义：** USB 设备同步失败。

**映射代码：** `code: 4`

### usb.removed

**含义：** USB 设备已拔出。

**映射代码：** `code: 5`

**接收端点：** `POST /usb-events`（`src/local-notify.ts:174`）

**请求 schema：** `LucyLocalNotifyPayloadSchema`（`src/types.ts:45-50`）

---

## 审批事件

详见 [执行审批](./exec-approvals.md#approval-events)。

### approval.pending

**含义：** 有待审批的高危命令。

**字段：**

```typescript
{
  type: "approval.pending",
  approvalId: string,           // 审批唯一 ID
  approvalSlug: string,         // approvalId 的前 8 位，用于 /approve 命令
  approvalCommand: string,      // 清理后的命令行（去掉控制字符）
  approvalHost: string,         // 执行主机名
  approvalCwd?: string,         // 工作目录
  approvalExpiresAtMs: number,  // 过期时间戳
  approvalAllowedDecisions: string[]  // 例如 ["allow-once", "allow-always", "deny"]
}
```

**消费方：** App 弹出审批气泡，用户选择决定。

### approval.resolved

**含义：** 审批已解决（用户选择或超时）。

**字段：**

```typescript
{
  type: "approval.resolved",
  approvalId: string,
  approvalDecision: string,     // "allow-once" | "allow-always" | "deny" | "timeout"
  approvalResolvedBy?: string   // 解决者（用户 ID 或 "timeout"）
}
```

**消费方：** App 标记审批气泡为已处理。

---

## 错误事件

### error

**含义：** 通用错误（例如 schema 校验失败）。

**字段：**

```typescript
{
  type: "error",
  text: string,               // 错误说明
  sourceMessageId?: string,   // 关联的入站消息 ID
  metadata?: {
    errorCode?: string,
    issues?: string[]         // zod 校验错误列表
  }
}
```

**消费方：** App 显示错误气泡。

---

## 事件类型枚举

完整类型定义（`src/types.ts`）：

```typescript
export type LucyMachineEventType =
  | "inbound.accepted"
  | "assistant.start"
  | "assistant.partial"
  | "assistant.final"
  | "error"
  | "config.updated"
  | "config.error"
  | "restart.scheduled"
  | "restart.completed"
  | "approval.pending"
  | "approval.resolved"
  | "usb.inserted"
  | "usb.syncing"
  | "usb.synced"
  | "usb.failed"
  | "usb.removed";
```

---

## 媒体描述符结构

在 `assistant.final` 和其他类型中使用的媒体字段采用以下结构：

```typescript
{
  transport: "iroh-blob",           // 媒体传输方式（固定值）
  blob_ref: string,                 // 对象存储引用 ID
  kind: "image" | "audio" | "video" | "document",
  contentType?: string,             // MIME 类型
  size: number,                     // 字节数
  fileName?: string                 // 建议的文件名
}
```

**获取媒体：** App 使用 `blob_ref` 通过 `downloadLucyMediaDescriptor()` 或等效接口从 Object Store 下载。

---

## 事件序列化与传输

所有事件通过 `serializeLucyMachineEventJson()`（`src/nats.ts`）序列化为 JSON：

```typescript
const json = serializeLucyMachineEventJson(event);
await session.publishChannel(buildNpcPublishSubject(userId), json);
```

App 订阅 `cephalon.im.user.<user_id>` 主题并解析 JSON 以获得类型化事件。

---

## 相关文档

- [入站消息管道](./inbound-pipeline.md) — assistant.* 事件的生成流程
- [执行审批](./exec-approvals.md) — 审批事件详解
- [USB 本地通知](../01-overview/diagrams.md#diagram-usb-local-notify) — 本地通知流程图
