<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# 出站媒体来源与白名单

## 概述

Lucy 的出站媒体（Lucy → App）可能来自多个来源：OpenClaw runtime 生成的文件（file:// URL）、本地缓存目录、第三方工具的输出等。为了安全性，Lucy 对媒体来源施加白名单管理，防止任意文件被上传到 Object Store。

---

## 媒体来源类型

### 1. file:// URL

OpenClaw runtime（例如 agent、tool）可能生成包含 `file://` URL 的附件：

```
file:///tmp/output.jpg
file:///var/tmp/generated_image.png
```

这些 URL 引用本地文件系统中的真实文件。

### 2. 白名单目录

通过配置 `channels.lucy.mediaLocalRoots`，可以指定若干允许的目录。这些目录内的任何文件都可被加载为媒体。

**配置示例（YAML）：**

```yaml
channels:
  lucy:
    mediaLocalRoots:
      - "/tmp"
      - "/var/cache/ollama"
      - "/home/user/media"
```

**配置示例（JSON）：**

```json
{
  "channels": {
    "lucy": {
      "mediaLocalRoots": ["/tmp", "/var/cache"]
    }
  }
}
```

### 3. HTTPS URL（未来扩展）

当前不支持，保留用于未来实现。

---

## 媒体加载函数

### loadLucyOutboundMediaFromUrl()

位置：`src/outbound-media.ts:222`

**作用：** 从各种来源加载媒体文件，返回可上传的 Buffer。

**签名：**

```typescript
export async function loadLucyOutboundMediaFromUrl(params: {
  cfg: OpenClawConfig;
  url: string;                       // file:// URL 或路径
  maxSizeBytes?: number;             // 文件大小限制（可选）
}): Promise<{
  bytes: Buffer;
  mime: string;
  fileName?: string;
}>
```

**返回值：**

```typescript
{
  bytes: Buffer,                     // 文件字节
  mime: string,                      // 推断的 MIME 类型
  fileName?: string                  // 文件名（从路径提取）
}
```

### 内部流程

#### 步骤 1：解析 URL

```typescript
const url = new URL(params.url);
if (url.protocol !== "file:") {
  throw new Error(`unsupported protocol: ${url.protocol}`);
}
const filePath = url.pathname;  // 去掉 file:// 前缀
```

#### 步骤 2：白名单检查

```typescript
const mediaLocalRoots = params.cfg.channels?.lucy?.mediaLocalRoots ?? [];
const isWhitelisted = mediaLocalRoots.some(root =>
  path.resolve(filePath).startsWith(path.resolve(root))
);

if (!isWhitelisted) {
  throw new Error(
    `file path not in whitelist: ${filePath}. ` +
    `Allowed roots: ${mediaLocalRoots.join(", ")}`
  );
}
```

**验证逻辑：**

- 要求文件路径必须在配置的白名单目录内
- 使用 `path.resolve()` 防止 `../` 等相对路径逃逸
- 如果白名单为空（未配置），所有 file:// URL 被拒绝

#### 步骤 3：文件读取

```typescript
const bytes = await fs.readFile(filePath);
```

**错误处理：**

- 文件不存在 → 抛 ENOENT
- 无读权限 → 抛 EACCES
- 路径是目录 → 抛 EISDIR

#### 步骤 4：大小检查

```typescript
const configMaxMb = params.cfg.channels?.lucy?.mediaMaxMb ?? 20;
const maxBytes = configMaxMb * 1024 * 1024;

if (bytes.length > (params.maxSizeBytes ?? maxBytes)) {
  throw new Error(
    `file too large: ${bytes.length} bytes (limit: ${maxBytes} bytes)`
  );
}
```

#### 步骤 5：MIME 类型推断

```typescript
const mime = inferMimeFromExt(filePath) || "application/octet-stream";
```

使用文件扩展名推断 MIME 类型。常见映射：

| 扩展名 | MIME 类型 |
|--------|-----------|
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.png` | `image/png` |
| `.gif` | `image/gif` |
| `.mp3` | `audio/mpeg` |
| `.wav` | `audio/wav` |
| `.mp4` | `video/mp4` |
| `.pdf` | `application/pdf` |

#### 步骤 6：文件名提取

```typescript
const fileName = path.basename(filePath);
```

---

## 白名单配置

### 配置键

```
channels.lucy.mediaLocalRoots
```

### Schema

定义位置：`src/types.ts:64`

```typescript
mediaLocalRoots: z.array(z.string().min(1)).optional()
```

- 类型：字符串数组
- 默认值：`[]`（空数组，所有 file:// URL 被拒绝）
- 可选

### 配置示例

#### 开发环境

```yaml
channels:
  lucy:
    mediaLocalRoots:
      - "/tmp"
      - "/var/tmp"
```

#### 生产环境

```yaml
channels:
  lucy:
    mediaLocalRoots:
      - "/var/cache/ollama"      # Ollama 生成的图片
      - "/opt/app/output"        # App 输出目录
      - "/home/lucy/media"       # Lucy 工作目录
```

#### 不允许任何文件

```yaml
channels:
  lucy:
    mediaLocalRoots: []           # 空列表，禁用所有 file:// URL
```

---

## 在出站流程中的位置

当 OpenClaw runtime 生成包含媒体的回复时：

1. **Runtime 生成附件** —— 例如 tool 输出 `file:///tmp/chart.png`
2. **网关收集附件** —— `gateway.ts` 收集所有附件 URL
3. **逐个加载媒体** —— 对每个 URL 调用 `loadLucyOutboundMediaFromUrl()`
4. **上传到 Object Store** —— 使用 `uploadLucyMediaFromSource()` 上传每个加载的媒体
5. **构造 descriptor** —— 每个上传的媒体得到一个 descriptor
6. **发送给 App** —— 所有 descriptor 被嵌入到 `assistant.final` 事件

**代码位置：** `src/gateway.ts`（搜索 loadLucyOutboundMediaFromUrl）

---

## 安全考量

### 1. 路径遍历防护

使用 `path.resolve()` 规范化路径，防止 `../` 等相对路径逃逸：

```typescript
// 攻击尝试：file:///var/cache/ollama/../../etc/passwd
// path.resolve 后：/etc/passwd
// 检查：/etc/passwd 是否在 [/var/cache/ollama] 中？否 → 拒绝
```

### 2. 符号链接

当前实现不显式检查符号链接。建议在配置白名单时：

- 避免指向不受信任的目录的符号链接
- 在高安全环境下，使用 `realpath()` 验证

### 3. TOCTOU 问题

文件可能在 `loadLucyOutboundMediaFromUrl()` 读取期间被修改或删除。这是接受的：

- 文件删除 → 抛 ENOENT（upload 失败，机器事件返回错误）
- 文件修改 → 上传修改后的内容（无安全问题）

### 4. 权限检查

依赖操作系统的文件权限。确保运行 Lucy 的用户有权读取白名单目录中的文件。

---

## 错误处理

### 场景 1：文件不在白名单

**错误信息：**

```
file path not in whitelist: /home/attacker/secret.jpg. 
Allowed roots: /tmp, /var/cache
```

**处理：** 发送 `error` 或 `config.error` 机器事件给 App，说明媒体加载失败。

### 场景 2：文件不存在

**错误信息：**

```
ENOENT: no such file or directory: /tmp/output.jpg
```

**处理：** 同上，记录日志供调试。

### 场景 3：文件太大

**错误信息：**

```
file too large: 104857600 bytes (limit: 20971520 bytes)
```

**处理：** 告知 App 媒体超过限制，可建议用户压缩或分割文件。

### 场景 4：路径是目录

**错误信息：**

```
EISDIR: illegal operation on a directory: /tmp/is/a/directory
```

**处理：** 同上。

---

## 故障排查

### URL 格式错误

**症状：** `loadLucyOutboundMediaFromUrl()` 抛 "unsupported protocol" 异常。

**原因：** Runtime 传入的 URL 不是 `file://` 开头。

**排查：**

```bash
# 查看网关日志
openclaw gateway logs | grep -i "unsupported protocol"

# 检查 runtime 配置
cat ~/.openclaw/config.json | jq .agents
```

### 白名单配置丢失

**症状：** 所有 file:// URL 都被拒绝。

**原因：** `mediaLocalRoots` 未配置或为空数组。

**解决：**

```bash
# 查看当前配置
openclaw config get channels.lucy.mediaLocalRoots

# 添加白名单
openclaw config set channels.lucy.mediaLocalRoots '["/tmp", "/var/cache"]'

# 重启网关
openclaw gateway restart
```

### 权限不足

**症状：** 日志中出现 `EACCES: permission denied`。

**排查：**

```bash
# 检查文件权限
ls -la /tmp/output.jpg

# 检查 Lucy 进程的用户
ps aux | grep openclaw

# 尝试手动读取文件
cat /tmp/output.jpg
```

**解决：** 调整文件权限或运行 Lucy 的用户。

---

## 配置参考

| 配置键 | 类型 | 说明 | 默认值 |
|--------|------|------|--------|
| `channels.lucy.mediaLocalRoots` | string[] | 媒体文件白名单目录 | `[]` |
| `channels.lucy.mediaMaxMb` | number | 单个媒体大小限制（MB） | 20 |

定义位置：`src/types.ts:52-70`

---

## 相关文档

- [JetStream 对象存储](./object-store.md) — 媒体上传与下载
- [入站消息管道](../04-messaging/inbound-pipeline.md) — 媒体在入站流程中的位置
- [媒体传输流程图](../01-overview/diagrams.md#diagram-media-transfer) — 完整的媒体往返流程
