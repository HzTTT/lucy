# Lucy BLE 前端集成指南

本文为移动端 / 前端开发者提供 Lucy 设备的 BLE 配对、用户绑定和 WiFi 配置实现指南。所有示例基于实际测试运行捕获的真实数据交互。

当本文与其他文档或测试记录冲突时，以本文和当前代码为准。

## 概述

Lucy 系统允许移动应用通过 BLE（蓝牙低功耗）完成以下操作：

1. **设备发现与连接** — 扫描 Lucy 设备（BLE Service UUID）并建立连接
2. **读取设备信息** — 获取设备名称、网络状态、IP 地址等元数据
3. **OTP 绑定流程** — 请求 OTP、验证并完成用户设备绑定
4. **WiFi 配置** — 扫描可用网络、配置 SSID 和密码

BLE 服务由运行在 Lucy 设备上的 `blue-wifi-agent` 提供。

## 前置条件

### 设备要求

- Lucy 设备已启动并运行 `blue-wifi-agent`
- 设备开启 BLE 广播
- 设备与移动设备在蓝牙覆盖范围内

### 用户要求

- 用户已在 Lucy App 中注册账号（拥有 phone + password）
- 用户具有访问 user-center 的网络连接

### 开发环境

- iOS: Xcode 15+ 与 CoreBluetooth 框架
- Android: Android 8.0+ 与蓝牙权限（`BLUETOOTH`, `BLUETOOTH_ADMIN`, `ACCESS_FINE_LOCATION` 或 `NEARBY_WIFI_DEVICES`）

## BLE 服务说明

### 服务信息

| 项目 | 值 |
|------|-----|
| **Service UUID** | `7f0c0000-4f31-4a32-a917-9a4ec0b20001` |
| **广播名称** | `Lucy-Setup` 或自定义设备名称 |
| **广播服务UUID** | `7f0c0000-4f31-4a32-a917-9a4ec0b20001` |

### GATT 特性表

| 特性名 | UUID | 操作 | 用途 | 数据格式 |
|------|------|------|------|---------|
| **device_info** | `7f0c0001-4f31-4a32-a917-9a4ec0b20001` | Read | 设备元数据（主机名、网络接口、IP） | JSON |
| **network_status** | `7f0c0002-4f31-4a32-a917-9a4ec0b20001` | Read / Notify | WiFi 连接状态和 IP 信息 | JSON |
| **wifi_config** | `7f0c0003-4f31-4a32-a917-9a4ec0b20001` | Write | 配置 WiFi SSID 和密码 | JSON |
| **wifi_scan** | `7f0c0004-4f31-4a32-a917-9a4ec0b20001` | Read / Write | 扫描可用网络 | JSON |
| **lucy_pairing_info** | `7f0c0005-4f31-4a32-a917-9a4ec0b20001` | Read | 设备配对信息和 OTP | JSON |
| **lucy_pairing_request** | `7f0c0006-4f31-4a32-a917-9a4ec0b20001` | Write | 请求 OTP | JSON |

## 完整流程时序图

```
Frontend           Lucy Device        lucy-server      user-center
   |                  |                   |               |
   |-- BLE Scan ----->|                   |               |
   |<-- Found Device -|                   |               |
   |                  |                   |               |
   |-- Connect BLE -->|                   |               |
   |                  |                   |               |
   |-- Read device_info                  |               |
   |<-- device info --|                   |               |
   |                  |                   |               |
   |-- Read network_status                              |
   |<-- network status                    |               |
   |                  |                   |               |
   |-- Read lucy_pairing_info             |               |
   |<-- cdi + binding_status              |               |
   |                  |                   |               |
   |-- Write lucy_pairing_request         |               |
   |<-- OTP returned in pairing_info      |               |
   |                  |                   |               |
   |-- POST /v1/login -------- (user creds) ----------->|
   |<-- access token -------- (from user-center) ------|
   |                  |                   |               |
   |-- PUT /v1/channels/lucy/devices/device-bindings -->|
   |    (OTP + Bearer token)             |               |
   |<-- bind result ---------- (from lucy-server) ------|
   |                  |                   |               |
   |-- Read lucy_pairing_info (verify bound)            |
   |<-- binding_status = "bound"          |               |
   |                  |                   |               |
   |-- WiFi Scan ----->|                   |               |
   |<-- Available Networks               |               |
   |                  |                   |               |
   |-- Write WiFi Config -->|             |               |
   |<-- Connected ---|                   |               |
   |                  |                   |               |
```

## 详细步骤

### 步骤 1: BLE 扫描和连接

#### 扫描条件

应用启动 BLE 扫描，查找 Service UUID 为 `7f0c0000-4f31-4a32-a917-9a4ec0b20001` 的设备。

```javascript
// 伪代码示例
const TARGET_SERVICE_UUID = "7f0c0000-4f31-4a32-a917-9a4ec0b20001";

startBLEScan((device) => {
  if (device.advertisedServices?.includes(TARGET_SERVICE_UUID)) {
    console.log(`Found device: ${device.name} (${device.address})`);
    connect(device);
  }
});
```

#### 实际扫描结果（2026-04-13 测试数据）

```json
{
  "name": "cephalon",
  "address": "519AF758-99B8-D118-6F8A-89F8B2E1F87D",
  "rssi": -45,
  "txPower": -6,
  "advertisedServices": ["7f0c0000-4f31-4a32-a917-9a4ec0b20001"]
}
```

#### 连接

调用 BLE 连接 API，传入设备地址。连接通常在 1-3 秒内完成。

### 步骤 2: 读取 device_info 特性

读取特性 UUID `7f0c0001-4f31-4a32-a917-9a4ec0b20001`。

#### 请求

```javascript
const DEVICE_INFO_UUID = "7f0c0001-4f31-4a32-a917-9a4ec0b20001";
const data = await readCharacteristic(DEVICE_INFO_UUID);
```

#### 响应数据（实际测试）

```json
{
  "hostname": "cephalon",
  "model": "",
  "serial": "",
  "interface": "wlx6c1ff7dd744a",
  "ip": "192.168.0.9",
  "ssid": "",
  "state": "connected",
  "error": ""
}
```

#### 字段说明

| 字段 | 类型 | 描述 |
|------|------|------|
| `hostname` | string | 设备主机名 |
| `model` | string | 设备型号（可能为空） |
| `serial` | string | 序列号（可能为空） |
| `interface` | string | 网络接口名称（如 `wlan0`） |
| `ip` | string | 当前 IP 地址 |
| `ssid` | string | 已连接的 WiFi SSID（若无网络则为空） |
| `state` | string | 网络状态：`connected` 或 `disconnected` |
| `error` | string | 错误信息（若有） |

### 步骤 3: 读取 network_status 特性

读取特性 UUID `7f0c0002-4f31-4a32-a917-9a4ec0b20001`，获取实时网络状态。

#### 请求

```javascript
const NETWORK_STATUS_UUID = "7f0c0002-4f31-4a32-a917-9a4ec0b20001";
const data = await readCharacteristic(NETWORK_STATUS_UUID);
```

#### 响应数据（实际测试）

```json
{
  "state": "connected",
  "ssid": "",
  "ip": "192.168.0.9",
  "error": "",
  "updatedAt": "2026-04-13T11:57:08.26998792Z"
}
```

#### 字段说明

| 字段 | 类型 | 描述 |
|------|------|------|
| `state` | string | `connected` / `disconnected` / `connecting` / `failed` |
| `ssid` | string | 已连接网络的 SSID（若无则为空） |
| `ip` | string | 当前 IP 地址 |
| `error` | string | 错误信息（若有） |
| `updatedAt` | string | RFC3339 格式的更新时间戳 |

#### 通知订阅

建议订阅此特性的 Notify 特性，以便在网络状态变化时实时收到通知。

```javascript
await subscribeToNotifications(NETWORK_STATUS_UUID, (data) => {
  console.log("Network status updated:", data);
});
```

### 步骤 4: 读取 lucy_pairing_info 特性

读取特性 UUID `7f0c0005-4f31-4a32-a917-9a4ec0b20001`，获取设备配对信息和绑定状态。

#### 请求

```javascript
const PAIRING_INFO_UUID = "7f0c0005-4f31-4a32-a917-9a4ec0b20001";
const data = await readCharacteristic(PAIRING_INFO_UUID);
```

#### 初始响应（未请求 OTP）

```json
{
  "version": 1,
  "channel": "lucy",
  "state": "ready",
  "channel_device_id": "2043659680854093824",
  "binding_status": "pending",
  "created_at_ms": 1776081412014
}
```

#### 字段说明

| 字段 | 类型 | 描述 |
|------|------|------|
| `version` | number | 协议版本（当前为 1） |
| `channel` | string | 频道名称（固定为 `lucy`） |
| `state` | string | 设备状态：`ready` / `unavailable` |
| `channel_device_id` | string | **设备唯一标识 (CDI)** — 绑定和后续通信中需要使用 |
| `binding_status` | string | 绑定状态：`pending` / `bound` |
| `created_at_ms` | number | 创建时间戳（毫秒） |
| `otp`（可选） | string | 一次性密码（仅在请求后出现） |
| `otp_expires_at_ms`（可选） | number | OTP 过期时间（毫秒时间戳） |

### 步骤 5: 请求 OTP（一次性密码）

向特性 UUID `7f0c0006-4f31-4a32-a917-9a4ec0b20001` 写入 OTP 请求。

#### 请求

```javascript
const PAIRING_REQUEST_UUID = "7f0c0006-4f31-4a32-a917-9a4ec0b20001";
const requestPayload = {
  "request_id": "1776081428529"  // 可以是任意唯一 ID（通常为时间戳）
};
await writeCharacteristic(PAIRING_REQUEST_UUID, JSON.stringify(requestPayload));
```

#### 等待 OTP

写入后，等待 2-3 秒，然后重新读取 `lucy_pairing_info` 特性（UUID `7f0c0005`）。

#### 读取响应（包含 OTP）

```json
{
  "version": 1,
  "channel": "lucy",
  "state": "ready",
  "channel_device_id": "2043659680854093824",
  "binding_status": "pending",
  "created_at_ms": 1776081412014,
  "otp": "323584",
  "otp_expires_at_ms": 1776081728856
}
```

#### OTP 有效性检查

```javascript
const now = Date.now();
const expiresAt = responseData.otp_expires_at_ms;
const isExpired = now > expiresAt;
const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));

if (isExpired) {
  console.log("OTP has expired, request a new one");
} else {
  console.log(`OTP valid for ${remainingSeconds} seconds`);
  console.log(`Use OTP: ${responseData.otp}`);
}
```

### 步骤 6: 用户登录和设备绑定

#### 6a: 登录 user-center

发送 POST 请求到 user-center 登录接口。

```javascript
const userCenterDomain = "https://user-center.example.com";
const loginURL = `${userCenterDomain}/v1/login`;

const loginResponse = await fetch(loginURL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    "phone": "18888888888",
    "pwd": "***",
    "way": "phone_pwd"
  })
});

const loginData = await loginResponse.json();
// loginData.data.token 是访问令牌
const accessToken = loginData.data.token;
```

#### 登录响应示例（200 OK）

```json
{
  "code": 20000,
  "msg": "操作成功",
  "data": {
    "id": "1862247176453038080",
    "phone": "18888888888",
    "nick_name": "dadas",
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "create_time": "2026-01-15T10:30:00Z",
    "update_time": "2026-04-13T11:57:00Z"
  }
}
```

#### 6b: 提交 OTP 绑定

向 lucy-server 的绑定接口提交 OTP 以完成设备绑定。

```javascript
const lucyServerDomain = "https://lucy-server.example.com";
const bindURL = `${lucyServerDomain}/v1/channels/lucy/devices/device-bindings`;

const bindResponse = await fetch(bindURL, {
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${accessToken}`
  },
  body: JSON.stringify({
    "otp": "323584"  // 从 BLE 读取的 OTP
  })
});

const bindResult = await bindResponse.json();
// bindResult.status 应为 "bound"
// bindResult.cdi 是设备 ID
```

#### 绑定成功响应（200 OK）

```json
{
  "cdi": "2043659680854093824",
  "status": "bound"
}
```

#### 错误处理

| HTTP 状态 | 错误原因 | 处理建议 |
|----------|--------|--------|
| 400 | OTP 无效或已过期 | 重新请求 OTP（回到步骤 5） |
| 401 | 访问令牌无效或过期 | 重新登录（回到步骤 6a） |
| 409 | 设备已绑定到其他用户 | 告知用户需重置设备状态 |
| 500 | 服务器错误 | 重试或稍后再试 |

### 步骤 7: 验证绑定状态

重新读取 `lucy_pairing_info` 特性，确认设备已成功绑定。

#### 请求

```javascript
const PAIRING_INFO_UUID = "7f0c0005-4f31-4a32-a917-9a4ec0b20001";
const verifyData = await readCharacteristic(PAIRING_INFO_UUID);
```

#### 成功响应

```json
{
  "version": 1,
  "channel": "lucy",
  "state": "ready",
  "channel_device_id": "2043659680854093824",
  "binding_status": "bound",
  "created_at_ms": 1776081434247
}
```

#### 验证逻辑

```javascript
if (verifyData.binding_status === "bound") {
  console.log("Device successfully bound!");
  return true;
} else if (verifyData.binding_status === "pending") {
  console.log("Device still pending binding");
  return false;
}
```

## WiFi 配置流程

### 步骤 8: WiFi 扫描

向特性 UUID `7f0c0004-4f31-4a32-a917-9a4ec0b20001` 写入扫描请求。

#### 扫描请求

```javascript
const WIFI_SCAN_UUID = "7f0c0004-4f31-4a32-a917-9a4ec0b20001";
const scanRequest = { "action": "scan" };
await writeCharacteristic(WIFI_SCAN_UUID, JSON.stringify(scanRequest));
```

#### 等待结果

扫描通常耗时 3-5 秒。等待后读取同一特性获取扫描结果。

```javascript
// 等待 5 秒
await sleep(5000);

// 读取扫描结果
const scanResult = await readCharacteristic(WIFI_SCAN_UUID);
```

#### 扫描结果（实际测试 2026-04-14）

```json
{
  "state": "ready",
  "networks": [
    {
      "ssid": "Cephalon",
      "signal": 100,
      "security": "WPA1 WPA2",
      "active": false
    },
    {
      "ssid": "Cephalon-Bak",
      "signal": 100,
      "security": "WPA1 WPA2",
      "active": false
    },
    {
      "ssid": "ChinaNet-5beu",
      "signal": 100,
      "security": "WPA1 WPA2",
      "active": false
    },
    {
      "ssid": "ChinaNet-5beu-5G",
      "signal": 95,
      "security": "WPA1 WPA2",
      "active": false
    },
    {
      "ssid": "YSZX-wifi",
      "signal": 89,
      "security": "",
      "active": false
    }
  ],
  "error": "",
  "updatedAt": "2026-04-14T02:58:01.746563554Z"
}
```

#### 字段说明

| 字段 | 类型 | 描述 |
|------|------|------|
| `state` | string | `ready` / `scanning` / `failed` |
| `networks` | array | 发现的网络列表 |
| `networks[].ssid` | string | 网络 SSID |
| `networks[].signal` | number | 信号强度（0-100） |
| `networks[].security` | string | 安全类型：`Open` / `WEP` / `WPA` / `WPA2` / `WPA3` |
| `networks[].active` | boolean | 是否为当前已连接网络 |
| `error` | string | 错误信息（如无 WiFi 适配器） |
| `updatedAt` | string | RFC3339 格式的更新时间戳 |

#### 错误处理

```javascript
if (scanResult.state === "failed") {
  console.error("WiFi scan failed:", scanResult.error);
  // 处理：设备可能没有 WiFi 适配器
  return;
}

if (!scanResult.networks || scanResult.networks.length === 0) {
  console.log("No networks found in scan range");
  return;
}
```

### 步骤 9: WiFi 配置

向特性 UUID `7f0c0003-4f31-4a32-a917-9a4ec0b20001` 写入 WiFi 凭证。

#### 配置请求

```javascript
const WIFI_CONFIG_UUID = "7f0c0003-4f31-4a32-a917-9a4ec0b20001";
const wifiConfig = {
  "ssid": "cephalon-bak",
  "password": "duannao2023",
  "hidden": false  // 是否为隐藏网络
};
await writeCharacteristic(WIFI_CONFIG_UUID, JSON.stringify(wifiConfig));
```

#### 等待连接

写入配置后，等待 5-10 秒，然后读取 `network_status` 特性验证连接状态。

#### 验证响应

```javascript
// 等待 5 秒
await sleep(5000);

const NETWORK_STATUS_UUID = "7f0c0002-4f31-4a32-a917-9a4ec0b20001";
const statusData = await readCharacteristic(NETWORK_STATUS_UUID);
```

#### 成功连接响应（实际测试 2026-04-14）

```json
{
  "state": "connected",
  "ssid": "cephalon-bak",
  "ip": "192.168.0.9",
  "error": "",
  "updatedAt": "2026-04-14T02:58:23.329879893Z"
}
```

#### 验证逻辑

```javascript
if (statusData.state === "connected" && statusData.ssid === "cephalon-bak") {
  console.log("WiFi configured successfully!");
  console.log(`Device IP: ${statusData.ip}`);
  return true;
} else if (statusData.state === "connecting") {
  console.log("WiFi connection in progress...");
  return null;  // 重试
} else if (statusData.state === "failed" || statusData.error) {
  console.error("WiFi connection failed:", statusData.error);
  return false;
}
```

#### 错误处理

| 错误信息 | 原因 | 处理建议 |
|---------|------|--------|
| `Invalid password` | WiFi 密码错误 | 检查密码并重试 |
| `Network not found` | 输入的 SSID 不存在 | 重新扫描并选择正确的 SSID |
| `Connection timeout` | 连接超时 | 检查设备与 WiFi 路由器的距离 |
| `Device busy` | 设备忙或尚未初始化 | 等待片刻后重试 |

## 错误处理指南

### 通用错误处理策略

#### BLE 连接错误

```javascript
try {
  await connectToDevice(deviceAddress);
} catch (error) {
  if (error.code === "BLUETOOTH_OFF") {
    // 蓝牙已关闭
    console.log("Please enable Bluetooth");
  } else if (error.code === "PERMISSION_DENIED") {
    // 权限不足
    console.log("Bluetooth permission required");
  } else if (error.code === "TIMEOUT") {
    // 连接超时
    console.log("Connection timeout, try again");
  }
}
```

#### 特性读写错误

```javascript
try {
  const data = await readCharacteristic(uuid);
} catch (error) {
  if (error.code === "CHARACTERISTIC_NOT_FOUND") {
    // 特性不存在
    console.log("Device does not support this characteristic");
  } else if (error.code === "READ_NOT_PERMITTED") {
    // 读取权限不足
    console.log("Read permission denied");
  } else if (error.code === "DISCONNECTED") {
    // 设备已断开连接
    console.log("Device disconnected, reconnecting...");
    await reconnect();
  }
}
```

### 重试策略

对于网络操作（HTTP 请求到 user-center 和 lucy-server），建议使用指数退避重试：

```javascript
async function retryWithBackoff(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const delayMs = Math.pow(2, attempt - 1) * 1000;
      console.log(`Attempt ${attempt} failed, retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
}

// 使用示例
const bindResult = await retryWithBackoff(() => 
  submitOTPBinding(otp, accessToken)
);
```

## 重要注意事项

### OTP 有效期

- **有效期**: 约 5 分钟（从请求时起）
- **过期后**: 需重新请求 OTP（返回步骤 5）
- **检查方式**: 比较当前时间与 `otp_expires_at_ms` 字段

```javascript
const isExpired = Date.now() > pairing_info.otp_expires_at_ms;
if (isExpired) {
  console.log("OTP expired, requesting a new one");
  await requestNewOTP();
}
```

### 幂等性

**OTP 提交操作不是幂等的**。重复提交相同的 OTP 或以不同用户身份提交 OTP 可能导致：

- 绑定失败
- HTTP 409 冲突（设备已绑定到其他用户）

**建议**: 每次提交 OTP 前，先检查设备的当前绑定状态。

```javascript
// 提交前检查
const pairingInfo = await readCharacteristic(PAIRING_INFO_UUID);
if (pairingInfo.binding_status === "bound") {
  console.log("Device already bound, skipping OTP submission");
  return;
}
```

### 超时设置

| 操作 | 推荐超时 | 备注 |
|------|---------|------|
| BLE 连接 | 10 秒 | 可能受信号干扰影响 |
| 特性读写 | 5 秒 | 若超时，断开重连 |
| OTP 请求 | 3 秒写入 + 5 秒等待 | 总计约 8 秒 |
| WiFi 扫描 | 10 秒 | 取决于环境中的网络数量 |
| WiFi 连接 | 30 秒 | 包括多次重试 |
| HTTP 请求（登录/绑定） | 15 秒 | 考虑网络延迟 |

### 设备重置

如果设备需要重置绑定状态（例如切换用户），需在 OpenClaw 设备侧执行：

```bash
openclaw lucy reset-state
```

重置后：

- Ed25519 密钥对被清除
- `channel_device_id` (CDI) 重新生成
- `binding_status` 返回 `pending`
- 前端需重新完整执行绑定流程

### WiFi+BLE 共用射频注意事项（Combo Dongle）

部分 Lucy 设备使用 WiFi+BT combo USB 适配器（如 Realtek `0bda:b851`），WiFi 和 BLE 共享同一射频模块。这会导致以下行为：

**WiFi 操作期间 BLE 可能断连**

WiFi 扫描、连接、断开等操作会短暂干扰 BLE 连接。尤其是写入 `wifi_config` 触发 WiFi 连接后，BLE 连接很可能中断。

**前端处理策略：**

1. **写入 `wifi_config` 后预期断连** — 不要将断连视为错误，这是正常行为
2. **等待 10-15 秒后重新扫描连接** — WiFi 连接完成后 BLE 会恢复
3. **重连后读取 `network_status`** — 验证 WiFi 是否配置成功

```javascript
// WiFi 配置的推荐流程
async function configureWiFi(ssid, password) {
  // 1. 写入配置（使用 write-without-response 模式）
  await writeCharacteristicWithoutResponse(WIFI_CONFIG_UUID, JSON.stringify({
    ssid, password, hidden: false
  }));

  // 2. 预期 BLE 断连，等待 WiFi 连接完成
  await sleep(15000);

  // 3. 重新扫描并连接设备
  const device = await scanAndConnect();

  // 4. 验证 WiFi 连接状态
  const status = await readCharacteristic(NETWORK_STATUS_UUID);
  return status.state === "connected" && status.ssid === ssid;
}
```

**WiFi 扫描可能返回空结果**

首次扫描时 NetworkManager 缓存可能为空。服务端已加自动重试（3 秒后重读），但前端建议也做兜底：如果返回空 `networks`，等待 5 秒后重试一次。

### 写入模式选择

所有写入特征（`wifi_config`、`wifi_scan`、`lucy_pairing_request`）同时支持两种 BLE 写入模式：

| 模式 | iOS API | Android API | 适用场景 |
|------|---------|-------------|---------|
| Write With Response | `.withResponse` | `WRITE_TYPE_DEFAULT` | 需要确认写入成功 |
| Write Without Response | `.withoutResponse` | `WRITE_TYPE_NO_RESPONSE` | **推荐** — 更快，射频争用时更可靠 |

**推荐优先使用 Write Without Response**，尤其是 `wifi_config` 写入，因为 combo dongle 环境下 Write With Response 需要额外的 ACK 往返，更容易因射频争用而超时。

```swift
// iOS 示例：使用 writeWithoutResponse
peripheral.writeValue(data, for: characteristic, type: .withoutResponse)
```

```kotlin
// Android 示例：使用 WRITE_TYPE_NO_RESPONSE
characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
gatt.writeCharacteristic(characteristic)
```

### JSON 数据格式

所有 BLE 特性的数据均为 **UTF-8 编码的 JSON**。读写时需正确编码 / 解码：

```javascript
// 读取（字节 -> JSON）
const rawBytes = await readCharacteristic(uuid);
const jsonString = new TextDecoder().decode(rawBytes);
const data = JSON.parse(jsonString);

// 写入（JSON -> 字节）
const data = { "ssid": "MyNetwork", "password": "pass123" };
const jsonString = JSON.stringify(data);
const bytes = new TextEncoder().encode(jsonString);
await writeCharacteristic(uuid, bytes);
```

### 网络环境

- **user-center 和 lucy-server 的域名** 应通过应用配置或环境变量传入，**不应硬编码**
- **HTTPS**: 所有 HTTP 请求必须使用 HTTPS（除非在本地开发环境中明确配置）
- **DNS 解析**: 考虑添加 DNS 缓存或故障转移机制

## 完整集成示例（伪代码）

```javascript
async function lucyBLEBinding(userPhone, userPassword) {
  try {
    // Step 1-2: 扫描并连接
    const device = await scanAndConnect();
    
    // Step 3-4: 获取设备信息和配对信息
    const deviceInfo = await readCharacteristic(DEVICE_INFO_UUID);
    const pairingInfo = await readCharacteristic(PAIRING_INFO_UUID);
    
    const cdi = pairingInfo.channel_device_id;
    console.log(`Connected to device: ${deviceInfo.hostname} (CDI: ${cdi})`);
    
    // Step 5: 请求 OTP
    console.log("Requesting OTP...");
    await writeCharacteristic(PAIRING_REQUEST_UUID, JSON.stringify({
      request_id: Date.now().toString()
    }));
    
    await sleep(3000);
    const pairingInfoWithOTP = await readCharacteristic(PAIRING_INFO_UUID);
    const otp = pairingInfoWithOTP.otp;
    console.log(`OTP received: ${otp}`);
    
    // Step 6a: 用户登录
    console.log("Logging in user...");
    const accessToken = await loginUser(userPhone, userPassword);
    
    // Step 6b: 提交 OTP 绑定
    console.log("Binding device...");
    const bindResult = await submitOTPBinding(otp, accessToken);
    console.log(`Bind result: ${bindResult.status}`);
    
    // Step 7: 验证绑定
    await sleep(2000);
    const verifyInfo = await readCharacteristic(PAIRING_INFO_UUID);
    if (verifyInfo.binding_status === "bound") {
      console.log("Device binding successful!");
    }
    
    // Step 8-9: WiFi 配置（可选）
    await configureWiFi("MyNetwork", "password123");
    
    return { success: true, cdi };
  } catch (error) {
    console.error("Binding failed:", error);
    return { success: false, error: error.message };
  }
}
```

## 协议变更日志

| 日期 | 版本 | 变更 | 备注 |
|------|------|------|------|
| 2026-04-13 | 1.0 | 初版发布 | 基于蓝牙 LE GATT 标准，所有特性使用 JSON 格式 |

## 相关文档

- `extensions/lucy/README.md` — Lucy 插件概述和部署指南
- `extensions/lucy/doc/app-nats-integration.md` — App / NATS 侧接入指南
- `extensions/lucy/doc/app-integration-guide.md` — App 综合集成指南
- `extensions/lucy/outside/user-center/docs/lucy-model-config.md` — user-center 模型配置接口文档
- `extensions/lucy/doc/debugging.md` — 调试脚本和故障排除指南

## 联系方式

如有问题或需要技术支持，请：

1. 检查本文档的 [错误处理指南](#错误处理指南) 章节
2. 查阅 `extensions/lucy/doc/debugging.md` 的调试决策树
3. 检查设备日志（如可访问）
4. 提交 issue 或联系开发团队
