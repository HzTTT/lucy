# Lucy App 端对接指南

本文面向 iOS / Android / Web 等客户端开发者，说明如何接入 Lucy IM 并与 OpenClaw NPC 交互。

## 1. 整体架构

```
App ──→ user-center (登录/绑定查询/模型配置)
App ──→ lucy-server (设备绑定/NATS token 获取)
App ←──→ NATS (JetStream 消息收发)
         ↕
NPC (OpenClaw + Lucy 插件)
```

App 通过 `lucy-im-sdk-kotlin`（或等效实现）完成鉴权和消息收发。

## 2. 接入流程

### 2.1 登录

```
POST {user-center}/v1/login
Content-Type: application/json

{
  "phone": "18888888888",
  "pwd": "xxx",
  "way": "phone_pwd"
}

→ {
    "code": 20000,
    "data": {
      "token": "eyJhbGciOiJIUzI1NiIs...",
      "id": "1862247176453038080",
      ...
    }
  }
```

保存 `token`，后续所有需要鉴权的请求都带 `Authorization: Bearer <token>`。

### 2.2 绑定设备

NPC 启动后会在终端或日志中显示 OTP 和二维码。App 扫码获取 `cdi`（或直接从 NPC 拿到 OTP）。

**用 OTP 绑定：**

```
PUT {lucy-server}/v1/channels/lucy/devices/device-bindings
Authorization: Bearer <token>
Content-Type: application/json

{ "otp": "224808" }

→ { "cdi": "2042541809425543168", "status": "bound" }
```

### 2.3 获取 NATS 连接凭据

```
POST {lucy-server}/v1/channels/lucy/nats/token/user
Authorization: Bearer <token>

→ {
    "token": "random_auth_token",
    "expires_in": 300,
    "nats_url": "nats://test-chat.lucy.run:4222",
    "access_token": "random_access_token",
    "access_token_expires_in": 7200
  }
```

用返回的 `token` 连接 `nats_url`：

```
NATS CONNECT { token: "random_auth_token" }
```

### 2.4 获取模型配置

```
GET {user-center}/v1/channels/lucy/current-user/model-config
Authorization: Bearer <token>

→ {
    "code": 20000,
    "data": {
      "channel": "lucy",
      "provider_id": "cephalon",
      "api_key": "sk-xxx",
      "base_url": "https://test.unicorn.org.cn/cephalon/user-center/v1/model",
      "default_model_id": "kimi-k2.5",
      "created": false,
      "models": [
        { "id": "kimi-k2.5", "label": "Kimi K2.5", "enabled": true, "is_default": true }
      ]
    }
  }
```

## 3. NATS Subject 约定

连接 NATS 后，App 使用以下 subject 收发消息。`user_id` 从登录响应或 credential 接口获取，`cdi` 为目标 NPC 的设备标识。

### 发送消息给 NPC

```
Publish → cephalon.im.npc.<user_id>.<cdi>
```

通过 JetStream publish（stream `IM_NPC`）。

### 接收 NPC 的回复

```
Subscribe ← cephalon.im.user.<user_id>
```

**推荐使用 JetStream consumer**（stream `IM_USER`，durable `user-<user_id>`，ack policy `Explicit`），这样 App 短暂离线期间 NPC 推过来的事件会在 JetStream 里暂存并在重连后补发。对不要求离线补发的场景（例如一次性脚本探测）可以临时用 core NATS `nc.subscribe`，但会丢掉订阅窗口之外的事件。

NPC 侧所有 machine event 都是通过 `js.publish` 写进 `cephalon.im.user.<user_id>`，所以 JetStream 消费者一定能看到。App 侧的 `lucy-im-sdk-kotlin` 默认以 JetStream pull consumer 方式消费这条 subject。

### Presence（NPC 在线状态）

```
Subscribe ← cephalon.im.npc.<user_id>._discover
```

NPC 上线时发布：
```json
{ "cmd": "report", "report": { "status": "online", "cdi": "2042541809425543168" } }
```

NPC 下线时发布：
```json
{ "cmd": "report", "report": { "status": "offline", "cdi": "2042541809425543168" } }
```

主动探测 NPC 是否在线 — 向 `_discover` 发布带 reply 的请求：
```json
{ "cmd": "ping" }
```
NPC 会 reply：
```json
{ "cmd": "report", "report": { "status": "online", "cdi": "..." } }
```

## 4. 消息收发

连接 NATS 后，App 通过 JetStream 与 NPC 交互。每次交互都是一个完整的"发送 → 接收事件流"周期。

NPC 回复统一为 machine event JSON，格式如下：

```json
{
  "version": 2,
  "eventId": "2043591075525193728",
  "type": "assistant.final",
  "timestamp": 1776065055148,
  "channel_user_key": "1862247176453038080",
  "channel_device_id": "2042541809425543168",
  "source_message_id": "2300000000000000001",
  "run_id": "0e564af0-5d79-47a3-93ce-e27cbdf6e00f",
  "session_key": "agent:main:lucy:direct:1862247176453038080",
  "text": "Hello! 👋"
}
```

线上格式的命名规则：`channel_user_key`、`channel_device_id`、`source_message_id`、`run_id`、`session_key`、`tool_name` 使用 **snake_case**；`eventId`、`version`、`type`、`timestamp`、`text`、`metadata`、`media` 保持原样。SDK 内部 TypeScript 类型 (`LucyMachineEventSchema`) 使用 camelCase，但 App 侧收到的 JSON 是 snake_case。

### 4.1 文本对话

**发送：**

```json
{
  "version": 2,
  "messageId": "1234567890123456789",
  "text": "你好",
  "timestamp": 1775812918000
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `version` | `2` | 是 | 固定为 `2` |
| `messageId` | string | 强烈建议 | 19 位数字字符串，用于关联回复 |
| `text` | string | 条件 | `text` 和 `media` 至少一个 |
| `timestamp` | number | 否 | 毫秒时间戳 |
| `metadata` | object | 否 | 辅助信息，如 `{ "platform": "ios" }` |

**收到的事件流：**

App 会在 `cephalon.im.user.<user_id>` 上依次收到以下 machine events（均携带 `source_message_id` 指回你发的 `messageId`）：

| 事件类型 | 含义 | App 应如何处理 |
|----------|------|----------------|
| `inbound.accepted` | NPC 收到了你的消息 | 标记消息为"已送达"，显示加载指示器 |
| `assistant.start` | 模型开始生成回复 | 显示"正在输入..."状态 |
| `reasoning.partial` | 模型思考过程（流式） | 可选：显示思考气泡（可折叠） |
| `reasoning.final` | 模型思考结束 | 可选：收起思考气泡 |
| `tool.start` | 模型调用了工具 | 显示"正在使用 XX 工具..." |
| `tool.end` | 工具调用结束 | 隐藏工具状态 |
| `assistant.partial` | 回复内容（流式，累积） | **实时更新聊天气泡内容** |
| `assistant.final` | 最终完整回复 | **用此内容替换气泡，标记为完成** |
| `error` | 处理出错 | 显示错误提示 |

**典型事件序列 — 普通文本回复：**
```
inbound.accepted
assistant.start
reasoning.final          ← 模型可能跳过推理
assistant.partial "你"
assistant.partial "你好"
assistant.partial "你好！"
assistant.final   "你好！有什么可以帮助你的？"
```

**典型事件序列 — 带推理的回复：**
```
inbound.accepted
assistant.start
reasoning.partial "用户问了..."    ← 思考过程
reasoning.partial "用户问了...我应该..."
reasoning.final                   ← 思考结束
assistant.partial "根据"
assistant.partial "根据分析"
...
assistant.final   "根据分析，答案是 391。"
```

**典型事件序列 — 带工具调用的回复：**
```
inbound.accepted
assistant.start
tool.start        { tool_name: "web_search" }
tool.end          { tool_name: "web_search" }
assistant.start                               ← 工具结束后重新开始
assistant.partial "当前时间是"
...
assistant.final   "当前时间是 2026-04-10 10:28:44 UTC"
```

> **`assistant.partial` 是累积的**：`text` 字段是当前完整内容，不是增量 delta。直接用最新 partial 的 `text` 替换聊天气泡即可，不需要自己拼接。
>
> ```
> partial: "你"        ← 显示 "你"
> partial: "你好"      ← 替换为 "你好"
> partial: "你好！"    ← 替换为 "你好！"
> final:   "你好！..."  ← 最终内容，替换气泡
> ```

### 4.2 图片/媒体消息

**发送：**

媒体通过 Iroh Blob P2P 传输。发送流程：

1. 调用 `blobPut(data, fileName)` 上传文件，获得 `blobRef`
2. 在消息中携带 media descriptor
3. **必须保持 blob session 直到 NPC fetch 完成**

```json
{
  "version": 2,
  "messageId": "1234567890123456790",
  "text": "看看这张图",
  "media": {
    "transport": "iroh-blob",
    "blob_ref": "blobachohci6kqlyda5z4gprvfbvt3rqwy6hocbe...",
    "kind": "image",
    "contentType": "image/png",
    "size": 104857,
    "fileName": "photo.png"
  },
  "timestamp": 1775812918001
}
```

| media 字段 | 类型 | 必填 | 说明 |
|-----------|------|------|------|
| `transport` | string | 是 | 固定 `"iroh-blob"` |
| `blob_ref` | string | 是 | Iroh BlobTicket 字符串 |
| `kind` | string | 是 | `"image"` / `"audio"` / `"video"` / `"document"` |
| `contentType` | string | 否 | MIME 类型 |
| `size` | number | 是 | 字节数 |
| `fileName` | string | 否 | 原始文件名 |

**收到的事件流：**

事件序列与文本消息相同（`inbound.accepted` → ... → `assistant.final`）。如果 NPC 回复也包含图片/文件，`assistant.final` 会带上 `media` 字段：

```json
{
  "version": 2,
  "eventId": "2043590718422151168",
  "type": "assistant.final",
  "timestamp": 1776064971127,
  "channel_user_key": "1862247176453038080",
  "channel_device_id": "2042541809425543168",
  "text": "Here's your test image - a 100x100 red square:",
  "media": {
    "transport": "iroh-blob",
    "blob_ref": "blobadrjrapdmk7ie7dq6psiobhexjzkiozkmnkbecpsu4iowutaluno6ajpnb2hi4dthixs65lto4ys2mjoojswyylzfzxdaltjojxwqlldmfxgc4tzfzuxe33ifzwgs3tlfyxqiadrlsoo35ohaiahcxe45xsn4aqavqiqaapvy4babqfiaae7lrycaegmgbhmieuot6v3ifzdjdpcrmz5vdnut67kxdy3eoiqnn22sntqq",
    "kind": "image",
    "contentType": "image/png",
    "size": 356,
    "fileName": "test_square.png"
  }
}
```

> **注意**：带媒体的 `assistant.final` 可能没有 `source_message_id`、`run_id`、`session_key`，取决于 NPC 的处理路径（例如多轮工具调用后生成图片）。App 应容忍这些字段缺失。

App 用 `blobFetch(blob_ref)` 下载文件内容并显示。

> **媒体上传失败处理**：如果 NPC 尝试回复媒体但上传失败，且没有文本内容，App 会收到一条 `error` 事件（`text` 包含失败原因）而不是 `assistant.final`。如果有文本但媒体上传失败，App 会先收到一条 `error` 事件（警告），再收到不带 `media` 的 `assistant.final`。

### 4.3 模型配置下发

**发送：**

```json
{
  "version": 3,
  "kind": "provision_model",
  "messageId": "1234567890123456791",
  "timestamp": 1775812918002,
  "provision": {
    "providerId": "cephalon",
    "modelId": "kimi-k2.5",
    "apiKey": "sk-xxx",
    "baseUrl": "https://test.unicorn.org.cn/cephalon/user-center/v1/model",
    "switchDefaultModel": true,
    "restartRequested": true
  }
}
```

**收到的事件流：**

NPC 收到后会自动写入配置并重启，App 依次收到：

```
config.updated           ← NPC 配置已更新，提示"配置已更新"
restart.scheduled        ← NPC 正在自动重启，显示"设备重启中..."，禁用输入
    ← NPC 断开 NATS（_discover offline）
    ← NPC 重连 NATS（_discover online）
restart.completed        ← NPC 重启完成，恢复输入，显示"设备已上线"
```

如果配置更新失败，会收到 `config.error` 事件。

### 4.4 事件关联规则（重要）

App 侧收到事件后**必须按 `source_message_id` 过滤**才能把事件归到正确的 pending 请求。`cephalon.im.user.<user_id>` 是这个用户的所有 NPC 回复的单一聚合 subject，可能同时有多条输入在 agent 队列里处理，它们的 event 会交叉到达：

```
发送 A (messageId=m1) → 发送 B (messageId=m2) → ...
订阅流里会看到:
  inbound.accepted  source_message_id=m1
  assistant.start   source_message_id=m1  run_id=R1
  inbound.accepted  source_message_id=m2   ← m2 的 accepted 先于 m1 的 final 到达
  assistant.partial source_message_id=m1  run_id=R1
  assistant.final   source_message_id=m1  run_id=R1
  assistant.start   source_message_id=m2  run_id=R2
  ...
```

正确做法：
1. 本地维护 `Map<messageId, PendingRequest>`
2. 每条收到的 event 按 `source_message_id` 分发到对应的 PendingRequest
3. 在某个 PendingRequest 的 `run_id` 内部按 event 顺序更新 UI（start → reasoning → tool → partial → final）
4. 遇到 `assistant.final` 或 `error` 把对应 PendingRequest 标记完成
5. 没有 `source_message_id` 的事件（主动系统消息）单独渲染成主动通知

不要使用"抓到第一条 `assistant.final` 就结束"这种简化逻辑，会在多并发、排队、重试场景下错把别人的回复当成自己的。

### 4.5 关键字段说明

| 字段 | 说明 |
|------|------|
| `eventId` | 每条 machine event 的唯一 ID（NPC 侧 snowflake 生成），App 应按此做去重 |
| `source_message_id` | 对应 App 发送的 `messageId`，用于关联回复。**主动消息没有此字段** |
| `run_id` | 同一轮 agent 执行内部的 run 标识，同一条输入消息可能触发多个 run（如工具调用后重新推理） |
| `session_key` | OpenClaw 的会话标识，格式 `agent:<agentId>:<sessionId>` |
| `channel_user_key` / `channel_device_id` | NPC 路由信息，与 subject 的 `user_id` / `cdi` 对应 |
| `text` | `assistant.partial` 中是**累积内容**，不是增量。直接用最新的 partial 替换显示 |
| `tool_name` | `tool.start` / `tool.end` 中出现，标识具体调用的工具 |
| `media` | 仅在 `assistant.final` 中出现，格式同发送时的 media descriptor（iroh-blob） |
| `metadata` | 扩展信息。当前 iOS 按 `[String: String]?` 解码，所以值必须是扁平字符串 |

### 4.6 主动系统消息与审批事件

以下事件**没有对应的 App 发送动作**，是 NPC 主动推送的：

**主动系统消息：**

NPC 可以主动推送通知，这些事件**没有 `source_message_id`**：

```
assistant.final   "U盘同步完成（/dev/sdb1）"   ← 没有 source_message_id
```

App 应将此类事件单独渲染为系统通知，不要尝试关联到某条已发送的消息。

**审批事件（可选）：**

| 事件类型 | 含义 |
|----------|------|
| `approval.pending` | NPC 请求用户审批执行某个操作 |
| `approval.resolved` | 审批已处理 |

## 5. 错误处理

### NPC 离线

- 订阅 `_discover` 监听 online/offline 状态
- 消息发到离线的 NPC 不会立即失败（JetStream 会保存），NPC 上线后会处理
- 如果 NPC 长时间不上线（超过 JetStream 的 ack_wait 180s），消息会重投

### NATS token 过期

- `token` 有效期 300 秒（`expires_in`）
- `access_token` 有效期 7200 秒
- token 过期后 NATS 连接会断开，App 需要重新调 `/nats/token/user` 获取新 token 并重连

### 消息解码错误

- 所有 machine event 的 `metadata` 值必须是 `string` 类型
- iOS 客户端按 `[String: String]?` 解码，嵌套对象会导致整条事件解码失败
- 如果遇到解码错误，先检查 `metadata` 是否有非 string 值

## 6. 环境配置

| 变量 | test 环境 |
|------|-----------|
| user-center | `https://test.unicorn.org.cn/cephalon/user-center` |
| lucy-server | `https://test.unicorn.org.cn/aiden/lucy-server` |
| NATS | `nats://test-chat.lucy.run:4222`（由 token 接口返回） |

`base_url`（模型 API）由 `model-config` 接口返回，**不要硬编码**。

## 7. 快速验证步骤

1. 调 `/v1/login` 登录
2. 调 `/v1/channels/lucy/nats/token/user` 获取 NATS token
3. 用 token 连接 NATS
4. 订阅 `cephalon.im.user.<user_id>`
5. 向 `cephalon.im.npc.<user_id>.<cdi>` 发送 `{"version":2,"messageId":"...","text":"ping","timestamp":...}`
6. 等待收到 `inbound.accepted` → `assistant.final`
7. 确认 `assistant.final` 的 `text` 有内容

如果只收到 `inbound.accepted` 但没有后续事件，说明 NPC 的模型 provider 配置有问题（检查 OpenClaw 的 `models.providers`）。
