<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# Presence 与在线状态

**重要声明**：Lucy 插件代码库中**不存在** `presence.ts` 或任何显式的 presence 管理模块。Presence 功能（在线状态、心跳、在线/离线通知）由 **lucy-im-sdk-nodejs** 内部完全管理。本章说明 presence 的外部可观察行为，以及为什么插件不需要干预。

## SDK 内部的 Presence 实现

lucy-im-sdk-nodejs 在 `LucyImClient.connect()` 成功后自动启动 presence：

```typescript
// lucy-im-sdk-nodejs/src/natsConn.ts（伪代码）

async function initializePresence(natsConnection) {
  // 1. 订阅 _discover 主题（Presence 信号）
  const discoverSub = natsConnection.subscribe("_discover.>");
  
  // 2. 定期发送心跳（每 30 秒）
  setInterval(() => {
    const status = {
      client_id: cdi,
      user_id: userId,
      timestamp: Date.now(),
      status: 'online'
    };
    natsConnection.publish("_discover.report", JSON.stringify(status));
  }, 30000);
  
  // 3. 监听 ping 并回复
  natsConnection.subscribe("_discover.ping", msg => {
    natsConnection.publish(msg.reply, JSON.stringify({
      client_id: cdi,
      pong: true
    }));
  });
  
  // 4. 处理 _discover 离线事件（连接丢失时 NATS 自动发送）
  discoverSub.on('message', msg => {
    const event = JSON.parse(msg.data);
    if (event.status === 'offline') {
      // 其他设备或 App 会收到此用户离线通知
      eventEmitter.emit('user.offline', { userId: event.user_id });
    }
  });
  
  // 5. 连接断开时自动清理（NATS 发送 $SYS.ACCOUNT.> 信号）
  // presence-bridge（npc-im-server）监听并转成 _discover 事件
}
```

**关键特性**：
- **自动**：连接建立后立即启动，无需插件介入
- **持续**：整个连接生命周期保持活动
- **故障恢复**：连接断开时自动停止，重连后自动恢复

## 外部可观察行为

虽然插件不管理 presence，但应该了解它的外部表现：

### 1. 在线状态（Online Status）

App 或其他客户端可通过查询 NATS `_discover` 主题判断设备是否在线：

```
_discover.status -> { "client_id": "device-xyz", "status": "online", "timestamp": 1713307200000 }
_discover.status -> { "client_id": "device-xyz", "status": "offline", "timestamp": 1713307300000 }
```

Lucy 插件只需确保 NATS 连接保活；presence 事件由 SDK 自动生成。

### 2. 心跳（Heartbeat）

SDK 每 30 秒发送一个心跳。如果 App 未收到心跳，会标记设备为"离线"。

**心跳丢失的原因**：
- NATS 连接中断（网络问题）
- Lucy gateway 崩溃或被杀
- gateway 进程卡住（阻塞在某个同步操作）

**Lucy 侧的防范**：
- 使用 `startLucyGateway()` 的 `ctx.signal` 监听 abort 信号
- 若收到 signal，立即关闭 SDK 连接，允许 presence 清理
- 避免长时间阻塞（例如大文件上传不应该阻塞消息循环）

### 3. Ping / Pong（Keep-Alive）

若 App 需要快速检查设备是否真的在线，可发送 ping：

```
_discover.ping -> { "client_id": "device-xyz" }
device-xyz -> _discover.pong (via reply subject)
```

Lucy 的 SDK 自动回复 pong。插件无需处理。

## NATS 后端的 Presence 基础设施

Lucy 依赖的 NATS 后端（npc-im-server）提供了额外的 presence 支持：

### presence-bridge（npc-im-server）

这是一个守护进程，监听：

1. **应用上报**：SDK 发送的 `_discover.report` 信号
2. **系统事件**：`$SYS.ACCOUNT.>` 中的连接断开事件

它将这两种信号聚合为统一的在线/离线事件，供 App 订阅。

### auth-callout（npc-im-server）

验证 NATS token 时，同时返回该设备的当前在线状态（可选）。

---

## 为什么插件不需要 presence.ts

### 设计原则

**关注点分离**：
- **SDK 的职责**：连接、认证、presence 生命周期
- **插件的职责**：消息处理、运行时集成、媒体传输

presence 属于连接层，与消息内容无关。插件在 `startLucyGateway()` 中传入 `signal` 参数后，SDK 会在 signal 触发时自动清理 presence。

### 历史背景

早期的 Lucy 实现（doc/AGENTS.md 中提到的虚构文件）曾有显式的 `presence.ts` 模块。后来迁移到 SDK 时，这个模块被吸收进 SDK 内部，以减少插件的复杂度。

### 验证方法

```bash
# 查看 src/ 目录，确认不存在 presence.ts
ls -la extensions/lucy/src/ | grep -i presence
# 输出：（无）

# 查看 SDK 中的 presence 实现
ls -la extensions/lucy/lucy-im-sdk/src/ | grep -i presence
# 输出：natsConn.ts（包含 presence 逻辑）
```

---

## 故障诊断

### 问题：App 显示设备离线，但 Lucy 的网络看起来正常

**检查清单**：
1. 查看 gateway 日志中是否有 NATS 连接错误：
   ```bash
   tail -f ~/.openclaw/logs/gateway.log | grep -i "nats\|presence\|offline"
   ```

2. 检查 NATS 连接是否活跃：
   ```bash
   nats server info | grep connections
   ```

3. 检查 presence-bridge 是否在线：
   ```bash
   nats sub "_discover.>" &  # 订阅，观察消息流量
   ```

4. 若无消息流，检查 SDK 是否正确初始化：
   ```bash
   # 查看 SDK 日志（若有）
   cat ~/.openclaw/logs/sdk.log | grep -i presence
   ```

### 问题：设备频繁显示离线又在线

**根因**：NATS 连接不稳定或网络抖动。

**检查清单**：
1. 网络延迟：`ping nats-server`
2. 防火墙：WebSocket 端口（通常 443 或 9222）
3. NATS 服务器负载：`nats server report`
4. Lucy gateway 日志中的重连次数

---

## Presence 状态机

```
未连接
  ↓
SDK.connect() 成功
  ↓
启动心跳循环（每 30 秒）
启动 _discover 监听
启动 ping handler
  ↓
[在线状态：持续发送心跳]
  ↓
网络中断 / gateway 停止
  ↓
心跳停止，其他客户端无法 ping 通
  ↓
NATS 服务端检测到连接丢失，发 $SYS 事件
  ↓
presence-bridge 转成 _discover offline 事件
  ↓
[离线状态：App 接收通知]
  ↓
gateway 重启或连接恢复
  ↓
SDK.connect() 重新建立
  ↓
回到"在线状态"
```

---

## 与其他章节的关系

- **NATS 主题**：详见[NATS 主题](./nats-subjects.md)（_discover 是特殊主题）
- **系统架构**：详见[第 1 章 - 架构](../01-overview/architecture.md)（SDK 部分）
- **故障排查**：详见[第 8 章 - 排障指南](../08-operations/debugging.md)

---

## 总结

Lucy 的 presence 功能由 lucy-im-sdk-nodejs 完全管理。插件不需要（也不应该）创建或维护 presence.ts 模块。插件的职责仅限于：

1. 调用 SDK 的 `connect()` 方法
2. 传入 `signal` 参数以支持优雅关闭
3. 让 SDK 在连接生命周期内自动处理 presence

App 通过 NATS _discover 主题观察 presence 变化，不依赖插件的主动通知。
