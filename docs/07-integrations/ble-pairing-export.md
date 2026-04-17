<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# BLE 配对信息导出

本文档面向 BLE 设备和前端开发者。它说明了 Lucy 如何导出配对信息、pairing IPC 协议的客户端接口、以及 BLE 侧如何读取这些信息。

## 配对信息导出概览

Lucy 插件启动后，会调用 `syncLucyPairingExport()`（`src/pairing-export.ts:60`）在本地生成 `pairing-info.json`，包含启动后立即可用的设备信息（`cdi`、`cuk`、`user_id` 等）。这个文件由 BLE provisioning 应用（例如 `outside/blue-wifi`）通过文件系统或 IPC socket 读取，然后通过 GATT 特性暴露给 iOS/Android app。

**典型流程：**
1. Lucy 启动 → `startLucyGateway()` → `syncLucyBindingWithSdk()` → `syncLucyPairingExport()`
2. BLE 守护进程定期轮询或监听 `pairing-info.json` 文件变化
3. BLE 设备读取文件内容，通过 GATT 特性 `lucy_pairing_info` 暴露给附近的 iOS/Android app
4. App 读取 BLE 数据，直接扫码或手动输入 Lucy QR 码，完成绑定

## 配对信息导出文件格式

`pairing-info.json` 的完整结构（`src/pairing-export.ts:7–14` 中的 zod schema）：

```json
{
  "version": 1,
  "channel": "lucy",
  "state": "ready",
  "channel_device_id": "2044762959396634624",
  "binding_status": "pending",
  "created_at_ms": 1639900000000
}
```

**字段说明：**

| 字段 | 类型 | 说明 | 例值 |
|------|------|------|------|
| `version` | number | 导出格式版本，当前为 1 | `1` |
| `channel` | string | 通道标识符（总是 `"lucy"`） | `"lucy"` |
| `state` | string | 导出状态（总是 `"ready"`，表示 Lucy 已初始化） | `"ready"` |
| `channel_device_id` | string | 设备 ID（channel device ID），由 SDK 生成 | `"2044762959396634624"` |
| `binding_status` | string | 绑定状态：`"pending"`（待绑定）或 `"bound"`（已绑定） | `"pending"` 或 `"bound"` |
| `created_at_ms` | number | 导出时间戳（毫秒） | `1639900000000` |

**重要说明：**
- **不含 OTP**：`pairing-info.json` 刻意不包含 OTP，因为 OTP 是临时凭证，且持久化到磁盘会有安全风险
- **不含 cuk/user_id**：虽然 SDK 在绑定后会保存 `cuk` 和 `user_id` 到 `~/.lucy/identity/channel_ids/`，但 `pairing-info.json` 的导出只反映绑定状态（pending 或 bound），不暴露这些敏感标识符
- **绑定状态说明**：
  - `pending`：设备已注册（有 `channel_device_id`），但用户未在 app 侧完成绑定
  - `bound`：设备已完全绑定，用户可以收发消息

## Pairing IPC 协议

当 Lucy 进入待绑定状态（`PendingBind`）时，如果配置了 IPC socket 路径，插件会启动 pairing IPC 客户端（src/gateway.ts:625）。BLE/前端应用可以通过 Unix domain socket 连接到 Lucy，按照固定协议向 Lucy 实时申请 OTP 和接收绑定事件。

**OTP 的来源**：
- BLE 应用通过 IPC 发送 `bind.request` 消息
- Lucy 接收后，调用 SDK 的 `preBind()` 向 lucy-server 申请 OTP
- lucy-server 返回 `{ otp, expires_in }`（通常有效期 60 秒）
- Lucy 通过 IPC 发送 `otp.issued { otp, expires_at_ms, request_id }` 回复
- BLE 应用展示 OTP 或通过 GATT 特性暴露给附近的 iOS/Android 设备

### 连接建立

```bash
# BLE/前端应用打开 Unix domain socket，默认路径为：
# /var/run/lucy/pairing.sock
# 或环境变量 LUCY_PAIRING_SOCKET 覆盖

socket_path=$(printenv LUCY_PAIRING_SOCKET || echo "/var/run/lucy/pairing.sock")
nc -U "$socket_path"
```

### 消息格式与流程

所有消息采用 **NDJSON**（Newline Delimited JSON）格式，每条消息以 `\n` 结尾，单条消息大小不超过 4KB（`PAIRING_IPC_MAX_FRAME_BYTES = 4096`）。

#### 1. BLE 发起绑定请求

```json
{
  "type": "bind.request",
  "request_id": "req_001",
  "requested_at_ms": 1639900000000
}
```

Lucy 接收后，向 `lucy-server` 请求 OTP。

#### 2. Lucy 发送 OTP

```json
{
  "type": "otp.issued",
  "request_id": "req_001",
  "otp": "123456",
  "expires_at_ms": 1639900060000
}
```

OTP 有效期通常为 60 秒。BLE 应将此 OTP 展示给用户或通过 GATT 暴露。

#### 3. OTP 申请失败（可选）

```json
{
  "type": "otp.error",
  "request_id": "req_001",
  "error": "lucy-server 连接失败或超时"
}
```

#### 4. 绑定完成

用户在 app 侧完成绑定后，`user-center` 返回成功，Lucy 向 socket 推送：

```json
{
  "type": "bind.completed",
  "cuk": "channel_user_key_xyz",
  "user_id": "user_12345"
}
```

#### 5. 绑定状态清除（reset 时）

```json
{
  "type": "bind.cleared"
}
```

#### 6. 心跳检测

BLE 可定期发送 ping 保活连接：

```json
{
  "type": "ping"
}
```

Lucy 回复：

```json
{
  "type": "pong"
}
```

### IPC 客户端 API

`pairing-ipc-client.ts`（811 行）提供了 TypeScript/Node.js 侧的完整客户端实现。BLE/前端应用如果用 Node.js，可以导入使用；否则应按上述协议自行实现 socket 客户端。

**主要导出类与方法：**

| 类/函数 | 签名 | 说明 |
|--------|------|------|
| `PairingIpcClient` | `new PairingIpcClient(socketPath: string)` | 初始化 IPC 客户端，连接到指定 socket |
| `connect()` | `Promise<void>` | 建立 socket 连接 |
| `requestBind()` | `Promise<{ requestId: string }>` | 发起绑定请求，返回 request_id |
| `listenBindingState()` | `AsyncIterable<PairingIpcMessage>` | 监听绑定状态变化（OTP 发行、完成、错误） |
| `close()` | `Promise<void>` | 关闭连接 |

**使用示例（伪代码）：**

```typescript
import { PairingIpcClient } from "./pairing-ipc-client.ts";

const client = new PairingIpcClient("/var/run/lucy/pairing.sock");
await client.connect();

// 发起绑定
const { requestId } = await client.requestBind();
console.log(`请求 ID: ${requestId}`);

// 监听事件
for await (const msg of client.listenBindingState()) {
  if (msg.type === "otp.issued") {
    console.log(`OTP: ${msg.otp}，有效期至 ${msg.expires_at_ms}`);
  } else if (msg.type === "bind.completed") {
    console.log(`绑定成功，user_id: ${msg.user_id}`);
    break;
  } else if (msg.type === "otp.error") {
    console.error(`OTP 申请失败: ${msg.error}`);
    break;
  }
}

await client.close();
```

### 错误处理

IPC 协议定义了以下错误代码（`PairingIpcFrameErrorCode`）：

| 错误码 | 含义 | 建议处理 |
|--------|------|---------|
| `frame_too_large` | 消息超过 4KB | 检查 payload 大小，重新组织数据 |
| `invalid_json` | JSON 解析失败 | 检查编码或格式 |
| `invalid_schema` | 消息不符合 zod schema | 检查消息 `type` 和字段 |

## BLE 侧的集成（blue-wifi 参考）

`outside/blue-wifi`（配置链接：`outside/blue-wifi/internal/bluewifi/lucy.go`）是 BLE provisioning 的标准实现。它：

1. **定期轮询或监听** `pairing-info.json` 文件（默认位置由 Lucy 插件决定）
2. **通过 GATT 特性暴露：**
   - Service UUID: `7f0c0000-4f31-4a32-a917-9a4ec0b20001`
   - Characteristic `lucy_pairing_info`（可读）：返回 `pairing-info.json` 的完整内容
   - Characteristic `lucy_device_state`（可读）：返回当前设备状态摘要
3. **支持 IPC 连接**（可选）：当启用 pairing IPC 时，blue-wifi 可连接到 socket，获取实时 OTP 和绑定事件
4. **权限控制**：BLE 特性通常只对蓝牙范围内的设备可见

**iOS/Android App 读取步骤：**

1. 扫描 Service UUID `7f0c0000-4f31-4a32-a917-9a4ec0b20001`
2. 读取 Characteristic `lucy_pairing_info`，获得 JSON blob
3. 解析 JSON，提取 `cdi` 和 `auth_qr_uri`
4. 显示 QR 码给用户扫描，或直接使用 `cdi` 发起绑定流程

## 配置与路径

Lucy 的 pairing IPC 配置由以下配置键控制（`src/types.ts` `LucyConfigSchema`）：

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `channels.lucy.pairingSocket` | string | — | blue-wifi IPC Unix domain socket 绝对路径（未设置则不启用 IPC） |

```yaml
channels:
  lucy:
    pairingSocket: "/var/run/lucy/pairing.sock"
```

## 故障排查

| 现象 | 原因 | 排查步骤 |
|------|------|---------|
| `pairing-info.json` 不存在 | Lucy 未进入 PendingBind 状态 | 检查 `openclaw channels status --probe`，确保 Lucy 已启动 |
| BLE 读取失败 | 文件权限不足或路径错误 | 检查 `~/.lucy/` 目录权限，确认路径配置 |
| IPC socket 连接超时 | Lucy 未启用 IPC 或 socket 路径错误 | 确认 `channels.lucy.pairingSocket` 已设置且路径存在 |
| OTP 申请返回错误 | lucy-server 不可达或网络问题 | 检查 Lucy gateway 日志，确认 `lucy-server` 连接状态 |

## 相关文档

- [设备绑定流程](../02-auth-binding/integrated-flow.md)
- [App 接入指南](./app-integration.md)
- [user-center 集成](../02-auth-binding/user-center-integration.md)
