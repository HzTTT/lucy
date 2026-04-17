<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# JetStream Pull Consumer 与入站分发

Lucy 的入站消息处理通过 NATS JetStream Pull Consumer 完成。本章解释 consumer 的生命周期、消息分发、事件流和故障恢复。

## 什么是 JetStream Pull Consumer

NATS JetStream 是一个完全持久化的消息流系统。Consumer 是该系统中的"订阅端"，负责：
1. 从指定的 stream 中拉取消息
2. 确认消息已处理
3. 记录消费进度（offset）
4. 在应用重启后恢复进度

Lucy 使用 Pull Consumer（而非 Push）以获得更好的流控和重试能力。

---

## Consumer 生命周期

### 创建（来自 SDK）

```typescript
// lucy-im-sdk-nodejs/src/natsConn.ts
const consumer = await js.consumers.add(stream, {
  name: "npc-" + cdi,  // 例如：npc-device-20240416-xyz789
  durable_name: "npc-" + cdi,
  stream_name: "IM_NPC",
  filter_subject: buildNpcSubscribeSubject(userId, cdi),
  // 例如：cephalon.im.npc.user-20240101-abc.device-20240416-xyz
  
  // Consumer 配置
  ack_policy: AckPolicy.Explicit,   // 手动确认
  max_ack_pending: 10,               // 最多 10 条未确认消息
  deliver_policy: DeliverPolicy.New, // 仅新消息
  max_waiting: 1024,                 // 最多 1024 个等待请求
  idle_heartbeat: 5000,              // 心跳间隔（毫秒）
  
  // 重试配置
  backoff: [1000, 2000, 5000],      // 退避策略（毫秒）
  max_deliver: 3                     // 最多重试 3 次
});
```

**参数说明**：
- `name` 和 `durable_name`：持久化名称，重启后 offset 保留
- `filter_subject`：精确订阅该设备的入站主题
- `ack_policy: Explicit`：SDK 必须显式调用 `msg.ack()`，否则消息重新入队
- `deliver_policy: New`：只投递连接后的新消息（不重放历史）
- `max_waiting`：等待中的 fetch 请求数上限
- `idle_heartbeat`：若长时间无消息，服务端发心跳保活连接

### 消息投递

```typescript
// SDK 在消息循环中拉取
while (true) {
  const msg = await consumer.next({ timeout: 5000 });
  if (!msg) continue;  // 心跳或超时
  
  // msg 对象包含：
  // - msg.data: Uint8Array（JSON 序列化的消息）
  // - msg.info.sequence: 该 consumer 的消息序号
  // - msg.info.pending: 剩余未确认消息数
  
  // 交给 Lucy 插件处理
  handleLucyInboundMessage(JSON.parse(msg.data));
  
  msg.ack();  // 确认处理完成
}
```

### 销毁

当 SDK 连接关闭时，consumer 的 durable name 保留在服务端。下次 Lucy 重新连接时，同一个 consumer 被恢复，offset 继续。若需要清理：

```bash
nats consumer rm IM_NPC npc-device-xyz
```

---

## 入站消息分发

### 流程（完整时序）

详见[入站消息时序](../01-overview/diagrams.md#diagram-inbound-sequence)。

### 关键步骤

#### 1. 消息到达主题

App 发布消息到 `cephalon.im.user.<user_id>`（这是 App 的发布端）。

但 Lucy **订阅**的是 `cephalon.im.npc.<user_id>.<cdi>`。

两者如何对应？用户/App 的实现约定：
- App 接收 `cdi` 和 `user_id`（通过二维码或 BLE pairing-info）
- App 发布消息时自动将接收方主题改为：
  ```
  cephalon.im.npc.<user_id>.<cdi>
  ```

这样，消息直接到达 Lucy 的 Pull Consumer。

#### 2. Lucy 拉取消息

```typescript
// gateway.ts:630+ startLucyGateway()
const connectedClient = await connectLucySdk(...);
connectedClient.session.subscribeChannel(
  buildNpcSubscribeSubject(userId, cdi),
  handleLucyInboundMessage  // 回调函数
);
```

SDK 内部将 `subscribeChannel` 映射到 JetStream Pull Consumer：

```typescript
// SDK 内部
consumer.next({ timeout: 5000 }).then(msg => {
  if (msg) {
    const event = JSON.parse(msg.data);
    handler(event);  // 调用 handleLucyInboundMessage
    msg.ack();
  }
});
```

#### 3. 校验与解码

```typescript
// gateway.ts:200+ handleLucyInboundMessage()
function handleLucyInboundMessage(event: InboundMessage) {
  // 1. 校验 channel_user_key
  if (event.channel_user_key !== cachedCuk) {
    publishLucyMachineEvent({
      type: 'inbound.rejected',
      text: 'User key mismatch'
    });
    return;  // 不投递给 runtime
  }
  
  // 2. 下载附件
  const attachments = event.attachments
    ? await Promise.all(event.attachments.map(att =>
        downloadLucyMediaDescriptor(att.media_descriptor)
      ))
    : [];
  
  // 3. 发送 inbound.accepted 事件
  await publishLucyMachineEvent({
    type: 'inbound.accepted',
    sourceMessageId: event.messageId
  });
  
  // 4. 投递给 OpenClaw runtime
  await runtime.processMessage({
    text: event.text,
    attachments,
    sourceId: event.messageId
  });
}
```

#### 4. Runtime 回调

OpenClaw runtime 处理消息并产生 events：

```typescript
// runtime 回调（可能多次）
runtime.on('assistant.start', evt => {
  publishLucyMachineEvent({
    type: 'assistant.start',
    sourceMessageId: originalMessageId
  });
});

runtime.on('assistant.partial', evt => {
  publishLucyMachineEvent({
    type: 'assistant.partial',
    text: evt.text,
    sourceMessageId: originalMessageId
  });
});

runtime.on('assistant.final', evt => {
  publishLucyMachineEvent({
    type: 'assistant.final',
    text: evt.text,
    media: evt.attachments,
    sourceMessageId: originalMessageId,
    runId: evt.runId
  });
});
```

#### 5. 出站消息发送

```typescript
// send.ts:62 publishLucyMachineEvent()
async function publishLucyMachineEvent(event: MachineEvent) {
  const serialized = {
    version: 4,
    eventId: generateSnowflakeId(),
    type: event.type,
    timestamp: Date.now(),
    channel_user_key: cachedCuk,
    channel_device_id: cdi,
    ...event
  };
  
  await connectedClient.session.publishChannel(
    buildNpcPublishSubject(userId),
    JSON.stringify(serialized)
  );
}
```

---

## 事件类型速查

| 事件类型 | 发送者 | 何时发送 | App 应如何处理 |
|---------|--------|---------|---------------|
| `inbound.accepted` | gateway.ts | 消息通过校验，开始处理 | 展示 "processing..." |
| `inbound.rejected` | gateway.ts | channel_user_key 不匹配 | 显示错误，可重试 |
| `inbound.error` | gateway.ts | 处理异常（如附件下载失败） | 显示错误提示 |
| `assistant.start` | send.ts | 模型开始推理 | 创建新气泡，显示输入状态 |
| `assistant.partial` | send.ts | 模型输出中间 token | 追加文本，流式渲染 |
| `assistant.final` | send.ts | 模型完成回复 | 标记气泡完成，关闭输入状态 |
| `approval.pending` | exec-approvals-handler.ts | 需要用户批准命令 | 展示审批对话框 |
| `approval.resolved` | exec-approvals-handler.ts | 用户做出选择 | 隐藏对话框，显示结果 |
| `config.updated` | provider-provisioning.ts | 模型配置已应用 | 显示 "Config updated" 提示 |
| `config.error` | provider-provisioning.ts | 配置更新失败 | 显示错误原因 |
| `restart.scheduled` | provider-provisioning.ts | 即将重启 gateway | 显示 "Restarting..." |
| `restart.completed` | provider-provisioning.ts | 重启完成 | 隐藏重启提示 |

---

## 错误处理与重试

### 消息确认失败

若 Lucy 处理消息时异常（例如 runtime 崩溃），SDK 会：

```typescript
try {
  await handler(msg.data);
  msg.ack();  // 成功
} catch (err) {
  // 不调用 ack，消息留在队列
  logger.error('Message processing failed', { err, msgSeq: msg.info.sequence });
  
  // SDK 根据 max_deliver 和 backoff 重试
  // 默认最多 3 次，间隔 1s/2s/5s
}
```

重试流程：
1. 消息留在 consumer 的 pending 列表
2. 等待 backoff 时间
3. SDK 重新拉取，再次调用 handler
4. 若 3 次后仍失败 → 消息进入 **dead-letter queue**（可选配置）

### 连接恢复

若 Lucy 与 NATS 连接中断：

```typescript
// SDK 自动重连
consumer.next()  // 超时或异常
  .catch(err => {
    logger.warn('Consumer disconnected', err);
    // SDK 启动重连循环（指数退避）
    // 重连成功后，offset 保留，消息从中断点继续
  });
```

---

## 性能调优

### 并发处理

Lucy 使用 `max_ack_pending: 10`，意味着最多同时处理 10 条消息。可按以下调整：

- **增加吞吐**：提高 `max_ack_pending`（但会增加内存）
- **降低延迟**：降低 `max_ack_pending`（消息处理更快完成）

### 心跳与超时

- `idle_heartbeat: 5000`：若 5 秒无消息，服务端发心跳
- `timeout: 5000`：客户端等待 5 秒后返回

若消息处理耗时长，应增加超时：

```typescript
// SDK 内部可配置
const msg = await consumer.next({ timeout: 30000 });  // 30 秒
```

---

## 监控

### 检查 Consumer 状态

```bash
nats consumer info IM_NPC npc-device-xyz

# 输出：
# Name: npc-device-xyz
# Stream: IM_NPC
# State:
#   Messages: 150 (总消息数)
#   Bytes: 1.2 MB
#   First Sequence: 1
#   Last Sequence: 150
#   Consumer Sequence: 148 (已处理到 148)
#   Pending: 2 (还有 2 条未确认)
```

### 监听未确认消息

```bash
# 列出所有未确认消息
nats consumer report IM_NPC npc-device-xyz --filter pending

# 若消息长时间未确认，可能是 Lucy 处理卡住
# 检查 gateway 日志
tail -f ~/.openclaw/logs/gateway.log | grep inbound
```

---

## 常见问题

**Q：为什么要用 Pull Consumer 而不是 Push？**
A：Pull 给 Lucy 更好的流控能力。Lucy 可以按自己的速度拉取，而不是被 NATS 推送淹没。

**Q：consumer 的 offset 存在哪里？**
A：NATS 服务端维护，存储在 RocksDB 或其他持久化后端。重启后恢复。

**Q：如果一条消息 10 秒内处理不完呢？**
A：consumer 会在 `idle_heartbeat` 间隔（5 秒）发一个心跳保活。只要应用在处理（未超时），就继续处理。

**Q：如何防止消息丢失？**
A：必须显式调用 `msg.ack()`。若应用崩溃未 ACK，重启后消息重新投递。

---

## 与其他章节的关系

- **主题约定**：详见[NATS 主题](./nats-subjects.md)
- **时序图**：详见[入站消息时序](../01-overview/diagrams.md#diagram-inbound-sequence)
- **SDK 细节**：lucy-im-sdk-nodejs 源码 `src/natsConn.ts`
