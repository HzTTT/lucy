# lucy-im-sdk-nodejs E2E 集成测试报告

**测试日期：** 2026-04-10
**测试环境：** cephalon@192.168.0.9（Ubuntu x86_64, Node 22.22.2）
**SDK 版本：** lucy-im-sdk 0.1.0（git submodule）
**user-center：** https://test.unicorn.org.cn/cephalon/user-center
**lucy-server：** https://test.unicorn.org.cn/aiden/lucy-server
**NATS：** nats://test-chat.lucy.run:4222

## 测试结果

| 测试项 | 状态 | 说明 |
|--------|------|------|
| SDK 设备注册（Ed25519） | ✅ | `POST /v1/devices/new` → cdi |
| SDK preBind（OTP） | ✅ | lucy-server pre-bind → 6 位 OTP |
| lucy-server 绑定 | ✅ | `PUT /v1/channels/lucy/devices/device-bindings` + OTP |
| SDK pollBinding | ✅ | lucy-server → cuk + user_id |
| SDK connect（NATS token） | ✅ | 签名换 token → NATS 连接 |
| Gateway JetStream 监听 | ✅ | 持续运行无 auto-restart |
| 简单文本消息 | ✅ | "PONG" 正确回复 |
| 推理输出 | ✅ | reasoning.partial/final 事件正常 |
| 工具调用 | ✅ | tool.start/tool.end 事件正常 |
| Iroh Blob 往返 | ✅ | blobPut → blobFetch 内容完全一致 |
| 图片消息 | ✅ | 1x1 PNG → NPC 识别并描述图片内容 |
| Machine event 完整序列 | ✅ | accepted → start → reasoning → partial → final |

## 完整调用流程

### 1. NPC → user-center：设备注册

```
POST /v1/devices/new
Content-Type: application/json

{ "public_key": "<32字节 Ed25519 公钥的 Base64>" }

→ { "code": 20000, "data": { "cdi": "2042541809425543168" } }
```

### 2. NPC → lucy-server：preBind 获取 OTP

```
POST /v1/channels/lucy/devices/pre-bind
Content-Type: application/json

{
  "cdi": "2042541809425543168",
  "nonce": "randomAlphanumeric16",
  "ts": "1775812918",
  "sign": "<Ed25519 签名 Base64>"
}

签名内容: cdi=...&nonce=...&ts=...

→ { "expires_in": 300, "otp": "224808" }
```

### 3. App → user-center：登录

```
POST /v1/login
Content-Type: application/json

{ "phone": "18888888888", "pwd": "xxx", "way": "phone_pwd" }

→ { "code": 20000, "data": { "token": "jwt..." } }
```

### 4. App → lucy-server：绑定

```
PUT /v1/channels/lucy/devices/device-bindings
Authorization: Bearer <user_token>
Content-Type: application/json

{ "otp": "224808" }

→ { "cdi": "2042541809425543168", "status": "bound" }
```

### 5. NPC → lucy-server：轮询绑定结果

```
GET /v1/channels/lucy/devices/device-bindings?cdi=...&nonce=...&ts=...&sign=...

→ { "status": "bound", "cuk": "1862247176453038080", "user_id": "1862247176453038080" }
```

### 6. NPC → lucy-server：换取 NATS token

```
POST /v1/channels/lucy/nats/token/npc
Content-Type: application/json

{
  "cdi": "2042541809425543168",
  "device_type": "lucy",
  "nonce": "randomAlphanumeric16",
  "ts": "1775812919",
  "sign": "<Ed25519 签名 Base64>"
}

签名内容: cdi=...&cuk=...&kind=lucy&nonce=...&ts=...

→ {
    "token": "random_auth_token",
    "expires_in": 300,
    "nats_url": "nats://test-chat.lucy.run:4222",
    "access_token": "random_access_token",
    "access_token_expires_in": 7200
  }
```

### 7. NPC → NATS：连接并监听

```
CONNECT { token: "random_auth_token" }

Subscribe: cephalon.im.npc.<user_id>.<cdi> (JetStream IM_NPC, durable npc-<cdi>)
Publish:   cephalon.im.user.<user_id> (JetStream)
```

## SDK 修复记录

| 修复 | 文件 | 说明 |
|------|------|------|
| `device_type` 字段 | `http.ts` | lucy-server 要求 `device_type`（不是 `kind`） |
| `ts` 类型 | `http.ts` | lucy-server 要求 `ts` 为 string |
| `checkAPI: false` | `natsConn.ts` | auth-callout 权限不含 `$JS.API.INFO`，跳过前置检查 |
| `ensureConsumer` 不 update | `natsConn.ts` | JetStream 不允许修改 consumer 的 `opt_start_time` |
| `child_process` 移除 | `lucy-blob-node-native/index.js` | NAPI-RS Node 10 兼容代码被安全扫描拦截 |
| gateway 阻塞等待 | `gateway.ts` | `subscribeChannel` 后加 `abortSignal` 等待，防止函数提前返回 |
