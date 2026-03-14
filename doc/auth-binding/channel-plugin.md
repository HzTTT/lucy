# Channel 插件鉴权与绑定文档

本文只关注插件在鉴权和绑定链路上要处理的内容，不展开聊天、媒体和 UI。

## 1. 插件负责什么

插件负责：

- 生成并持久化 `channel_device_id`
- 生成并持久化 `bootstrap_token`
- 把 `channel_device_id + bootstrap_token` 注册到端脑云
- 输出绑定二维码
- 轮询设备是否已经被绑定
- 在绑定成功后拿到用户的 `channel_user_key`
- 用 `channel_user_key + channel_device_id` 连接 NATS

插件不负责：

- 管理用户账号
- 决定绑定关系
- 决定某个 `channel_user_key` 属于谁

## 2. 插件本地至少要保存什么

- `channel_device_id`
- `bootstrap_token`
- `channel_user_key`
- 当前绑定状态

说明：

- `channel_device_id` 是设备自己的长期标识
- `bootstrap_token` 是设备在 bootstrap 阶段自证身份用的凭据
- `channel_user_key` 是绑定成功后用于正式连接的用户侧凭据

## 3. 插件启动流程

### 模式一：云端直接注入

如果部署系统已经直接注入：

- `channel_user_key`
- `channel_device_id`

那插件只要：

1. 读取配置
2. 直接连接 NATS

### 模式二：本地自助绑定

如果本地没有 `channel_user_key`，插件要做：

1. 生成或读取本地 `channel_device_id`
2. 生成或读取本地 `bootstrap_token`
3. 调用 `POST /v1/channels/lucy/devices/registrations`
4. 提供 `openclaw lucy auth-qrcode`
5. 终端输出二维码，二维码内容至少包含 `channel_device_id`
6. 轮询 `GET /v1/channels/lucy/device-bindings/{channel_device_id}`
7. 在请求头里带上 `X-Bootstrap-Token`
8. 拿到 `channel_user_key` 后保存到本地
9. 用 `channel_user_key + channel_device_id` 连接 NATS

推荐二维码内容：

```text
lucy://bind?channel_device_id=2031655882831360000
```

## 4. 插件和端脑云的对接接口

插件需要调用这些接口：

- `POST /v1/channels/lucy/devices/registrations`
- `GET /v1/channels/lucy/device-bindings/{channel_device_id}`

其中最关键的接口约束是：

- `registrations` 只负责让云端知道这台设备存在，并记录 `bootstrap_token` 的 hash
- `device-bindings/{channel_device_id}` 只负责告诉插件“是否已绑定”和“绑定后的 `channel_user_key` 是什么”

## 5. 插件和 NATS 的对接约束

插件连接 NATS 时最少要带：

- `channel_user_key`
- `channel_device_id`

具体放法：

- `user = channel_user_key`
- `pass = channel_device_id`

NATS `auth-callout` 会用这两个值去端脑云校验：

- 这个 `channel_user_key` 是否有效
- 这个 `channel_device_id` 是否属于这个 `channel_user_key` 对应的用户

只有校验通过，插件才能建立正式连接。

## 6. 插件需要暴露给用户或运维的能力

插件至少要能输出：

- 当前 `channel_device_id`
- 当前绑定状态
- 当前绑定二维码

这样用户才能在 App 里完成绑定。

## 7. 插件侧的关键约束

- `channel_device_id` 一旦生成，不能每次重启都变化
- `bootstrap_token` 一旦生成，也要随设备状态一起持久化
- 未绑定前，不能用假 `channel_user_key` 连正式 NATS
- 绑定成功后，插件本地要能稳定恢复 `channel_user_key + channel_device_id`
- 如果云端解绑或撤销了这台设备，插件重连时必须被拒绝
