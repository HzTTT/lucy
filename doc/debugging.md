# Lucy 调试与测试工具

本文档汇总 `scripts/` 目录下的调试脚本，覆盖从连通性验证到 JetStream 诊断的完整工作流。

## 前置条件

所有 probe 脚本通过 user-center 登录获取 NATS token，需要：

1. 本地 Lucy 客户端状态目录存在（默认 `/tmp/lucy-test/identity/`），包含：
   - `channel_ids/cdi` — 设备 ID
   - `channel_ids/user_id` — 用户 ID
   - `channel_ids/cuk` — channel user key
2. test 环境的 user-center 和 lucy-server 可达
3. `nats` npm 包可用（全局或项目 `node_modules`）

## 脚本一览

| 脚本 | 用途 | 运行时间 |
|------|------|----------|
| `scripts/e2e-probe.mjs` | 端到端全链路测试（4 个用例） | ~3 分钟 |
| `scripts/correlation-probe.mjs` | 唯一标签回显相关性验证 | ~90 秒 |
| `scripts/consumer-info.mjs` | JetStream stream/consumer 状态诊断 | <5 秒 |
| `scripts/demo-chat.ts` | 交互式/单次 NATS 聊天客户端 | 按需 |
| `scripts/raw-event-probe.mjs` | Docker 容器内事件流验证（6 个用例） | ~2 分钟 |
| `scripts/print-probe-fields.mjs` | 输出运行时配置探针字段 | <1 秒 |
| `scripts/auth-qrcode.ts` | 生成设备绑定 QR 码 | <1 秒 |

## 使用方法

### 1. 端到端全链路测试（推荐首选）

验证 Lucy 插件的完整链路：登录 → NATS 连接 → JetStream 发布 → 事件接收 → 模型推理 → 工具调用。

```bash
# 从 extensions/lucy/ 目录运行
node scripts/e2e-probe.mjs
```

包含 4 个测试用例：

| 用例 | 验证点 |
|------|--------|
| "Reply with exactly one word: PONG" | 基本消息收发、模型推理 |
| "Think step by step: what is 17 * 23?" | 推理能力、流式输出 |
| "What is the current date and time? Use any available tool." | 工具调用链路 |
| "Say hello" | 简单回复 |

**预期输出：** 每个用例应看到完整的事件链 `inbound.accepted → assistant.start → reasoning.final → assistant.partial* → assistant.final`。

**判断标准：**
- 4 个用例均收到 `assistant.final` → 全链路正常
- 有 `inbound.accepted` 无 `assistant.*` → 传输正常，模型执行有问题
- 无 `inbound.accepted` → NATS 连接或 JetStream consumer 有问题

### 2. 相关性验证

发送包含唯一标签的消息，验证 `assistant.final` 中是否包含该标签，用于确认消息不会串线。

```bash
node scripts/correlation-probe.mjs
```

**预期输出：** `result: matched` 且退出码 0。如果 `result: timeout`，说明消息未被正确路由或模型未能回显标签。

### 3. JetStream 诊断

查看 `IM_NPC` stream 和 `npc-<cdi>` consumer 的状态，用于排查消息积压或消费延迟。

```bash
node scripts/consumer-info.mjs
```

**关键字段：**
- `stream.messages` — stream 中的消息总数
- `num_pending` — 待消费消息数（正常应为 0 或很小）
- `num_ack_pending` — 已投递未确认数（持续增长说明 consumer 卡住）
- `delivered.stream_seq` vs `ack_floor.stream_seq` — 差值大说明有消息未确认

### 4. 交互式聊天测试

用于手动发送消息并观察机器事件流。需要直连 NATS（user/pass 认证），适合本地 NATS 或有直连权限的场景。

```bash
# 单次发送
pnpm exec tsx scripts/demo-chat.ts \
  --channel-user-key <cuk> \
  --channel-device-id <cdi> \
  --server nats://127.0.0.1:4222 \
  --text "Reply with exactly LUCY_E2E_OK." \
  --wait-ms 25000

# 交互模式（不传 --text）
pnpm exec tsx scripts/demo-chat.ts \
  --channel-user-key <cuk> \
  --channel-device-id <cdi> \
  --server nats://127.0.0.1:4222

# 带媒体上传
pnpm exec tsx scripts/demo-chat.ts \
  --channel-user-key <cuk> \
  --channel-device-id <cdi> \
  --server nats://127.0.0.1:4222 \
  --text "Describe this image" \
  --media /path/to/image.png

# 下载机器回复中的媒体
pnpm exec tsx scripts/demo-chat.ts \
  --channel-user-key <cuk> \
  --channel-device-id <cdi> \
  --server nats://127.0.0.1:4222 \
  --download-dir /tmp/lucy-media
```

### 5. Docker 容器内事件探测

在 Docker 环境中运行，从容器本地配置和设备状态读取参数，输出 JSON 报告。

```bash
# 设置环境变量指向容器内路径
OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
LUCY_DEVICE_STATE_PATH=/home/node/.openclaw/lucy/device-state.json \
node scripts/raw-event-probe.mjs
```

结果写入 `/tmp/lucy-raw-probe-results.json`（可通过 `LUCY_PROBE_OUTPUT_PATH` 覆盖）。

### 6. 配置探针字段

输出当前 Lucy 运行时的关键配置值，用于快速确认 subject、bucket 等参数是否正确。

```bash
node scripts/print-probe-fields.mjs
node scripts/print-probe-fields.mjs --show-paths  # 同时显示配置文件路径
```

### 7. 绑定 QR 码

生成设备绑定 QR 码，用于 iOS 客户端扫码绑定。

```bash
pnpm exec tsx scripts/auth-qrcode.ts          # 终端显示 QR 码
pnpm exec tsx scripts/auth-qrcode.ts --json    # JSON 输出
pnpm exec tsx scripts/auth-qrcode.ts --no-qr   # 仅输出 URI，不显示 QR
```

## 调试决策树

```
Lucy 是否在线？
├─ 运行 e2e-probe.mjs
│  ├─ 4/4 通过 → 全链路正常
│  ├─ 连接失败 → 检查 user-center/lucy-server 可达性
│  ├─ 有 inbound.accepted，无 assistant.* → 模型/provider 问题
│  │  └─ 检查 cephalon provider 配置、apiKey、baseUrl
│  ├─ 无 inbound.accepted → JetStream consumer 问题
│  │  └─ 运行 consumer-info.mjs 检查 pending/ack 状态
│  └─ assistant.final 内容异常 → 运行 correlation-probe.mjs 排除串线
│
├─ 需要交互式调试？
│  └─ 运行 demo-chat.ts（需直连 NATS）
│
├─ Docker 环境？
│  └─ 运行 raw-event-probe.mjs（容器内）
│
└─ 配置确认？
   └─ 运行 print-probe-fields.mjs
```

## 远程主机测试

测试远程 Lucy 网关时，probe 脚本从本地运行即可（它们通过 user-center 获取 NATS token，不需要直连网关）。

确保本地 `/tmp/lucy-test/identity/channel_ids/` 中的 `cdi` 和 `user_id` 与远程网关的一致：

```bash
# 查看远程凭据
ssh <user>@<host> "cat /var/lib/lucy/identity/channel_ids/cdi; echo; cat /var/lib/lucy/identity/channel_ids/user_id"

# 查看本地凭据
cat /tmp/lucy-test/identity/channel_ids/cdi
cat /tmp/lucy-test/identity/channel_ids/user_id
```
