# Lucy 文档导览

Lucy 是 OpenClaw 的 NATS-based DM-only Channel 插件，用 `lucy-im-sdk-nodejs` SDK 处理认证、绑定、消息收发和存在管理。本文档按分层主题组织，帮助不同角色快速定位所需内容。

## 文档结构

### 第一章：系统架构与生命周期

- [01-overview/architecture.md](01-overview/architecture.md) — Lucy 系统全景图：SDK 分工、plugin 职责边界、核心组件关系
- [01-overview/plugin-lifecycle.md](01-overview/plugin-lifecycle.md) — 插件从注册到消息转发的完整生命周期
- [01-overview/data-flow.md](01-overview/data-flow.md) — 端到端数据流：从 App 消息到 OpenClaw 网关再到模型执行
- [01-overview/diagrams.md](01-overview/diagrams.md) — Mermaid 流程图索引（绑定流、消息流、重启流等）

### 第二章：认证与设备绑定

- [02-auth-binding/integrated-flow.md](02-auth-binding/integrated-flow.md) — 完整的绑定+认证流程：设备注册、OTP、binding 轮询、NATS token 换取
- [02-auth-binding/user-center-integration.md](02-auth-binding/user-center-integration.md) — user-center API 详解：`/v1/devices/new`、`/v1/channels/lucy/devices/device-bindings`、model-config 端点

### 第三章：传输层（NATS/JetStream）

- [03-transport/nats-subjects.md](03-transport/nats-subjects.md) — Lucy NATS 主题约定：入站/出站主题格式、消息版本演进（v2/v3/v4）
- [03-transport/jetstream-consumer.md](03-transport/jetstream-consumer.md) — JetStream Pull Consumer 架构：stream `IM_NPC`、durable consumer、消息分发路由
- [03-transport/presence.md](03-transport/presence.md) — Presence 机制：在线/离线状态、心跳、`_discover` 事件、ping/pong

### 第四章：消息与执行流程

- [04-messaging/inbound-pipeline.md](04-messaging/inbound-pipeline.md) — 入站消息管道：路由、验证、模型执行、超时处理
- [04-messaging/machine-events.md](04-messaging/machine-events.md) — 机器事件格式与发布：事件类型、版本字段、JSON 架构、Snowflake ID
- [04-messaging/exec-approvals.md](04-messaging/exec-approvals.md) — 执行审批流程：pending 回复格式、OpenClaw approvals 网关集成

### 第五章：模型供应与自动重启

- [05-model-provisioning/cephalon-provider.md](05-model-provisioning/cephalon-provider.md) — 嵌入式 Cephalon 提供者：模型列表、默认模型、provider ID 注册
- [05-model-provisioning/provision-flow.md](05-model-provisioning/provision-flow.md) — 供应流程：`version=3/kind=provision_model` 消息、配置写入、gateway restart 触发
- [05-model-provisioning/auto-restart.md](05-model-provisioning/auto-restart.md) — 自动重启机制：restart ticket、completion event、重启计时器

### 第六章：媒体传输

- [06-media/object-store.md](06-media/object-store.md) — JetStream Object Store：桶创建、媒体上传/下载、描述符格式
- [06-media/outbound-sources.md](06-media/outbound-sources.md) — 出站媒体加载：文件 URL 解析、本地路径白名单、MIME 类型判断

### 第七章：集成接口

- [07-integrations/app-integration.md](07-integrations/app-integration.md) — App/客户端集成指南：绑定 QR 码、NATS 凭证、模型切换通知
- [07-integrations/ble-pairing-export.md](07-integrations/ble-pairing-export.md) — BLE pairing 导出：`pairing-info.json` 格式、blue-wifi 读取、iOS 配对流程
- [07-integrations/usb-local-notify.md](07-integrations/usb-local-notify.md) — USB 本地通知：HTTP 服务器、事件码（插入/同步/完成/失败/拔出）、机器事件转换

### 第八章：运维与配置

- [08-operations/cli-commands.md](08-operations/cli-commands.md) — Lucy CLI 命令：`openclaw lucy auth-qrcode`、`reset-state`、配置验证
- [08-operations/config-reference.md](08-operations/config-reference.md) — Lucy 配置项全参考：`channels.lucy.*`、`models.providers.cephalon.*`、环境变量
- [08-operations/debugging.md](08-operations/debugging.md) — 调试脚本与决策树：probe 脚本列表、常见故障信号、分层验证方法

### 第九章：测试策略

- [09-testing/test-strategy.md](09-testing/test-strategy.md) — 测试组织与运行方法：单元测试、集成测试、Docker 验证、iOS 回归检查

---

## 按角色分流

### 🎯 新接手 Lucy 的工程师

**快速入门路径：**
1. [系统架构](01-overview/architecture.md) — 了解 SDK vs Plugin 分工
2. [插件生命周期](01-overview/plugin-lifecycle.md) — 把握启动流程
3. [完整绑定流程](02-auth-binding/integrated-flow.md) — 理解认证链路
4. [数据流概览](01-overview/data-flow.md) — 看消息如何流转
5. [运维调试](08-operations/debugging.md) — 学会诊断问题

### 📱 App / iOS 开发者

**关键文档：**
- [NATS 主题约定](03-transport/nats-subjects.md) — 消息格式与主题规则
- [App 集成指南](07-integrations/app-integration.md) — 客户端接入步骤
- [BLE 配对导出](07-integrations/ble-pairing-export.md) — iOS 扫描与配对
- [user-center API](02-auth-binding/user-center-integration.md) — 调用哪些 API
- [入站消息管道](04-messaging/inbound-pipeline.md) — 消息如何被处理

### 🔧 运维与部署

**关键文档：**
- [配置参考](08-operations/config-reference.md) — 所有配置项说明
- [CLI 命令](08-operations/cli-commands.md) — 绑定 QR 码生成、重置等
- [调试决策树](08-operations/debugging.md) — 问题排查流程
- [模型供应](05-model-provisioning/provision-flow.md) — 模型推送与重启

### 🏭 模型/供应商集成

**关键文档：**
- [Cephalon 提供者](05-model-provisioning/cephalon-provider.md) — 嵌入式提供者机制
- [供应流程](05-model-provisioning/provision-flow.md) — 下发配置的全流程
- [自动重启](05-model-provisioning/auto-restart.md) — 重启票证与完成通知
- [user-center 模型配置](02-auth-binding/user-center-integration.md#model-config) — API 返回格式

### 📡 通道/BLE 集成

**关键文档：**
- [BLE 配对导出](07-integrations/ble-pairing-export.md) — pairing-info.json 格式
- [NATS 主题](03-transport/nats-subjects.md) — 消息路由规则
- [本地 USB 通知](07-integrations/usb-local-notify.md) — 事件推送机制
- [完整绑定流程](02-auth-binding/integrated-flow.md) — 前后端协调

---

## 快速链接

- **源码位置：** `extensions/lucy/src/`
- **外部组件（symlink）：** `extensions/lucy/outside/`（user-center、iOS demo、NATS 服务器）
- **脚本与测试：** 见 [第八章调试](08-operations/debugging.md) 和 [第九章测试](09-testing/test-strategy.md)
- **旧文档迁移：** 见 [`../doc/README.md`](../doc/README.md) 的重定向说明

---

**最后更新：** 2026-04-16  
**代码版本：** ai-npc 分支，以 `src/` 为事实源
