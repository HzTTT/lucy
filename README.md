# Lucy

Lucy 是 OpenClaw 的 Lucy Channel 插件，用来把 OpenClaw Gateway 接到 Lucy App 的消息链路上。标准部署场景下，请使用 npm 包 `@hzttt/lucy` 安装；在 OpenClaw 内部，插件 id、配置前缀和 CLI 命令名都叫 `lucy`。

当前设计中，Lucy 不再依赖额外安装独立的 `cephalon` provider 插件。`@hzttt/lucy` 在注册 channel 的同时，也会把 `providerId = cephalon` 的 provider 一并注册到 OpenClaw，用于接收 App 下发的模型配置并把主 agent 默认模型切到 `cephalon/kimi-k2.5`。

## 版本要求

Lucy 需要 OpenClaw `2026.3.23` 及以上版本。低于这个版本的 OpenClaw 不支持当前的插件安装方式和 `openclaw lucy ...` 命令。

## 依赖

Lucy 使用 `lucy-im-sdk-nodejs`（git submodule `lucy-im-sdk/`）处理：

- Ed25519 密钥对管理
- 设备注册与绑定
- NATS token 换取与连接
- JetStream 消息收发
- Presence（上下线、heartbeat、ping）

SDK 工作目录默认为 `~/data/lucy_im/`，存放密钥对和绑定标识。

## 最小接入

最小接入流程请直接按下面三条命令执行，不要改成其他安装方式：

```bash
openclaw plugins install @hzttt/lucy
openclaw config set channels.lucy.enabled true
```

配置完成后，运行：

```bash
openclaw lucy auth-qrcode
```

这个命令会输出当前 OpenClaw 节点的 Lucy 绑定二维码。打开 Lucy App，登录后扫描二维码，即可把当前节点接入 Lucy。

## 当前整体设计

当前 Lucy 链路分成两层：

1. **鉴权 / 绑定 / 传输层**（由 `lucy-im-sdk` 处理）
   - Ed25519 密钥对生成与管理
   - 设备注册（公钥 → `cdi`）
   - pre-bind OTP + 绑定轮询（→ `cuk` + `user_id`）
   - Ed25519 签名换取 NATS token
   - JetStream 消息收发
   - Presence 自动管理
2. **模型配置下发层**
   - Lucy App 通过 user-center 的 Lucy 专属接口获取 `provider + api_key + base_url + models[]`
   - App 通过 JetStream 向 Lucy 设备下发 `version = 3 / kind = provision_model`
   - Lucy 写入 OpenClaw 的 `models.providers.cephalon.*` 与 `agents.defaults.model.primary`
   - Lucy 自动执行 `openclaw gateway restart`

## 接入流程说明

1. 用 `openclaw plugins install @hzttt/lucy` 安装插件。
2. 打开 `channels.lucy.enabled`。
3. 执行 `openclaw lucy auth-qrcode`，在 Lucy App 中扫码完成绑定。
4. 绑定完成后，Lucy App 可继续拉取 `GET /v1/channels/lucy/current-user/model-config`，并把模型配置下发到设备。

NATS 服务器地址由 token 接口动态返回，无需手动配置。
6. 设备自动重启并恢复上线后，再从 Lucy App 发消息验证链路。

## 推荐配置

推荐把 `channels.lucy` 保持为最小配置：

```json5
{
  "channels": {
    "lucy": {
      "enabled": true
    }
  }
}
```

NATS 服务器地址由 `lucy-server` 的 token 接口动态返回（`nats_url` 字段），无需在配置中硬编码。

如果你要把本机的 USB 同步 daemon 事件回报给 Lucy，可以额外开启一个本地 HTTP 通知入口：

```json5
{
  "channels": {
    "lucy": {
      "enabled": true,
      "localNotify": {
        "enabled": true,
        "bind": "127.0.0.1",
        "port": 8788,
        "path": "/usb-events"
      }
    }
  }
}
```

daemon 侧把：

```json
{
  "notify": {
    "url": "http://127.0.0.1:8788/usb-events"
  }
}
```

指向 Lucy 即可。

如果你把 `localNotify.port` 或 `localNotify.path` 改成别的值，daemon 侧的 `notify.url` 也必须同步调整；Lucy 不会帮你做端口映射或 URL 兼容。

### `kind` / `device_type`

`channels.lucy.kind` 控制设备类型标识，默认 `"lucy"`。这个值会影响：

- NATS token 请求中的 `device_type` 字段和签名参数 `kind`，lucy-server 据此分配不同的 NATS 权限
- JetStream 的 stream 名称和 durable consumer 名称（`nas` 使用独立的 stream 和 consumer）

可选值：

| 值 | 说明 |
|----|------|
| `"lucy"` | 默认，标准 Lucy 设备 |
| `"nas"` | NAS 设备，使用独立的 JetStream stream |
| 自定义字符串 | 按需扩展，需 lucy-server 侧同步支持 |

标准接入不需要改这个字段。只有在部署 NAS 或其他非标准设备类型时才需要设置：

```json5
{
  "channels": {
    "lucy": {
      "enabled": true,
      "kind": "nas"
    }
  }
}
```

Lucy 会通过 SDK 自动处理以下状态，不需要手工写入：

- Ed25519 密钥对（`~/data/lucy_im/bootstrap_token/`）
- `cdi`（`~/data/lucy_im/channel_ids/cdi`）
- `cuk`（`~/data/lucy_im/channel_ids/cuk`）
- `user_id`（`~/data/lucy_im/channel_ids/user_id`）

当 App 下发模型配置时，Lucy 还会自动写入：

- `models.providers.cephalon`
- `agents.defaults.model.primary = "cephalon/kimi-k2.5"`

除非你在做调试或兼容性排查，否则不要把这些值手工写回配置。

## 常用命令

- `openclaw lucy auth-qrcode`
  显示当前设备的绑定二维码。这个命令只负责查看二维码，不会重置本地状态。
- `openclaw lucy reset-state`
  清空 Lucy 本地设备状态，重新生成新的设备身份，并输出新的绑定二维码。适合重新绑定时使用。
- `openclaw channels status --probe`
  查看 Lucy 当前运行状态、探针字段和连接信息。

## App 下发模型配置

当前推荐的 App 侧模型配置接口是：

- `GET /v1/channels/lucy/current-user/model-config`

这个接口由 user-center 按当前登录用户返回：

- `provider_id`
- `api_key`
- `base_url`
- `default_model_id`
- `models[]`

其中：

- `provider_id` 当前固定为 `cephalon`
- `default_model_id` 当前固定为 `kimi-k2.5`
- `base_url` **必须跟随当前 user-center 环境返回**，不能在 App 或插件里写死 prod/test
- `models[]` 现在只开放 `kimi-k2.5`，但 UI 应按列表渲染，给未来扩容预留入口

Lucy 收到 `provision_model` 控制消息后会：

1. 写入 `models.providers.cephalon`
2. 写入 `agents.defaults.model.primary`
3. 如果已启用 `plugins.entries.multimodal-rag`，且其 `ollama.baseUrl` 已配置为绝对 `cephalon ... /v1/model` URL，或 `whisper.zhipuApiBaseUrl` 已配置为绝对 `cephalon ... /v1/model` / `cephalon ... /v1/model/v1` URL，则把同一份 App 下发的 `apiKey` 额外写入对应的 `ollama.apiKey` / `whisper.zhipuApiKey`
4. 非 cephalon URL、相对路径、或未启用的 `multimodal-rag` 配置不会被自动改写
5. 发 `config.updated`
6. 发 `restart.scheduled`
7. 自动执行 `openclaw gateway restart`
8. 启动后发 `restart.completed`

## 注意事项

- 安装包名是 `@hzttt/lucy`，不是 `lucy`。
- Lucy 需要 OpenClaw `2026.3.23` 及以上版本。
- OpenClaw 配置键和命令名是 `lucy`，例如 `channels.lucy.*` 和 `openclaw lucy ...`。
- `servers` 必须按 JSON 数组写入，因此推荐直接使用文档里的命令，不要手工改写。
- 当前标准接入流程是二维码绑定，不是旧文档里那种手填 `apiKey`、`token`、`username` 或 `password` 的方式。
- 如果你的 Gateway 开启了插件 allowlist，需要把 `lucy` 加入 `plugins.allow`。
- Lucy 默认会用 `openclaw gateway restart` 做自动重启；如果宿主环境 PATH 不包含 `openclaw`，可以配置：
  - `channels.lucy.restartHelperCommand`
  - `channels.lucy.restartHelperArgs`
  - `channels.lucy.restartOnlineTimeoutMs`
- 自动重启前后，App 预期会看到：
  - `config.updated`
  - `restart.scheduled`
  - `restart.completed`

## 本地 USB 通知入口

当 `channels.lucy.localNotify.enabled = true` 时，Lucy 会在本机启动一个只监听本地地址的 HTTP 服务，默认配置为：

- `bind = 127.0.0.1`
- `port = 8788`
- `path = /usb-events`

当前只接受：

- `POST`
- JSON body

请求体格式：

```json
{
  "code": 1,
  "device": "/dev/sdb1",
  "timestamp": "2026-03-30T19:02:00.000000",
  "message": ""
}
```

事件码会被 Lucy 映射为主动推送的 `assistant.final`，因此 App 不需要额外升级协议就能直接显示：

- `1` -> `U盘已插入`
- `2` -> `U盘同步中`
- `3` -> `U盘同步完成`
- `4` -> `U盘同步失败`
- `5` -> `U盘已拔出`

这类通知没有 `sourceMessageId`，会作为 Lucy 的主动系统消息出现；原始字段会以扁平字符串字段放进 machine event 的 `metadata` 中，当前键名为：

- `localNotifyCode`
- `localNotifyCodeName`
- `localNotifyDevice`
- `localNotifyTimestamp`
- `localNotifyMessage`

这里必须保持"扁平字符串字典"。当前 iOS `LucyMachineEvent.metadata` 解码类型仍是 `[String: String]?`，如果再改回嵌套对象，App 会在 machine event 解码阶段直接失败。

## 验证接入

建议按下面顺序验证：

```bash
openclaw channels status --probe
openclaw lucy auth-qrcode
```

然后在 Lucy App 中扫码绑定。若你在验证模型配置下发链路，建议再执行：

1. App 调 `current-user/model-config`
2. App 下发 `provision_model`
3. 等待设备自动重启与恢复上线
4. 再发送一条真实消息

如果 Lucy 已经连通，但没有拿到模型回复，优先检查 OpenClaw 自身的模型 provider 配置。Lucy 负责的是 Channel 传输层，不能替代上游模型配置。

## 进一步文档

- [doc/auth-binding/integrated-flow.md](doc/auth-binding/integrated-flow.md)：绑定流程与字段约定
- [doc/app-nats-integration.md](doc/app-nats-integration.md)：App / SDK 接入协议
- [doc/README.md](doc/README.md)：仓库内其他文档索引
