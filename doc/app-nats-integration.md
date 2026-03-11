# Lucy App 侧 NATS 接入文档

本文面向直接通过 NATS 接入 Lucy 的 App 或客户端开发者。把 Lucy 理解成一个挂在 NATS 上的聊天网关即可：

- App 向 `client` subject 发消息
- Lucy 收到后交给 OpenClaw/模型处理
- Lucy 再把过程和结果发回 `machine` subject

真正需要关心的是：

- subject 规则
- 入站消息格式
- 出站机器事件格式
- 事件语义，尤其是 `partial` 和 `final`
- 少量可能泄漏到文本里的控制标签

## 1. 通信总览

### 1.1 subject 规则

```text
client  = {subjectPrefix}.{apiKey}.{deviceId}.client
machine = {subjectPrefix}.{apiKey}.{deviceId}.machine
```

默认 `subjectPrefix`：

```text
cephalon.im.npc
```

示例：

```text
cephalon.im.npc.demo_user.1234567890123456789.client
cephalon.im.npc.demo_user.1234567890123456789.machine
```

### 1.2 方向

- App -> Lucy：向 `client` subject 发布 JSON
- Lucy -> App：订阅 `machine` subject 接收机器事件

### 1.3 接入前需要拿到的值

- `servers`：NATS 地址，例如 `nats://host:4222`
- `servers`：NATS 地址，例如 `nats://host:4222` 或 `wss://host/nats-ws`
- 认证信息：`token` 或 `username/password`
- `subjectPrefix`
- `apiKey`
- `deviceId`

说明：

- `apiKey` 同时是 Lucy 命名空间的一部分
- `deviceId` 由 Lucy 生成，必须和当前运行实例一致
- 如果 Lucy 配置目录重建，`deviceId` 可能变化，不要把它当永久常量
- 某些部署只暴露 `wss://.../nats-ws`，并不暴露可直接替换成 `nats://...`
  的原生 NATS 端口

### 1.4 WebSocket 部署说明

Lucy 现在支持在 Node 环境里直接连接 NATS over WebSocket：

- `ws://host/nats-ws`
- `wss://host/nats-ws`

如果服务端只提供 WebSocket 入口：

- App 侧必须使用真正支持 NATS over WebSocket 的客户端
- 不能只把 `wss://` 改成 `nats://`
- 如果需要鉴权，仍然按 NATS 协议使用 `auth_token` / `user` / `pass`

如果服务端同时暴露原生 NATS：

- `nats://host:4222` 或 `tls://host:4443` 同样可用
- 但这取决于服务端是否真的开放了对应监听，不要靠 scheme 猜测

## 2. 常见字段

| 字段 | 含义 |
| --- | --- |
| `apiKey` | 当前 Lucy 账号/命名空间标识 |
| `deviceId` | 当前 Lucy 实例 ID，19 位数字字符串 |
| `messageId` | App 发给 Lucy 的消息 ID |
| `sourceMessageId` | 机器事件对应的入站消息 ID |
| `runId` | 一次模型执行的运行 ID |
| `sessionKey` | OpenClaw 会话键 |
| `eventId` | 机器事件自己的唯一 ID |

建议把一次问答主键定为 `sourceMessageId`；如果需要区分同一条消息上的多轮内部执行，再配合 `runId`。

## 3. App 发给 Lucy 的 JSON

发布目标：

```text
{subjectPrefix}.{apiKey}.{deviceId}.client
```

示例：

```json
{
  "version": 1,
  "messageId": "1000000000000000001",
  "text": "你好，帮我总结一下今天的待办",
  "timestamp": 1773158143515,
  "metadata": {
    "traceId": "app-req-001",
    "platform": "ios"
  },
  "apiKey": "demo_user",
  "deviceId": "1234567890123456789"
}
```

### 3.1 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | 固定为 `1` |
| `text` | 是 | 用户输入文本 |
| `messageId` | 否 | 19 位数字字符串；建议 App 自己生成，方便关联返回事件 |
| `timestamp` | 否 | 毫秒时间戳 |
| `metadata` | 否 | 扩展信息；当前不保证原样回传 |
| `apiKey` | 否 | 如果传了，必须与 subject 中一致 |
| `deviceId` | 否 | 如果传了，必须与 subject 中一致 |

### 3.2 约束

- `version` 只能是 `1`
- `messageId` 如果传，必须是 19 位数字字符串
- `deviceId` 如果传，必须是 19 位数字字符串
- `apiKey` 必须满足 `^[A-Za-z0-9_-]+$`

如果 payload 里的 `apiKey` 或 `deviceId` 与 subject 不一致，Lucy 不会继续处理，而是往 `machine` subject 发 `error` 事件。

## 4. Lucy 回给 App 的机器事件

订阅目标：

```text
{subjectPrefix}.{apiKey}.{deviceId}.machine
```

公共格式：

```json
{
  "version": 1,
  "eventId": "1000000000000000999",
  "type": "assistant.partial",
  "timestamp": 1773158149000,
  "apiKey": "demo_user",
  "deviceId": "1234567890123456789",
  "sourceMessageId": "1000000000000000001",
  "runId": "run_abc123",
  "sessionKey": "agent:main:main",
  "text": "当前完整可见回答",
  "toolName": "read",
  "metadata": {}
}
```

### 4.1 公共字段

| 字段 | 说明 |
| --- | --- |
| `version` | 固定为 `1` |
| `eventId` | 机器事件唯一 ID |
| `type` | 事件类型 |
| `timestamp` | 毫秒时间戳 |
| `apiKey` | 当前命名空间 |
| `deviceId` | 当前 Lucy 实例 ID |
| `sourceMessageId` | 这条事件对应的入站消息 |
| `runId` | 当前运行 ID；早期事件可能没有 |
| `sessionKey` | OpenClaw 会话键 |
| `text` | 文本内容；不是每种事件都有 |
| `toolName` | 工具名；不是每种事件都有 |
| `metadata` | 扩展字段；不是每种事件都有 |

## 5. 事件类型与处理方式

Lucy 当前会发这些事件：

- `inbound.accepted`
- `assistant.start`
- `assistant.partial`
- `assistant.final`
- `reasoning.partial`
- `reasoning.final`
- `tool.start`
- `tool.end`
- `error`

### 5.1 `inbound.accepted`

含义：Lucy 已接收入站消息，subject、命名空间和基础路由已打通。

建议：

- 把消息状态改成“已接收”
- 可以进入“处理中”状态

### 5.2 `assistant.start`

含义：助手即将开始输出。

它在一条消息里可能出现多次，尤其是工具调用后恢复输出时。只把它当成 typing/loading 信号即可。

### 5.3 `assistant.partial`

含义：当前回答的实时预览。

`assistant.partial.text` 是完整快照，不是增量 delta。

所以应该替换草稿：

```text
draftAnswer = evt.text
```

不要这样做：

```text
draftAnswer += evt.text
```

### 5.4 `assistant.final`

含义：一段已提交的最终回答块。

`assistant.final.text` 应进入正式消息历史。一次回复可能收到多个 `assistant.final`，多个最终块按接收顺序拼接，不要自行重排。

推荐做法：

```text
finalBlocks.push(evt.text)
```

`assistant.partial` 只做预览，`assistant.final` 才写入正式聊天记录。

### 5.5 `reasoning.partial`

含义：推理/思考过程的实时预览。

语义和 `assistant.partial` 一样，也是完整快照，不是增量。

```text
draftReasoning = evt.text
```

某些模型不会产生这个事件，它是可选增强，不应该成为主流程依赖。

### 5.6 `reasoning.final`

含义：推理流结束。

它常常只是结束标记，可能没有 `text`。收到后关闭“思考中”状态即可。

### 5.7 `tool.start`

含义：模型开始调用工具。

当前稳定暴露的主要是 `toolName`。工具参数、tool call id、工具返回正文目前不应当视为稳定协议，所以只把它当成生命周期提示即可。

### 5.8 `tool.end`

含义：一次工具调用结束。

建议：结束对应工具的 loading 状态。

### 5.9 `error`

含义：入站校验失败或本次处理失败。

建议：

- 直接展示失败状态
- 记录 `text`
- 不要继续等待更多结果

## 6. 推荐状态机

如果只记住一条规则，请记住：

- `assistant.partial` / `reasoning.partial`：替换草稿
- `assistant.final`：追加最终块

### 6.1 最简单稳定版

如果不需要边生成边显示，可以只处理：

- `inbound.accepted`
- `assistant.start`
- `tool.start`
- `tool.end`
- `assistant.final`
- `error`

优点：最稳，不会遇到 partial/final 去重问题。缺点：没有流式体验。

### 6.2 完整流式版

建议每条入站消息维护一份状态：

```ts
type ReplyState = {
  sourceMessageId: string;
  runId?: string;
  accepted: boolean;
  draftAnswer: string;
  draftReasoning: string;
  finalBlocks: string[];
  activeTools: string[];
  errored: boolean;
};
```

推荐处理规则：

```ts
switch (evt.type) {
  case "inbound.accepted":
    state.accepted = true;
    break;
  case "assistant.partial":
    state.draftAnswer = evt.text ?? "";
    break;
  case "reasoning.partial":
    state.draftReasoning = evt.text ?? "";
    break;
  case "tool.start":
    if (evt.toolName) state.activeTools.push(evt.toolName);
    break;
  case "tool.end":
    state.activeTools = state.activeTools.filter((x) => x !== evt.toolName);
    break;
  case "assistant.final":
    if (evt.text) state.finalBlocks.push(evt.text);
    state.draftAnswer = "";
    break;
  case "error":
    state.errored = true;
    break;
}
```

### 6.3 完成判定

Lucy 当前没有单独的 `assistant.done` 事件。

更稳妥的做法：

1. 按 `sourceMessageId` 聚合同一轮事件
2. 至少收到一条 `assistant.final`
3. 再等待一小段空闲窗口
4. 没有新事件后再标记完成

建议空闲窗口：`1000ms` 到 `2000ms`。

## 7. 优先消费机器事件，不要直接消费 transcript

对 App 来说，真正的外部协议是 `machine` subject 上的事件，而不是：

- 模型原始 transcript
- provider 原始流式包
- OpenClaw 内部 session 文件

因为 transcript 可能混入控制标签、tool call、thinking block 和 provider 特有结构，更适合调试，不适合直接做 App UI 协议。

## 8. 标签说明

正常情况下，应优先按事件类型渲染，而不是解析文本标签。只有在需要兼容原始 transcript 泄漏时，才额外做标签清洗。

### 8.1 `[[reply_to_current]]`

含义：回复当前触发消息。

不要直接展示给用户。支持引用回复时可解释为“回复当前消息”，否则直接移除。

### 8.2 `[[reply_to:<messageId>]]`

含义：回复指定消息 ID。

支持引用回复时把 `<messageId>` 当目标消息；不支持时直接移除。

### 8.3 `<think>...</think>` 及同类标签

常见形式：

- `<think>...</think>`
- `<thinking>...</thinking>`
- `<thought>...</thought>`
- `<antthinking>...</antthinking>`

含义：推理区，不属于最终回答正文。

不要和最终回答混在一个气泡里；要展示 reasoning 就放到单独区域，不展示就直接过滤。

### 8.4 `<final>...</final>`

含义：这部分是最终答案。

处理建议：去掉标签，只保留内部文本。

例如：

```text
<final>你好</final>
```

应显示为：

```text
你好
```

### 8.5 `<relevant_memories>...</relevant_memories>`

含义：内部记忆/上下文脚手架，不是面向最终用户的内容。

直接过滤。

## 9. 完整示例

### 9.1 App 发送

发布到：

```text
cephalon.im.npc.demo_user.1234567890123456789.client
```

```json
{
  "version": 1,
  "messageId": "1000000000000000001",
  "text": "请先读 TOOL_CHECK.txt，再回答。",
  "timestamp": 1773158143515
}
```

### 9.2 App 收到的事件序列

```json
{"type":"inbound.accepted","sourceMessageId":"1000000000000000001"}
{"type":"assistant.start","sourceMessageId":"1000000000000000001","runId":"run_1"}
{"type":"tool.start","sourceMessageId":"1000000000000000001","runId":"run_1","toolName":"read"}
{"type":"tool.end","sourceMessageId":"1000000000000000001","runId":"run_1","toolName":"read"}
{"type":"assistant.start","sourceMessageId":"1000000000000000001","runId":"run_1"}
{"type":"assistant.partial","sourceMessageId":"1000000000000000001","runId":"run_1","text":"Sentinel: LUCY_"}
{"type":"assistant.partial","sourceMessageId":"1000000000000000001","runId":"run_1","text":"Sentinel: LUCY_TOOL_SENTINEL=alpha-2026-03-10"}
{"type":"assistant.final","sourceMessageId":"1000000000000000001","runId":"run_1","text":"Sentinel: LUCY_TOOL_SENTINEL=alpha-2026-03-10\n\nTool used: `read`\n\n后续说明第一段"}
{"type":"assistant.final","sourceMessageId":"1000000000000000001","runId":"run_1","text":"后续说明第二段"}
```

这组事件说明：消息先被 Lucy 接收，中间调用了 `read`，`assistant.partial` 只用于替换草稿，`assistant.final` 才是按顺序落库的正式内容。

## 10. JavaScript/TypeScript 最小接入示例

```ts
import { connect, JSONCodec } from "nats";

const jc = JSONCodec();

const subjectPrefix = "cephalon.im.npc";
const apiKey = "demo_user";
const deviceId = "1234567890123456789";

const clientSubject = `${subjectPrefix}.${apiKey}.${deviceId}.client`;
const machineSubject = `${subjectPrefix}.${apiKey}.${deviceId}.machine`;

const nc = await connect({
  servers: ["nats://127.0.0.1:4222"],
  token: "YOUR_NATS_TOKEN"
});

const sourceMessageId = "1000000000000000001";

const sub = nc.subscribe(machineSubject);
(async () => {
  for await (const msg of sub) {
    const evt = jc.decode(msg.data);
    if (evt.sourceMessageId !== sourceMessageId) continue;
    console.log("machine event:", evt);
  }
})();

nc.publish(
  clientSubject,
  jc.encode({
    version: 1,
    messageId: sourceMessageId,
    text: "你好，做一个三点总结"
  })
);
```

## 11. 常见误区与已知特性

- 不要把 `assistant.partial.text` 当 delta 追加
- 不要假设只会收到一条 `assistant.final`
- 不要把 `reasoning.*` 当最终回答正文
- 不要把 `[[reply_to_current]]` 直接展示给用户
- 不要依赖 `metadata` 一定会原样回传
- 不要把 session transcript 当成 App 对外协议
- `assistant.start` 在一次请求里可能出现多次
- `reasoning.final` 可能只有结束语义，没有文本
- `tool.start` / `tool.end` 当前主要只稳定提供 `toolName`

如果 App 严格按这份文档实现，已经可以稳定接入 Lucy。
