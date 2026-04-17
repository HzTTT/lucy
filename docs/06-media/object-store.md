<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# JetStream 对象存储

## 概述

Lucy 使用 NATS JetStream 的对象存储功能（Object Store）来存储双向媒体文件：App 上传的图片、音频等，以及 Lucy 回复中包含的生成结果（例如 AI 生成的图片）。媒体通过描述符（descriptor）在消息中引用，支持完整的生命周期管理。

媒体传输图参见 [媒体上传与下载](../01-overview/diagrams.md#diagram-media-transfer)。

---

## 对象存储初始化

### ensureLucyMediaStore()

位置：`src/media.ts`（搜索该函数）

**作用：** 初始化或获取 Lucy 的 JetStream 对象存储。

**签名：**

```typescript
export async function ensureLucyMediaStore(params: {
  session: ConnectedClient;
  userId: string;
  cdi: string;
}): Promise<ObjectStore>
```

**流程：**

1. 检查 NATS 连接中是否已初始化 Object Store
2. 如果未初始化，创建一个新的 Object Store
3. 返回可用的 ObjectStore 实例

**对象存储 bucket 名：**

```
lucy_media_<user_id>_<cdi>
```

其中 `user_id` 和 `cdi` 来自当前身份，确保不同用户的媒体完全隔离。

**代码位置：** `src/media.ts`

---

## 媒体上传

### uploadLucyMediaFromSource()

位置：`src/media.ts:53`

**作用：** 将本地媒体文件上传到 Object Store。

**签名：**

```typescript
export async function uploadLucyMediaFromSource(params: {
  session: ConnectedClient;
  userId: string;
  cdi: string;
  source: {
    bytes: Buffer | Uint8Array;
    mime: string;                    // MIME 类型
    suggestedFileName?: string;       // 建议的文件名
  };
}): Promise<LucyMediaDescriptor>
```

**返回值（媒体描述符）：**

```typescript
{
  transport: "iroh-blob",            // 固定值，表示 JetStream 对象存储
  blob_ref: string,                  // 对象存储中的唯一 ID
  kind: "image" | "audio" | "video" | "document",  // 媒体类别
  contentType?: string,              // MIME 类型（例如 image/jpeg）
  size: number,                      // 字节数
  fileName?: string                  // 文件名
}
```

**内部流程：**

1. **生成唯一 ID**

   ```typescript
   const blobId = getProcessSnowflakeGenerator().nextId();
   ```

   使用雪花 ID 生成器确保全局唯一性。

2. **上传到 Object Store**

   ```typescript
   const objstore = await ensureLucyMediaStore(params);
   await objstore.put(blobId, source.bytes, {
     name: source.suggestedFileName || blobId,
     mimeType: source.mime
   });
   ```

3. **构造描述符**

   ```typescript
   return {
     transport: "iroh-blob",
     blob_ref: blobId,
     kind: inferLucyMediaKind(source.mime),  // 根据 MIME 类型推断
     contentType: source.mime,
     size: source.bytes.length,
     fileName: source.suggestedFileName
   };
   ```

4. **返回给调用者**

   描述符被嵌入到 `assistant.final` 或其他机器事件中，发送给 App。

**错误处理：**

- 如果上传失败（例如 NATS 连接丢失），抛异常
- 调用者需在 try-catch 中处理

**代码示例：**

```typescript
try {
  const descriptor = await uploadLucyMediaFromSource({
    session,
    userId,
    cdi,
    source: {
      bytes: imageBuffer,
      mime: "image/jpeg",
      suggestedFileName: "output.jpg"
    }
  });
  // 现在可以将 descriptor 发送给 App
  await publishLucyMachineEvent({
    session,
    userId,
    cuk,
    cdi,
    type: "assistant.final",
    media: descriptor
  });
} catch (err) {
  // 处理上传失败
}
```

---

## 媒体下载

### downloadLucyMediaDescriptor()

位置：`src/media.ts:94`

**作用：** 从 Object Store 下载媒体描述符对应的文件。

**签名：**

```typescript
export async function downloadLucyMediaDescriptor(params: {
  session: ConnectedClient;
  userId: string;
  cdi: string;
  descriptor: LucyMediaDescriptor;
}): Promise<{
  bytes: Uint8Array;
  mime: string;
  fileName?: string;
}>
```

**流程：**

1. **验证描述符**

   检查 `transport` 必须为 `"iroh-blob"`；其他传输方式被拒绝。

2. **从 Object Store 获取**

   ```typescript
   const objstore = await ensureLucyMediaStore(params);
   const info = await objstore.get(descriptor.blob_ref);
   const bytes = await info.bytes();
   ```

3. **返回媒体数据**

   ```typescript
   return {
     bytes,
     mime: descriptor.contentType || "application/octet-stream",
     fileName: descriptor.fileName
   };
   ```

**错误处理：**

- 如果 `blob_ref` 不存在，Object Store 返回 404 异常
- 调用者需在 try-catch 中处理

**使用场景：**

在入站消息处理中，当 App 发送包含媒体的消息时：

```typescript
const inboundMessage = { /* ... media: descriptor */ };

const downloaded = await downloadLucyMediaDescriptor({
  session,
  userId,
  cdi,
  descriptor: inboundMessage.media
});

// 现在可以将 downloaded.bytes 传递给 OpenClaw runtime
await channelRuntime.inbound({
  type: "text",
  text: inboundMessage.text,
  media: {
    bytes: downloaded.bytes,
    mime: downloaded.mime,
    fileName: downloaded.fileName
  }
});
```

---

## 媒体描述符结构

完整的媒体描述符定义（zod schema：`LucyMediaDescriptorSchema`，`src/types.ts:20-27`）：

```typescript
{
  transport: "iroh-blob",            // 必填，传输方式
  blob_ref: string,                  // 必填，对象 ID
  kind: "image" | "audio" | "video" | "document",  // 必填，媒体类别
  contentType?: string,              // 可选，MIME 类型
  size: number,                      // 必填，字节数
  fileName?: string                  // 可选，建议文件名
}
```

**字段说明：**

| 字段 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `transport` | 是 | 传输方式（目前仅支持 iroh-blob） | `"iroh-blob"` |
| `blob_ref` | 是 | 对象存储中的唯一 ID（通常是雪花 ID） | `"1234567890123456789"` |
| `kind` | 是 | 媒体类别 | `"image"` |
| `contentType` | 否 | MIME 类型 | `"image/jpeg"` |
| `size` | 是 | 媒体字节数 | `5242880` |
| `fileName` | 否 | 建议的文件名 | `"photo.jpg"` |

---

## 媒体类别推断

### inferLucyMediaKind()

位置：`src/media.ts`（搜索该函数）

**作用：** 根据 MIME 类型推断媒体类别。

**映射规则：**

| MIME 类型前缀 | 媒体类别 |
|-------------|---------|
| `image/*` | `"image"` |
| `audio/*` | `"audio"` |
| `video/*` | `"video"` |
| 其他 | `"document"` |

**示例：**

```
image/jpeg → "image"
audio/mpeg → "audio"
video/mp4 → "video"
application/pdf → "document"
text/plain → "document"
```

---

## 出站媒体流程

当 OpenClaw runtime 生成包含媒体的回复时：

1. **Runtime 生成媒体** —— 例如 AI 生成图片保存为 `/tmp/output.jpg`
2. **出站媒体加载** —— `loadLucyOutboundMediaFromUrl()`（见 [出站媒体来源与白名单](./outbound-sources.md)）将文件转为 Buffer
3. **上传到 Object Store** —— `uploadLucyMediaFromSource()` 上传并得到 descriptor
4. **构造机器事件** —— descriptor 被嵌入到 `assistant.final` 事件
5. **发送给 App** —— 通过 NATS JetStream 发送事件

---

## 入站媒体流程

当 App 发送包含媒体的消息时：

1. **App 上传媒体** —— App 独立上传到 Object Store，得到 descriptor
2. **App 发送入站消息** —— 消息中包含 descriptor（不包含实际字节）
3. **Lucy 接收消息** —— `handleLucyInboundMessage()` 接收并检查 descriptor
4. **媒体下载** —— `downloadLucyMediaDescriptor()` 从 Object Store 拉取
5. **投递给 Runtime** —— 附带实际字节的消息投递给 OpenClaw runtime

---

## 存储容量与清理

### 存储限制

媒体存储受以下配置限制：

| 配置键 | 说明 | 默认值 |
|--------|------|--------|
| `channels.lucy.mediaMaxMb` | 单个媒体文件大小限制 | 20 MB |
| `channels.lucy.maxAttachments` | 单条消息最大附件数 | 10 |

定义位置：`src/types.ts:52-70`

**验证时机：**

- 在 `downloadLucyMediaDescriptor()` 中检查 `descriptor.size` 是否超过限制
- 在 `uploadLucyMediaFromSource()` 中检查上传字节数

### 自动清理

Lucy 本身不实现自动清理机制。对象存储的清理由以下方式处理：

1. **手动清理** —— 管理员使用 NATS CLI 删除过期对象
2. **对象存储过期策略** —— NATS server 配置 Object Store 的过期规则
3. **应用层清理** —— App 记录历史消息的 descriptor，定期清理不用的对象

---

## 故障排查

### 上传失败：NATS 连接丢失

**症状：** `uploadLucyMediaFromSource()` 抛异常。

**排查步骤：**

1. 验证 NATS 连接：`nc -zv nats-server 4222`
2. 查看网关日志：`openclaw gateway logs | grep -i nats`
3. 重启 NATS 连接：`openclaw channels restart lucy`

### 下载失败：blob_ref 不存在

**症状：** `downloadLucyMediaDescriptor()` 返回 404。

**原因：**

1. 媒体已过期或被清理
2. App 传入的 descriptor 来自其他用户/设备
3. Object Store bucket 损坏

**排查步骤：**

1. 使用 NATS CLI 检查对象存在性：`nats object ls lucy_media_<user_id>_<cdi>`
2. 检查 descriptor 中的 `blob_ref` 是否正确
3. 重新上传媒体

### 媒体文件过大

**症状：** 上传或下载被拒绝。

**排查步骤：**

1. 检查文件大小：`ls -lh file.jpg`
2. 查看配置：`cat ~/.openclaw/config.json | jq .channels.lucy.mediaMaxMb`
3. 如需支持更大文件，增加 `mediaMaxMb` 配置（需重启网关）

---

## 相关文档

- [出站媒体来源与白名单](./outbound-sources.md) — 媒体从 runtime 到 Object Store 的路径
- [入站消息管道](../04-messaging/inbound-pipeline.md) — 媒体在入站流程中的位置
- [机器事件字典](../04-messaging/machine-events.md#media) — 媒体在事件中的表示
- [媒体传输流程图](../01-overview/diagrams.md#diagram-media-transfer) — 完整的媒体往返流程
