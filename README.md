# Lucy

Lucy 是一个面向 OpenClaw 的 DM-only Channel 插件。它负责把 App/客户端 与 OpenClaw Gateway 通过 NATS 连接起来：

- App/客户端向 `client` subject 发布入站消息
- Lucy 插件订阅 `client`，把消息转成 OpenClaw inbound context
- OpenClaw 执行 agent / 模型 / 工具
- Lucy 插件把 `assistant.*`、`reasoning.*`、`tool.*`、`error` 事件发布到 `machine` subject
- 图片与音频走 JetStream Object Store，事件里只传 media descriptor

Lucy 只负责 Channel 传输层，不负责：

- `user-center` 的账号与绑定真相
- `auth-callout` 的连接鉴权决策
- OpenClaw 模型 provider 的凭据和可用性

如果模型 provider 不可用，Lucy 仍然会正常收消息，但不会产出可用回复。

## 文档导航

- [doc/README.md](doc/README.md)：文档索引，区分权威协议文档与历史调查文档
- [doc/auth-binding/integrated-flow.md](doc/auth-binding/integrated-flow.md)：当前权威绑定流程
- [doc/app-nats-integration.md](doc/app-nats-integration.md)：App / SDK 侧协议边界
- [doc/raw-event-sequences.md](doc/raw-event-sequences.md)：当前有效的 raw event 样例与观察结论
- [LucyIOSDemo/README.md](LucyIOSDemo/README.md)：iOS 演示工程说明

## 当前权威流程

当前以 `doc/auth-binding/integrated-flow.md` 和代码为准，主流程是：

1. Lucy 插件首次启动时自动生成并持久化：
   - `channel_device_id`
   - `bootstrap_token`
2. 插件调用 `user-center` 注册设备，状态进入 `pending`
3. iOS App 登录 `user-center`，扫码拿到 `channel_device_id`
4. App 调 `PUT /v1/channels/lucy/device-bindings/{channel_device_id}` 完成绑定
5. 插件轮询 `GET /v1/channels/lucy/device-bindings/{channel_device_id}`，拿到绑定后的 `channel_user_key`
6. 插件用 `username = channel_user_key`、`password = channel_device_id` 连接 NATS
7. `auth-callout` 从 NATS 握手读取这组凭据，调用 `POST /v1/channels/lucy/connection-verifications`
8. 通过校验后，`auth-callout` 给该设备对签发最小权限
9. App 如需直连 NATS，也使用同一组 `channel_user_key + channel_device_id`

这意味着生产链路的核心身份不是旧文档里的手填 `demo_user/apiKey`，而是绑定后得到的：

- `channel_user_key`
- `channel_device_id`

## 当前已验证的联通路径

按 2026-03-15 的实际排障结果，当前可工作的链路是：

- `user-center`：`https://prod.unicorn.org.cn/cephalon/user-center`
- NATS：`nats://chat.lucy.run:4222`
- `auth-callout`：在 `116.207.140.203` 上运行，并已按 `channel_user_key + channel_device_id` 做真实校验
- OpenClaw：在 `lucy@192.168.0.4` 上运行，Lucy 插件已成功绑定并连接 NATS
- OpenClaw 默认模型：`openai-local/gpt-5.4`

实际验证过的边界：

- `auth-callout` 日志可见 `kind=lucy auth ok`
- `openclaw channels status --probe` 显示 Lucy `running` 且 `works`
- 直接向 Lucy `client` subject 发消息，可收到：
  - `inbound.accepted`
  - `assistant.start`
  - `assistant.partial`
  - `assistant.final`

## 安装

Lucy 发布到 npm 的包名是 `@hzttt/lucy`，但 OpenClaw 内部的插件 id 与 channel id 都是 `lucy`。

```bash
openclaw plugins install @hzttt/lucy
```

如果 Gateway 开启了插件 allowlist，把 `lucy` 加入 `plugins.allow`。

## 绑定与重置命令

Lucy 当前常用的设备绑定命令有两个：

- `openclaw lucy auth-qrcode`
- `/lucy auth-qrcode`
  - 输出当前本地 `channel_device_id` 的绑定二维码
  - 不会修改已有的本地设备状态

- `openclaw lucy reset-state`
- `openclaw lucy reset`
- `/lucy reset-state`
- `/lucy reset`
  - 清空 Lucy 本地持久化的设备绑定状态
  - 重新生成新的 `channel_device_id` 和 `bootstrap_token`
  - 直接输出一份新的绑定二维码
  - 不会删除 `user-center` 上旧设备的服务端绑定
  - 如果 Lucy gateway 正在运行，执行后需要 reload 或重启，运行中的 NATS 连接才会切到新设备身份
  - 如果 `channels.lucy.channelDeviceId`、`channels.lucy.bootstrapToken` 或 `channels.lucy.channelUserKey` 在配置里被手工写死，下一次启动时这些值仍会覆盖本地 state

## 推荐配置

### 生产配置：绑定优先

当前推荐的 `channels.lucy` 最小配置是：

```json5
{
  channels: {
    lucy: {
      enabled: true,
      servers: ["nats://chat.lucy.run:4222"]
    }
  }
}
```

在这个模式下：

- `channelDeviceId` 由 Lucy 自动生成并持久化
- `bootstrapToken` 由 Lucy 自动生成并持久化
- `channelUserKey` 由 Lucy 通过 `user-center` 绑定后自动拿到
- Lucy 还会在本地 state 目录写出一个脱敏的 `lucy/pairing-info.json`，供 `blue-wifi` 这类本地配网服务把 `channel_device_id` 通过 BLE 暴露给 App

不要再把“手填一个固定 `demo_user`”当成默认主线。

### 开发 / 覆盖配置

代码当前仍支持这些可选覆盖项：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用 Lucy |
| `servers` | `["nats://127.0.0.1:4222"]` | NATS 地址数组，支持 `nats://`、`tls://`、`ws://`、`wss://` |
| `channelUserKey` | 无 | 绑定后得到的 `channel_user_key`；也可手工覆盖 |
| `channelDeviceId` | 无 | 绑定设备 id；一般不需要手工写 |
| `bootstrapToken` | 无 | 设备 bootstrap 凭据；一般不需要手工写 |
| `subjectPrefix` | `cephalon.im.npc` | subject 前缀 |
| `mediaBucket` | `lucy_media_v2` | JetStream Object Store bucket |
| `mediaRetentionHours` | `168` | 媒体对象保留小时数 |
| `mediaMaxMb` | `20` | 单个媒体对象大小上限 |
| `mediaLocalRoots` | 无 | 额外允许读取的本地媒体目录 |
| `dmPolicy` | `allowlist` | `allowlist` / `open` / `disabled` |
| `allowFrom` | `[channelUserKey]` | `allowlist` 模式下允许的 peer 列表 |
| `name` | 无 | 状态输出里的显示名称 |

与当前代码兼容但不推荐继续作为主流程文档的旧字段：

- `apiKey`
- `token`
- `username`
- `password`

这些字段依然被代码兼容，但不属于当前推荐的绑定式 Lucy 流程。

## 运行验证

推荐按下面顺序验证，不要把传输层和模型层混在一起：

1. `openclaw config validate`
2. `openclaw channels status --probe`
3. `openclaw lucy auth-qrcode`
   - 如需丢弃当前本地设备状态并重新生成绑定身份与二维码，运行 `openclaw lucy reset-state`
4. App 扫码绑定并获取当前用户的 `channel_user_key`
5. 发一条真实消息，观察是否出现：
   - `inbound.accepted`
   - `assistant.start`
   - `assistant.final`

如果你需要稳定读取当前运行参数，优先看 `channels status --probe` 和 Lucy 启动日志。`gateway call channels.status --json` 在很多环境也能工作，但不要把它当成唯一真相源。

### 探针字段

Lucy 的 probe / status 输出里，最关键的字段是：

- `channelDeviceId`
- `bindingStatus`
- `clientSubject`
- `machineSubject`
- `mediaBucket`
- `connectedUrl`

## 端到端验证命令

### 1. 验证 OpenClaw 模型层

先在 OpenClaw 主机上证明模型 provider 可用：

```bash
openclaw agent --agent main --message "Reply with exactly OK." --json
```

如果这里失败，Lucy 不需要改，先修 OpenClaw 模型配置。

### 2. 验证 Lucy 传输层

仓库里自带一个 NATS demo client，可直接打 `client` / `machine` subjects：

```bash
node_modules/.bin/tsx extensions/lucy/scripts/demo-chat.ts \
  --server nats://chat.lucy.run:4222 \
  --channel-user-key <channel_user_key> \
  --channel-device-id <channel_device_id> \
  --text "Reply with exactly LUCY_E2E_OK." \
  --wait-ms 25000
```

成功时应至少看到：

- `inbound.accepted`
- `assistant.start`
- `assistant.final`

## App / iOS 侧注意事项

Lucy 当前线上 machine event 使用的是：

- `channelUserKey`
- `channelDeviceId`

iOS / Swift 客户端不能只认：

- `channelDeviceID`
- `channel_device_id`
- `deviceId`

否则会在收到线上 event 时直接解码失败，并显示通用错误：

`The data couldn’t be read because it is missing.`

仓库里的 `LucyIOSDemo` 已修正这一点，见：

- `LucyMachineEvent` 兼容 `channelDeviceId`
- 对应回归测试已补

## 媒体传输

Lucy 将文本/控制事件和媒体字节分离：

- 入站：App 先上传 Object Store，再在 `client` 消息里带 descriptor
- 出站：Lucy 上传 Object Store，再在 `assistant.final.media` 里返回 descriptor

关键约束：

- `transport` 固定为 `jetstream-object-store`
- 默认 bucket 为 `lucy_media_v2`
- 当前每个 `assistant.final` 最多只携带一个媒体对象
- 如果上游给的是本地 `mediaUrl`，该路径必须位于 OpenClaw 允许的本地媒体根目录内

详细协议请看 [doc/app-nats-integration.md](doc/app-nats-integration.md)。

## 常见故障边界

| 信号 | 解释 | 首要动作 |
| --- | --- | --- |
| 没有 `inbound.accepted` | Lucy listener、subject、NATS 连通性异常 | 先查 `auth-callout`、NATS 连接和 probe 输出 |
| 有 `inbound.accepted`，没有 `assistant.start` | OpenClaw 路由或 agent 执行没开始 | 查 OpenClaw 日志 |
| 有 `assistant.start`，但最终报 provider/auth/model 错 | Lucy 传输层没问题 | 查 OpenClaw 模型配置 |
| `No API key found for provider ...` | OpenClaw 默认模型不可用 | 修模型配置，不要改 Lucy |
| iOS 端提示 `The data couldn’t be read because it is missing.` | App 侧 machine event decoder 与线上字段不兼容 | 升级到接受 `channelDeviceId` 的客户端 |
| 媒体发送失败，提示本地路径不安全 | 上游 `mediaUrl` 不在允许目录内 | 把文件复制到 OpenClaw 允许的根目录后再发 |

## 开发命令

以下命令从 OpenClaw 仓库根目录运行：

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"
pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts
docker build --build-arg OPENCLAW_EXTENSIONS=lucy -t openclaw:local -f Dockerfile .
```

如果要验证 iOS demo：

```bash
xcodebuildmcp swift-package test --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage --filter LucyIOSDemoFeatureTests.testMachineEventDecodesCamelCaseChannelDeviceId
```
