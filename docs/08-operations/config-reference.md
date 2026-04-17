<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/types.ts LucyConfigSchema 为事实源 -->

# 配置参考

本文档是 Lucy 插件的完整配置参考。所有配置项均在 `src/types.ts` 中以 `LucyConfigSchema`（zod）定义，通过 `src/config.ts` 的 `resolveLucyAccount()` 解析生效。

## 快速查询表

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `channels.lucy.enabled` | boolean | `true` | 启用/禁用 Lucy 频道 |
| `channels.lucy.name` | string | — | 频道显示名称（可选） |
| `channels.lucy.deviceType` | string | `"cloud"` | 设备类型，上报给 user-center 的 `POST /v1/devices/new` type 字段（`ai_npc` / `claw_pi` / `cloud`，SDK 不校验） |
| `channels.lucy.homeDir` | string | `~/.lucy/identity/` | SDK 身份数据目录 |
| `channels.lucy.userCenterDomain` | string | — | user-center API 域名（必填） |
| `channels.lucy.lucyServerDomain` | string | — | lucy-server 域名（必填） |
| `channels.lucy.subjectPrefix` | string | `"cephalon.im.npc"` | NATS 主题前缀 |
| `channels.lucy.dmPolicy` | `"allowlist"` \| `"open"` \| `"disabled"` | `"allowlist"` | DM 访问策略 |
| `channels.lucy.allowFrom` | string[] | `[]` | allowlist 策略下允许的用户 ID 列表 |
| `channels.lucy.mediaMaxMb` | number | `20` | 单个媒体文件最大 MB 数 |
| `channels.lucy.maxAttachments` | number | `10` | 单条消息最大附件数（上限 20） |
| `channels.lucy.mediaLocalRoots` | string[] | — | 允许出站的本地文件路径前缀白名单 |
| `channels.lucy.localNotify.enabled` | boolean | `true` | 启用 USB 本地通知 HTTP 服务 |
| `channels.lucy.localNotify.bind` | string | `"127.0.0.1"` | 本地通知监听地址 |
| `channels.lucy.localNotify.port` | number | `8788` | 本地通知监听端口 |
| `channels.lucy.localNotify.path` | string | `"/usb-events"` | 本地通知 HTTP 路径 |
| `channels.lucy.restartHelperCommand` | string | — | 自动重启时执行的命令（覆盖默认重启行为） |
| `channels.lucy.restartHelperArgs` | string[] | — | 重启命令的参数列表 |
| `channels.lucy.restartOnlineTimeoutMs` | number | — | 重启后等待网关上线的超时时长（毫秒） |
| `channels.lucy.pairingSocket` | string | — | blue-wifi IPC Unix domain socket 绝对路径 |

## 详细说明

### 通用配置

#### channels.lucy.enabled

- **类型**：`boolean`
- **默认值**：`true`
- **说明**：设为 `false` 时，Lucy 频道不会被加载，OpenClaw 会跳过初始化

```yaml
channels:
  lucy:
    enabled: true
```

#### channels.lucy.deviceType

- **类型**：`string`
- **默认值**：`"cloud"`
- **说明**：注册设备时上报给 user-center 的 `POST /v1/devices/new` 的 `type` 字段。SDK 不做校验，服务端枚举值：
  - `ai_npc` — AI NPC 设备
  - `claw_pi` — 龙虾派
  - `cloud` — 端脑云及其他（默认）

> 插件固定以 `kind: "lucy"` 调用 SDK，不再暴露为配置项。

```yaml
channels:
  lucy:
    deviceType: "ai_npc"
```

#### channels.lucy.homeDir

- **类型**：`string`（目录路径）
- **默认值**：`"~/.lucy/identity/"`
- **说明**：lucy-im-sdk-nodejs 存储 Ed25519 密钥和设备身份的目录。路径支持 `~` 展开到当前进程 HOME。目录必须存在或可创建，且有写权限

```yaml
channels:
  lucy:
    homeDir: "~/.lucy/identity/"
```

**目录结构**（由 SDK 自动创建）：
```
~/.lucy/identity/
├── bootstrap_token/        # Ed25519 私钥存储
│   └── key.pem
└── channel_ids/            # 设备和用户 ID
    ├── cdi
    ├── cuk
    └── user_id
```

#### channels.lucy.userCenterDomain

- **类型**：`string`（HTTPS URL）
- **默认值**：无（必填）
- **说明**：user-center 服务的 API 域名。SDK 会向该域名发起设备注册、绑定轮询、模型配置查询

```yaml
channels:
  lucy:
    userCenterDomain: "https://user.npc.im"
```

#### channels.lucy.lucyServerDomain

- **类型**：`string`（HTTPS URL）
- **默认值**：无（必填）
- **说明**：lucy-server 服务的 API 域名。SDK 会向该域名申请 OTP、轮询绑定状态、交换 NATS token

```yaml
channels:
  lucy:
    lucyServerDomain: "https://npc.im"
```

#### channels.lucy.subjectPrefix

- **类型**：`string`
- **默认值**：`"cephalon.im.npc"`
- **说明**：NATS 主题的前缀。通常不需要修改，仅在非标准 NATS 部署时才调整

```yaml
channels:
  lucy:
    subjectPrefix: "cephalon.im.npc"
```

### DM 访问策略

#### channels.lucy.dmPolicy

- **类型**：`"allowlist" | "open" | "disabled"`
- **默认值**：`"allowlist"`
- **说明**：
  - `"allowlist"`：只接受 `allowFrom` 中列出的用户发来的消息
  - `"open"`：接受所有已绑定用户的消息
  - `"disabled"`：拒绝所有入站消息

```yaml
channels:
  lucy:
    dmPolicy: "allowlist"
    allowFrom:
      - "user_id_1"
      - "user_id_2"
```

#### channels.lucy.allowFrom

- **类型**：`string[]`
- **默认值**：`[]`
- **说明**：当 `dmPolicy` 为 `"allowlist"` 时，只有此列表中的 `user_id` 可以发送消息。列表为空时，allowlist 策略会拒绝所有消息

### 媒体传输配置

#### channels.lucy.mediaMaxMb

- **类型**：`number`（正数）
- **默认值**：`20`
- **说明**：单个媒体文件的最大大小（MB）。超过限制的文件会被拒绝上传

```yaml
channels:
  lucy:
    mediaMaxMb: 20
```

#### channels.lucy.maxAttachments

- **类型**：`number`（正整数，最大 20）
- **默认值**：`10`
- **说明**：单条消息允许携带的最大附件数量

#### channels.lucy.mediaLocalRoots

- **类型**：`string[]`
- **默认值**：无（未设置时使用内置白名单）
- **说明**：允许 Lucy 读取并上传的本地文件路径前缀列表。用于出站附件的路径白名单校验

```yaml
channels:
  lucy:
    mediaLocalRoots:
      - "/home/user/documents/"
      - "/tmp/openclaw-attachments/"
```

### USB 本地通知配置

#### channels.lucy.localNotify.enabled

- **类型**：`boolean`
- **默认值**：`true`
- **说明**：启用后，Lucy 会在启动时创建本地 HTTP 服务器，监听 USB 事件通知

```yaml
channels:
  lucy:
    localNotify:
      enabled: true
```

#### channels.lucy.localNotify.bind

- **类型**：`string`（IP 地址）
- **默认值**：`"127.0.0.1"`
- **说明**：本地通知 HTTP 服务器监听地址。仅允许本机访问（不建议设置为 `0.0.0.0`）

```yaml
channels:
  lucy:
    localNotify:
      bind: "127.0.0.1"
```

#### channels.lucy.localNotify.port

- **类型**：`number`（1–65535）
- **默认值**：`8788`
- **说明**：本地通知 HTTP 服务器监听端口。若被占用，启动会失败，需要更改或释放端口

```yaml
channels:
  lucy:
    localNotify:
      port: 8788
```

**完整 URL**：`http://127.0.0.1:8788/usb-events`

#### channels.lucy.localNotify.path

- **类型**：`string`（HTTP 路径）
- **默认值**：`"/usb-events"`
- **说明**：本地通知的 HTTP POST 路径

```yaml
channels:
  lucy:
    localNotify:
      path: "/usb-events"
```

### 自动重启配置

#### channels.lucy.restartHelperCommand

- **类型**：`string`
- **默认值**：无（使用 OpenClaw 默认重启行为）
- **说明**：模型供应完成后触发 gateway 重启时执行的命令。未设置时使用默认重启路径

```yaml
channels:
  lucy:
    restartHelperCommand: "/usr/local/bin/restart-openclaw.sh"
    restartHelperArgs:
      - "--graceful"
```

#### channels.lucy.restartHelperArgs

- **类型**：`string[]`
- **默认值**：无
- **说明**：传给 `restartHelperCommand` 的参数列表

#### channels.lucy.restartOnlineTimeoutMs

- **类型**：`number`（正整数，毫秒）
- **默认值**：无（使用 SDK 内置超时）
- **说明**：重启后等待 gateway 重新上线的超时时长

### 配对 IPC 配置

#### channels.lucy.pairingSocket

- **类型**：`string`（Unix domain socket 绝对路径）
- **默认值**：无（不启用 IPC）
- **说明**：blue-wifi IPC Unix domain socket 的绝对路径。设置后，Lucy 在待绑定状态会通过该 socket 与 blue-wifi 代理通信，提供 OTP 和绑定事件。父目录必须存在且可写

```yaml
channels:
  lucy:
    pairingSocket: "/var/run/lucy/pairing.sock"
```

## 配置文件示例

### 最小配置（生产推荐）

```yaml
channels:
  lucy:
    enabled: true
    homeDir: "~/.lucy/identity/"
    userCenterDomain: "https://user.npc.im"
    lucyServerDomain: "https://npc.im"
```

### 完整配置（含所有常用选项）

```yaml
channels:
  lucy:
    enabled: true
    deviceType: "ai_npc"
    homeDir: "~/.lucy/identity/"
    userCenterDomain: "https://user.npc.im"
    lucyServerDomain: "https://npc.im"
    dmPolicy: "allowlist"
    allowFrom:
      - "user_id_1"
    mediaMaxMb: 20
    maxAttachments: 10
    localNotify:
      enabled: true
      bind: "127.0.0.1"
      port: 8788
      path: "/usb-events"
    pairingSocket: "/var/run/lucy/pairing.sock"
```

### 开发配置

```yaml
channels:
  lucy:
    enabled: true
    homeDir: "/tmp/lucy-identity/"
    userCenterDomain: "https://dev.user.npc.im"
    lucyServerDomain: "https://dev.npc.im"
    dmPolicy: "open"
    localNotify:
      enabled: true
      port: 8788
    pairingSocket: "/tmp/lucy-pairing.sock"
```

## 安全考虑

**禁止的做法：**
```yaml
# 不要在配置中硬编码 NATS token 或其他敏感凭证
channels:
  lucy:
    natsToken: "xxx"  # 该字段不存在
```

Lucy 通过 Ed25519 签名与 lucy-server 交换 token，所有敏感凭证由 SDK 托管在 `homeDir` 下，不应在配置文件中出现。

确保各目录的权限正确：

```bash
# homeDir 必须由 OpenClaw gateway 进程可读写（路径按运行用户的 HOME 展开）
mkdir -p ~/.lucy/identity/
chmod 700 ~/.lucy/identity/

# IPC socket 应只有本机进程可访问
chmod 600 /var/run/lucy/pairing.sock
```

## 故障排查

| 问题 | 配置检查 |
|------|---------|
| Lucy 启动失败，提示 `userCenterDomain is required` | 确保 `userCenterDomain` 已设置且非空 |
| Lucy 启动失败，提示 `lucyServerDomain is required` | 确保 `lucyServerDomain` 已设置且非空 |
| 本地通知端口被占用 | 更改 `localNotify.port`（默认 8788）或释放端口 |
| user-center 连接超时 | 验证 `userCenterDomain` 和网络连通性 |
| IPC socket 连接失败 | 确认 `pairingSocket` 路径存在且父目录可写 |
| 消息被拒绝（inbound.rejected） | 检查 `dmPolicy` 和 `allowFrom` 配置 |

## 相关文档

- [CLI 命令参考](./cli-commands.md)
- [排障指南](./debugging.md)
