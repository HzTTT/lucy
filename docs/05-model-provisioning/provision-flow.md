<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# 模型下发主流程

## 概述

Lucy 通过 App 下发的 `version=3 / kind=provision_model` 消息完成模型配置的整个生命周期：获取凭证、应用配置、触发重启、验证生效。本章详解每一步的机制与关键决策点。

完整流程图参见 [模型供应与自动重启](../01-overview/diagrams.md#diagram-provisioning-restart)。

---

## 前置条件

### 1. App 侧获取模型配置

App 首先从 user-center 获取当前用户的可用模型列表与凭证：

```
GET /v1/channels/lucy/current-user/model-config
```

**返回示例：**

```json
{
  "providerId": "cephalon",
  "modelId": "kimi-k2.5",
  "apiKey": "sk-...",
  "baseUrl": "https://api.cephalon.ai",
  "supportsStreaming": true,
  "supportsVision": true
}
```

**重要：** 凭证来自 user-center，不由 Lucy 生成。Lucy 只负责应用这些凭证到本地 config。

### 2. App 构造 Provision Message

App 基于上述信息构造入站消息：

```json
{
  "version": 3,
  "kind": "provision_model",
  "channelUserKey": "<cuk>",
  "channelDeviceId": "<cdi>",
  "provision": {
    "providerId": "cephalon",
    "modelId": "kimi-k2.5",
    "apiKey": "sk-...",
    "baseUrl": "https://api.cephalon.ai",
    "switchDefaultModel": true,
    "restartRequested": true
  }
}
```

### 3. App 发布到 NATS

App 发布到以下主题（由 App 负责）：

```
cephalon.im.user.<user_id>
```

Lucy 不参与这个发布步骤；Lucy 通过 JetStream Pull Consumer 订阅的是 `cephalon.im.npc.<user_id>.<cdi>`，App 的消息最终由 App 侧的其他逻辑转发。

---

## Lucy 侧处理流程

### 步骤 1：入站消息接收与解析

Lucy 的网关通过 `handleLucyInboundMessage()`（`src/gateway.ts:268`）接收并解析消息。

**Schema 验证：** 消息必须通过 `LucyInboundMessageV3Schema`（`src/types.ts:126-150`）验证。

**分类判断：**

```typescript
if (parsedInbound.kind === "provision_model") {
  // 转交给 handleLucyProvisioningMessage()
} else {
  // 普通聊天消息，交给 OpenClaw runtime
}
```

位置：`src/gateway.ts:300`

### 步骤 2：模型下发处理

调用 `handleLucyProvisioningMessage()`（`src/provider-provisioning.ts:305`）。

**函数签名：**

```typescript
export async function handleLucyProvisioningMessage(params: {
  cfg: OpenClawConfig;
  account: ResolvedLucyAccount;
  provision: LucyProvisioningPayload;
  session: ConnectedClient;
  userId: string;
  cuk: string;
  cdi: string;
}): Promise<void>
```

### 步骤 3：Provider ID 验证

```typescript
if (provision.providerId !== "cephalon") {
  await publishLucyMachineEvent({
    type: "config.error",
    text: `unsupported provider: ${provision.providerId}`
  });
  return;
}
```

位置：`src/provider-provisioning.ts:320`

**备注：** 当前只支持 `cephalon`。如果 App 尝试下发其他 provider（例如 OpenAI），会收到 `config.error` 事件。

### 步骤 4：应用配置

调用 `applyLucyProvisioningConfig()`（`src/provider-provisioning.ts:220`）：

```typescript
const updated = await applyLucyProvisioningConfig({
  cfg,
  provision,
});
```

**内部操作：**

1. **写入 Provider 配置**

   ```typescript
   cfg.models.providers.cephalon = {
     model: provision.modelId,    // "kimi-k2.5"
     apiKey: provision.apiKey,
     baseUrl: provision.baseUrl
   };
   ```

2. **切换默认模型**

   如果 `switchDefaultModel` 为 true（默认）：

   ```typescript
   cfg.agents.defaults.model.primary = `cephalon/${provision.modelId}`;
   ```

3. **自动调整 Multimodal RAG 配置**（如果启用）

   如果 `plugins.entries.multimodal-rag` 存在：

   ```typescript
   if (provision.baseUrl) {
     cfg.ollama.baseUrl = provision.baseUrl;  // Embedding
     cfg.whisper.zhipuApiBaseUrl = provision.baseUrl;  // 语音识别
   }
   ```

   **作用：** 使 RAG 插件与 Cephalon provider 使用同一服务端点，避免网络隔离。

4. **持久化配置**

   ```typescript
   await api.config.write(updated);
   ```

位置：`src/provider-provisioning.ts:220-280`

### 步骤 5：发送 config.updated 事件

```typescript
await publishLucyMachineEvent({
  session,
  userId,
  cuk,
  cdi,
  type: "config.updated",
  text: `模型已更新为 ${provision.modelId}`,
  metadata: {
    providerId: "cephalon",
    modelId: provision.modelId
  }
});
```

位置：`src/provider-provisioning.ts:365`

**App 消费：** 可选地显示配置已更新的提示。

---

## 重启流程

### 步骤 6：落盘重启票据

如果 `restartRequested !== false`（默认为 true），Lucy 写入重启票据：

```typescript
await writeLucyRestartTicket({
  homeDir: params.account.homeDir,
  ticketId: getProcessSnowflakeGenerator().nextId(),
  modelId: provision.modelId,
  providerId: "cephalon",
  timestamp: Date.now()
});
```

位置：`src/provider-provisioning.ts:375`

**票据文件位置：**

```
<homeDir>/restart-ticket.json
```

**票据内容示例：**

```json
{
  "ticketId": "1234567890123456789",
  "modelId": "kimi-k2.5",
  "providerId": "cephalon",
  "timestamp": 1713254400000
}
```

### 步骤 7：发送 restart.scheduled 事件

```typescript
await publishLucyMachineEvent({
  type: "restart.scheduled",
  text: "网关即将重启以应用新配置",
  metadata: {
    ticketId: ticketId,
    estimatedDelayMs: 2000
  }
});
```

位置：`src/provider-provisioning.ts:369`

### 步骤 8：触发网关重启

使用 `runCommandWithTimeout()`（来自 OpenClaw plugin SDK）异步执行重启命令：

```typescript
runCommandWithTimeout({
  command: restartHelperCommand,
  args: restartHelperArgs,
  timeoutMs: 10000,
  background: true  // fire-and-forget
});
```

**默认命令：** `openclaw gateway restart`

**可配置项：**

| 配置键 | 说明 | 默认值 |
|--------|------|--------|
| `channels.lucy.restartHelperCommand` | 重启命令 | `"openclaw"` |
| `channels.lucy.restartHelperArgs` | 重启命令参数 | `["gateway", "restart"]` |

**执行流程：** 命令以 fire-and-forget 方式执行，不阻塞当前 handler。网关进程会被新进程替代。

位置：`src/provider-provisioning.ts:387`

---

## 重启后的验证

### 步骤 9：新网关进程启动

新的 `startLucyGateway()` 实例启动（在 `channel.start()` 被再次调用时）。

该实例重新执行以下流程：

1. `syncLucyBindingWithSdk()` —— 恢复身份
2. `connectLucySdk()` —— 重新连接 NATS

### 步骤 10：读取重启票据

在 NATS 连接成功后，立即检查重启票据：

```typescript
const ticket = await readLucyRestartTicket({
  homeDir: params.account.homeDir
});

if (ticket) {
  await publishLucyRestartCompletionIfPending({
    session,
    userId,
    cuk,
    cdi,
    ticket
  });
}
```

位置：`src/provider-provisioning.ts:405`（搜索 publishLucyRestartCompletionIfPending）

### 步骤 11：发送 restart.completed 事件

```typescript
await publishLucyMachineEvent({
  type: "restart.completed",
  text: "网关已重启，新配置已生效",
  metadata: {
    ticketId: ticket.ticketId,
    modelId: ticket.modelId,
    providerId: "cephalon",
    reconnectDurationMs: Date.now() - ticket.timestamp
  }
});
```

### 步骤 12：清除重启票据

```typescript
await clearLucyRestartTicket({
  homeDir: params.account.homeDir
});
```

**作用：** 避免每次启动都重复发送 restart.completed 事件。

---

## 特殊情况处理

### restartRequested = false

如果 App 设置 `restartRequested: false`，Lucy 跳过重启步骤：

```typescript
if (provision.restartRequested === false) {
  // 发送 config.updated，但不进入重启流程
  return;
}
```

**应用场景：** 模型参数的微调（例如温度、top-p），无需重启网关即可生效。

### 多次快速下发

如果 App 在前一个重启完成前再次下发新配置：

1. 新的 provision message 覆盖前一个票据
2. 旧票据被新票据替代
3. 只有最后一个票据会被读取和清除

---

## 故障恢复

### 重启失败或网关崩溃

如果网关在重启过程中崩溃：

1. 重启票据保留在磁盘
2. 重启后的网关进程再次读取并处理该票据
3 App 会最终收到 `restart.completed` 事件（可能延迟）

### 配置文件损坏

如果 OpenClaw config 文件在写入时损坏：

- `applyLucyProvisioningConfig()` 会抛异常
- Handler 捕获异常并发送 `config.error` 事件
- 重启票据不被写入，避免重启一个不可用的配置

---

## 监控与日志

### 关键日志行

```
[lucy] apply provisioning: providerId=cephalon modelId=kimi-k2.5
[lucy] restart ticket written: ticketId=123... timestamp=...
[lucy] gateway restart triggered via command: openclaw gateway restart
[lucy] restart ticket read: modelId=kimi-k2.5
[lucy] restart completed event published
```

### 监控指标

建议在 App 侧监控以下指标：

- `provision_success_count` — 成功的配置下发次数
- `provision_error_count` — 失败的配置下发次数
- `restart_duration_ms` — 从 `restart.scheduled` 到 `restart.completed` 的时间

---

## 相关文档

- [Cephalon Provider](./cephalon-provider.md) — Provider 设计与功能
- [自动重启与恢复](./auto-restart.md) — 重启机制详解
- [配置架构](../01-overview/diagrams.md#diagram-provisioning-restart) — 流程图
