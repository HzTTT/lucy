# NATS 鉴权文档

本文只关注 NATS 和 `auth-callout` 在 `channel_user_key`、`channel_device_id`、绑定关系上的职责。

## 1. NATS 负责什么

NATS 负责：

- 接收 App 和插件的连接
- 把连接鉴权请求交给 `auth-callout`
- 根据 `auth-callout` 的结果决定是否放行

NATS 不负责：

- 保存用户和设备的绑定关系
- 直接判断某个 `channel_user_key` 属于谁

## 2. Auth Callout 负责什么

`auth-callout` 只做一件核心事情：

- 把 NATS 的连接信息拿去调用端脑云连接校验接口，然后把结果翻译成 NATS 权限

也就是：

1. 收到连接请求
2. 调用端脑云连接校验接口
3. 如果通过，就签发最小权限
4. 如果失败，就拒绝连接

## 3. NATS 连接里怎么带校验信息

无论是插件还是 App，NATS 连接时都直接带：

- `user = channel_user_key`
- `pass = channel_device_id`

也就是：

```ts
connect({
  servers,
  user: channelUserKey,
  pass: channelDeviceId,
});
```

`auth-callout` 从连接握手里取出这两个值，再去问端脑云。

## 4. 对接接口约束

`POST /v1/channels/lucy/connection-verifications` 是给 `auth-callout` 调用的接口，至少支持这种请求体：

```json
{
  "channel_user_key": "cuk_xxx",
  "channel_device_id": "2031655882831360000"
}
```

至少返回：

```json
{
  "ok": true,
  "user_id": "u_123",
  "channel_device_id": "2031655882831360000"
}
```

## 5. NATS 权限边界

`auth-callout` 不需要知道完整业务流程，它只需要根据 `user_id + channel_device_id` 给出最小权限。

推荐 subject：

```text
cephalon.im.user.<user_id>.device.<channel_device_id>.client
cephalon.im.user.<user_id>.device.<channel_device_id>.machine
```

最小权限约束：

- App 只能访问自己选中的那个 `channel_device_id`
- 插件只能访问自己的那个 `channel_device_id`
- 不允许跨用户、跨设备放通

## 6. NATS 侧的关键约束

- 每次新连接都要重新问端脑云
- 设备撤销后，新连接必须被拒绝
- `channel_user_key` 和 `channel_device_id` 必须从 NATS 连接握手中的 `user/pass` 读取
- `auth-callout` 负责调用端脑云，不在 NATS 侧重复实现一套绑定判断逻辑
- `auth-callout` 不保存绑定真相，只消费端脑云的判断
