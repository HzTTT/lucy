<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# CLI 命令参考

本文档列出了 Lucy 插件提供的所有命令行工具。这些命令可以帮助开发者和运维人员快速诊断、配置和重置 Lucy 的运行状态。

## Lucy 专有命令

Lucy 在 OpenClaw CLI 下注册了两个核心命令。通过 `registerLucyCommand()`（`src/command.ts:117`）在启动时自动注册。

### openclaw lucy auth-qrcode

**用途**：生成设备绑定二维码 URI，用于 App 扫码绑定。该命令每次执行都会调用 SDK 的 `preBind()` 申请新的 OTP。

**命令：**

```bash
openclaw lucy auth-qrcode [--json]
```

**选项：**
- `--json`：以 JSON 格式输出，便于脚本解析

**输出示例（纯文本）：**

```
Lucy auth QR code generated.

1) Open Lucy iOS Demo
2) Sign in to user-center
3) Scan this QR code to capture channel_device_id
4) Confirm the bind action in the app

channel_device_id: 2044762959396634624
bind_url: lucy://bind?channel_device_id=2044762959396634624&otp=153298

[QR 码 ASCII 艺术]
```

**关键点**：
- **OTP 每次刷新**：每次执行 `openclaw lucy auth-qrcode` 时，SDK 调用 `preBind()` 生成新的 OTP（一次性密码，有效期通常 60 秒）
- **必须包含 OTP**：正常的 App 扫码绑定流程**必须**提供有效的 OTP；不提供 OTP 则绑定失败
- **不可持久化**：OTP 是临时凭证，不写入磁盘；如果过期需重新运行此命令申请新 OTP

**典型场景：**

1. **首次启动 Lucy**，需要扫码绑定设备
2. **恢复设备**，原 QR 码已丢失
3. **调试绑定流程**，验证 QR URI 格式是否正确

### openclaw lucy reset-state

**用途**：清除本地绑定状态，重置设备为未绑定状态。通常用于测试或换用户。

**命令：**

```bash
openclaw lucy reset-state [--confirm]
```

**选项：**
- `--confirm`：跳过确认提示，直接执行重置

**后续操作：**

重置后，设备会回到 `unregistered` 状态，需要运行：

```bash
openclaw lucy auth-qrcode
```

## 通用诊断命令

### openclaw channels status --probe

**用途**：实时探测所有注册的 channel，包括 Lucy，检查其连接状态和健康度。

```bash
openclaw channels status [--probe] [--json]
```

**Lucy 状态指示：**
- `configured, works, connected`：正常运行
- `configured, works, stopped`：配置正确但监听未启动

### openclaw gateway call channels.status --json

**用途**：以机器可读的 JSON 格式获取精确的频道状态。

```bash
openclaw gateway call channels.status \
  --params '{"probe":true,"timeoutMs":10000}' \
  --json
```

### openclaw gateway logs

**用途**：查看 OpenClaw gateway 的实时日志，包括 Lucy 的启动、绑定、消息处理等。

```bash
openclaw gateway logs --tail 100
openclaw gateway logs --grep "lucy" --tail 200
openclaw gateway logs --follow
```

## 配置管理

### 检查 Lucy 配置

```bash
openclaw config get channels.lucy
```

### 修改 Lucy 配置

```bash
openclaw config set channels.lucy.localNotify.enabled true
openclaw config set channels.lucy.localNotify.port 8788
openclaw config set channels.lucy.pairingSocket /var/run/lucy/pairing.sock
```

### 重启 Gateway

```bash
openclaw gateway restart
```

## 相关文档

- [配置参考](./config-reference.md)
- [排障指南](./debugging.md)
