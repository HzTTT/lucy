<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# Lucy 绑定与认证集成流程

Lucy 的设备身份从"未注册"到"已绑定"的全过程由 `lucy-im-sdk-nodejs` 和 OpenClaw 插件协同完成。本章详细解释每个阶段的状态、用户可见行为和后端调用。

## 设备身份三态

Lucy 只有三种身份状态，不存在中间状态或失效状态：

### 状态 1：Unregistered（未注册）
- **特征**：`~/.lucy/identity/` 目录不存在或为空
- **首次启动时进入**
- **SDK 操作**：`client.init()` 调用 user-center `/v1/devices/new` 注册设备
  - 发送 Ed25519 公钥
  - 收到 `cdi`（channel device ID）
  - 保存公钥到 `~/.lucy/identity/bootstrap_token/`
  - 保存 `cdi` 到 `~/.lucy/identity/channel_ids/`
- **转移条件**：注册成功 → PendingBind

### 状态 2：PendingBind（待绑定）
- **特征**：`channel_ids/` 中有 `cdi`，但无 `cuk` 或 `user_id`
- **等待用户在 App 侧完成绑定**
- **用户可见行为**：
  - 展示二维码（`lucy://bind?channel_device_id=...&otp=...`）或 BLE pairing 接口
  - 用户打开 App，扫二维码或读 BLE 信息
  - App 在扫码时包含有效的 OTP（一次性密码，有效期通常 60 秒）
  - App 向 user-center 调用 `/v1/channels/lucy/devices/device-bindings`（需用户登录 + OTP 验证）
  - App 完成绑定，user-center 返回绑定成功
- **Lucy 侧操作**：
  - `syncLucyBindingWithSdk()` 里如果检测到 PendingBind，会回调 `onPendingBind(client)`
  - 回调内容：
    1. 启动 Pairing IPC 客户端（用于 BLE），监听 `bind.request`
    2. **调用 SDK 的 `preBind()` 申请 OTP**（返回 `{ otp, expires_in }`）
    3. 生成二维码 URI：`lucy://bind?channel_device_id=<cdi>&otp=<otp>`
    4. 展示 QR 码或通过 IPC 将 OTP 发送给 BLE 设备
  - 然后 SDK `client.pollBinding()` 每 2 秒查询一次 user-center `/v1/channels/lucy/devices/device-bindings`
  - 当 API 返回 `{ user_id, cuk }` 时，SDK 保存到 `channel_ids/`
  - **OTP 不持久化**：OTP 是临时凭证，不写入磁盘；每次需要新 OTP 时重新调用 `preBind()`
- **转移条件**：用户完成 App 端绑定 → Bound

### 状态 3：Bound（已绑定）
- **特征**：`channel_ids/` 中有 `cdi`、`cuk` 和 `user_id`（完整三元组）
- **设备可以连接 NATS、收发消息**
- **SDK 操作**：`client.connect()` 调用 lucy-server NATS token exchange
  - 发送 Ed25519 签名的请求
  - 收到临时 NATS token
  - 连接 NATS（WebSocket 地址由 token 端点返回）
  - 初始化 JetStream consumer 和 Presence
- **有效期**：`cuk` 本身不过期，但 NATS token 由 sdk 缓存并在需要时刷新
- **转移条件**：执行 `openclaw lucy reset-state` → 回到 Unregistered

**状态迁移图**详见[绑定三态](../01-overview/diagrams.md#diagram-binding-states)。

---

## 认证二维码与 OTP

### 二维码 URI 格式

绑定期间，Lucy 需要对外暴露设备信息和 OTP（一次性密码），以便 App 扫码或通过 BLE 获取。Lucy 插件通过 `buildLucyAuthQrUri()` 和 `buildLucyAuthQrJson()` 生成这些数据。

**OTP 是临时凭证**：
- 每次调用 `openclaw lucy auth-qrcode` 时，SDK 的 `preBind()` 生成新的 OTP
- OTP 有 `expires_in`（秒数，由 SDK/lucy-server 约定，通常 60 秒）
- OTP 不持久化到磁盘；必须通过 CLI 或 IPC 实时申请
- App 扫码时必须提供有效的 OTP（不提供则绑定失败）

**URI 格式**（src/auth-qrcode.ts:21–30）：
```
lucy://bind?channel_device_id=<channel_device_id>&otp=<otp>
```

**示例**：
```
lucy://bind?channel_device_id=2044762959396634624&otp=153298
```

**关键参数**：
- `channel_device_id`：设备 ID（由 SDK 生成，如 `2044762959396634624`）
- `otp`：一次性密码（由 `preBind()` 申请，如 `153298`）；不带 otp 时 URI 退化为仅含 `channel_device_id`（仅用于离线排障，正常 App 扫码流程必须带 otp）

**Lucy 插件实现**（src/auth-qrcode.ts）：
```typescript
export type LucyAuthQrPayload = {
  channel: "lucy";
  channel_device_id: string;
  otp?: string;
};

// 构造 lucy://bind?... 格式的 URI
export function buildLucyAuthQrUri(
  channelDeviceId: string,
  otp?: string,
): string {
  const payload = buildLucyAuthQrPayload(channelDeviceId, otp);
  const params = new URLSearchParams({ channel_device_id: payload.channel_device_id });
  if (payload.otp) {
    params.set("otp", payload.otp);
  }
  return `lucy://bind?${params.toString()}`;
}
```

### 二维码 JSON 格式

BLE 前端可能无法解析 URI。Lucy 也提供 JSON 格式（src/auth-qrcode.ts:33–38）：

```json
{
  "channel": "lucy",
  "channel_device_id": "2044762959396634624",
  "otp": "153298"
}
```

**JSON 构造函数**：
```typescript
export function buildLucyAuthQrJson(
  channelDeviceId: string,
  otp?: string,
): string {
  return JSON.stringify(buildLucyAuthQrPayload(channelDeviceId, otp));
}

function buildLucyAuthQrPayload(
  channelDeviceId: string,
  otp?: string,
): LucyAuthQrPayload {
  const normalized = parseLucyAuthQrChannelDeviceId(channelDeviceId.trim());
  return {
    channel: "lucy",
    channel_device_id: normalized,
    ...(otp ? { otp } : {}),
  };
}
```

### 二维码生成命令

Lucy 插件暴露 CLI 命令生成二维码：

```bash
openclaw lucy auth-qrcode
```

此命令：
1. 读取本地 OpenClaw 配置（`channels.lucy.*` 设置）
2. 若已绑定 → 返回空或提示 "Already bound"
3. 若未注册 → 初始化 SDK，获得 `cdi`
4. 若待绑定 → 用本地 `cdi`、配置中的 user-center/lucy-server 域名生成 URI
5. 输出 QR 码图片（或 JSON 格式）

**使用场景**：
- 开发环境：开发者手动运行命令，扫码绑定测试 App
- BLE 集成：`blue-wifi` 守护进程读取 `pairing-info.json`（由同一函数生成）

---

## 状态同步与连接建立

### 同步函数：syncLucyBindingWithSdk()

这是 Lucy 插件与 SDK 之间的核心接口（auth-binding.ts:14）。

**函数签名**：
```typescript
export async function syncLucyBindingWithSdk(params: {
  cfg: LucyImConfig;
  client?: LucyImClient;
  signal?: AbortSignal;
  log?: { info?: (...) => void; ... };
  waitForBinding: boolean;
  onPendingBind?: (client: LucyImClient) => void;
  pollIntervalMs?: number;
}): Promise<{ cdi: string; userId: string; cuk: string }>
```

**执行流**：

1. **初始化阶段**：`client = params.client ?? new LucyImClient(params.cfg)`
   - 若未传入 client，创建新的

2. **SDK init 调用**：`const init = await client.init()`
   - SDK 生成 Ed25519 密钥对
   - 注册设备到 user-center，获得 `cdi`
   - 保存密钥和 `cdi` 到本地
   - 返回 `{ kind: "Ready" | "PendingBind" }`

3. **状态检查**：
   ```
   if (init.kind === "Ready") {
     // 设备已绑定，读本地 channel_ids/
     const { cdi, userId, cuk } = await client.deviceIdentity();
     return { cdi, userId, cuk };
   }
   ```

4. **待绑定处理**（若 `init.kind === "PendingBind" && waitForBinding`）：
   - 回调 `onPendingBind?.(client)` — 让调用者启动 Pairing IPC 或生成二维码
   - 调用 `client.pollBinding()` — 每 2 秒查询一次 user-center
   - 轮询直到：
     - 设备被绑定（API 返回 `{ user_id, cuk }`）→ 返回三元组
     - 超时或 abortSignal 触发 → 抛异常

5. **返回结果**：`{ cdi, userId, cuk }`

**在 Lucy 插件中的调用**（gateway.ts:600+）：
```typescript
const identity = await syncLucyBindingWithSdk({
  cfg: sdkConfig,
  signal: ctx.signal,
  log: logger,
  waitForBinding: true,
  onPendingBind: (client) => {
    // 启动 Pairing IPC、展示二维码
    const qrUri = buildLucyAuthQrUri({ ... });
    // ... 向前端发送 pairing-info.json ...
  },
  pollIntervalMs: 2000
});
```

### 连接函数：connectLucySdk()

一旦设备绑定（三元组完整），调用 `connectLucySdk()` 建立 NATS 连接（auth-binding.ts:83）。

**函数签名**：
```typescript
export async function connectLucySdk(params: {
  cfg: LucyImConfig;
  client: LucyImClient;
  identity: { cdi: string; userId: string; cuk: string };
  signal?: AbortSignal;
  log?: { ... };
}): Promise<ConnectedClient>
```

**执行流**：

1. **SDK connect 调用**：`const connected = await client.connect()`
   - SDK 调用 lucy-server `/v1/channels/lucy/token` 端点（Ed25519 签名请求）
   - 接收 NATS token 和 NATS 地址（WebSocket URL）
   - 连接 NATS
   - 初始化 JetStream consumer（stream `IM_NPC`、durable `npc-<cdi>`）
   - 启动 Presence 循环（自动心跳和 `_discover` 事件）

2. **返回 ConnectedClient**：可用于 `session.subscribeChannel()` 和 `session.publishChannel()`

**在 Lucy 插件中的调用**（gateway.ts:630+）：
```typescript
const connectedClient = await connectLucySdk({
  cfg: sdkConfig,
  client,
  identity,
  signal: ctx.signal,
  log: logger
});

// 订阅入站消息
connectedClient.session.subscribeChannel(
  buildNpcSubscribeSubject(identity.userId, identity.cdi),
  handleLucyInboundMessage
);

// 发布出站事件
await connectedClient.session.publishChannel(
  buildNpcPublishSubject(identity.userId),
  serializedEvent
);
```

---

## 本地状态文件

Lucy 的所有持久化状态由 SDK 存储在用户主目录（通常 `~/.lucy/identity/`）：

```
~/.lucy/identity/
├─ bootstrap_token/
│  ├─ (public-key).pub         # Ed25519 公钥（用于签名校验）
│  └─ (public-key).key         # Ed25519 私钥（机密，不导出）
│
└─ channel_ids/
   ├─ cdi                       # channel device ID（设备标识）
   ├─ user_id                   # user ID（绑定后写入）
   └─ cuk                        # channel user key（绑定后写入）
```

**重置设备状态**：
```bash
openclaw lucy reset-state
```

此命令删除上述整个目录，强制设备重新注册与绑定。

---

## user-center API 约定

Lucy 的绑定流程依赖 user-center 的以下 API：

### 1. 设备注册

```
POST /v1/devices/new
Content-Type: application/json

{
  "device_type": "npc",
  "public_key": "base64(Ed25519 public key)",
  "locale": "zh_CN"
}

Response 200:
{
  "cdi": "device-20240416-001234567890ab",
  "expires_at": 1713307200000
}
```

### 2. 绑定轮询

```
GET /v1/channels/lucy/devices/device-bindings
Query: ?device_id=<cdi>
Auth: Ed25519 signature in Authorization header

Response 200 (bound):
{
  "user_id": "user-abc123",
  "cuk": "key-xyz789",
  "expires_at": null
}

Response 202 (pending):
{
  "status": "pending"
}
```

### 3. 模型配置

```
GET /v1/channels/lucy/current-user/model-config
Auth: Ed25519 signature header

Response 200:
{
  "providerId": "cephalon",
  "modelId": "claude-opus-4",
  "apiKey": "sk-...",
  "base_url": "https://api.anthropic.com",
  "locale": "zh_CN"
}
```

---

## 典型场景

### 场景 1：首次启动，需要绑定

1. 用户在 OpenClaw 机器上首次启动 Lucy 插件
2. `startLucyGateway()` 调用 `syncLucyBindingWithSdk(waitForBinding: true)`
3. SDK 注册设备，进入 PendingBind
4. 回调 `onPendingBind()` 触发，生成二维码 URI
5. 用户用 App 扫二维码或读 BLE pairing-info
6. App 向 user-center 完成绑定
7. SDK 轮询 user-center 检测到绑定完成
8. `syncLucyBindingWithSdk()` 返回 `{ cdi, userId, cuk }`
9. 继续调用 `connectLucySdk()` 建立 NATS 连接
10. 插件启动消息循环

### 场景 2：重启，已绑定

1. 用户重启 OpenClaw
2. `syncLucyBindingWithSdk()` 检测本地 `channel_ids/` 存在（Ready）
3. 直接读本地三元组，立即返回
4. 跳过二维码阶段，直接 `connectLucySdk()`
5. 消息循环启动

### 场景 3：设备重置

1. 用户运行 `openclaw lucy reset-state`
2. 删除 `~/.lucy/identity/` 目录
3. 重启 Lucy 插件，回到"首次启动"流程

---

## 故障排查

**问题**：二维码显示但无法扫描
- 检查 `user_center` 和 `lucy_server` 域名是否正确
- 检查 App 是否能访问这些域名（网络、防火墙）

**问题**：轮询卡住，设备一直处于 PendingBind
- 检查 user-center `/v1/channels/lucy/devices/device-bindings` API 是否可用
- 检查 App 是否真的发起了绑定请求
- 检查 user-center 日志中是否有绑定记录

**问题**：NATS 连接失败
- 检查 lucy-server token 端点是否可达
- 检查 NATS WebSocket 地址是否正确
- 检查 NATS auth-callout 是否正确校验了 token

详见[第 8 章 - 排障指南](../08-operations/debugging.md)。
