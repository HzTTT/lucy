# Lucy Channel 插件 — AI Agent 指引

## Scope

这个目录是 Lucy OpenClaw Channel 插件：一个 DM-only NATS 传输，通过 `lucy-im-sdk-nodejs` 连接 OpenClaw Gateway 和 Lucy 客户端。SDK 负责认证、绑定、NATS token 交换、JetStream 消息收发和 Presence。插件负责 OpenClaw 集成、媒体传输和模型供应；**不负责**模型/供应商可用性。

当代码和文档有矛盾时，以当前代码为事实源，更新文档以匹配代码。

## 必读文档

所有这些文档都指向 `docs/` 新结构（不再用 `doc/` 旧文件）：

- `docs/01-overview/architecture.md` — Lucy 系统架构：SDK 分工、plugin 职责、核心组件关系
- `docs/02-auth-binding/integrated-flow.md` — 完整的绑定+认证流程：设备注册、OTP、binding 轮询、NATS token
- `docs/03-transport/nats-subjects.md` — NATS 主题约定：入站/出站主题、消息版本
- `docs/08-operations/debugging.md` — 调试脚本和决策树
- 完整索引：`docs/README.md`

## 关联的外部组件（`outside/` symlink）

这些组件是真实集成的一部分。修改时需要同步验证：

- `outside/LucyIOSDemo` — iOS 客户端和协议验证应用。修改 app-facing 协议、BLE pairing UX、机器事件、主题时检查
- `outside/user-center` — 注册、绑定、current-user 凭证查询的服务端真相源。修改 `cdi`、`cuk`、`user_id`、bind 流程、`/v1/channels/lucy/*` 契约时检查
- `outside/npc-im-server` — NATS 认证和 Presence 基础设施。`auth-callout` 验证 Lucy NATS 凭证，`presence-bridge` 转换 `_discover` 事件
- `outside/blue-wifi` — BLE Wi-Fi 供应代理。读 Lucy 的 `pairing-info.json`，通过 BLE 暴露为 `lucy_pairing_info` 特性

## 架构角色

把这个仓库视为 **OpenClaw 侧的 Lucy channel 集成**，而不是用户身份或绑定状态的真相源。

**Lucy 插件职责**（通过 `lucy-im-sdk-nodejs`）：
- 生成 Ed25519 密钥对，向 user-center 注册设备获得 `cdi`
- 执行 pre-bind OTP 和轮询绑定获得 `cuk` + `user_id`
- 交换 Ed25519 签名的参数换取 NATS token 并连接
- 通过 JetStream Pull Consumer (stream `IM_NPC`, durable `npc-<cdi>`) 订阅/发布
- SDK 内部处理 Presence（`_discover` 在线/离线、心跳、ping 回复）
- 导出清理后的配对状态供 BLE/onboarding 流程使用
- 在 Lucy 插件包内部嵌入注册 `cephalon` provider
- 接受 `version = 3 / kind = provision_model` 控制消息
- 写入 `models.providers.cephalon.*` 并切换 `agents.defaults.model.primary`
- 供应后自动触发 `openclaw gateway restart`（或配置的重启辅助命令）

**user-center 职责**：接受 Ed25519 公钥注册返回 `cdi`；拥有用户-设备绑定、`cuk`、凭证查询；暴露 `GET /v1/channels/lucy/current-user/model-config`；懒创建并重用 Lucy 专属模型 API key

**lucy-server 职责**：pre-bind OTP 签名（Ed25519 验证）；设备绑定状态查询（Ed25519 验证）；NATS token 交换（Ed25519 验证）

**outside/npc-im-server/auth-callout 职责**：验证 NATS token；为验证的设备颁发最小 NATS 权限

**outside/blue-wifi 职责**：读 Lucy 本地配对导出，通过 BLE 暴露

**iOS / 外部客户端职责**（通过 `lucy-im-sdk-kotlin`）：扫 QR 或获取 BLE 配对信息获得 `cdi`；调用 user-center bind/current-user API；通过自己的 SDK 连接 NATS

保持术语一致：`cdi`、`cuk`、`user_id`、Ed25519 密钥对。

## 项目结构与关键代码

Lucy 是 TypeScript ESM OpenClaw Channel 插件。认证、绑定、NATS 连接、JetStream 消息、Presence 全部委托给 `lucy-im-sdk-nodejs`（git submodule `lucy-im-sdk/`）。

**完整的源码文件分类与职责见 `src/AGENTS.md`**（按传输层、绑定认证、模型供应、状态配置、媒体、本地通知、执行审批、辅助与入口分组）。

顶层入口：
- `index.ts`（在 `extensions/lucy/` 根，不在 `src/`）— 默认导出 `defineLucyChannelPluginEntry()` 给 OpenClaw 加载器
- `src/channel-plugin-entry.ts` — entry 钩子实现（注册 channel、命令、provider）
- `src/channel.ts` — 顶级 ChannelPlugin 定义
- `src/gateway.ts` — 入站消息管道、JetStream consumer、运行时事件镜像（当前最大的实现文件）
- `src/run-context.ts` — 入站请求的 AsyncLocalStorage 上下文（`sourceMessageId`、`cuk`、`cdi`、`sessionKey`），用于异步处理链路中传递 per-request 元数据

## 启动和绑定流程

网关启动是 binding-first，使用 `lucy-im-sdk-nodejs`：

1. `startLucyGateway()` 用配置（`homeDir`、`userCenterDomain`、`lucyServerDomain`、`kind`）创建 `LucyImClient`
2. 调 `client.init()` — SDK 生成 Ed25519 密钥对、注册设备（公钥 → `cdi`）、检查本地 `cuk`/`user_id`
3. 如果 `PendingBind`：调 `client.preBind()` 获取 OTP，然后 `client.pollBinding()` 轮询到绑定完成（持久化 `cuk` + `user_id`）
4. 调 `client.connect()` — SDK 交换 Ed25519 签名的参数换取 NATS token、连接、初始化 JetStream、启动 Presence
5. 插件通过 `session.subscribeChannel("cephalon.im.npc.<user_id>.<cdi>", handler)` 订阅
6. 插件通过 `session.publishChannel("cephalon.im.user.<user_id>", payload)` 发布

SDK 在 `~/.lucy/identity/` 下存储状态（Ed25519 密钥在 `bootstrap_token/`，标识在 `channel_ids/`）。

## 跨仓库修改检查清单

- **协议字段或机器事件改动**：更新 `extensions/lucy/src/**`、验证 `outside/LucyIOSDemo/**`
- **绑定语义或 user-center / lucy-server API 改动**：SDK 内部处理；验证 `outside/user-center/**`
- **模型供应 / 自动重启 / 嵌入式 `cephalon` provider 改动**：更新 `cephalon-provider.ts`、`provider-provisioning.ts`、`restart-ticket.ts`、`gateway.ts`、`types.ts`；验证 `outside/user-center/**` 和 `outside/LucyIOSDemo/**`；三个仓库同时更新文档使 provider id、model id、事件名、重启行为、`base_url` 语义保持一致
- **Presence / `_discover` / 心跳 / NATS 认证改动**：Presence 由 SDK 内部处理（lucy-im-sdk/src/natsConn.ts）；NATS 认证是 token-based via SDK；验证 `outside/npc-im-server/**`
- **配对导出改动**：更新 `pairing-export.ts`；验证 `outside/blue-wifi/**` 和 `outside/LucyIOSDemo/**`
- **入站上下文 / AsyncLocalStorage 改动**：更新 `run-context.ts`、`gateway.ts`（通过 `runInLucyInboundContext()` 进入）、`channel.ts`；任何需要在异步处理链中读到 `sourceMessageId` / `cuk` / `cdi` 的新出站事件也要走这个 seam

## 调试工作流

见 `docs/08-operations/debugging.md` 了解完整的调试脚本目录和决策树。

分层优先级：证明最便宜的层先，然后向外扩展。

1. **先在本地证明 Lucy**：跑聚焦测试和针对 typecheck；若失败，修代码后再试 Docker
2. **启动最小化有用的栈**：先启 NATS 和 gateway；保持 SDK homeDir（`~/.lucy/identity/`）稳定
3. **分离 plugin 失败 vs 框架/config 失败**：读 gateway 日志；用 `channels status --probe` 人工检查；用 `gateway call channels.status ... --json` 获取稳定机器字段；如果 status 说 `configured, works, stopped`，检查 Lucy 生命周期/启动逻辑
4. **验证容器内运行时依赖可见性**：成功的镜像构建不保证运行时解析有效；若日志显示 `Cannot find module 'nats'`，检查 `/app/extensions/lucy/node_modules` 和 `/app/node_modules`
5. **先验证传输再验证模型认证**：`inbound.accepted` = JetStream consumer、channel routing、入站分发正常；`assistant.start`/`partial` = 模型执行启动；`assistant.final` 带上游认证文本或 HTTP 401 = Lucy 传输健康，provider 配置是瓶颈
6. **最后验证用更长的等待**：发一条消息等足够久的 `assistant.final`；需要精确事件顺序时用裸 NATS 订阅/发布

## 失败信号

- `auto-restart attempt N/10` — Lucy 启动返回太早或在 account start 时抛错
- `configured, works, stopped` — 框架接受了配置但 listener 没有保活
- `Cannot find module 'nats'` — 运行时打包问题，不是 TypeScript 问题
- 没有 `inbound.accepted` — JetStream consumer 设置、NATS token 交换、channel 启动破了
- `inbound.accepted` 出现但没有 assistant 事件 — 传输活跃；检查模型执行或上游运行时状态
- `assistant.final` 返回认证或 provider 错误 — Lucy 在工作；修 provider 凭证或模型配置
- 一条入站消息重复的 accepted/final 事件 — 怀疑 gateway 自动重启和重复 listener 注册，再怪 NATS

## 编码风格与命名

TypeScript ESM，2 空格缩进、分号、相对导入显式 `.js` 后缀。推荐写小的纯 helper（配置解析、主题逻辑、协议规范化）而不是复制验证。

## 测试指南

Vitest 是测试框架。`*.test.ts` 文件放在被测试代码旁。优先写协议 seam 和集成 seam 测试（配置解析、状态持久化、主题生成、配对导出、网关事件、媒体传输）再做 Docker-only 验证。

## 安全与配置提示

不要提交真实的 `cuk`、`cdi`、NATS token、Ed25519 私钥或 `user_id` 值。用仍然满足运行时格式规则的占位符（这些值在主题、认证、协议负载中使用）。

运行时包放在 `dependencies`；只在 `devDependencies` 或 `peerDependencies` 中放 `openclaw`，这样插件安装兼容主机加载器。

媒体路径依赖 native 模块 `@hzttt/lucy-blob-node-native`（通过 `lucy-im-sdk` 的 `blobPut`/`blobFetch` 间接使用）。升级版本或改动 blob 生命周期时，需确认 Docker/CI 镜像里有匹配平台的预编译二进制，否则运行时会报模块解析失败。

## OpenClaw SDK 兼容性

把主机 `openclaw` 包视为有效的 plugin SDK 版本。

- 推荐用 `openclaw/plugin-sdk` 获取通用 plugin API
- 不要从 Lucy 依赖 `openclaw/plugin-sdk/compat`
- 只在 Lucy 刻意需要已知版本的情况下用更窄的 subpath
- 改 SDK 时，用最旧和最新声称支持的主机版本验证 Lucy

## 快速启动命令

从 OpenClaw 根目录运行（除非特别说明）：

- `pnpm install` — 安装依赖
- `vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"` — 聚焦测试
- `pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts` — 针对 typecheck
- `docker compose -f extensions/lucy/docker-compose.nats.yml up -d nats` — 本地 NATS（可选）
- `pnpm exec tsx extensions/lucy/scripts/auth-qrcode.ts --json` — 打印绑定 QR
- `env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml up -d` — 本地栈
- `openclaw lucy auth-qrcode` — Lucy CLI 命令：生成绑定 QR
- `openclaw lucy reset-state` — 重置本地状态

见 `docs/09-testing/test-strategy.md` 了解完整的测试命令和 iPhone 验证流程。

---

**最后核对**：2026-04-18，以 `src/` 为事实源
