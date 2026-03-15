# user-center 落地说明

本文记录当前 `user-center` 已经落地的这套 Lucy 绑定实现，避免文档和代码再脱节。

## 1. 统一术语

- `channel_device_id`
  - 插件自己生成、自己持久化的设备长期标识

- `bootstrap_token`
  - 插件自己生成、自己持久化的 bootstrap 阶段凭据
  - 服务端只保存其 hash

- `channel_user_key`
  - 当前用户在 Lucy channel 下唯一的长期凭据
  - 第一次成功绑定设备时懒创建

## 2. 当前表结构

当前 `user-center` 已经新增：

- `channel_devices`
- `channel_user_credentials`

设计约束：

- `channel_devices(channel, channel_device_id)` 唯一
- `channel_user_credentials(channel, user_id)` 唯一
- `channel_user_credentials(channel, channel_user_key)` 唯一

## 3. 当前接口

### `POST /v1/channels/lucy/devices/registrations`

请求：

```json
{
  "channel_device_id": "2031655882831360000",
  "bootstrap_token": "cbt_xxx"
}
```

响应：

```json
{
  "channel": "lucy",
  "channel_device_id": "2031655882831360000",
  "binding_status": "pending"
}
```

### `PUT /v1/channels/lucy/device-bindings/{channel_device_id}`

说明：

- 依赖用户登录态
- 第一次成功绑定时会自动创建 `channel_user_key`
- 同用户重复绑定是幂等的

### `GET /v1/channels/lucy/device-bindings/{channel_device_id}`

说明：

- 插件必须带 `X-Bootstrap-Token`
- 未绑定时只返回状态
- 已绑定时返回 `channel_user_key`

### `GET /v1/channels/lucy/current-user/device-bindings`

说明：

- 依赖用户登录态
- 返回当前用户绑定的 Lucy 设备列表

实际响应包体：

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

### `GET /v1/channels/lucy/current-user/credential`

说明：

- 依赖用户登录态
- 只有在用户已经至少成功绑定过一台 Lucy 设备后才有结果

实际响应包体：

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

### `POST /v1/channels/lucy/connection-verifications`

请求：

```json
{
  "channel_device_id": "2031655882831360000",
  "channel_user_key": "cuk_xxx"
}
```

响应：

```json
{
  "ok": true,
  "user_id": "2032791907809468416",
  "channel_device_id": "2031655882831360000"
}
```

## 4. 当前实现约束

- `current-user/*` 接口走普通用户 JWT
- `connection-verifications` 当前没有额外 service-secret 校验
- 服务启动时如果不带 `--db_migrate`，新表不会自动落库

## 5. 当前测试结论

已经实际验证通过：

- 未登录访问 `current-user/*` 会被拒绝
- `registrations` 新建设备成功，状态为 `pending`
- 绑定前 `device-bindings/{channel_device_id}` 不会泄露 `channel_user_key`
- 登录后绑定成功，状态变成 `bound`
- 同用户重复绑定幂等
- `current-user/device-bindings` 能看到绑定设备
- `current-user/credential` 能拿到唯一的 `channel_user_key`
- 绑定后插件 bootstrap 能拿到同一个 `channel_user_key`
- `connection-verifications` 对正确组合返回 `ok=true`
- `connection-verifications` 对错误 key 返回 `ok=false`
- 当前真实登录返回中，访问 token 位于 `data.token`

## 6. 一个已知细节

错误的 `bootstrap_token` 当前会返回通用的 `AuthFailed` 文案，也就是“登录状态已失效，请重新登录”。

这个行为在逻辑上是拒绝成功的，但文案语义还不够精确。后续如果要继续打磨，可以把它单独改成更明确的“bootstrap token 无效”。
