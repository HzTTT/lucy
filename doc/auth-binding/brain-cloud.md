# 端脑云鉴权与绑定文档

本文只关注 4 件事：

- 用户的 `channel_user_key`
- 设备的 `channel_device_id`
- 插件自持的 `bootstrap_token`
- 用户和设备的绑定关系

NATS 连接时约定直接带：

- `user = channel_user_key`
- `pass = channel_device_id`

## 1. 端脑云负责什么

端脑云是这套系统里的唯一真相源，负责：

- 管理用户登录态
- 管理 `channel_user_key -> user_id`
- 管理 `channel_device_id -> user_id`
- 管理 `bootstrap_token_hash`
- 保证一台设备只能绑定一个用户
- 给 App 返回当前用户的设备列表和自己的 `channel_user_key`
- 给 NATS `auth-callout` 返回“这次连接是否合法”

端脑云不负责：

- 不负责 NATS 长连接
- 不负责聊天消息本身
- 不负责插件运行逻辑

## 2. 端脑云至少要保存什么

- 用户侧凭据
  - `user_id`
  - `channel`
  - `channel_user_key`
  - `status`

- 设备
  - `channel`
  - `channel_device_id`
  - `binding_status`
  - `bound_user_id`
  - `bootstrap_token_hash`

其中 `binding_status` 最少只需要这几个值：

- `pending`
- `bound`
- `revoked`

## 3. 端脑云至少要提供哪些接口

### `POST /v1/channels/lucy/devices/registrations`

给插件用。  
作用：登记一个新的 `channel_device_id`，同时记录插件提交的 `bootstrap_token` 摘要。

最少输入：

```json
{
  "channel_device_id": "2031655882831360000",
  "bootstrap_token": "cbt_xxx"
}
```

最少输出：

```json
{
  "channel": "lucy",
  "channel_device_id": "2031655882831360000",
  "binding_status": "pending"
}
```

### `PUT /v1/channels/lucy/device-bindings/{channel_device_id}`

给 App 用。  
作用：把当前登录用户和某个 `channel_device_id` 绑定起来。

接口约束：

- 这条接口必须依赖用户自己的登录态
- 第一次成功绑定时，如果该用户还没有 `channel_user_key`，需要懒创建

### `GET /v1/channels/lucy/device-bindings/{channel_device_id}`

给插件用。  
作用：插件轮询这台设备是否已经被绑定；如果已绑定，返回 `channel_user_key`。

插件必须通过请求头带：

- `X-Bootstrap-Token`

最少输出：

```json
{
  "channel": "lucy",
  "channel_device_id": "2031655882831360000",
  "binding_status": "bound",
  "channel_user_key": "cuk_xxx"
}
```

### `GET /v1/channels/lucy/current-user/device-bindings`

给 App 用。  
作用：返回当前登录用户已经绑定的设备列表。

最少输出：

```json
{
  "devices": [
    {
      "channel_device_id": "2031655882831360000",
      "binding_status": "bound"
    }
  ]
}
```

### `GET /v1/channels/lucy/current-user/credential`

给 App 用。  
作用：返回当前登录用户在 Lucy channel 下的 `channel_user_key`。

说明：

- 这条接口依赖正常用户登录态
- 如果用户还没有成功绑定过任何 Lucy 设备，可以返回 `NotFound`

### `POST /v1/channels/lucy/connection-verifications`

给 NATS `auth-callout` 调用。  
作用：`auth-callout` 在收到 NATS 连接请求后，拿着握手里的 `channel_user_key` 和 `channel_device_id` 来这里查询是否合法。

最少输入：

```json
{
  "channel_user_key": "cuk_xxx",
  "channel_device_id": "2031655882831360000"
}
```

最少输出：

```json
{
  "ok": true,
  "user_id": "u_123",
  "channel_device_id": "2031655882831360000"
}
```

## 4. 端脑云必须保证的约束

- `channel_user_key` 必须能唯一定位到一个用户
- `channel_device_id` 必须全局唯一
- `bootstrap_token` 只由插件自己持有，云端只保存其 hash
- 一个用户可以绑定多台设备
- 一台设备不能同时绑定给多个用户
- 如果设备被撤销，后续连接校验必须失败

## 5. 端脑云和其他模块怎么对接

- 对插件：
  - 提供设备注册
  - 提供 bootstrap 轮询查询

- 对 App：
  - 提供设备绑定
  - 提供当前用户设备列表
  - 提供当前用户自己的 `channel_user_key`

- 对 NATS：
  - 提供一个给 `auth-callout` 调用的连接校验接口
  - `channel_user_key` 和 `channel_device_id` 都来自 NATS 连接握手里的 `user/pass`
