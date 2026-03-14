# 鉴权与绑定总流程文档

本文只串联这 4 个模块在鉴权和绑定上的关系：

- 端脑云
- Channel 插件
- App
- NATS / auth-callout

配套文档：

- [端脑云鉴权与绑定文档](./brain-cloud.md)
- [Channel 插件鉴权与绑定文档](./channel-plugin.md)
- [App 鉴权与绑定文档](./app.md)
- [NATS 鉴权文档](./nats-auth.md)
- [user-center 落地说明](./user-center-integration.md)

## 1. 统一规则

- 用户有自己的 `channel_user_key`
- 设备有自己的 `channel_device_id`
- 设备还有一个只给插件自己持有的 `bootstrap_token`
- 一个用户可以绑定多台设备
- 一台设备只能绑定一个用户
- 绑定关系以端脑云为准
- `channel_user_key` 在同一个 channel 下按用户唯一
- NATS 只负责校验和放行，不负责保存绑定关系
- NATS 连接时统一使用 `user=channel_user_key`、`pass=channel_device_id`

## 2. 自助绑定流程

这是本地安装插件时的流程。

1. 插件首次启动，生成并持久化本地 `channel_device_id`
2. 插件同时生成并持久化本地 `bootstrap_token`
3. 插件调用 `POST /v1/channels/lucy/devices/registrations`
4. 插件侧执行 `openclaw lucy auth-qrcode`
5. 用户在 App 中登录
6. 用户扫描二维码拿到 `channel_device_id`
7. App 调用 `PUT /v1/channels/lucy/device-bindings/{channel_device_id}`
8. 端脑云建立 `user <-> channel_device_id` 绑定关系
9. 如果该用户还没有 `channel_user_key`，端脑云在第一次成功绑定时懒创建
10. 插件轮询 `GET /v1/channels/lucy/device-bindings/{channel_device_id}`，并通过 `X-Bootstrap-Token` 自证设备身份
11. 插件拿到绑定后的 `channel_user_key`
12. 插件开始用 `channel_user_key + channel_device_id` 连接 NATS

## 3. 云端直接注入流程

这是云端托管插件时的流程。

1. 云端提前准备好 `channel_user_key`
2. 云端提前准备好 `channel_device_id`
3. 云端把这两个值直接注入插件
4. 插件启动后直接连接 NATS

这个模式没有本地配对流程。

## 4. App 查看设备与凭据流程

1. 用户登录 App
2. App 调用 `GET /v1/channels/lucy/current-user/device-bindings`
3. 端脑云返回当前用户绑定的全部 `channel_device_id`
4. App 如需主动建立 NATS 连接，再调用 `GET /v1/channels/lucy/current-user/credential`
5. 端脑云返回当前用户在 Lucy channel 下的 `channel_user_key`

## 5. NATS 鉴权流程

### 插件连接

1. 插件带 `channel_user_key + channel_device_id` 连接 NATS
2. NATS 把请求交给 `auth-callout`
3. `auth-callout` 调用 `POST /v1/channels/lucy/connection-verifications`
4. 端脑云判断这组 `channel_user_key + channel_device_id` 是否成立
5. 通过后，NATS 放行

### App 连接

1. App 带 `channel_user_key + channel_device_id` 连接 NATS
2. NATS 把请求交给 `auth-callout`
3. `auth-callout` 调用 `POST /v1/channels/lucy/connection-verifications`
4. 端脑云判断这组 `channel_user_key + channel_device_id` 是否成立
5. 通过后，NATS 放行

## 6. 四个模块各自只做什么

### 端脑云

- 保存 `channel_user_key`
- 保存 `channel_device_id`
- 保存 `bootstrap_token` 的 hash
- 保存绑定关系
- 提供绑定、查询、校验接口

### 插件

- 生成 `channel_device_id`
- 生成 `bootstrap_token`
- 发起注册
- 输出绑定入口
- 获取绑定后的 `channel_user_key`
- 用 `channel_user_key + channel_device_id` 连 NATS

### App

- 登录
- 查看设备列表
- 完成绑定
- 获取当前用户的 `channel_user_key`
- 带 `channel_user_key + channel_device_id` 去访问指定设备

### NATS / auth-callout

- 收连接
- 调用端脑云校验接口确认是否合法
- 通过就放行，不通过就拒绝

## 7. 关键接口路径汇总

- `POST /v1/channels/lucy/devices/registrations`
- `PUT /v1/channels/lucy/device-bindings/{channel_device_id}`
- `GET /v1/channels/lucy/device-bindings/{channel_device_id}`
- `GET /v1/channels/lucy/current-user/device-bindings`
- `GET /v1/channels/lucy/current-user/credential`
- `POST /v1/channels/lucy/connection-verifications`
