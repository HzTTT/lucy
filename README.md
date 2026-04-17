# Lucy

Lucy 是 OpenClaw 的 NATS-based Channel 插件，把 OpenClaw Gateway 接到 Lucy App 的消息链路上。插件包名是 `@hzttt/lucy-ai-npc`；在 OpenClaw 内部，插件 ID、配置前缀和 CLI 命令都叫 `lucy`。

## 版本要求

OpenClaw `2026.3.23` 及以上。

## 最小接入三步

```bash
# 1. 安装插件
openclaw plugins install @hzttt/lucy-ai-npc

# 2. 启用 Lucy channel
openclaw config set channels.lucy.enabled true

# 3. 生成绑定二维码
openclaw lucy auth-qrcode
```

在 Lucy App 中扫描二维码，完成设备绑定。绑定完成后 App 可拉取 `GET /v1/channels/lucy/current-user/model-config` 获取模型配置，然后推送给设备。设备自动重启后上线。

## 常用验证命令

```bash
# 查看 Lucy 运行状态和连接信息
openclaw channels status --probe

# 重新生成设备身份和绑定 QR 码（清空本地状态）
openclaw lucy reset-state
```

## 常见配置

最小配置（NATS 服务器地址由 lucy-server 动态返回）：

```json
{
  "channels": {
    "lucy": {
      "enabled": true
    }
  }
}
```

如需本地 USB 通知事件回报：

```json
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

详细配置说明见 [docs/08-operations/config-reference.md](docs/08-operations/config-reference.md)。

## 进一步文档

完整文档按分层主题组织在 `docs/` 下：

- **新接手？** 先读 [docs/01-overview/architecture.md](docs/01-overview/architecture.md)（系统架构）和 [docs/01-overview/plugin-lifecycle.md](docs/01-overview/plugin-lifecycle.md)（生命周期）
- **App 开发？** 直接读 [docs/07-integrations/app-integration.md](docs/07-integrations/app-integration.md)
- **运维排障？** 读 [docs/08-operations/debugging.md](docs/08-operations/debugging.md)
- **完整导航？** 见 [docs/README.md](docs/README.md)

## 快速链接

- 源码：`extensions/lucy/src/`
- 外部组件（symlink）：`extensions/lucy/outside/`（user-center、iOS 客户端、NATS 服务器）
- 旧文档迁移说明：[doc/README.md](doc/README.md)
