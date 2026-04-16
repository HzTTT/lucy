# Lucy App / SDK 侧 NATS 接入指南

本文只描述 App / SDK 直接接入 Lucy 时的对外协议边界。
如果这里与历史 demo、旧截图或调查记录冲突，以本文和当前代码为准。

权威边界是：

- JetStream 上的入站 JSON（`cephalon.im.npc.<user_id>.<cdi>`，NPC 侧 pull consumer 订阅）
- JetStream 上的 Lucy machine events（`cephalon.im.user.<user_id>`，NPC 侧 `js.publish` 发布；App 侧由 `lucy-im-sdk-kotlin` 通过 IM_USER JetStream consumer 消费）
- Iroh Blob 上的媒体字节（App 与 NPC 两端本地跑 `lucy-blob` native 模块，通过 P2P blob ref 互相抓取；消息 JSON 里只带 `blob_ref`，不带字节）
- Core NATS 上的 presence / heartbeat / discover（SDK 内部自动处理，App 通常不关心）

不要把 OpenClaw 内部 session transcript、模型 provider 原始响应或历史 debug 日志当成对外协议。

## 1. 前置条件

在 App 接入前，Lucy 所在的 OpenClaw 必须已经：

1. 安装并启用 Lucy 插件
2. SDK 完成设备初始化（Ed25519 密钥对 + 设备注册获得 `cdi`）
3. 完成绑定（获得 `cuk` 和 `user_id`）
4. 通过 SDK 换取 NATS token 并成功连接
5. 如需自动切换模型，当前用户还应能访问：
   - `GET /v1/channels/lucy/current-user/model-config`

当前推荐流程：

- App 登录 `user-center`
- App 获取当前用户绑定设备列表
- App 获取当前用户自己的 `cuk`
- App 通过自己的 SDK（`lucy-im-sdk-kotlin`）连接 NATS

## 2. 凭据来源

NATS 连接不再使用 username/password。

NPC 侧（本插件）通过 `lucy-im-sdk-nodejs` 的 Ed25519 签名向 `lucy-server` 换取 NATS token：

- `POST /v1/channels/lucy/nats/token/npc`
- 签名参数：`cdi`, `kind`, `nonce`, `ts`, `cuk`
- 返回：`token`, `nats_url`, `access_token`

App 侧通过 `lucy-im-sdk-kotlin` 获取自己的 NATS 凭据（IM_USER JetStream，协议与 NPC 侧不同）。

推荐的 App 侧取数方式：

1. `POST {user-center}/v1/login`
2. `POST {lucy-server}/v1/channels/lucy/nats/token/user`（获取 NATS 连接凭据）
3. `GET {user-center}/v1/channels/lucy/current-user/model-config`（获取模型配置）

### `current-user/model-config`

```json
{
  "code": 20000,
  "msg": "操作成功",
  "data": {
    "channel": "lucy",
    "provider_id": "cephalon",
    "api_key": "sk_xxx",
    "base_url": "https://test.unicorn.org.cn/cephalon/user-center/v1/model",
    "default_model_id": "kimi-k2.5",
    "created": false,
    "models": [
      {
        "id": "kimi-k2.5",
        "label": "Kimi K2.5",
        "enabled": true,
        "is_default": true
      }
    ]
  }
}
```

说明：

- `provider_id` 当前固定为 `cephalon`
- `models[]` 当前只有 `kimi-k2.5`，但客户端 UI 应按列表渲染，给未来多模型扩展预留入口
- `base_url` 必须视当前 user-center 环境返回，客户端和插件都不应写死 prod / test
- `created` 表示这次访问是否懒创建了 Lucy 专用 API key

## 3. 连接方式

SDK 从 `lucy-server` 的 token 响应中获取 `nats_url`，直接使用该地址连接。
NATS 地址由服务端动态下发，客户端不应硬编码。

## 4. Subject 约定

Lucy 使用 JetStream 进行消息收发。Subject 由业务与后端约定，SDK 不自动生成。

### 消息通道（JetStream）

NPC 侧：

```text
subscribe = cephalon.im.npc.<user_id>.<cdi>
publish   = cephalon.im.user.<user_id>
```

JetStream 配置（NPC 侧 pull consumer，`lucy-im-sdk-nodejs` 自动创建）：

- Stream: `IM_NPC`（`kind=lucy`），`IM_NAS`（`kind=nas`）
- Durable consumer: `npc-<cdi>`（`kind=lucy`），`nas-<cdi>`（`kind=nas`）
- Ack policy: Explicit，ack_wait = 180s
- Deliver policy: **`New`**（新 durable 只消费创建之后到达的消息；已存在的 durable 由 ack floor 决定回放位置，首次 create 之后的 deliver_policy 不再生效）
- Replay policy: Instant

方向约定：

- **App → NPC**：App 的 `lucy-im-sdk-kotlin` 用 `js.publish` 把入站 JSON 写入 `cephalon.im.npc.<user_id>.<cdi>`（后端绑定到 `IM_NPC` 流），NPC 侧 pull consumer 拉取并处理
- **NPC → App**：NPC 的 `lucy-im-sdk-nodejs` 用 `js.publish` 把 machine event 写入 `cephalon.im.user.<user_id>`（后端绑定到 `IM_USER` 流），App 通过自己的 JetStream consumer 消费

App 侧重启或短暂离线时，只要 JetStream 保留窗口内的消息尚未过期，新建 consumer 仍会补发 —— 相比 core NATS 订阅有明显优势，避免掉事件。

### Presence（SDK 内部处理）

Presence 由 `lucy-im-sdk` 内部自动管理，应用层不需要额外处理：

- SDK 连接后自动向 `cephalon.im.npc.<user_id>._discover` 发布 online
- SDK 自动 30 分钟心跳到 `client.status.report`
- SDK 自动响应 `_discover` 上的 `cmd: "ping"` 请求
- SDK 关闭时自动发布 offline

Presence 消息格式（JSON）：

```json
{
  "cmd": "report",
  "report": {
    "status": "online",
    "cdi": "2034248517330624512"
  }
}
```

Heartbeat 消息格式（发到 `client.status.report`）：

```json
{
  "cmd": "heartbeat",
  "heartbeat": {
    "client_id": "42",
    "cdi": "2034248517330624512",
    "user_id": "2032791907809468416"
  }
}
```

## 5. App -> Lucy：入站消息协议

当前推荐同时支持：

- `version = 2`：普通聊天消息（单媒体）
- `version = 3`：控制消息（例如模型配置下发）
- `version = 4`：多媒体聊天消息（当前推荐）

### 文本消息示例

```json
{
  "version": 2,
  "messageId": "1773582494346106545",
  "text": "hello",
  "timestamp": 1773582494346,
  "metadata": {
    "platform": "ios"
  }
}
```

### 文本 + 媒体示例

```json
{
  "version": 2,
  "messageId": "1773582494346106546",
  "text": "describe this image",
  "media": {
    "transport": "iroh-blob",
    "blob_ref": "nodeticket:aeat...",
    "kind": "image",
    "contentType": "image/png",
    "size": 104857,
    "fileName": "photo.png",
    "fileHash": "blake3:0f4c2b..."
  },
  "timestamp": 1773582494347
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | `2` / `4` | 是 | `2` = 单媒体，`4` = 多媒体（推荐） |
| `kind` | `string` | V4 必填 | `"chat"` 或 `"provision_model"`（V4 only） |
| `messageId` | `string` | 强烈建议 | 建议始终提供；必须是 19 位数字字符串 |
| `text` | `string` | 条件必填 | `text`、`media`、`attachments` 至少一个存在 |
| `media` | `object` | 条件必填 | 单个媒体 descriptor（V2 兼容字段） |
| `attachments` | `object[]` | 条件必填 | 多个媒体 descriptor 数组（V4 推荐） |
| `timestamp` | `number` | 否 | 毫秒时间戳 |
| `metadata` | `Record<string, unknown>` | 否 | 辅助观测信息 |

注意：入站消息中不再需要 `channelUserKey` / `channelDeviceId` 字段，因为 subject 本身已经包含了路由信息。

### 模型配置下发消息示例

```json
{
  "version": 3,
  "kind": "provision_model",
  "messageId": "1773582494346106547",
  "timestamp": 1773582494348,
  "metadata": {
    "platform": "ios"
  },
  "provision": {
    "providerId": "cephalon",
    "modelId": "kimi-k2.5",
    "apiKey": "sk_xxx",
    "baseUrl": "https://test.unicorn.org.cn/cephalon/user-center/v1/model",
    "switchDefaultModel": true,
    "restartRequested": true
  }
}
```

约束：

- 当前只支持 `providerId = cephalon`
- 当前只支持 `modelId = kimi-k2.5`
- 该消息不会进入普通聊天 agent 链路，而是由 Lucy 插件直接处理

### V4 多媒体消息示例

```json
{
  "version": 4,
  "kind": "chat",
  "messageId": "1773582494346106548",
  "text": "describe these images",
  "attachments": [
    {
      "transport": "iroh-blob",
      "blob_ref": "nodeticket:aeat1...",
      "kind": "image",
      "contentType": "image/png",
      "size": 104857,
      "fileName": "photo1.png"
    },
    {
      "transport": "iroh-blob",
      "blob_ref": "nodeticket:aeat2...",
      "kind": "image",
      "contentType": "image/jpeg",
      "size": 204800,
      "fileName": "photo2.jpg"
    }
  ],
  "timestamp": 1773582494349
}
```

### V4 attachments 兼容性规则

- `attachments` 优先于 `media`：当 `attachments` 存在且非空时，忽略 `media` 字段
- 仅 `media` 存在时等价于 `attachments: [media]`（向后兼容 V2）
- 单个附件大小不超过 `mediaMaxMb`（默认 20 MB）
- 附件数量不超过 `maxAttachments`（默认 10，最大 20）；超出部分静默截断
- V4 的 `kind` 字段必填：`"chat"` 或 `"provision_model"`

## 6. Lucy -> App：machine event 协议

当前 machine event 为 `version = 2`，典型顺序如下：

1. `inbound.accepted`
2. `assistant.start`
3. `reasoning.partial` / `reasoning.final`（可选）
4. `tool.start` / `tool.end`（可选）
5. `assistant.partial`（0..n）
6. `assistant.final`

当 App 下发模型配置时，会额外出现：

1. `config.updated`
2. `restart.scheduled`
3. `restart.completed`

### 当前真实事件样例

```json
{
  "version": 2,
  "eventId": "2033178474344333312",
  "type": "assistant.final",
  "timestamp": 1773582497570,
  "channel_user_key": "cuk_demo_user",
  "channel_device_id": "2033138771050475520",
  "sourceMessageId": "1773582494346106545",
  "runId": "4f3ae523-b2d9-424f-bdd9-308c5eb75635",
  "sessionKey": "agent:main:main",
  "text": "LUCY_E2E_OK"
}
```

### 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | 当前固定为 `2` |
| `eventId` | 是 | 事件唯一 id |
| `type` | 是 | 见下方事件类型 |
| `timestamp` | 是 | 毫秒时间戳 |
| `channel_user_key` | 是 | 当前用户标识 |
| `channel_device_id` | 是 | 当前设备 cdi |
| `sourceMessageId` | 否 | 对应哪条用户输入 |
| `runId` | 否 | 同一轮执行内部 run 标识 |
| `sessionKey` | 否 | OpenClaw session key |
| `text` | 否 | partial/final/reasoning/error 文本 |
| `toolName` | 否 | tool.start/tool.end 使用 |
| `metadata` | 否 | 扩展信息，不保证结构稳定；当前 iOS 客户端按 `[String: String]?` 解码，所以新增字段时优先使用扁平字符串键值 |
| `media` | 否 | `assistant.final` 的第一个媒体 descriptor（兼容字段） |
| `attachments` | 否 | `assistant.final` 的全部媒体 descriptor 数组 |

### 主动系统消息

Lucy 除了回复用户输入外，也可以主动推送没有 `sourceMessageId` 的 `assistant.final`。当前已使用的场景包括：

- `message` 工具主动推送内容
- 本地 `channels.lucy.localNotify` HTTP 入口接收到系统通知

客户端应把这类事件当成"主动消息"处理，而不是强依赖它一定能关联到一条用户输入。

### 事件类型

- `inbound.accepted`
- `assistant.start`
- `assistant.partial`
- `assistant.final`
- `reasoning.partial`
- `reasoning.final`
- `tool.start`
- `tool.end`
- `error`
- `approval.pending`
- `approval.resolved`
- `config.updated`
- `config.error`
- `restart.scheduled`
- `restart.completed`

### 自动重启语义

当 Lucy 接收到有效的 `provision_model` 消息后：

1. 先写入 OpenClaw 的 `models.providers.cephalon.*`
2. 再把主 agent 默认模型切到 `cephalon/kimi-k2.5`
3. 如果已启用 `plugins.entries.multimodal-rag`，且其 `ollama.baseUrl` 已配置为绝对 `cephalon ... /v1/model` URL，或 `whisper.zhipuApiBaseUrl` 已配置为绝对 `cephalon ... /v1/model` / `cephalon ... /v1/model/v1` URL，则把同一份 `apiKey` 额外写入对应的 `ollama.apiKey` / `whisper.zhipuApiKey`
4. 非 cephalon URL、相对路径、或未启用的 `multimodal-rag` 配置不会被自动改写
5. 发 `config.updated`
6. 发 `restart.scheduled`
7. 自动执行 `openclaw gateway restart`

因此 App 不应把 `restart.scheduled` 理解为"请用户手动点击重启"，而应把它理解为：

- "设备已接收配置，正在自动重启"
- 随后等待 `restart.completed`

## 6.1 Lucy 本地通知 HTTP 入口

当 Lucy 配置了：

```json
{
  "channels": {
    "lucy": {
      "localNotify": {
        "enabled": true,
        "bind": "127.0.0.1",
        "port": 8788,
        "path": "/usb-events"
      }
    }
  }
}
```

它会在本机监听 `http://127.0.0.1:8788/usb-events`，接收本地 daemon 发送的：

```json
{
  "code": 1,
  "device": "/dev/sdb1",
  "timestamp": "2026-03-30T19:02:00.000000",
  "message": ""
}
```

`port` 和 `path` 都是配置项，不是协议常量。如果 Lucy 改成监听例如 `http://127.0.0.1:8000/usb-events`，本地 daemon 的 `notify.url` 也必须同步改成同一个地址。

然后把它转换成主动推送的 `assistant.final`：

- `text` 为用户可读文案，例如 `U盘同步完成（/dev/sdb1）`
- `metadata` 用扁平字符串字段保留原始语义：

```json
{
  "localNotifyCode": "3",
  "localNotifyCodeName": "usb.synced",
  "localNotifyDevice": "/dev/sdb1",
  "localNotifyTimestamp": "2026-03-30T19:02:00.000000",
  "localNotifyMessage": ""
}
```

当前 `codeName` 约定：

- `1` -> `usb.inserted`
- `2` -> `usb.syncing`
- `3` -> `usb.synced`
- `4` -> `usb.failed`
- `5` -> `usb.removed`

不要把这组本地通知元数据改回嵌套对象。当前 iOS `LucyMachineEvent` 会把 `metadata` 直接解成 `[String: String]?`，嵌套 JSON 会导致整条 machine event 解码失败。

## 7. 媒体上传 / 下载（Iroh Blob）

Lucy 不在消息 JSON 中携带媒体字节本体。当前走的是 **Iroh Blob P2P**（`lucy-im-sdk` 内置的 `lucy-blob` native 模块）：发送端把本地字节喂给 `blobPut()`，拿到 `blob_ref`（ticket 字符串）和 `fileHash`；接收端收到 descriptor 后用 `blobFetch(blob_ref)` 直接从对端拉取。Iroh session 期间 blob 才可达，发送端调用 `session.close()` 或进程退出后，对应 ref 立即失效，所以通常由一条消息的生命周期决定。

### 上行（App → NPC）

1. App 本地调 `blobPut(bytes, fileName)` → `{blobRef, fileHash}`
2. App publish 入站 JSON，在 `media` 字段里带 `{transport:"iroh-blob", blob_ref, fileHash, kind, size, ...}`
3. NPC 收到 inbound 后立刻 `blobFetch(blob_ref)` 把字节拉下来注入 OpenClaw inbound context
4. App 可以在收到 `inbound.accepted`（或更保守一点，收到 `assistant.start` / `assistant.final`）之后释放 blob session

### 下行（NPC → App）

1. agent 用 `message` 工具发送本地文件时，NPC 在本地 `blobPut` 后把 `blob_ref` 写进 `assistant.final` 的 `media` 字段
2. App 收到后调 `blobFetch(blob_ref)` 把字节取回本地缓存
3. NPC 会在发送完成后一段时间保持 blob session 开启；App 应尽快抓取

### descriptor 定义

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `transport` | 是 | 固定为 `iroh-blob` |
| `blob_ref` | 是 | Iroh ticket 字符串，任意长度 |
| `kind` | 是 | `image` 或 `audio` |
| `contentType` | 否 | MIME 类型 |
| `size` | 是 | 字节数，客户端 `blobFetch` 后应校验 |
| `fileName` | 否 | 原始文件名 |
| `fileHash` | 否 | 如 `blake3:...`，用于可选内容校验 |

## 8. 调试边界

排障时按边界判断：

- 有 `inbound.accepted`
  - 说明 JetStream consumer、Lucy listener、OpenClaw 路由已经打通
- 有 `assistant.start`
  - 说明模型执行已经开始
- 有 `assistant.final`
  - 说明 Lucy 传输层与模型层都已走通
- App 显示通用解码错误
  - 先查客户端 machine event decoder，再怀疑后端

## 9. 历史字段说明

旧的 `apiKey/deviceId/version=1` 文档样本已经从当前正文档里移除。
旧的 Core NATS `client/machine` subject 模式、`username=channelUserKey / password=channelDeviceId` 认证、纯文本 presence 格式均已废弃。

当前所有消息收发使用 JetStream，NATS 认证使用 Ed25519 签名换取的 token。
