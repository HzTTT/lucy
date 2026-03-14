# 鉴权与绑定文档目录

这组文档现在统一使用这几个术语：

- 用户侧长期凭据：`channel_user_key`
- 设备长期标识：`channel_device_id`
- 设备 bootstrap 凭据：`bootstrap_token`
- NATS 校验组合：`channel_user_key + channel_device_id`
- 插件侧绑定入口命令：`openclaw lucy auth-qrcode`
- 开发环境备用命令：`pnpm --filter @hzttt/lucy auth-qrcode`

建议阅读顺序：

- [Lucy 鉴权绑定整合文档](./integrated-flow.md)
- [总流程文档](./overview.md)
- [端脑云鉴权与绑定文档](./brain-cloud.md)
- [Channel 插件鉴权与绑定文档](./channel-plugin.md)
- [App 鉴权与绑定文档](./app.md)
- [NATS 鉴权文档](./nats-auth.md)
- [user-center 落地说明](./user-center-integration.md)

目录说明：

- `integrated-flow.md`
  - 当前已经落地的统一主流程和时序图

- `overview.md`
  - 串联 4 个模块的整体流程

- `brain-cloud.md`
  - 说明端脑云保存什么、提供哪些接口

- `channel-plugin.md`
  - 说明插件如何生成 `channel_device_id`、`bootstrap_token`，以及绑定后如何拿到 `channel_user_key`

- `app.md`
  - 说明 App 如何登录、绑定设备、查看设备并获取自己的 `channel_user_key`

- `nats-auth.md`
  - 说明 NATS 握手里如何带 `channel_user_key` 和 `channel_device_id`，以及 `auth-callout` 如何调用端脑云校验

- `user-center-integration.md`
  - 说明当前 `user-center` 已经落地的表、接口、代码入口和运行约束
