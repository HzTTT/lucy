<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 test/ + vitest.config.ts 为事实源 -->

# 测试策略

本文档说明了 Lucy 插件的测试分层、运行方式、以及 iPhone 真机验证循环。

## 测试分层

Lucy 的测试分为三层，从最快的协议层到最慢的 E2E 层。

### 第 1 层：协议层测试（单元 + 集成）

**范围**：zod schema 验证、主题名称生成、事件序列化、IPC 消息编码解码

**文件**：`extensions/lucy/src/*.test.ts`（约 15 个测试文件，共 2000+ 行）

**运行命令**：

```bash
# 全部
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"

# 指定文件
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/types.test.ts"

# 按 pattern 过滤
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts" -t "nats"
```

**典型测试用例**：

| 文件 | 覆盖内容 | 运行时 |
|------|---------|--------|
| `types.test.ts` | 入站/出站消息 zod schema、机器事件枚举 | < 1s |
| `nats.test.ts` | 主题名称生成（`buildNpcSubscribeSubject` 等） | < 1s |
| `pairing-ipc-client.test.ts` | IPC 消息编码/解码、frame size 校验 | < 1s |
| `provider-provisioning.test.ts` | 模型供应配置应用、重启票据生成 | < 2s |
| `restart-ticket.test.ts` | 重启票据的读写和清除 | < 1s |

**预期状态**：绿色（通过）

### 第 2 层：集成层测试（gateway + SDK）

**范围**：gateway 启动、SDK 初始化、消息收发、媒体传输、配置应用

**文件**：`extensions/lucy/src/*.test.ts` 中的集成测试（标记 `@integration`）

**运行命令**：

```bash
# 运行所有集成测试
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts" -t "@integration"

# 或运行特定文件
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/gateway.test.ts"
```

**依赖**：本地 NATS（可选）

```bash
docker compose -f extensions/lucy/docker-compose.nats.yml up -d nats
```

**典型测试用例**：

| 场景 | 文件 | 用时 |
|------|------|------|
| Gateway 启动到 PendingBind | `gateway.test.ts` | 3–5s |
| 消息入站和回复 | `gateway.test.ts` | 2–3s |
| 媒体上传和下载 | `media.test.ts` | 2–3s |
| 模型供应和重启 | `provider-provisioning.test.ts` | 2–3s |

**预期状态**：绿色（通过）

### 第 3 层：E2E 脚本（user-side 客户端模拟）

**范围**：模拟 iOS 客户端走完整路径 — user-center 密码登录 → lucy-server 申请 user-side NATS token → NATS core sub 出站 / JetStream pub 入站，验证 lucy gateway 完整事件流（含 `assistant.complete` 收尾契约）

**前置条件**：

1. lucy gateway 已绑定：`ls ~/.lucy/identity/channel_ids/` 含 `cdi`、`cuk`、`user_id`
2. gateway 与 probe 在同一环境（默认 test）。若 gateway 配的是 prod，要么改 `~/.openclaw/openclaw.json` 的 `channels.lucy.userCenterDomain` 和 `lucyServerDomain` 切到 test，要么用 env var 让 probe 切到 prod

**关键脚本**：

| 脚本 | 用途 | 命令 |
|------|------|------|
| `auth-qrcode.ts` | 生成绑定 QR 码 | `pnpm exec tsx extensions/lucy/scripts/auth-qrcode.ts --json` |
| `assistant-complete-probe.ts` | **协议契约验证（推荐入口）**：发一条入站消息后捕获事件流，验证 `assistant.complete` 是最后一个事件 | `pnpm exec tsx extensions/lucy/scripts/assistant-complete-probe.ts` |
| `e2e-probe.mjs` | 6 个内置测试用例（plain reply、reasoning、tool use 等）针对独立 home `/tmp/lucy-test/identity/` | `node extensions/lucy/scripts/e2e-probe.mjs` |
| `correlation-probe.mjs` | 关联性验证：同一 inbound 的所有事件必须带相同 `source_message_id` | `node extensions/lucy/scripts/correlation-probe.mjs` |
| `consumer-info.mjs` | JetStream 消费者状态：stream `IM_NPC` + durable `npc-<cdi>` 的 pending/ack 序号 | `node extensions/lucy/scripts/consumer-info.mjs` |

**`assistant-complete-probe.ts` 工作流**：

1. 读 `~/.lucy/identity/channel_ids/{cdi,user_id}` 拿到 gateway 当前绑定
2. `POST /v1/login`（user-center）用 phone+pwd 拿 user session token
3. `POST /v1/channels/lucy/nats/token/user`（lucy-server）带 `Authorization: Bearer <token>` + `{"client_id": "..."}` 拿 user-side NATS token
4. NATS connect with token → core sub `cephalon.im.user.<user_id>` → JetStream pub `cephalon.im.npc.<user_id>.<cdi>`
5. 收到 `assistant.complete` 后等 3s grace window，断言它是最后事件 + 唯一一个 + `runId` 匹配

**运行示例**：

```bash
# 默认 test 环境 + 内置 test 账号
pnpm exec tsx extensions/lucy/scripts/assistant-complete-probe.ts

# 自定义 prompt
LUCY_PROBE_PROMPT="reply with exactly: HELLO" \
  pnpm exec tsx extensions/lucy/scripts/assistant-complete-probe.ts

# 切到 prod
LUCY_PROBE_USER_CENTER=https://prod.unicorn.org.cn/cephalon/user-center \
LUCY_PROBE_LUCY_SERVER=https://prod.unicorn.org.cn/aiden/lucy-server \
LUCY_PROBE_PHONE=<prod-phone> LUCY_PROBE_PWD=<prod-pwd> \
  pnpm exec tsx extensions/lucy/scripts/assistant-complete-probe.ts
```

**预期事件流（happy path）**：

```
inbound.accepted → assistant.start → assistant.partial × N → assistant.final → assistant.complete
```

输出末尾：

```
[probe] VERDICT: PASS - exactly 1 assistant.complete is the LAST event (1 assistant.final blocks before it)
[probe] complete carries: sourceMessageId=... runId=... eventId=...
```

**注意 — `assistant.complete` 契约**：每个 inbound run 必须以恰好 1 个 `assistant.complete` 收尾。无论 happy path、block error（被 dispatcher `onError` 消化）、还是 fatal dispatcher throw，都不会有任何事件出现在 complete 之后。fatal 路径下事件流是 `... → error → assistant.complete`。

## 运行完整的测试套件

```bash
# 1. 安装依赖
pnpm install

# 2. 运行所有 Lucy 测试（包括单元 + 集成）
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"

# 3. 类型检查
pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts

# 4. E2E 协议验证（可选，需 gateway 运行 + 已绑定）
pnpm exec tsx extensions/lucy/scripts/assistant-complete-probe.ts
```

**总耗时**：< 30 秒（仅单元 + 集成）

## iPhone 真机验证循环（可选）

对于 `outside/LucyIOSDemo` 相关的 App 侧改动，需要在真机上验证。

### 前置条件

1. 连接物理 iPhone（推荐 `宏仔头的iPhone (2)` UDID: `C6EE7005-94ED-5C16-87D7-875DD6ACB13F`）
2. 安装 `xcodebuildmcp` 工具（用于自动化构建和运行）

### 验证步骤

#### 步骤 1：运行 Swift Package 单测

```bash
xcodebuildmcp swift-package test \
  --package-path ./extensions/lucy/outside/LucyIOSDemo/LucyIOSDemoPackage \
  --filter LucyIOSDemoFeatureTests
```

**预期**：所有测试通过

#### 步骤 2：在真机上构建和运行

```bash
# 列出可用设备
xcodebuildmcp device list

# 在真机上构建并运行 App
xcodebuildmcp device build-and-run \
  --project-path ./extensions/lucy/outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  --scheme LucyIOSDemo \
  --device-id C6EE7005-94ED-5C16-87D7-875DD6ACB13F \
  --platform iOS
```

**预期**：App 启动成功，可见主页面

#### 步骤 3：获取 App 信息并启动日志捕获

```bash
# 获取 App 路径和 Bundle ID
APP_PATH=$(xcodebuildmcp device get-app-path \
  --project-path ./extensions/lucy/outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  --scheme LucyIOSDemo \
  --platform iOS)

BUNDLE_ID=$(xcodebuildmcp device get-app-bundle-id --app-path "$APP_PATH")

# 启动设备日志捕获
LOG_SESSION=$(xcodebuildmcp device start-device-log-capture \
  --device-id C6EE7005-94ED-5C16-87D7-875DD6ACB13F \
  --bundle-id "$BUNDLE_ID")

echo "Log session ID: $LOG_SESSION"
```

#### 步骤 4：手动测试 App 功能

1. **扫码绑定**：使用 App 扫描 Lucy gateway 的 QR 码（通过 `openclaw lucy auth-qrcode` 获取）
2. **发送消息**：在 App 中输入消息并发送，检查是否收到回复
3. **查看流式响应**：观察气泡是否实时流式显示
4. **测试特殊事件**：如果有模型供应、审批等事件，验证是否正确展示

#### 步骤 5：收集日志和验证结果

```bash
# 停止日志捕获并保存
xcodebuildmcp device stop-device-log-capture \
  --log-session-id "$LOG_SESSION" \
  --output-path ./lucy-device-logs.txt

# 查看日志
cat ./lucy-device-logs.txt
```

**日志应包含**：
- 扫码绑定的日志
- NATS 连接成功
- 消息发送和接收
- 无崩溃日志（无 EXC_BAD_ACCESS 等）

### 降级路径

若无物理设备可用，降级使用模拟器：

```bash
# 在 iOS Simulator 上运行
xcodebuildmcp device build-and-run \
  --project-path ./extensions/lucy/outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  --scheme LucyIOSDemo \
  --platform iOS \
  --simulator
```

**注意**：模拟器无法测试 BLE 功能，仅能验证 UI 和逻辑。

## 覆盖率目标

Lucy 插件的测试覆盖率目标（Vitest + V8）：

| 范围 | 目标 | 当前 |
|------|------|------|
| 语句（Statements） | 70% | TODO |
| 分支（Branches） | 65% | TODO |
| 函数（Functions） | 70% | TODO |
| 行（Lines） | 70% | TODO |

运行覆盖率报告：

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts" --coverage
```

## 持续集成（CI）

Lucy 的 CI 流程在每次 push 时自动运行：

```yaml
# .github/workflows/lucy.yml (示例)
name: Lucy Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"
      - run: pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts
```

## 常见测试问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 测试超时 | NATS 或依赖服务不可达 | 启动 `docker compose -f extensions/lucy/docker-compose.nats.yml up -d nats` |
| `Cannot find module 'nats'` | 依赖未安装 | 运行 `pnpm install` |
| 集成测试间歇性失败 | 网络不稳定或资源竞争 | 增加 timeout，或分离为独立 test suite |
| iOS Demo 构建失败 | Xcode 版本不匹配 | 确保 Xcode 版本 >= 14，运行 `xcode-select --install` |

## 相关文档

- [排障指南](../08-operations/debugging.md)
- [CLI 命令参考](../08-operations/cli-commands.md)
- [配置参考](../08-operations/config-reference.md)
