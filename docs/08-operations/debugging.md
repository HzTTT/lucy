<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# 排障指南

本文档提供了 Lucy 插件的排障工作流和失败信号对照表。按照分层验证策略，从最小单元开始逐层向外排查。

## 分层验证策略

### 第 1 层：单元测试与类型检查

**目的**：验证代码逻辑和编译是否正确。

```bash
# 运行 Lucy 相关单测
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"

# 类型检查
pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts
```

**失败信号**：
- 测试用例失败 → 检查对应的 `*.test.ts` 和源代码
- TypeScript 类型错误 → 检查类型定义和使用

### 第 2 层：最小 Stack（NATS + Lucy Gateway）

**目的**：验证 Lucy 能否启动并连接到 NATS。

```bash
# 启动本地 NATS（可选）
docker compose -f extensions/lucy/docker-compose.nats.yml up -d nats

# 配置并启动 OpenClaw gateway
openclaw config set channels.lucy.enabled true
openclaw gateway run --port 18789
```

**检查清单**：
- [ ] Gateway 日志出现 `lucy: init with sdk`
- [ ] 没有 NATS 连接错误
- [ ] `openclaw channels status --probe` 返回 Lucy 的状态

### 第 3 层：频道状态探测

**目的**：验证 Lucy 频道是否健康。

```bash
# 人类可读格式
openclaw channels status --probe

# JSON 格式（用于脚本）
openclaw gateway call channels.status \
  --params '{"probe":true,"timeoutMs":10000}' \
  --json
```

**健康指标**：
- `state: "configured, works, connected"` → 正常
- `state: "configured, works, stopped"` → 频道已配置但监听未启动（可能正在重启）
- `state: "configured, offline"` → NATS 连接丢失

### 第 4 层：依赖可见性检查

**目的**：验证运行时依赖（特别是 `nats` 包）是否正确安装。

```bash
# 检查容器内的依赖
docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml \
  run --rm openclaw-cli ls -la /app/extensions/lucy/node_modules/ | grep nats

# 或检查本地
ls -la extensions/lucy/node_modules/nats
```

**失败信号**：
- `Cannot find module 'nats'` → 依赖未正确安装
- 解决方案：运行 `pnpm install` 或在容器内重新构建

### 第 5 层：消息传输验证

**目的**：验证 Lucy 能否接收和发送消息。

```bash
# 检查 inbound 消息统计
openclaw channels status --probe | grep "Inbound accepted"

# 查看日志
openclaw gateway logs --grep "inbound.accepted" --tail 50
```

**关键事件序列**：
1. `inbound.accepted` → 入站消息被接受
2. `assistant.start` → 模型开始生成
3. `assistant.partial` (多次) → 流式输出
4. `assistant.final` → 生成完成

**失败信号**：
- 无 `inbound.accepted` 事件 → JetStream 消费者问题或 NATS 权限不足
- 有 `inbound.accepted` 但无 `assistant.*` → 模型执行问题

### 第 6 层：模型与提供者验证

**目的**：验证上游模型提供者配置和认证。

```bash
# 检查模型配置
openclaw config get models.providers.cephalon

# 查看提供者相关日志
openclaw gateway logs --grep "provider\|assistant" --tail 100
```

**失败信号**：
- `assistant.final` 返回 HTTP 401/403 → API 密钥错误或权限不足
- `assistant.final` 返回 timeout → 模型服务响应慢

## 失败信号对照表

以下是常见的错误消息及其对应的原因和解决方案。

| 失败信号 | 位置 | 原因 | 排查步骤 |
|---------|------|------|---------|
| `configured, works, stopped` | `channels status --probe` | Lucy 监听已停止，通常由于崩溃或自动重启 | 检查日志 `openclaw gateway logs --grep "lucy"` 找出最后的错误 |
| `auto-restart attempt N/10` | gateway 日志 | Lucy 启动失败，gateway 正在尝试自动重启 | 检查 startLucyGateway() 的错误，确认 NATS 和 user-center 可达 |
| `nats token exchange failed` | gateway 日志 | Ed25519 签名或 lucy-server 连接失败 | 验证 lucy-server 可达，检查 homeDir 中的密钥是否完整 |
| `subscribe failed: permission denied` | gateway 日志 | NATS auth-callout 拒绝了权限 | 检查 NATS token 是否过期，确认 auth-callout 正确配置 |
| `Cannot find module 'nats'` | gateway 启动时 | 运行时依赖未安装 | 运行 `pnpm install`，检查 extensions/lucy/node_modules/nats 是否存在 |
| `pairing-info.json` 不存在 | BLE 读取时 | Lucy 未生成配对信息文件 | 确认 Lucy 已进入 PendingBind 状态，检查 homeDir 目录权限 |
| `IPC socket connection refused` | BLE/前端日志 | pairing IPC 服务未启动 | 确认 `channels.lucy.pairingSocket` 已配置，检查 socket 路径是否存在且可写 |
| `inbound.rejected: invalid signature` | gateway 日志 | App 发送的消息签名验证失败 | 检查 App 使用的 `channel_user_key` 是否与 Lucy 的 `cuk` 一致 |
| USB 本地通知 curl 返回 404 | curl 命令行 | HTTP 路径不匹配 | 确认 `channels.lucy.localNotify.path` 配置，默认为 `/usb-events` |
| USB 本地通知 curl 返回 202 但 App 无消息 | 机器端日志 | 用户未绑定或 NATS 消费者断开 | 检查 Lucy 是否已进入 `bound` 状态，验证用户 `user_id` |

## 常见工作流

### 工作流 1：首次启动诊断

```bash
# 1. 检查配置
openclaw config get channels.lucy

# 2. 启动 gateway
openclaw gateway run &

# 3. 等待初始化（通常 5-10 秒）
sleep 10

# 4. 检查状态
openclaw channels status --probe | grep -A 10 "Channel: lucy"

# 5. 查看完整日志
openclaw gateway logs --grep "lucy" --tail 100

# 6. 生成 QR 码
openclaw lucy auth-qrcode --json
```

**预期输出**：
```
Channel: lucy
  State:            configured, works, pending_bind
  Binding state:    pending_bind
  Last update:      just now
```

### 工作流 2：消息流故障排查

```bash
# 1. 确认 Lucy 已绑定
openclaw channels status --probe | grep "binding_state"

# 2. 模拟发送消息（手动或通过 demo-chat.ts）
pnpm exec tsx extensions/lucy/scripts/demo-chat.ts \
  --channel-user-key <cuk> \
  --channel-device-id <cdi> \
  --text "test message" \
  --wait-ms 25000

# 3. 实时观看日志
openclaw gateway logs --follow --grep "inbound\|assistant"

# 4. 如果有错误，查看详细日志
openclaw gateway logs --grep "error" --tail 200
```

**预期日志序列**：
```
lucy: inbound.accepted
lucy: assistant.start
lucy: assistant.partial (多次)
lucy: assistant.final
```

### 工作流 3：NATS 连接问题排查

```bash
# 1. 检查 NATS 是否运行
docker ps | grep nats

# 2. 查看 lucy-server 和 user-center 可达性
curl -I https://npc.im/
curl -I https://user.npc.im/

# 3. 检查 gateway 日志中的 NATS 相关错误
openclaw gateway logs --grep "nats\|jetstream\|token" --tail 100

# 4. 如果怀疑是网络问题
ping -c 3 npc.im
```

## 日志过滤器速查

```bash
# 所有 Lucy 日志
openclaw gateway logs --grep "lucy" --tail 200

# 仅错误
openclaw gateway logs --grep "error.*lucy" --tail 50

# NATS 连接相关
openclaw gateway logs --grep "nats\|jetstream\|token" --tail 100

# 消息流事件
openclaw gateway logs --grep "inbound\|assistant\|approval" --tail 100

# 绑定流程
openclaw gateway logs --grep "binding\|bind\|otp" --tail 100

# 配置和初始化
openclaw gateway logs --grep "init\|config\|setup" --tail 100
```

## 性能基准

用于判断是否异常的性能数据：

| 操作 | 正常耗时 | 异常耗时 |
|------|---------|---------|
| Lucy 启动到 PendingBind | < 5 秒 | > 30 秒 |
| NATS 连接建立 | < 2 秒 | > 10 秒 |
| 消息从入站到 assistant.start | < 1 秒 | > 5 秒 |
| 完整 assistant 流（start → final） | 2–10 秒 | > 30 秒 |

## 相关文档

- [CLI 命令参考](./cli-commands.md)
- [配置参考](./config-reference.md)
- [测试策略](../09-testing/test-strategy.md)
