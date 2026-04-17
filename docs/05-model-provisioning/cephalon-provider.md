<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# 嵌入式 Cephalon Provider

## 设计原则

**Cephalon provider 不是独立的 OpenClaw 插件包，而是注册在 Lucy 内部的 provider。** 这是有意的设计选择：

- App 通过 Lucy 通道下发模型配置（`version=3 / kind=provision_model`）
- Lucy 负责验证、应用配置，并向 OpenClaw config 写入 `models.providers.cephalon`
- 模型的 API Key、Base URL 等由 user-center 服务提供，Lucy 不硬编码环境信息
- 自动重启由 Lucy 内部管理（`restart-ticket.ts`），不依赖外部重启机制

---

## Cephalon Provider 构建

### 函数签名

```typescript
export function buildLucyCephalonProvider(): ProviderPlugin
```

位置：`src/cephalon-provider.ts:55`

### Provider 注册时机

在插件启动时，通过 `defineLucyChannelPluginEntry()` 注册：

```typescript
api.registerProvider(buildLucyCephalonProvider())
```

位置：`src/channel-plugin-entry.ts:43`

这使得 Cephalon provider 对 OpenClaw runtime 可用，App 可通过 provision message 配置它。

### Provider 元数据

```typescript
{
  id: "cephalon",                    // 固定 ID
  displayName: "Cephalon",           // 用户可读名称
  description: "Lucy 的嵌入式 Cephalon 模型 provider",
  version: "1.0.0",
  supportsModelSelection: true,      // 支持模型选择
  supportsCustomEndpoint: true,      // 支持自定义 Base URL
  features: {
    streaming: true,                 // 流式输出
    functionCalling: true,           // 函数调用
    vision: true                      // 多模态（图片）
  }
}
```

---

## 模型编录与默认值

### 默认模型 ID

```
cephalon/kimi-k2.5
```

应用配置中的完整形式：

```
models.providers.cephalon.model = "kimi-k2.5"
agents.defaults.model.primary = "cephalon/kimi-k2.5"
```

### 支持的模型列表

Cephalon provider 支持的模型由 user-center 的 `/v1/channels/lucy/current-user/model-config` 返回。Lucy 不在代码中硬编码模型列表，而是：

1. App 查询 user-center 获得可用模型
2. App 发送 provision message 指定模型 ID
3. Lucy 应用配置，不验证模型 ID 的有效性（委托给 runtime）

---

## 配置架构

### 写入的 Config 结构

当 App 下发模型配置后，`applyLucyProvisioningConfig()`（`src/provider-provisioning.ts:220`）写入：

```typescript
{
  models: {
    providers: {
      cephalon: {
        model: "kimi-k2.5",         // 默认模型 ID
        apiKey: "sk-...",           // 从 user-center 返回
        baseUrl: "https://..."      // 从 user-center 返回或环境变量
      }
    }
  },
  agents: {
    defaults: {
      model: {
        primary: "cephalon/kimi-k2.5"  // 指向 cephalon provider
      }
    }
  }
}
```

### Base URL 来源（优先级）

Cephalon provider 的 `baseUrl` 不硬编码 `prod` / `test` 环境，而是遵循以下优先级：

1. **App 提供的值** —— 如果 provision message 中包含 `baseUrl` 字段
2. **user-center 返回值** —— `/v1/channels/lucy/current-user/model-config` 的 `base_url` 字段
3. **环境变量**（如配置允许）—— 例如 `LUCY_MODEL_BASE_URL`

这保证了 Lucy 无需硬编码环保信息，可灵活适应不同部署环境。

---

## Provider 功能特性

### 流式推理

Cephalon provider 支持 OpenClaw 的流式推理（streaming），允许 App 实时接收 `assistant.partial` 事件。

### 函数调用与工具

Cephalon 支持 OpenClaw 的函数调用接口（function calling），使 agent 能调用系统工具。

### 多模态输入

通过媒体描述符，App 可向 Cephalon 发送图片、音频等，由 provider 处理多模态推理。

### 错误与重试

Cephalon provider 继承 OpenClaw 的错误处理机制：

- **HTTP 401** —— API Key 无效或过期，触发 `assistant.final` 返回错误文本
- **HTTP 5xx** —— 服务端错误，OpenClaw runtime 遵循配置的重试策略
- **Timeout** —— 推理超时，由 OpenClaw 的 timeout 配置决定

---

## 与其他 Provider 的兼容性

Cephalon 并不排斥其他 provider 的存在。用户可在 OpenClaw config 中同时配置多个 provider（例如 Cephalon + OpenAI + Anthropic），然后通过 `agents.defaults.model.primary` 指定默认值。

App 也可通过 provision message 动态切换默认 provider，但 Lucy 不负责验证跨 provider 的兼容性。

---

## 配置验证

### Schema 检查

Cephalon provider 的配置通过 zod schema 验证，确保所需字段的类型正确：

```typescript
const LucyProvisioningPayloadSchema = z.object({
  providerId: z.string().min(1),     // 必须是 "cephalon"
  modelId: z.string().min(1),        // 必须非空
  apiKey: z.string().min(1),         // 必须非空
  baseUrl: z.string().url().optional(),  // 可选，必须是有效 URL
  switchDefaultModel: z.boolean().optional(),
  restartRequested: z.boolean().optional(),
});
```

位置：`src/types.ts:117-124`

### 运行时检查

`handleLucyProvisioningMessage()` 在应用前检查：

```typescript
if (provision.providerId !== "cephalon") {
  // 拒绝非 cephalon provider
  await publishLucyMachineEvent({
    type: "config.error",
    text: `unsupported provider: ${provision.providerId}`
  });
  return;
}
```

位置：`src/provider-provisioning.ts:305`

---

## 日志与调试

### Provider 启动日志

Lucy 启动时会记录 Cephalon provider 的注册：

```
[lucy] registered cephalon provider with id=cephalon
```

### 模型推理日志

OpenClaw runtime 执行 Cephalon 模型时，会在标准日志中记录：

```
[runtime] invoking provider=cephalon model=kimi-k2.5
[runtime] stream chunk from cephalon: { ... }
```

### 错误日志

如果 API Key 无效或 Base URL 不可达，日志会显示：

```
[runtime] provider error: HTTP 401 from cephalon base_url
```

---

## 和 Multimodal RAG 的交互

如果启用了 `plugins.entries.multimodal-rag` 插件，Lucy 会自动调整以下配置：

| 配置键 | 修改行为 | 说明 |
|--------|---------|------|
| `ollama.baseUrl` | 自动改写为 user-center 返回值或环境变量 | Embedding 模型 |
| `whisper.zhipuApiBaseUrl` | 自动改写为 user-center 返回值或环境变量 | 语音识别 API |

**代码位置：** `src/provider-provisioning.ts`（搜索 multimodal-rag）

这保证了 RAG 插件使用与 Cephalon 一致的服务端点，避免跨域或网络隔离问题。

---

## 相关文档

- [模型供应与自动重启](../01-overview/diagrams.md#diagram-provisioning-restart) — 流程图
- [模型下发主流程](./provision-flow.md) — App 如何下发配置
- [自动重启与恢复](./auto-restart.md) — 重启机制
