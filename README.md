# Lucy

Lucy 是一个面向 OpenClaw 的 DM-only Channel 插件，负责把外部 App 与 OpenClaw Gateway 通过 NATS 连接起来。

- 文本与控制事件走 `client` / `machine` subjects
- 图片与音频走 JetStream Object Store，事件中只传 v2 media descriptor
- 支持原生 NATS/TLS：`nats://`、`tls://`
- 支持 NATS over WebSocket：`ws://`、`wss://`

Lucy 只负责 Channel 传输层，不负责模型提供商、Agent 策略或上游鉴权编排。要拿到可用的助手回复，OpenClaw 主配置里仍然必须有可工作的模型 provider。

## 文档导航

- `[README.md](README.md)`：部署、配置、验证与排障
- `[doc/app-nats-integration.md](doc/app-nats-integration.md)`：App / SDK 侧 NATS 接入协议
- `[doc/raw-event-sequences.md](doc/raw-event-sequences.md)`：原始事件时序样例，仅用于观测，不作为 schema 定义

## 架构与边界

```text
App/Client
  ├─ publish -> {prefix}.{apiKey}.{deviceId}.client
  ├─ subscribe <- {prefix}.{apiKey}.{deviceId}.machine
  └─ upload/download media <-> JetStream Object Store

Lucy Gateway Adapter
  ├─ 校验 subject 命名空间与 payload
  ├─ 将入站消息转换为 OpenClaw inbound context
  └─ 将 OpenClaw 执行过程映射为 machine events

OpenClaw Runtime
  ├─ 路由到 agent
  ├─ 调用模型 / 工具
  └─ 产生 assistant / reasoning / tool 生命周期事件
```

必须明确的约束：

- `apiKey` 会直接进入 NATS subject，必须满足 `^[A-Za-z0-9_-]+$`
- `deviceId` 由 Lucy 持久化生成；重建状态目录后可能变化
- App 必须使用 `openclaw gateway call channels.status --params '{"probe":true,"timeoutMs":10000}' --json` 返回里的同一个 `deviceId`
- 媒体依赖 JetStream Object Store；仅有 Core NATS 不够
- Lucy 当前每条 `assistant.final` 最多只携带一个媒体对象

## 安装与部署

### 在 Gateway 运行环境中从 npm 安装

Lucy 发布到 npm 的包名是 `@hzttt/lucy`，但在 OpenClaw 内部的插件 id 与 channel id 都是 `lucy`。

1. 安装插件：

```bash
openclaw plugins install @hzttt/lucy
```

1. 如果 Gateway 开启了插件 allowlist，把 `lucy` 加入 `plugins.allow`。
2. 在 `channels.lucy` 下配置 Channel，而不是写到 `plugins.entries.lucy.config`。

最小配置：

```json5
{
  channels: {
    lucy: {
      enabled: true,
      apiKey: "demo_user",
      servers: ["nats://127.0.0.1:4222"],
    },
  },
}
```

如果你的 NATS 服务启用了 token 鉴权，把 `token` 一并写入 `channels.lucy`：

```json5
{
  channels: {
    lucy: {
      enabled: true,
      apiKey: "demo_user",
      servers: ["nats://127.0.0.1:4222"],
      token: "nats-token-placeholder",
    },
  },
}
```

等价 CLI：

```bash
openclaw config set channels.lucy.enabled true --strict-json
openclaw config set channels.lucy.apiKey demo_user
openclaw config set channels.lucy.servers '["nats://127.0.0.1:4222"]' --strict-json
openclaw config set channels.lucy.token nats-token-placeholder
```

1. 重启 Gateway：

```bash
openclaw gateway restart
```

1. 验证并探测：

```bash
openclaw config validate
openclaw plugins info lucy
openclaw gateway call channels.status --params '{"probe":true,"timeoutMs":10000}' --json \
    | jq '.channelAccounts.lucy[] | select(.accountId=="default") | .probe | {deviceId, clientSubject, machineSubject, mediaBucket, mediaRetentionHours}'
```

1. 记录 `gateway call channels.status ... --json` 输出中的以下字段：

- `deviceId`
- `clientSubject`
- `machineSubject`
- `mediaBucket`
- `mediaRetentionHours`

补充说明：

- `openclaw plugins install @hzttt/lucy` 会安装 npm 包并创建插件记录；后续如果你手动关闭过插件，仍需检查 `plugins.entries.lucy.enabled`
- `channels status --probe` 适合人工看健康状态；给 App 取 `deviceId` / subject / media 参数时，使用 `gateway call channels.status ... --json`
- App 侧拼 subject、发送消息、下载媒体时，都要与当前 JSON 输出保持一致
- 如果配置目录或状态目录被重建，`deviceId` 可能变化，不能把它当常量硬编码

### 在仓库内做本地开发与联调

以下命令从 OpenClaw 仓库根目录运行。开发联调时建议固定配置目录和工作区目录，避免 `deviceId` 在同一会话里漂移。

1. 构建包含 Lucy 依赖的本地镜像：

```bash
docker build --build-arg OPENCLAW_EXTENSIONS=lucy -t openclaw:local -f Dockerfile .
```

1. 启动最小调试栈：

```bash
env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml up -d nats openclaw-gateway
```

1. 启用 Lucy 并写入最小配置：

```bash
env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli plugins enable lucy

env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli config set channels.lucy.enabled true

env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli config set channels.lucy.apiKey demo_user

env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli config set channels.lucy.servers '["nats://nats:4222"]' --strict-json
```

如果当前 NATS 环境要求 token 鉴权，再补一条：

```bash
env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli config set channels.lucy.token nats-token-placeholder
```

1. 重启 Gateway 容器并执行健康检查与稳定 JSON 取数：

```bash
env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml restart openclaw-gateway

env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli channels status --probe

env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli \
  gateway call channels.status --params '{"probe":true,"timeoutMs":10000}' --json
```

1. 查看 Gateway 日志：

```bash
env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace \
  docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml logs openclaw-gateway --tail=200
```

1. 从仓库根目录运行 demo client：

```bash
bun extensions/lucy/scripts/demo-chat.ts --api-key demo_user --device-id <deviceId>
```

常用 demo 参数：

- 一次性文本探测：`--text "hello"`
- 指定等待窗口：`--wait-ms 45000`
- 发送本地媒体：`--media /absolute/path/to/file.png`
- 自动下载返回媒体：`--download-dir /tmp/lucy-downloads`
- 连接远端 WSS：`--server wss://example.com/nats-ws --token <nats-token>`

## 配置参考

所有配置位于 `channels.lucy`。


| 字段                    | 必填  | 默认值                         | 说明                                               |
| --------------------- | --- | --------------------------- | ------------------------------------------------ |
| `enabled`             | 否   | `true`                      | 是否启用 Lucy Channel                                |
| `apiKey`              | 是   | 无                           | NATS 命名空间标识，必须满足 `^[A-Za-z0-9_-]+$`              |
| `servers`             | 否   | `["nats://127.0.0.1:4222"]` | NATS 地址数组，支持 `nats://`、`tls://`、`ws://`、`wss://` |
| `subjectPrefix`       | 否   | `cephalon.im.npc`           | subject 前缀                                       |
| `token`               | 否   | 无                           | NATS token 鉴权；设置后优先于用户名密码                        |
| `username`            | 否   | 无                           | NATS 用户名                                         |
| `password`            | 否   | 无                           | NATS 密码                                          |
| `dmPolicy`            | 否   | `allowlist`                 | 可选 `allowlist`、`open`、`disabled`                 |
| `allowFrom`           | 否   | `[apiKey]`                  | `dmPolicy = "allowlist"` 时的允许列表                  |
| `mediaBucket`         | 否   | `lucy_media_v2`             | JetStream Object Store bucket，必须满足 `^[-\\w]+$`   |
| `mediaRetentionHours` | 否   | `168`                       | 媒体对象保留时间，单位小时                                    |
| `mediaMaxMb`          | 否   | `20`                        | 单个媒体对象最大尺寸，单位 MiB                                |
| `mediaLocalRoots`     | 否   | 无                           | 额外允许读取的本地媒体目录数组；用于发送 OpenClaw 默认 roots 之外的本地文件 |
| `name`                | 否   | 无                           | 状态输出用的显示名称                                       |

如果你要通过 Lucy 发送类似 `/home/...`、`/mnt/...`、外接磁盘挂载目录之类的本地图片，而这些路径不在 OpenClaw 默认允许目录内，就必须显式配置 `channels.lucy.mediaLocalRoots`。Lucy 会把这些目录和 OpenClaw 运行时默认的安全 roots 合并，不会覆盖默认 roots。

示例：

```json5
{
  channels: {
    lucy: {
      enabled: true,
      apiKey: "demo_user",
      servers: ["nats://127.0.0.1:4222"],
      mediaLocalRoots: ["/home/lucy/data/usb", "/mnt/photos"],
    },
  },
}
```


远端 WSS 示例：

```json5
{
  plugins: {
    entries: {
      lucy: {
        enabled: true,
      },
    },
  },
  channels: {
    lucy: {
      enabled: true,
      apiKey: "demo_user",
      servers: ["wss://example.com/nats-ws"],
      token: "nats-token-placeholder",
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },
}
```

说明：

- 如果服务端只暴露 `wss://.../nats-ws`，不能把 scheme 改成 `nats://` 之后继续假设可用
- `token`、`username`、`password` 都是 Lucy 直连 NATS 时的认证信息，不是上游模型 provider 的凭据

## 运行验证

最小验证顺序：

1. `openclaw config validate`
2. `openclaw channels status --probe`
3. `openclaw gateway call channels.status --params '{"probe":true,"timeoutMs":10000}' --json`
4. 用 App 或 `scripts/demo-chat.ts` 发送一条消息
5. 等待 `assistant.final`

判断边界时，不要把传输层问题和模型配置问题混在一起：

- 看到了 `inbound.accepted`：NATS subject、Lucy listener、OpenClaw 路由已打通
- 看到了 `assistant.start` 或 `assistant.partial`：模型执行已经开始
- 看到了 `assistant.final`，但文本是上游鉴权失败或 HTTP 401：Lucy 正常，问题在 provider
- 没有 `inbound.accepted`：先查 NATS 连接、subject 拼装、Gateway 是否真的在运行

机器读取 Lucy 运行参数时，优先使用 `gateway call channels.status ... --json`。常用路径：

- `.channels.lucy.deviceId`：当前持久化实例 id
- `.channelAccounts.lucy[0].probe.connectedUrl`：当前连接到的 NATS 节点
- `.channelAccounts.lucy[0].probe.clientSubject`：App 入站 subject
- `.channelAccounts.lucy[0].probe.machineSubject`：App 订阅的事件 subject
- `.channelAccounts.lucy[0].probe.mediaBucket`：媒体 bucket
- `.channelAccounts.lucy[0].probe.mediaRetentionHours`：媒体保留时间

## 媒体传输

Lucy 将文本/控制事件和媒体字节分开处理。

入站媒体：

1. App 先把图片或音频上传到 JetStream Object Store
2. App 在 `client` 消息里携带 descriptor
3. Lucy 下载对象并注入 OpenClaw inbound context

出站媒体：

1. Agent 产出 `mediaUrl` / `mediaUrls`，或文本中的 `MEDIA: <path-or-url>` 指令
2. Lucy 选择第一个可识别的图片或音频源，上传到 Object Store
3. Lucy 在 `assistant.final.media` 中返回 descriptor

协议级注意事项：

- `media.transport` 固定为 `jetstream-object-store`
- 默认 bucket 为 `lucy_media_v2`
- 默认保留时间为 7 天
- 当前每个 `assistant.final` 最多只包含一个媒体对象
- 如有多个候选媒体，丢弃计数可能出现在 `metadata.droppedMediaCount`
- 如果 `mediaUrl` / `mediaUrls` 是本地路径，这个路径必须先落在 OpenClaw 允许的本地媒体根目录内；典型允许根包括 `~/.openclaw/media`、`~/.openclaw/workspace`、`~/.openclaw/agents`、`~/.openclaw/sandboxes` 和 OpenClaw tmp 目录。若你需要发送这些默认 roots 之外的路径，例如 `/home/.../data/...` 或挂载盘目录，请把对应父目录显式加入 `channels.lucy.mediaLocalRoots`
- 如果上游通过 `message` 工具把图片主动推送到 Lucy，工具里常见的目标写法是 `lucy:<apiKey>`；Lucy 会把它归一化到 `<apiKey>` 对应的命名空间再发到 machine subject

详细 schema 与事件语义请看 `[doc/app-nats-integration.md](doc/app-nats-integration.md)`。

## 开发与调试命令

以下命令从 OpenClaw 仓库根目录运行：

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"
pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts
docker build --build-arg OPENCLAW_EXTENSIONS=lucy -t openclaw:local -f Dockerfile .
```

建议遵循边界优先的调试流程：

1. 先跑 Lucy 的单测和定向 typecheck
2. 再启动最小 Docker 栈
3. 先读 Gateway 日志，再改代码
4. 每次关键变更后重新执行 `channels status --probe`；需要给 App 取稳定字段时，再执行 `gateway call channels.status ... --json`
5. 先证明传输层，再看模型 provider

## 常见故障信号


| 信号                              | 解释                                 | 首要动作                                                            |
| ------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `auto-restart attempt N/10`     | Gateway 账户启动函数过早返回或抛错              | 检查 Lucy 生命周期代码和启动日志                                             |
| `configured, works, stopped`    | 配置通过，但 listener 没有持续运行             | 检查 `gateway.startAccount` 是否阻塞到 `abortSignal`                   |
| `Cannot find module 'nats'`     | 运行时依赖可见性问题，不是 TypeScript 问题        | 检查容器内 `/app/extensions/lucy/node_modules` 与 `/app/node_modules` |
| 没有 `inbound.accepted`           | subject、NATS 连通性或 Lucy listener 异常 | 先验证 probe 输出与 App 实际 subject 是否一致                               |
| 出现 `assistant.final` 但内容是上游鉴权失败 | Lucy 传输层健康                         | 转去检查 provider 配置                                                |
| `Local media path is not under an allowed directory` | 上游生成了一个不在可信根目录内的本地 `mediaUrl` | 先把文件复制到 `~/.openclaw/media` 或 agent workspace 再发送，不要直接引用任意 `/home/...` 路径 |
| 同一条入站消息出现重复 accepted/final      | 可能是 Gateway 自动重启导致重复监听             | 排查 listener 生命周期与容器重启                                           |


本地 Docker 调试时，如果日志提示运行时找不到 `nats`，不要只盯着镜像构建结果。需要同时确认容器运行时的依赖挂载仍然有效，尤其是 `./extensions/lucy/node_modules:/app/extensions/lucy/node_modules` 这类本地挂载。
