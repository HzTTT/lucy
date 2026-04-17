<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# Lucy 插件生命周期

本章解释 OpenClaw 加载 `@hzttt/lucy-ai-npc` 时发生的各个关键阶段。重点是理解"为什么插件启动后必须阻塞直到 abortSignal"——这不是可选的优化，而是框架安全的必要条件。

## 启动序列

### 第一阶段：Plugin Entry 注册（立即）

```
OpenClaw host 加载 @hzttt/lucy-ai-npc
  └─ index.ts 默认导出
      └─ defineLucyChannelPluginEntry()（channel-plugin-entry.ts:28）
```

此时 `defineLucyChannelPluginEntry()` 做三件事：

1. **注册通道**：`api.registerChannel({ plugin: lucyPlugin })`
   - 插件框架会在适当的时刻（通常立即）调用 `lucyPlugin.start(ctx)`
   
2. **注册命令**：`registerLucyCommand(api)`（仅当 `registrationMode=full` 时）
   - 暴露 `openclaw lucy auth-qrcode` / `openclaw lucy reset-state` 命令
   
3. **注册模型供应商**：`api.registerProvider(buildLucyCephalonProvider())`
   - 注册嵌入式 cephalon provider（用于模型配置下发）

**关键点**：这些注册都是同步的，只是告诉 OpenClaw "我有这些能力"，并不启动任何后台任务。

### 第二阶段：通道启动（同步进行）

```
api.registerChannel() 返回后
  └─ OpenClaw 框架调用 lucyPlugin.start(ctx)（channel.ts）
      └─ startLucyGateway(ctx)（gateway.ts:590）
          ├─ syncLucyBindingWithSdk()（auth-binding.ts:14）
          │   ├─ 调用 client.init()（SDK 注册设备 → 获得 cdi）
          │   ├─ 检查本地 ~/.lucy/identity/ 状态
          │   ├─ 若状态为 Bound，跳到第三阶段
          │   └─ 若状态为 PendingBind，回调 onPendingBind() 并轮询
          │
          └─ connectLucySdk()（auth-binding.ts:83）
              └─ 调用 client.connect() → 返回 ConnectedClient
```

**阶段 2.1：初始化**
- SDK `client.init()` 调用 user-center `/v1/devices/new` 注册设备
- 生成 Ed25519 密钥对，保存到 `~/.lucy/identity/bootstrap_token/`
- 返回设备 ID（`cdi`）

**阶段 2.2：检查绑定状态**
- 读 `~/.lucy/identity/channel_ids/` 检查是否已绑定
- 若文件存在 → 设备已 Bound，跳到 2.3
- 若文件不存在或缺失 `cuk` → 设备处于 PendingBind 状态

**阶段 2.2.5：处理待绑定（可选）**
- 如果 `syncLucyBindingWithSdk()` 的 `onPendingBind` 回调被提供，现在调用它
- 回调用来启动 Pairing IPC 客户端（用于 BLE 绑定） 或生成二维码
- 插件本身在 `gateway.ts` 的 `onPendingBind` 回调里：
  1. 调用 SDK 的 `preBind()` 申请 OTP（返回 `{ otp, expires_in }`）
  2. 生成二维码 URI：`lucy://bind?channel_device_id=<cdi>&otp=<otp>`（auth-qrcode.ts:21–30）
  3. 展示 QR 码或通过 IPC 将 OTP 发送给 BLE 设备
- 然后 SDK 继续轮询 `/v1/channels/lucy/devices/device-bindings`（每 2 秒一次）
- 当用户在 App 侧完成绑定后，API 返回 `{ user_id, cuk }`
- SDK 把这些值写入 `~/.lucy/identity/channel_ids/`，状态变为 Bound
- **OTP 不持久化**：OTP 是临时凭证；若过期需重新调用 `preBind()`

**阶段 2.3：NATS 连接**
- SDK `client.connect()` 调用 lucy-server 交换 NATS token（Ed25519 签名）
- 连接 NATS 集群（WebSocket 地址由 token 端点返回）
- 初始化 JetStream Pull Consumer（stream `IM_NPC`、durable `npc-<cdi>`）
- SDK 自动启动 Presence 循环（heartbeat、ping reply、_discover）
- 返回 `ConnectedClient`

### 第三阶段：消息循环与阻塞（直到 abortSignal）

```
ConnectedClient 准备好后
  └─ session.subscribeChannel("cephalon.im.npc.<user_id>.<cdi>", handler)
      └─ 阻塞在 Pull Consumer 上
          ├─ 每收到一条消息 → handleLucyInboundMessage()
          │   └─ 验证 channel_user_key → 交给 OpenClaw runtime
          │
          ├─ 同时监听 OpenClaw runtime 事件
          │   └─ assistant.start / partial / final
          │       └─ publishLucyMachineEvent()
          │           └─ 发往 NATS cephalon.im.user.<user_id>
          │
          ├─ 监听 abortSignal
          │   └─ 若触发，执行清理
          │
          └─ 循环运行，直到 abortSignal 或错误退出
```

**关键守护栏（来自 AGENTS.md）**：
> Account 启动要阻塞到 abortSignal；spawning 一个后台循环且提前返回会触发 OpenClaw 自动重启，导致重复的入站处理。

这意味着：
- `startLucyGateway()` 不能在消息循环启动后立即返回
- 必须 `await` 消息循环的完成或错误
- 清理逻辑（关闭 SDK、停止本地通知服务器）在 abortSignal 触发时执行

### 第四阶段（可选）：模型供应与重启

如果 App 发送 `version=3 / kind=provision_model` 消息（见 types.ts）：

```
handleLucyInboundMessage() 识别 MachineEvent.kind === 'provision_model'
  └─ handleLucyProvisioningMessage()（provider-provisioning.ts:70）
      ├─ 校验供应商 ID（仅支持 cephalon）
      ├─ 写入 models.providers.cephalon.* 配置
      ├─ 写入 agents.defaults.model.primary
      └─ 若 restartRequested !== false
          ├─ writeLucyRestartTicket()（restart-ticket.ts:40）
          ├─ 发送 restart.scheduled 事件给 App
          └─ 触发 openclaw gateway restart（fire-and-forget）
              └─ 新进程启动后
                  ├─ startLucyGateway() 再次执行（第二阶段）
                  ├─ readLucyRestartTicket()（restart-ticket.ts:80）
                  ├─ publishLucyRestartCompletionIfPending()（provider-provisioning.ts:405）
                  ├─ 发送 restart.completed 给 App
                  └─ clearLucyRestartTicket()
```

详见[模型供应与重启机制](../05-model-provisioning/auto-restart.md)（第 5 章）。

## 完整时序图

详见[插件生命周期](./diagrams.md#diagram-plugin-lifecycle)。

## 常见故障

### "configured, works, stopped"

**症状**：`openclaw channels status --probe` 显示 Lucy 一直在重启。

**根因**：`startLucyGateway()` 提前返回，未阻塞直到 abortSignal。

**检查清单**：
1. `startLucyGateway()` 末尾是否有 `return` 或 `throw` 不是来自消息循环？
2. 是否在 `connectLucySdk()` 返回后立即返回，而不是进入消息循环？
3. 是否有 `try/catch` 吞掉了错误但没有重新 throw？

**修复**：确保消息循环以及所有清理逻辑都在主控制流中。

### "Cannot find module 'nats'"

**症状**：gateway 容器启动失败，日志显示模块加载错误。

**根因**：运行时依赖未正确安装到容器中。

**检查清单**：
1. `npm install --omit=dev` 是否在 Dockerfile 中为 lucy 插件运行过？
2. `/app/extensions/lucy/node_modules` 中是否存在 `nats` 包？
3. 是否遗漏了 package.json 中的 dependencies？

**修复**：
```bash
# 本地测试
npm install

# Docker 构建
docker build --build-arg OPENCLAW_EXTENSIONS=lucy ...
```

### 入站消息丢失

**症状**：App 发送消息，Lucy 无法收到（无 `inbound.accepted` 事件）。

**根因**：通常是 NATS 连接未建立或 JetStream consumer 初始化失败。

**检查清单**：
1. SDK `client.connect()` 是否成功返回？
2. NATS server 是否在线（`echo info | nc <nats-addr> <port>`）？
3. 是否存在 token 过期（auth-callout 拒绝）？

**修复**：查看 gateway 日志，找 auth 或连接相关的错误。

## 安全性考虑

- **Ed25519 密钥**：存储在 `~/.lucy/identity/bootstrap_token/`，绝不导出
- **NATS token**：由 SDK 在内存中持有，不落盘
- **channel_user_key**：从 user-center 每次连接时获取，用于签名校验
- **设备重置**：`openclaw lucy reset-state` 删除所有本地标识符，强制重新注册与绑定
