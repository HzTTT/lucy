# Lucy App / SDK 侧 NATS 接入指南

本文只描述 App / SDK 直接接入 Lucy 时的对外协议边界。  
如果这里与历史 demo、旧截图或调查记录冲突，以本文和当前代码为准。

权威边界是：

- `client` subject 上的入站 JSON
- `machine` subject 上的 Lucy machine events
- JetStream Object Store 中的媒体对象

不要把 OpenClaw 内部 session transcript、模型 provider 原始响应或历史 debug 日志当成对外协议。

## 1. 前置条件

在 App 接入前，Lucy 所在的 OpenClaw 必须已经：

1. 安装并启用 Lucy 插件
2. 完成设备 bootstrap
3. 通过 `user-center` 完成绑定
4. 拿到绑定后的：
   - `channel_user_key`
   - `channel_device_id`
5. 成功连接 NATS

当前推荐流程不是手工配置固定 `demo_user`，而是：

- App 登录 `user-center`
- App 获取当前用户绑定设备列表
- App 获取当前用户自己的 `channel_user_key`
- App 用 `channel_user_key + channel_device_id` 连接 NATS

## 2. 凭据来源

对 NATS 来说：

- `username = channel_user_key`
- `password = channel_device_id`

推荐的 App 侧取数方式：

1. `POST /v1/login`
2. `GET /v1/channels/lucy/current-user/device-bindings`
3. `GET /v1/channels/lucy/current-user/credential`

当前真实响应示例：

### `current-user/device-bindings`

```json
{
  "code": 20000,
  "msg": "操作成功",
  "data": {
    "devices": [
      {
        "channel": "lucy",
        "channel_device_id": "2033138771050475520",
        "binding_status": "bound",
        "bound_at": "2026-03-15T19:18:14.970013+08:00"
      }
    ]
  }
}
```

### `current-user/credential`

```json
{
  "code": 20000,
  "msg": "操作成功",
  "data": {
    "channel": "lucy",
    "channel_user_key": "cuk_xxx",
    "status": "active"
  }
}
```

## 3. 连接方式

Lucy 代码支持：

- 原生 NATS/TLS：`nats://`、`tls://`
- NATS over WebSocket：`ws://`、`wss://`

要用哪一种，取决于服务端实际开放的入口。  
当前已验证的部署使用的是：

```text
nats://chat.lucy.run:4222
```

## 4. Subject 约定

Lucy 使用以下 NATS subjects：

### 消息通道

```text
client  = {subjectPrefix}.{channelUserKey}.{channelDeviceId}.client
machine = {subjectPrefix}.{channelUserKey}.{channelDeviceId}.machine
```

### Presence（设备在线状态）

```text
discover = {subjectPrefix}.{channelUserKey}._discover
ping     = {subjectPrefix}.{channelUserKey}.{channelDeviceId}.ping
```

默认 `subjectPrefix`：

```text
cephalon.im.npc
```

方向约定：

- App -> Lucy：向 `client` subject 发布入站 JSON
- Lucy -> App：订阅 `machine` subject 接收生命周期事件
- Lucy -> App：设备连接 NATS 后，向 `_discover` 发布 `online\n{channelDeviceId}`，每 30s 重复；关闭时发 `offline\n{channelDeviceId}`
- App -> Lucy：向 `ping` subject 发布任意内容，设备立即回复一次 `online` 到 `_discover`（用于首次快速探测）
- 异常断线：presence-bridge 通过 `$SYS.ACCOUNT` 检测到设备断开，自动向 `_discover` 发布 `offline`

### Presence 消息格式

`_discover` subject 上的消息为 UTF-8 纯文本，两行：

```text
online
2034248517330624512
```

第一行：`online` 或 `offline`  
第二行：`channelDeviceId`

### Presence 注册（设备端 → presence-bridge）

设备连接 NATS 后向 `client.status.report` 发布一次注册：

```json
{
  "client_id": 42,
  "apikey": "cuk_xxx",
  "npc_id": "2034248517330624512"
}
```

其中 `client_id` 来自 `connection.info.client_id`。这让 presence-bridge 能在异常断线时通过 `$SYS.ACCOUNT` disconnect 事件找到对应设备并广播 offline。

### App 端建议

1. App 连接 NATS 后订阅 `_discover` subject
2. 立即向 `ping` subject 发一次消息触发即时 online 响应
3. 收到 `online` 时标记设备在线，重置 45s 超时计时器
4. 收到 `offline` 或 45s 无心跳时标记设备离线

### TODO

- TODO(2026-03-23): 校正多设备账号下的在线态语义。当前 `_discover` 是按 `channelUserKey` 共享的 presence 频道，同一账号绑定多台 `channelDeviceId` 时，App 在线 UI 需要按 `channelDeviceId` 分设备跟踪，不能只按单一用户态显示。
- TODO(2026-03-23): 复查 OpenClaw 设备在多设备场景下的 `_discover` 心跳可见性。已观察到同账号下另一台设备会稳定广播 `online`, 但 OpenClaw 设备是否总能被 App 正确识别仍需单独验证与修复。

## 5. App -> Lucy：入站消息协议

当前推荐使用 `version = 2`。

### 文本消息示例

```json
{
  "version": 2,
  "messageId": "1773582494346106545",
  "text": "hello",
  "timestamp": 1773582494346,
  "metadata": {
    "platform": "ios"
  },
  "channelUserKey": "cuk_demo_user",
  "channelDeviceId": "2031655882831360000"
}
```

### 文本 + 媒体示例

```json
{
  "version": 2,
  "messageId": "1773582494346106546",
  "text": "describe this image",
  "media": {
    "transport": "jetstream-object-store",
    "bucket": "lucy_media_v2",
    "key": "inbound/cuk_demo_user/2031655882831360000/1773582494346106546-photo.png",
    "kind": "image",
    "contentType": "image/png",
    "size": 104857,
    "fileName": "photo.png",
    "sha256": "0f4c2b..."
  },
  "timestamp": 1773582494347
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | `2` | 是 | 当前推荐固定为 `2` |
| `messageId` | `string` | 强烈建议 | 建议始终提供；必须是 19 位数字字符串 |
| `text` | `string` | 条件必填 | `text` 与 `media` 至少一个存在 |
| `media` | `object` | 条件必填 | 单个媒体 descriptor |
| `timestamp` | `number` | 否 | 毫秒时间戳 |
| `metadata` | `Record<string, unknown>` | 否 | 辅助观测信息 |
| `channelUserKey` | `string` | 否 | 如果传递，必须与 subject 命名空间一致 |
| `channelDeviceId` | `string` | 否 | 如果传递，必须与 subject 命名空间一致 |

### 兼容别名

Lucy 当前代码仍兼容这些旧字段：

- `apiKey`
- `deviceId`

但新接入端应优先发送：

- `channelUserKey`
- `channelDeviceId`

## 6. Lucy -> App：machine event 协议

当前 machine event 为 `version = 2`，典型顺序如下：

1. `inbound.accepted`
2. `assistant.start`
3. `reasoning.partial` / `reasoning.final`（可选）
4. `tool.start` / `tool.end`（可选）
5. `assistant.partial`（0..n）
6. `assistant.final`

### 当前真实事件样例

```json
{
  "version": 2,
  "eventId": "2033178474344333312",
  "type": "assistant.final",
  "timestamp": 1773582497570,
  "channelUserKey": "cuk_demo_user",
  "channelDeviceId": "2033138771050475520",
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
| `channelUserKey` | 是 | 当前命名空间 |
| `channelDeviceId` | 是 | 当前设备 id |
| `sourceMessageId` | 否 | 对应哪条用户输入 |
| `runId` | 否 | 同一轮执行内部 run 标识 |
| `sessionKey` | 否 | OpenClaw session key |
| `text` | 否 | partial/final/reasoning/error 文本 |
| `toolName` | 否 | tool.start/tool.end 使用 |
| `metadata` | 否 | 扩展信息，不保证结构稳定 |
| `media` | 否 | `assistant.final` 的媒体 descriptor |

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

### iOS / Swift 客户端必须兼容的字段名

线上 machine event 当前发送的是：

- `channelUserKey`
- `channelDeviceId`

客户端不能只认：

- `channelDeviceID`
- `channel_device_id`
- `deviceId`

否则会直接解码失败。

## 7. 媒体上传 / 下载

Lucy 不在 `client` 消息中携带媒体字节本体。正确顺序是：

1. App 先把文件上传到 JetStream Object Store
2. App 在入站 JSON 的 `media` 字段里携带 descriptor
3. Lucy 下载对象并注入 OpenClaw inbound context

descriptor 定义：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `transport` | 是 | 固定为 `jetstream-object-store` |
| `bucket` | 是 | Object Store bucket，默认 `lucy_media_v2` |
| `key` | 是 | 对象 key |
| `kind` | 是 | `image` 或 `audio` |
| `contentType` | 否 | MIME 类型 |
| `size` | 是 | 字节数 |
| `fileName` | 否 | 原始文件名 |
| `sha256` | 否 | 内容校验 |

## 8. 调试边界

排障时按边界判断：

- 有 `inbound.accepted`
  - 说明 NATS subject、Lucy listener、OpenClaw 路由已经打通
- 有 `assistant.start`
  - 说明模型执行已经开始
- 有 `assistant.final`
  - 说明 Lucy 传输层与模型层都已走通
- App 显示通用解码错误
  - 先查客户端 machine event decoder，再怀疑后端

## 9. 历史字段说明

旧的 `apiKey/deviceId/version=1` 文档样本已经从当前正文档里移除。  
如果你还在兼容历史客户端，只把这些字段当成兼容输入，不要再把它们当成新的接入示例。
