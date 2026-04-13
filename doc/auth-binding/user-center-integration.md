# user-center 与 lucy-server 落地说明

本文记录当前 `user-center` 和 `lucy-server` 已经落地的 Lucy 绑定与鉴权实现。

## 1. 统一术语

- `cdi`（channel_device_id）
  - 由 `user-center` 在设备注册时根据 Ed25519 公钥生成并返回

- `cuk`（channel_user_key）
  - 当前用户在 Lucy channel 下唯一的长期凭据
  - 第一次成功绑定设备时懒创建

- `user_id`
  - 绑定成功后返回的用户标识

- Ed25519 公钥
  - 设备注册时提交的 32 字节原始公钥（标准 Base64 编码）
  - 后续请求通过该密钥对签名验证身份

## 2. 服务划分

### `user-center` 负责

- 设备注册（接收公钥，返回 `cdi`）
- 用户登录
- 设备绑定（用户 ↔ `cdi`）
- 绑定设备列表查询
- 用户凭据（`cuk`）查询
- 模型配置接口（`current-user/model-config`）

### `lucy-server` 负责

- pre-bind OTP 签发（Ed25519 签名验证）
- 设备绑定状态查询（Ed25519 签名验证）
- NATS token 换取（Ed25519 签名验证）

## 3. `user-center` 接口

### `POST /v1/devices/new`

注册新设备。

请求：

```json
{
  "public_key": "Base64 编码的 32 字节 Ed25519 公钥"
}
```

响应（`code = 20000` 时）：

```json
{
  "code": 20000,
  "data": {
    "cdi": "2031655882831360000"
  }
}
```

### `PUT /v1/channels/lucy/device-bindings/{cdi}`

说明：

- 依赖用户登录态
- 第一次成功绑定时会自动创建 `cuk`
- 同用户重复绑定是幂等的

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

### `GET /v1/channels/lucy/current-user/model-config`

说明：

- 依赖用户登录态
- 第一次访问时懒创建 Lucy 专用 API key

实际响应包体：

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

## 4. `lucy-server` 接口

所有 `lucy-server` 接口都需要 Ed25519 签名验证。签名协议：

1. 构造参数 Map（如 `cdi`, `nonce`, `ts` 等）
2. 按 key ASCII 排序，拼成 `k=v&k=v` 格式
3. 用 Ed25519 私钥签名，Base64 编码
4. 将 `sign` 字段加入请求

### `POST /v1/channels/lucy/devices/pre-bind`

签发 OTP。

请求：

```json
{
  "cdi": "2031655882831360000",
  "nonce": "randomAlphanumeric16",
  "ts": "1712700000",
  "sign": "Base64 Ed25519 签名"
}
```

响应：

```json
{
  "otp": "123456",
  "expires_in": 300
}
```

### `GET /v1/channels/lucy/devices/device-bindings`

查询绑定状态。

Query 参数：`cdi`, `nonce`, `ts`, `sign`

响应（已绑定时）：

```json
{
  "status": "bound",
  "cuk": "cuk_xxx",
  "user_id": "2032791907809468416"
}
```

响应（未绑定时）：

```json
{
  "status": "pending"
}
```

### `POST /v1/channels/lucy/nats/token/npc`

换取 NATS token。

请求：

```json
{
  "cdi": "2031655882831360000",
  "kind": "lucy",
  "nonce": "randomAlphanumeric16",
  "ts": 1712700000,
  "sign": "Base64 Ed25519 签名"
}
```

签名参数包含 `cuk`（不在请求体中，但参与签名）。

响应：

```json
{
  "token": "nats_token_xxx",
  "expires_in": 3600,
  "nats_url": "nats://<server-returned-address>:4222",
  "access_token": "optional_access_token",
  "access_token_expires_in": 7200
}
```

## 5. 当前实现约束

- `current-user/*` 接口走普通用户 JWT
- `lucy-server` 接口通过 Ed25519 签名验证设备身份
- 业务错误大多是 HTTP 200 + `code/msg/data` 包装，客户端不能只看 HTTP 状态码
