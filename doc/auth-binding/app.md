# App 鉴权与绑定文档

本文只关注 App 在鉴权和绑定链路上要处理的内容，不展开聊天 UI、媒体上传和消息渲染。

## 1. App 负责什么

App 负责：

- 用户登录端脑云
- 获取当前用户绑定的设备列表
- 扫描插件提供的绑定二维码
- 帮用户完成新设备绑定
- 获取当前用户自己的 `channel_user_key`
- 选择某个 `channel_device_id` 去连接对应的 channel

App 不负责：

- 决定设备归属
- 决定某个 `channel_user_key` 是否有效
- 决定 NATS 权限

## 2. App 至少要接哪些云端接口

### 登录接口

App 先要有自己的登录态。  
当前 `user-center` 仍然通过 `/v1/login` 返回普通用户 JWT。

### `PUT /v1/channels/lucy/device-bindings/{channel_device_id}`

作用：把当前登录用户和某台设备绑定起来。

### `GET /v1/channels/lucy/current-user/device-bindings`

作用：获取当前登录用户绑定的设备列表。

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

作用：获取当前登录用户在 Lucy channel 下的 `channel_user_key`。

说明：

- 这条接口依赖用户登录态
- 如果用户还没有成功绑定过 Lucy 设备，可以返回 `NotFound`

## 3. App 的绑定流程

App 需要支持插件二维码扫码入口。

推荐二维码内容：

- `lucy://bind?channel_device_id=<id>`

如果后续要扩展字段，也可以支持 JSON：

```json
{
  "channel": "lucy",
  "channel_device_id": "2031655882831360000"
}
```

流程很简单：

1. 用户登录 App
2. 用户在插件侧执行 `openclaw lucy auth-qrcode`
3. App 扫码拿到 `channel_device_id`
4. App 调用 `PUT /v1/channels/lucy/device-bindings/{channel_device_id}`
5. 绑定成功后刷新 `GET /v1/channels/lucy/current-user/device-bindings`
6. 如需建立 NATS 连接，再调用 `GET /v1/channels/lucy/current-user/credential`

## 4. App 和 NATS 的对接约束

用户对 App 的可见配置只需要是：

- 已登录自己的端脑云账号
- 选中了一个 `channel_device_id`

App 发起 NATS 连接时，直接在握手里带：

- `user = channel_user_key`
- `pass = channel_device_id`

这样 `auth-callout` 就能去端脑云判断：

- 这个 `channel_user_key` 是否有效
- 这个 `channel_device_id` 是否属于这个 `channel_user_key` 对应的用户

## 5. App 侧的关键约束

- 设备列表必须来自端脑云，不要自己缓存成真相源
- 绑定成功后要重新拉一次设备列表
- 切换设备时，要按新的 `channel_device_id` 重建连接
- 如果设备已撤销，后续连接必须失败
