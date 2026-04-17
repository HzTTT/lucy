<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# user-center 集成详解

user-center 是 Lucy 系统的身份源。本章列出 Lucy 插件与 user-center 交互的所有 HTTP API、请求/响应格式、错误处理和 Ed25519 签名方案。

## API 概览

Lucy 插件通过 `lucy-im-sdk-nodejs` 调用 user-center 的四个主要端点：

| 端点 | 方法 | 用途 | 认证 |
|------|------|------|------|
| `/v1/devices/new` | POST | 设备注册 | 无（首次） |
| `/v1/channels/lucy/devices/device-bindings` | GET | 绑定状态查询 | Ed25519 签名 |
| `/v1/channels/lucy/current-user/model-config` | GET | 模型配置 | Ed25519 签名 |
| `/v1/channels/lucy/pairing-config` | GET | 配对配置（可选） | Ed25519 签名 |

---

## 1. 设备注册 API

### 请求

```http
POST /v1/devices/new
Content-Type: application/json

{
  "device_type": "npc",
  "public_key": "<base64 encoded Ed25519 public key>",
  "locale": "zh_CN"
}
```

**参数说明**：
- `device_type`：固定为 `"npc"` （与 lucy-server 的命名约定）
- `public_key`：设备的 Ed25519 公钥，Base64 编码（44 字符）
- `locale`：可选，设备的地区设置（影响 OTP 语言、错误提示等）

### 响应 200 OK

```json
{
  "cdi": "device-20240416-001234567890ab",
  "expires_at": 1713307200000,
  "status": "unregistered"
}
```

**字段说明**：
- `cdi`（channel device ID）：全局唯一的设备标识，由 user-center 分配
- `expires_at`：cdi 的有效期（毫秒时间戳），通常为 90 天或更长
- `status`：设备状态，初始为 `"unregistered"`

### 响应 4xx / 5xx

| 错误码 | 原因 | 插件处理 |
|--------|------|---------|
| 400 | 公钥格式错误或 device_type 无效 | 抛异常，用户需检查 SDK 配置 |
| 409 | 公钥已存在（重复注册） | 返回现有 cdi，继续 Ready / PendingBind 检查 |
| 503 | user-center 服务不可用 | 重试 3 次，间隔 2 秒；失败则抛异常 |

### SDK 调用示例

```typescript
// 来自 lucy-im-sdk-nodejs/src/http.ts
export async function registerLucyDevice(params: {
  userCenterDomain: string;
  publicKey: Uint8Array;
  locale?: string;
}): Promise<{ cdi: string; expiresAtMs: number }> {
  const body = JSON.stringify({
    device_type: "npc",
    public_key: base64encode(params.publicKey),
    ...(params.locale && { locale: params.locale })
  });
  
  const res = await fetch(`${params.userCenterDomain}/v1/devices/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  
  if (!res.ok) throw new Error(`registration failed: ${res.status}`);
  
  const data = await res.json();
  return { cdi: data.cdi, expiresAtMs: data.expires_at };
}
```

---

## 2. 绑定状态查询 API

### 请求

```http
GET /v1/channels/lucy/devices/device-bindings?device_id=<cdi>
Authorization: Signature keyId="<cdi>", algorithm="ed25519-sha512", signature="<base64>"
Content-Type: application/json
```

**查询参数**：
- `device_id`：设备 ID（必需）

**认证头**：Ed25519 签名（见下方签名方案）

### 响应 200 OK（已绑定）

```json
{
  "user_id": "user-20240101-abcdef123456",
  "cuk": "key-20240416-xyz789uvwxyz",
  "expires_at": null,
  "status": "bound",
  "bind_time": 1713307200000
}
```

**字段说明**：
- `user_id`：绑定的用户 ID（由 user-center 分配）
- `cuk`（channel user key）：用户密钥，用于后续的 channel_user_key 校验
- `expires_at`：null（cuk 不过期，除非设备被解绑）
- `status`：`"bound"`
- `bind_time`：绑定时间戳

### 响应 202 Accepted（待绑定）

```json
{
  "status": "pending",
  "otp_required": true,
  "otp_method": "sms",
  "otp_expires_at": 1713307200000
}
```

**字段说明**：
- `status`：`"pending"` —— 等待用户完成绑定
- `otp_required`：是否需要 OTP 验证（可选）
- `otp_method`：OTP 方式（`"sms"` 或 `"email"` 或 `"push"`）
- `otp_expires_at`：OTP 有效期

### 响应 404 Not Found

```json
{
  "error": "device_not_found",
  "message": "Device with cdi=<cdi> not registered"
}
```

插件行为：重新调用注册 API。

### 响应 401 Unauthorized

```json
{
  "error": "invalid_signature",
  "message": "Ed25519 signature verification failed"
}
```

插件行为：检查本地 Ed25519 私钥是否完整，若有损坏则触发设备重置。

### SDK 调用示例

```typescript
// 来自 lucy-im-sdk-nodejs/src/http.ts
export async function fetchLucyDeviceBinding(params: {
  userCenterDomain: string;
  cdi: string;
  privateKey: Uint8Array;
}): Promise<{ userId: string; cuk: string } | { status: "pending" }> {
  const signature = signRequest({
    method: "GET",
    path: `/v1/channels/lucy/devices/device-bindings?device_id=${params.cdi}`,
    privateKey: params.privateKey
  });
  
  const res = await fetch(
    `${params.userCenterDomain}/v1/channels/lucy/devices/device-bindings?device_id=${params.cdi}`,
    {
      method: "GET",
      headers: { Authorization: signature }
    }
  );
  
  if (res.status === 202) return { status: "pending" };
  if (res.status === 200) return await res.json();
  throw new Error(`binding query failed: ${res.status}`);
}
```

---

## 3. 模型配置 API

### 请求

```http
GET /v1/channels/lucy/current-user/model-config
Authorization: Signature keyId="<cdi>", algorithm="ed25519-sha512", signature="<base64>"
Accept: application/json
```

**认证**：Ed25519 签名（需提供 cdi 作为 keyId）

### 响应 200 OK

```json
{
  "providerId": "cephalon",
  "modelId": "claude-opus-4.1",
  "apiKey": "sk-ant-...",
  "base_url": "https://api.anthropic.com/v1",
  "locale": "zh_CN",
  "feature_flags": {
    "allow_file_uploads": true,
    "allow_web_search": false
  },
  "expires_at": null
}
```

**字段说明**：
- `providerId`：模型供应商 ID（目前仅支持 `"cephalon"`）
- `modelId`：模型标识符（如 `"claude-opus-4"`、`"claude-sonnet-4"` 等）
- `apiKey`：Anthropic API key（由 user-center 为该用户生成并管理）
- `base_url`：API 端点（可由环境驱动，例如测试环境 vs 生产环境）
- `locale`：用户地区设置（影响模型回复语言）
- `feature_flags`：用户权限标记
- `expires_at`：API key 的过期时间（通常为 null）

**关键规则**：
- `base_url` 必须由 user-center 响应驱动，**不能在 Lucy 插件或客户端硬编码**
- 同一用户首次请求时，user-center 自动生成 API key；后续请求返回同一 key
- 若 API key 过期，user-center 自动生成新的

### 响应 401 Unauthorized

```json
{
  "error": "invalid_signature",
  "message": "Ed25519 signature verification failed"
}
```

### 响应 404 Not Found

设备未绑定或不存在。

### SDK 调用示例

```typescript
// 来自 lucy-im-sdk-nodejs/src/http.ts
export async function fetchLucyUserCenterConfig(params: {
  userCenterDomain: string;
  cdi: string;
  privateKey: Uint8Array;
}): Promise<{
  providerId: string;
  modelId: string;
  apiKey: string;
  base_url: string;
  locale: string;
}> {
  const signature = signRequest({
    method: "GET",
    path: "/v1/channels/lucy/current-user/model-config",
    privateKey: params.privateKey
  });
  
  const res = await fetch(
    `${params.userCenterDomain}/v1/channels/lucy/current-user/model-config`,
    {
      method: "GET",
      headers: { Authorization: signature }
    }
  );
  
  if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
  
  return await res.json();
}
```

---

## Ed25519 签名方案

lucy-im-sdk-nodejs 使用 RFC 8032 Ed25519 签名请求。签名格式遵循 HTTP Signature (RFC 9421) 的简化版本。

### 签名生成

```typescript
// Pseudocode（来自 lucy-im-sdk-nodejs）

function signRequest(params: {
  method: string;           // "GET", "POST" etc.
  path: string;              // "/v1/channels/lucy/devices/device-bindings?..."
  body?: string;             // JSON string (仅 POST/PUT 有)
  timestamp?: number;        // 毫秒时间戳 (可选，服务端校验防重放)
  privateKey: Uint8Array;   // 32 字节 Ed25519 私钥
}): string {
  // 1. 组建 signing string
  const signingString = [
    `(request-target): ${params.method.toLowerCase()} ${params.path}`,
    `host: ${extractHostFromUrl(...)}`,
    `content-type: application/json`,
    ...(params.timestamp ? [`timestamp: ${params.timestamp}`] : []),
    ...(params.body ? [`digest: SHA-256=${base64(sha256(params.body))}`] : [])
  ].join('\n');
  
  // 2. Ed25519 签名
  const signature = sign(signingString, params.privateKey);
  
  // 3. Authorization 头
  return `Signature keyId="${cdi}", algorithm="ed25519-sha512", ` +
         `signature="${base64encode(signature)}"`;
}
```

### 服务端校验

user-center auth-callout 会：
1. 从 Authorization 头提取 signature、keyId（cdi）
2. 从 cdi 查询该设备的公钥
3. 重建 signing string（方法同上）
4. 用公钥验证签名

若验证失败 → 401 Unauthorized。

---

## 环境与配置

### 配置字段

Lucy 插件通过 OpenClaw 配置文件指定 user-center 和 lucy-server 的地址：

```toml
[channels.lucy]
enabled = true
home_dir = "~/.lucy/identity"
user_center_domain = "https://user-center.example.com"
lucy_server_domain = "https://lucy-server.example.com"
local_notify_port = 6789
```

**关键规则**：
- `user_center_domain` 和 `lucy_server_domain` 不能写死为 prod/test
- 必须能通过配置或环境变量切换
- 所有 https:// 的 URL 必须有有效的 SSL 证书（或 localhost 可用 http://）

### 从 user-center 的 base_url 驱动配置

当 App 调用 `/v1/channels/lucy/current-user/model-config` 并收到 `base_url` 时，这个值即为该用户应使用的 API 端点。Lucy 插件在写入 `models.providers.cephalon.base_url` 时应直接使用服务端返回的值，而非猜测或硬编码。

```typescript
// 来自 provider-provisioning.ts
const userCenterConfig = await fetchLucyUserCenterConfig(...);

// 直接使用服务端的 base_url
applyLucyProvisioningConfig({
  providerId: userCenterConfig.providerId,
  modelId: userCenterConfig.modelId,
  apiKey: userCenterConfig.apiKey,
  base_url: userCenterConfig.base_url  // 不修改，直接传
});
```

---

## 常见场景

### 场景：首次绑定后模型配置为空

**症状**：设备绑定成功，但调用 `/v1/channels/lucy/current-user/model-config` 返回 404 或空。

**根因**：用户在 user-center 侧还未关联任何模型，或尚未登录。

**解决**：
- 确保用户已在 user-center 登录
- 确保用户已为自己分配了默认模型
- 设备会自动定期重新查询（每次 gateway 重启时）

### 场景：更换 API key

**症状**：需要为某个设备切换到不同的 API key（例如升级套餐）。

**处理**：
- 在 user-center 后台管理界面为该用户分配新的 API key
- 设备无需任何操作，下次调用 `/v1/channels/lucy/current-user/model-config` 时自动获得新 key
- 模型供应与重启流程会自动更新配置

---

## 故障排查

**问题**：设备注册失败，返回 409 Conflict

- 检查是否有多个设备使用同一公钥
- 清空本地 `~/.lucy/identity/`，重新注册

**问题**：绑定查询返回 401 Unauthorized

- 检查本地 Ed25519 密钥文件是否存在且完整
- 检查 user-center 日志中的签名校验失败记录
- 若密钥损坏，运行 `openclaw lucy reset-state`

**问题**：模型配置 API 返回 404，但设备已绑定

- 检查该用户在 user-center 是否已登录
- 检查该用户是否分配了默认模型
- 若未分配，联系管理员或通过 user-center UI 自行分配

详见[第 8 章 - 排障指南](../08-operations/debugging.md)。
