<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# USB 本地通知入口

本文档面向机器端守护进程和系统集成开发者。它说明了 Lucy 如何通过 HTTP 本地端点接收和处理 USB 热插拔事件，转化为用户可见的 AI 助手消息。

## 概览

Lucy 提供了一个本地 HTTP 服务器端点，监听来自机器端守护进程的 USB 事件通知。当守护进程检测到 USB 设备插入、拔出或同步时，可以通过 HTTP POST 请求通知 Lucy，Lucy 会自动生成中文提示文案，并以 `assistant.final` 机器事件的形式发送给 App，用户可在聊天界面直接看到。

**典型场景：**
- U 盘插入时：自动提示"U盘已插入（设备名），同步开始"
- U 盘同步中：定期推送"U盘同步中（设备名）…"
- 同步完成：推送"U盘同步完成（设备名），共 N 个文件"
- 同步失败：推送"U盘同步失败（设备名），错误：xxx"
- U 盘拔出：推送"U盘已拔出（设备名）"

这是一条旁路，不经过 OpenClaw runtime 和模型，适合系统级的快速通知。

## HTTP 端点与请求格式

### 端点地址

```
POST http://127.0.0.1:{port}/usb-events
```

- **主机**：`127.0.0.1`（仅本机访问）
- **路径**：`/usb-events`（可通过配置 `channels.lucy.localNotify.path` 覆盖，默认 `/usb-events`）
- **端口**：`channels.lucy.localNotify.port`（默认 `8000`）

### 请求体格式

```json
{
  "code": 1,
  "device": "USB设备名称或标识符",
  "message": "可选的详细信息或错误消息"
}
```

**字段说明：**

| 字段 | 类型 | 范围 | 说明 |
|------|------|------|------|
| `code` | number | 1–5 | USB 事件码（详见下表） |
| `device` | string | 1–256 字 | 设备名称或标识符（例如 `/dev/sda1`、"My USB Drive"） |
| `message` | string | 0–512 字 | 可选的事件细节或错误信息 |

**event code 映射**（`src/local-notify.ts`）：

| code | 事件 | 对应 AI 消息 | 典型 message 内容 |
|-----|------|------------|------------------|
| 1 | USB 设备插入 | "U盘已插入（device）" | 可选文件计数或初始化信息 |
| 2 | USB 同步中 | "U盘同步中（device）" | 进度百分比或已同步文件数 |
| 3 | USB 同步完成 | "U盘同步完成（device）" | 总文件数、大小等统计 |
| 4 | USB 同步失败 | "U盘同步失败（device）" | 错误描述（磁盘满、权限不足等） |
| 5 | USB 设备拔出 | "U盘已拔出（device）" | 可选说明 |

### 请求示例

```bash
# 插入事件
curl -X POST http://127.0.0.1:8000/usb-events \
  -H "Content-Type: application/json" \
  -d '{
    "code": 1,
    "device": "My Backup Drive",
    "message": "32GB USB 3.0 设备"
  }'

# 同步完成
curl -X POST http://127.0.0.1:8000/usb-events \
  -H "Content-Type: application/json" \
  -d '{
    "code": 3,
    "device": "/dev/sda1",
    "message": "2,048 files, 15.3 GB synced successfully"
  }'

# 同步失败
curl -X POST http://127.0.0.1:8000/usb-events \
  -H "Content-Type: application/json" \
  -d '{
    "code": 4,
    "device": "backup-usb",
    "message": "磁盘空间不足，剩余 < 1 GB"
  }'
```

### 响应格式

**成功响应（202 Accepted）：**

```json
{
  "ok": true,
  "event_id": "evt_123456",
  "timestamp_ms": 1639900000000
}
```

**失败响应（400 Bad Request）：**

```json
{
  "ok": false,
  "error": "missing required field: device"
}
```

**错误场景与响应码：**

| 情形 | HTTP 码 | 错误信息 |
|------|---------|---------|
| 请求体解析失败 | 400 | `invalid json` |
| 缺少必需字段 | 400 | `missing required field: <field>` |
| `code` 不在 1–5 范围 | 400 | `code must be between 1 and 5` |
| 路径错误 | 404 | `Not Found` |
| 请求方法不是 POST | 405 | `Method Not Allowed` |
| 请求体超过 64KB | 413 | `Payload Too Large` |

## 消息转换与发送

当 Lucy 收到有效的 USB 事件请求后：

1. **提取字段**：从 JSON 解析 `code`、`device`、`message`
2. **生成文案**：调用 `buildLucyLocalNotifyText()`（`src/local-notify.ts:141`）根据 code 和 device 生成中文前缀，拼接可选的 message
   - 前缀例：`"U盘已插入"`, `"U盘同步中"`, `"U盘同步失败"`
   - 完整文案例：`"U盘已插入（My Backup Drive）：32GB USB 3.0 设备"`
3. **构造事件**：创建 `LucyMachineEvent`，类型为 `assistant.final`，文本为上一步的完整文案
4. **发布**：调用 `publishLucyMachineEvent()`（`src/send.ts:62`）通过 NATS JetStream 发送到 `cephalon.im.user.<user_id>`
5. **App 展示**：App 收到事件后，作为 assistant 的最终消息展示在聊天气泡中

**流程图：**

参考 [USB 本地通知入口流程](../01-overview/diagrams.md#diagram-usb-local-notify)。

## 配置与启用

### 配置选项

Lucy 的本地通知服务由以下配置键控制（`src/config-schema.ts`）：

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `channels.lucy.localNotify.enabled` | boolean | `true` | 是否启用本地通知服务 |
| `channels.lucy.localNotify.bind` | string | `"127.0.0.1"` | 监听地址（仅本机） |
| `channels.lucy.localNotify.port` | number | `8000` | 监听端口 |
| `channels.lucy.localNotify.path` | string | `"/usb-events"` | HTTP 路径 |

### 环境变量覆盖

```bash
export LUCY_LOCAL_NOTIFY_ENABLED=true
export LUCY_LOCAL_NOTIFY_PORT=8000
export LUCY_LOCAL_NOTIFY_PATH=/usb-events
```

### 启动验证

```bash
# 检查本地通知服务是否在运行
netstat -tlnp | grep 8000

# 或使用 curl 探测（应返回 400，因为缺少字段）
curl -X POST http://127.0.0.1:8000/usb-events \
  -H "Content-Type: application/json" \
  -d '{}'
# 预期响应：
# {"ok":false,"error":"missing required field: code"}
```

## 机器端守护进程集成示例

### 使用 systemd + udev 监听 USB 插拔

```bash
# /etc/udev/rules.d/90-lucy-usb-notify.rules
ACTION=="add", SUBSYSTEM=="block", ENV{ID_BUS}=="usb", \
  RUN+="/usr/local/bin/lucy-usb-notify-insert %E{DEVNAME} %E{ID_MODEL}"

ACTION=="remove", SUBSYSTEM=="block", ENV{ID_BUS}=="usb", \
  RUN+="/usr/local/bin/lucy-usb-notify-eject %E{DEVNAME} %E{ID_MODEL}"
```

### 通知脚本（Bash 示例）

```bash
#!/bin/bash
# /usr/local/bin/lucy-usb-notify-insert

DEVICE=$1
MODEL=$2
LUCY_NOTIFY_URL="http://127.0.0.1:8000/usb-events"

curl -X POST "$LUCY_NOTIFY_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"code\": 1,
    \"device\": \"${MODEL:-$DEVICE}\",
    \"message\": \"设备已插入，准备同步\"
  }"
```

### 同步完成通知（Python 示例）

```python
#!/usr/bin/env python3
import requests
import json
import sys

def notify_lucy_sync(device: str, status: int, message: str):
    """向 Lucy 发送 USB 同步事件"""
    url = "http://127.0.0.1:8000/usb-events"
    payload = {
        "code": status,
        "device": device,
        "message": message
    }
    try:
        response = requests.post(url, json=payload, timeout=5)
        if response.status_code == 202:
            print(f"✓ Lucy notification sent: {status} - {device}")
        else:
            print(f"✗ Lucy notification failed: {response.status_code} - {response.text}")
    except Exception as e:
        print(f"✗ Error notifying Lucy: {e}", file=sys.stderr)

# 示例：同步完成
notify_lucy_sync("/dev/sda1", 3, "2,048 files synchronized in 45 seconds")

# 示例：同步失败
notify_lucy_sync("/dev/sdb1", 4, "磁盘空间不足，只同步了 512 个文件")
```

## 数据安全与限制

### 请求大小限制

- **最大请求体**：64 KB（`channels.lucy.localNotify.maxRequestBytes`，硬编码默认 65536）
- **超过限制**：返回 413 Payload Too Large

### 字段长度约束

| 字段 | 最大长度 | 原因 |
|------|---------|------|
| `device` | 256 字 | zod schema 限制 |
| `message` | 512 字 | zod schema 限制 |
| `code` | 1–5 | 固定枚举 |

### 安全考虑

1. **本机通信**：仅接受 `127.0.0.1` 的请求，不支持远程通知（网络隔离）
2. **无身份认证**：本地通知不需要 Lucy 的 NATS token，适合系统守护进程
3. **无日志外泄**：`message` 字段不经过 OpenClaw 安全审计，仅在消息链中可见
4. **速率限制**：当前无速率限制，守护进程应自行控制频率（例如每秒最多 10 条）

## 故障排查

| 现象 | 原因 | 排查步骤 |
|------|------|---------|
| curl 返回 connection refused | Lucy 本地通知服务未启动 | 检查 `openclaw channels status --probe`，确认 Lucy gateway 在运行；检查配置 `channels.lucy.localNotify.enabled` |
| curl 返回 404 | 路径配置错误 | 检查 curl 的 URL 路径是否与配置 `channels.lucy.localNotify.path` 一致 |
| curl 返回 400 invalid json | 请求体 JSON 格式错误 | 使用 `jq` 验证 JSON：`echo '...' \| jq .` |
| curl 返回 202 但 App 没收到消息 | 用户未绑定或 NATS 连接断开 | 检查 Lucy channels status，确认用户已绑定；检查 NATS JetStream 消费者状态 |
| App 收到消息但文案不正确 | `code` 或 `device` 字段值错误 | 检查是否传入了意料之外的 code（应为 1–5），device 是否包含特殊字符 |

## 相关文档

- [机器事件详解](../04-messaging/machine-events.md)
- [出站媒体来源](../06-media/outbound-sources.md)
- [App 接入指南](./app-integration.md)
