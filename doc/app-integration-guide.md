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

### 2.3 查询已绑定设备

```
GET {user-center}/v1/channels/lucy/current-user/device-bindings
Authorization: Bearer <token>

→ {
    "code": 20000,
    "data": {
      "devices": [
        {
          "channel": "lucy",
          "channel_device_id": "2042541809425543168",
          "binding_status": "bound",
          "bound_at": "2026-04-10T16:56:49+08:00"
        }
      ]
    }
  }
```

### 2.4 获取 NATS 连接凭据

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

### 2.5 获取用户凭据

```
GET {user-center}/v1/channels/lucy/current-user/credential
Authorization: Bearer <token>

→ {
    "code": 20000,
    "data": {
      "channel": "lucy",
      "channel_user_key": "cuk-xxx",
      "status": "active"
    }
  }
```

### 2.6 获取模型配置

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

可用 Core NATS subscribe 或 JetStream consumer（stream `IM_USER`, durable `user-<user_id>`）。

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

## 4. 发送消息格式

### 4.1 文本消息

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

### 4.2 图片/媒体消息

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

### 4.3 模型配置下发

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

NPC 收到后会自动写入配置并重启。

## 5. 接收 Machine Event（NPC 回复）

NPC 通过 `cephalon.im.user.<user_id>` 发送 machine events。所有事件都是 JSON，统一格式：

```json
{
  "version": 2,
  "eventId": "2042541809425543169",
  "type": "assistant.final",
  "timestamp": 1775812920000,
  "channel_user_key": "1862247176453038080",
  "channel_device_id": "2042541809425543168",
  "source_message_id": "1234567890123456789",
  "run_id": "uuid",
  "session_key": "agent:main:main",
  "text": "你好！有什么可以帮助你的？"
}
```

### 5.1 事件类型及处理方式

#### 消息生命周期事件（按顺序）

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

#### 配置与重启事件

| 事件类型 | 含义 | App 应如何处理 |
|----------|------|----------------|
| `config.updated` | NPC 配置已更新 | 提示"配置已更新" |
| `config.error` | 配置更新失败 | 显示错误 |
| `restart.scheduled` | NPC 正在自动重启 | 显示"设备重启中..."，禁用输入 |
| `restart.completed` | NPC 重启完成 | 恢复输入，显示"设备已上线" |

#### 审批事件（可选）

| 事件类型 | 含义 |
|----------|------|
| `approval.pending` | NPC 请求用户审批执行某个操作 |
| `approval.resolved` | 审批已处理 |

### 5.2 典型事件序列

**普通文本回复：**
```
inbound.accepted
assistant.start
reasoning.final          ← 模型可能跳过推理
assistant.partial "你"
assistant.partial "你好"
assistant.partial "你好！"
assistant.final   "你好！有什么可以帮助你的？"
```

**带推理的回复：**
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

**带工具调用的回复：**
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

**模型配置下发后：**
```
config.updated
restart.scheduled
    ← NPC 断开 NATS（_discover offline）
    ← NPC 重连 NATS（_discover online）
restart.completed
```

**主动系统消息（无 source_message_id）：**
```
assistant.final   "U盘同步完成（/dev/sdb1）"   ← 没有 source_message_id
```

### 5.3 关键字段说明

| 字段 | 说明 |
|------|------|
| `source_message_id` | 对应 App 发送的 `messageId`，用于关联回复。**主动消息没有此字段** |
| `run_id` | 同一轮对话的 run 标识，同一条消息可能有多个 run（如工具调用后重新推理） |
| `session_key` | OpenClaw 的会话标识，格式 `agent:<agentId>:<sessionId>` |
| `text` | `assistant.partial` 中是**累积内容**，不是增量。直接用最新的 partial 替换显示 |
| `media` | 仅在 `assistant.final` 中出现，格式同发送时的 media descriptor |
| `metadata` | 扩展信息。当前 iOS 按 `[String: String]?` 解码，所以值必须是扁平字符串 |

### 5.4 assistant.partial 的处理

`assistant.partial` 的 `text` 是**累积的完整文本**，不是增量 delta。

```
partial: "你"        ← 显示 "你"
partial: "你好"      ← 替换为 "你好"
partial: "你好！"    ← 替换为 "你好！"
final:   "你好！..."  ← 最终内容，替换气泡
```

App 应该直接用最新 partial 的 `text` 替换聊天气泡，不需要自己做拼接。

### 5.5 assistant.final 带媒体

如果 NPC 回复包含图片/文件：

```json
{
  "type": "assistant.final",
  "text": "这是生成的图片",
  "media": {
    "transport": "iroh-blob",
    "blob_ref": "blobxxx...",
    "kind": "image",
    "contentType": "image/png",
    "size": 204800,
    "fileName": "output.png"
  }
}
```

App 用 `blobFetch(blob_ref)` 下载文件内容并显示。

## 6. 错误处理

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

## 7. 环境配置

| 变量 | test 环境 |
|------|-----------|
| user-center | `https://test.unicorn.org.cn/cephalon/user-center` |
| lucy-server | `https://test.unicorn.org.cn/aiden/lucy-server` |
| NATS | `nats://test-chat.lucy.run:4222`（由 token 接口返回） |

`base_url`（模型 API）由 `model-config` 接口返回，**不要硬编码**。

## 8. 快速验证步骤

1. 调 `/v1/login` 登录
2. 调 `/v1/channels/lucy/nats/token/user` 获取 NATS token
3. 用 token 连接 NATS
4. 订阅 `cephalon.im.user.<user_id>`
5. 向 `cephalon.im.npc.<user_id>.<cdi>` 发送 `{"version":2,"messageId":"...","text":"ping","timestamp":...}`
6. 等待收到 `inbound.accepted` → `assistant.final`
7. 确认 `assistant.final` 的 `text` 有内容

如果只收到 `inbound.accepted` 但没有后续事件，说明 NPC 的模型 provider 配置有问题（检查 OpenClaw 的 `models.providers`）。
