<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# 自动重启与恢复

## 概述

模型下发后，Lucy 需要重启 OpenClaw 网关以使新配置生效。本章详解重启的机制、可配置选项、故障信号与恢复流程。

相关代码：`src/restart-ticket.ts`（重启票据管理）、`src/provider-provisioning.ts`（下发与重启触发）

---

## 重启工作流

### 三个阶段

1. **Provisioning（下发）** —— App 发送模型配置，Lucy 应用到 config 并写入重启票据
2. **Restart（重启）** —— Lucy 触发网关重启命令
3. **Verification（验证）** —— 新网关启动后读取票据，发送 `restart.completed` 事件确认

---

## 重启票据（Restart Ticket）

### 文件位置

```
<homeDir>/restart-ticket.json
```

其中 `<homeDir>` 是 Lucy 的身份存储目录，默认为：

```
/var/lib/lucy/identity/
```

### 票据结构

```typescript
{
  ticketId: string;           // 19 位雪花 ID，票据唯一标识
  modelId: string;            // 例如 "kimi-k2.5"
  providerId: string;         // 例如 "cephalon"
  timestamp: number;          // 票据创建时间戳（ms）
}
```

### 票据操作函数

#### writeLucyRestartTicket()

位置：`src/restart-ticket.ts:40`

**签名：**

```typescript
export async function writeLucyRestartTicket(params?: {
  homeDir?: string;
  ticketId?: string;
  modelId?: string;
  providerId?: string;
  timestamp?: number;
}): Promise<void>
```

**作用：** 将重启票据写入磁盘。如果票据已存在，覆盖之。

**代码示例：**

```typescript
await writeLucyRestartTicket({
  homeDir: account.homeDir,
  ticketId: getProcessSnowflakeGenerator().nextId(),
  modelId: "kimi-k2.5",
  providerId: "cephalon",
  timestamp: Date.now()
});
```

#### readLucyRestartTicket()

位置：`src/restart-ticket.ts:24`

**签名：**

```typescript
export async function readLucyRestartTicket(params?: {
  homeDir?: string;
}): Promise<LucyRestartTicket | null>
```

**作用：** 从磁盘读取重启票据。如果不存在返回 `null`。

#### clearLucyRestartTicket()

位置：`src/restart-ticket.ts`（搜索该函数）

**作用：** 删除重启票据。用于验证完成后清理。

---

## 重启触发

### 默认重启命令

```bash
openclaw gateway restart
```

该命令由 OpenClaw CLI 提供，会：

1. 终止现有网关进程
2. 启动新的网关进程
3. 新进程重新加载配置文件

### 自定义重启命令

通过以下配置键覆盖默认命令：

| 配置键 | 类型 | 说明 | 默认值 |
|--------|------|------|--------|
| `channels.lucy.restartHelperCommand` | string | 重启命令名 | `"openclaw"` |
| `channels.lucy.restartHelperArgs` | string[] | 命令参数 | `["gateway", "restart"]` |

**配置示例（YAML）：**

```yaml
channels:
  lucy:
    restartHelperCommand: "bash"
    restartHelperArgs:
      - "-c"
      - "sleep 1 && pkill -f openclaw-gateway && sleep 2 && openclaw gateway run"
```

**配置示例（JSON）：**

```json
{
  "channels": {
    "lucy": {
      "restartHelperCommand": "sudo",
      "restartHelperArgs": ["systemctl", "restart", "openclaw-gateway"]
    }
  }
}
```

### 命令执行

使用 `runCommandWithTimeout()`（OpenClaw plugin SDK）异步执行：

```typescript
runCommandWithTimeout({
  command: restartHelperCommand,
  args: restartHelperArgs,
  timeoutMs: 10000,
  background: true
});
```

**特点：**

- **Fire-and-forget** —— 不等待命令完成，立即返回
- **超时保护** —— 如果命令 10 秒未完成，强制终止
- **后台执行** —— 不阻塞当前 handler

位置：`src/provider-provisioning.ts:387`

---

## 重启后的验证

### 新网关启动

当新网关进程启动时，会再次执行 `startLucyGateway()`，其中：

```typescript
const ticket = await readLucyRestartTicket({ homeDir: account.homeDir });
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

位置：`src/provider-provisioning.ts:405`

### publishLucyRestartCompletionIfPending()

位置：`src/restart-ticket.ts`（搜索该函数）

**作用：** 读取票据并发送 `restart.completed` 事件，然后清除票据。

**发送的事件：**

```typescript
{
  type: "restart.completed",
  text: "网关已重启，新配置已生效",
  metadata: {
    ticketId: string,
    modelId: string,
    providerId: string,
    reconnectDurationMs: number  // 从票据时间戳到现在的毫秒数
  }
}
```

**流程：**

1. 检查票据存在性
2. 发布 `restart.completed` 事件
3. 删除票据文件
4. 完成

---

## 超时与恢复

### restartOnlineTimeoutMs

配置键：`channels.lucy.restartOnlineTimeoutMs`

**说明：** 网关重启后，Lucy 等待 NATS 连接恢复的最长时间（毫秒）。

**默认值：** 30000（30 秒）

**超时处理：**

如果超时内 NATS 连接未恢复，Lucy 会：

1. 停止等待，返回错误
2. 不发送 `restart.completed` 事件（避免误导 App）
3. 重启票据保留在磁盘（下次启动重试）

**配置示例：**

```yaml
channels:
  lucy:
    restartOnlineTimeoutMs: 60000  # 等待 60 秒
```

### 网关崩溃恢复

如果网关在重启过程中崩溃：

1. 外部监控（例如 systemd）检测到进程异常
2. 外部监控重新启动网关（或由人工启动）
3. 新网关进程读取磁盘上的重启票据
4. 发送 `restart.completed` 事件

**重要：** 不要在代码中主动清除票据，除非 `restart.completed` 已发送。

---

## 故障信号与排查

### 信号 1：auto-restart attempt N/10

**含义：** 网关启动失败，OpenClaw 框架在尝试自动重启。

**原因：** Lucy 的 `startLucyGateway()` 返回或抛异常太早（未阻塞到 `abortSignal`）。

**排查步骤：**

1. 查看网关日志：`openclaw gateway logs --tail=100`
2. 寻找 Lucy 初始化的错误（例如 NATS 连接失败）
3. 检查网络连接：`nc -zv nats-server 4222`
4. 验证配置文件：`cat ~/.openclaw/config.json | jq .channels.lucy`

### 信号 2：configured, works, stopped

**含义：** 框架接受了配置，但 Lucy 监听器不保持活跃。

**原因：** NATS 连接断开但未重新连接，或订阅循环提前退出。

**排查步骤：**

1. 检查 NATS 连接：`openclaw channels status --probe`
2. 查看日志：`openclaw gateway logs --tail=100 | grep -i nats`
3. 验证 JetStream 订阅：使用 NATS CLI 手动订阅主题，检查消息是否到达

### 信号 3：restart.completed 未到达 App

**原因：**

1. 网关重启未完成（等待超时）
2. NATS 连接未恢复
3. 票据已被清除（重复启动）

**排查步骤：**

1. 检查重启票据是否存在：`cat /var/lib/lucy/identity/restart-ticket.json`
2. 检查网关日志中的 NATS 连接日志
3. 手动发送测试消息验证 NATS 连接：`openclaw lucy demo-chat --text "test"`

### 信号 4：重启循环（无限重启）

**原因：** 新配置有效性问题（例如 API Key 错误），导致网关无法正常启动，外部监控反复重启。

**排查步骤：**

1. 手动验证 API Key：`curl -H "Authorization: Bearer <apiKey>" https://<baseUrl>/v1/models`
2. 检查 config 文件：`cat ~/.openclaw/config.json | jq .models.providers.cephalon`
3. 临时禁用自动重启，手动启动网关以查看详细错误：`OPENCLAW_CONFIG_DIR=... openclaw gateway run --verbose`

---

## 可配置项参考

| 配置键 | 类型 | 说明 | 默认值 |
|--------|------|------|--------|
| `channels.lucy.restartHelperCommand` | string | 重启命令 | `"openclaw"` |
| `channels.lucy.restartHelperArgs` | string[] | 重启参数 | `["gateway", "restart"]` |
| `channels.lucy.restartOnlineTimeoutMs` | number | NATS 连接等待超时（ms） | 30000 |

定义位置：`src/types.ts:52-70`（LucyConfigSchema）

---

## 最佳实践

### 1. 幂等性

重启命令应该是幂等的：多次执行产生相同结果，不会导致数据丢失或重复初始化。

**推荐：** 使用官方的 `openclaw gateway restart` 命令。

**避免：** 自定义 shell 脚本中包含状态检查（例如 `if [ process running ]`）。

### 2. 等待时间

设置足够的 `restartOnlineTimeoutMs`（建议 >= 30 秒），确保网关有时间：

1. 终止旧进程
2. 重新初始化网络栈
3. 连接 NATS 并拉取消息

**对于高延迟网络：** 增加到 60000（60 秒）。

### 3. 日志监控

在生产环境中，定期检查网关日志中的重启记录：

```bash
openclaw gateway logs --tail=1000 | grep -E "restart|ticket"
```

### 4. App 侧处理

App 应该：

1. 监听 `restart.scheduled` 事件，显示加载提示（不要立即关闭 UI）
2. 监听 `restart.completed` 事件，验证新配置是否生效
3. 如果超时（例如 60 秒未收到 `restart.completed`），显示错误提示，允许用户手动重试

---

## 相关文档

- [模型下发主流程](./provision-flow.md) — 重启的触发点
- [入站消息管道](../04-messaging/inbound-pipeline.md) — restart.* 事件的发送
- [机器事件字典](../04-messaging/machine-events.md) — restart.scheduled / restart.completed 字段
