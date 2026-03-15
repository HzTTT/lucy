# Lucy 鉴权绑定整合文档

本文把当前已经落地的 Lucy 鉴权绑定方案收敛成一份统一说明，包含：

- 统一术语
- 模块职责
- 主流程
- 一张时序图

后续如果插件、iOS App、`npc-im-server`、`user-center` 之间出现理解偏差，以本文为准。

## 1. 统一术语

- `channel_user_key`
  - 旧的 `apikey`
  - 本质没变，只是统一改名

- `channel_device_id`
  - 旧的 `device_id`
  - 本质没变，只是统一改名

- `bootstrap_token`
  - 设备 bootstrap 阶段自证明凭据
  - 只由插件自己持有
  - 服务端只保存其 hash

- 对 NATS 来说：
  - `username = channel_user_key`
  - `password = channel_device_id`

## 2. 各模块职责

### `user-center`

负责：

- 保存 `channel_user_key`
- 保存 `channel_device_id`
- 保存 `bootstrap_token_hash`
- 保存用户与设备的绑定关系
- 提供注册、绑定、查询、连接校验接口

不负责：

- 不负责 NATS 长连接
- 不负责消息收发
- 不负责插件运行逻辑

### Lucy 插件

负责：

- 生成并持久化 `channel_device_id`
- 生成并持久化 `bootstrap_token`
- 向 `user-center` 注册设备
- 轮询绑定状态
- 拿到绑定后的 `channel_user_key`
- 用 `channel_user_key + channel_device_id` 连接 NATS

### iOS App

负责：

- 登录 `user-center`
- 扫描插件提供的绑定二维码
- 绑定 Lucy 设备
- 查询当前用户已绑定设备
- 查询当前用户自己的 `channel_user_key`
- 如需要，自己用 `channel_user_key + channel_device_id` 连接 NATS

### `npc-im-server` / `auth-callout`

负责：

- 从 NATS 握手里读取 `username/password`
- 将其解释为 `channel_user_key/channel_device_id`
- 调 `user-center` 的 Lucy 校验接口
- 按返回的 `user_id` 签发最小权限

不负责：

- 不保存绑定关系
- 不维护设备状态真相

## 3. 主流程

### 第一步：插件创建设备身份

Lucy 插件首次启动时：

1. 生成并持久化 `channel_device_id`
2. 生成并持久化 `bootstrap_token`

### 第二步：插件向 `user-center` 注册设备

Lucy 插件调用：

- `POST /v1/channels/lucy/devices/registrations`

请求体：

```json
{
  "channel_device_id": "2031655882831360000",
  "bootstrap_token": "cbt_xxx"
}
```

`user-center` 只记录：

- `channel_device_id`
- `bootstrap_token_hash`
- 当前 `binding_status = pending`

### 第三步：用户在 iOS App 登录 `user-center`

iOS App 调用：

- `POST /v1/login`

拿到普通用户登录 token。  
后续 App 用这个 token 去调 Lucy 绑定相关接口。

### 第四步：插件输出绑定二维码

Lucy 插件通过命令输出：

- `openclaw lucy auth-qrcode`

开发环境也可以直接运行：

- `pnpm --filter @hzttt/lucy auth-qrcode`

二维码内容建议为：

```text
lucy://bind?channel_device_id=2031655882831360000
```

### 第五步：用户在 App 里扫描并绑定设备

iOS App 扫码得到：

- `channel_device_id`

iOS App 调用：

- `PUT /v1/channels/lucy/device-bindings/{channel_device_id}`

`user-center` 建立：

- `user <-> channel_device_id`

如果这个用户第一次绑定 Lucy 设备，则懒创建唯一的：

- `channel_user_key`

### 第六步：插件轮询自己的绑定状态

Lucy 插件调用：

- `GET /v1/channels/lucy/device-bindings/{channel_device_id}`

并带请求头：

- `X-Bootstrap-Token: <bootstrap_token>`

如果还未绑定，只返回：

- `binding_status = pending`

如果已经绑定，则返回：

- `binding_status = bound`
- `channel_user_key`

### 第七步：Lucy 插件正式连接 NATS

Lucy 插件用：

- `user = channel_user_key`
- `pass = channel_device_id`

建立 NATS 连接。

### 第八步：iOS App 如需直连 NATS

iOS App 先调用：

- `GET /v1/channels/lucy/current-user/device-bindings`
- `GET /v1/channels/lucy/current-user/credential`

拿到：

- 当前用户已绑定的 `channel_device_id`
- 当前用户唯一的 `channel_user_key`

然后同样使用：

- `user = channel_user_key`
- `pass = channel_device_id`

连接 NATS。

### 第九步：`auth-callout` 校验连接

`npc-im-server/auth-callout` 从 NATS 握手里取：

- `username -> channel_user_key`
- `password -> channel_device_id`

然后调用：

- `POST /v1/channels/lucy/connection-verifications`

请求体：

```json
{
  "channel_user_key": "cuk_xxx",
  "channel_device_id": "2031655882831360000"
}
```

`user-center` 校验这组组合是否合法。  
如果合法，返回：

```json
{
  "ok": true,
  "user_id": "2032791907809468416",
  "channel_device_id": "2031655882831360000"
}
```

`auth-callout` 再基于这个 `user_id` 给 NATS 签发最小权限。

## 4. 时序图

```mermaid
sequenceDiagram
    participant Plugin as Lucy 插件
    participant App as iOS App
    participant UC as user-center
    participant NATS as NATS
    participant Auth as auth-callout

    Note over Plugin: 首次启动
    Plugin->>Plugin: 生成并持久化 channel_device_id
    Plugin->>Plugin: 生成并持久化 bootstrap_token

    Plugin->>UC: POST /v1/channels/lucy/devices/registrations\nchannel_device_id + bootstrap_token
    UC-->>Plugin: binding_status = pending

    Plugin-->>App: openclaw lucy auth-qrcode\nlucy://bind?channel_device_id=...

    App->>UC: POST /v1/login
    UC-->>App: user token

    App->>App: 扫码解析 channel_device_id
    App->>UC: PUT /v1/channels/lucy/device-bindings/{channel_device_id}
    Note over UC: 建立 user <-> channel_device_id\n若首次绑定则懒创建 channel_user_key
    UC-->>App: binding_status = bound

    Plugin->>UC: GET /v1/channels/lucy/device-bindings/{channel_device_id}\nX-Bootstrap-Token
    UC-->>Plugin: binding_status = bound + channel_user_key

    Plugin->>NATS: CONNECT\nuser=channel_user_key\npass=channel_device_id
    NATS->>Auth: 鉴权请求
    Auth->>UC: POST /v1/channels/lucy/connection-verifications\nchannel_user_key + channel_device_id
    UC-->>Auth: ok + user_id
    Auth-->>NATS: User Claims JWT
    NATS-->>Plugin: 连接放行

    App->>UC: GET /v1/channels/lucy/current-user/device-bindings
    UC-->>App: 当前用户绑定设备列表
    App->>UC: GET /v1/channels/lucy/current-user/credential
    UC-->>App: channel_user_key

    App->>NATS: CONNECT\nuser=channel_user_key\npass=channel_device_id
    NATS->>Auth: 鉴权请求
    Auth->>UC: POST /v1/channels/lucy/connection-verifications
    UC-->>Auth: ok + user_id
    Auth-->>NATS: User Claims JWT
    NATS-->>App: 连接放行
```

## 5. 当前实现上的关键结论

- `channel_user_key` 和 `channel_device_id` 是旧 `apikey/device_id` 的统一重命名，不是另一套全新身份模型
- 插件和 App 都必须最终收敛到同一套 NATS 握手：
  - `user = channel_user_key`
  - `pass = channel_device_id`
- `auth-callout` 不再自己伪造 NPC 身份映射，而是必须以 `user-center` 的校验结果为准
- `bootstrap_token` 只用于插件 bootstrap 阶段，不进入 NATS 握手
- 开发环境下也可以直接运行 Lucy 包脚本命令：`pnpm --filter @hzttt/lucy auth-qrcode`

## 6. 仍需注意的实现细节

- `user-center` 当前业务错误大多仍是 HTTP 200 + `code/msg/data` 包装，客户端不能只看 HTTP 状态码
- 错误的 `bootstrap_token` 当前返回文案仍偏旧，逻辑上是拒绝成功的，但提示语还不够精确
- App 侧 machine event decoder 需要兼容当前线上字段 `channelDeviceId`，不能只兼容旧的 `deviceId`
- 即使绑定、NATS 握手和 `auth-callout` 都已经打通，OpenClaw 仍然必须配置一个可用的模型 provider；否则链路会停在 `inbound.accepted` / `assistant.start` 之前或期间，并在 OpenClaw 日志里表现为 provider/auth/model 错误
