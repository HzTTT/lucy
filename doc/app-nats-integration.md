# Lucy App / SDK 侧 NATS 接入指南

本文面向直接通过 NATS 与 Lucy 对接的专业开发者。目标是定义一个稳定的外部协议边界，让 App、SDK 或服务端客户端能够独立实现发送、订阅、流式渲染和媒体下载。

协议的权威边界是：

- `client` subject 上的入站 JSON
- `machine` subject 上的 Lucy machine events
- JetStream Object Store 中的媒体对象

不要把 OpenClaw session transcript、模型 provider 原始流或内部调试日志当成对外协议。

## 1. 前置条件

在 App 接入之前，Gateway 侧必须已经完成 Lucy 安装、配置与探测。

最小流程：

1. 安装插件：

```bash
openclaw plugins install @hzttt/lucy
```

1. 配置 `channels.lucy`：

```json5
{
  channels: {
    lucy: {
      enabled: true,
      apiKey: "demo_user",
      servers: ["nats://127.0.0.1:4222"],
    },
  },
}
```

如果 Gateway 侧还需要通过 Lucy 发送默认 OpenClaw roots 之外的本地图片或音频，可以额外配置：

```json5
{
  channels: {
    lucy: {
      enabled: true,
      apiKey: "demo_user",
      servers: ["nats://127.0.0.1:4222"],
      mediaLocalRoots: ["/home/lucy/data/usb", "/mnt/photos"],
    },
  },
}
```

`mediaLocalRoots` 只影响 Gateway 读取本地文件并转成 Lucy 媒体 descriptor 的场景，不影响 App 侧按协议直接上传 JetStream Object Store。

如果 Gateway 连接的 NATS 需要 token 鉴权，配置应改为：

```json5
{
  channels: {
    lucy: {
      enabled: true,
      apiKey: "demo_user",
      servers: ["nats://127.0.0.1:4222"],
      token: "nats-token-placeholder",
    },
  },
}
```

1. 重启 Gateway：

```bash
openclaw gateway restart
```

1. 执行健康检查，并用稳定 JSON 输出取运行参数：

```bash
openclaw channels status --probe
openclaw gateway call channels.status --params '{"probe":true,"timeoutMs":10000}' --json \
    | jq '.channelAccounts.lucy[] | select(.accountId=="default") | .probe | {deviceId, clientSubject, machineSubject, mediaBucket, mediaRetentionHours}'
```

接入侧必须记录以下值：

- `servers`
- 认证信息：`token` 或 `username/password`
- `subjectPrefix`
- `apiKey`
- `deviceId`
- `mediaBucket`

约束：

- `deviceId` 由 Lucy 持久化生成，App 必须使用当前运行实例的值
- 如果配置目录或状态目录重建，`deviceId` 可能变化
- npm 包名是 `@hzttt/lucy`，但 OpenClaw 内部的插件 id 和 channel id 都是 `lucy`
- `channels status --probe` 适合人工查看健康状态；给 App 或脚本取 `deviceId` / subject / media 参数时，使用 `gateway call channels.status ... --json`

## 2. 连接方式

Lucy 支持两类 NATS 入口：

- 原生 NATS/TLS：`nats://host:4222`、`tls://host:4443`
- NATS over WebSocket：`ws://host/nats-ws`、`wss://host/nats-ws`

接入端需要与部署侧暴露的实际协议保持一致。

- 如果服务端只开放 `wss://.../nats-ws`，不能把地址改成 `nats://` 继续尝试
- 如果服务端同时开放原生 NATS 与 WSS，可以任选其一，但应以真实监听端口为准
- 鉴权仍按 NATS 协议处理，Lucy 不额外包一层 App 专用认证

## 3. Subject 约定

Lucy 使用 `subjectPrefix + apiKey + deviceId` 构造一对固定 subject：

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

方向约定：

- App -> Lucy：向 `client` subject 发布 JSON
- Lucy -> App：订阅 `machine` subject 接收生命周期事件

实现建议：

- 把 `sourceMessageId` 视为一次用户输入的聚合键
- 把 `runId` 视为同一轮执行中的内部运行标识
- 使用 `gateway call channels.status ... --json` 中的 `clientSubject` 和 `machineSubject` 作为最终来源，避免手拼错误

## 4. App -> Lucy：入站消息协议

### 4.1 推荐使用 v2

Lucy 当前推荐使用 `version = 2`。v1 仍被兼容，但只适用于纯文本历史消息，不建议新接入继续使用。

文本消息示例：

```json
{
  "version": 2,
  "messageId": "1000000000000000001",
  "text": "请帮我总结今天的待办",
  "timestamp": 1773158143515,
  "metadata": {
    "traceId": "app-req-001",
    "platform": "ios"
  },
  "apiKey": "demo_user",
  "deviceId": "1234567890123456789"
}
```

文本加媒体示例：

```json
{
  "version": 2,
  "messageId": "1000000000000000002",
  "text": "描述这张图片",
  "media": {
    "transport": "jetstream-object-store",
    "bucket": "lucy_media_v2",
    "key": "inbound/demo_user/1234567890123456789/1000000000000000002-photo.png",
    "kind": "image",
    "contentType": "image/png",
    "size": 104857,
    "fileName": "photo.png",
    "sha256": "0f4c2b..."
  },
  "timestamp": 1773158143516
}
```

### 4.2 字段定义


| 字段          | 类型                        | 必填   | 说明                                      |
| ----------- | ------------------------- | ---- | --------------------------------------- |
| `version`   | `2`                       | 是    | 当前推荐固定为 `2`                             |
| `messageId` | `string`                  | 否    | 建议始终提供；必须是 19 位数字字符串                    |
| `text`      | `string`                  | 条件必填 | `text` 与 `media` 至少有一个                  |
| `media`     | `object`                  | 条件必填 | 单个媒体 descriptor，当前仅支持 `image` / `audio` |
| `timestamp` | `number`                  | 否    | 毫秒时间戳                                   |
| `metadata`  | `Record<string, unknown>` | 否    | 扩展信息，不能假设会原样回传                          |
| `apiKey`    | `string`                  | 否    | 如果传递，必须与 subject 命名空间一致                 |
| `deviceId`  | `string`                  | 否    | 如果传递，必须与 subject 命名空间一致，且为 19 位数字字符串    |


工程建议：

- 始终自行生成 `messageId`，否则 Lucy 会在服务端补一个值，App 侧无法提前知道
- `timestamp` 建议由发送侧填入，方便端到端时延分析
- `metadata` 只放辅助观测字段，不要把核心业务语义绑定在它上面

### 4.3 校验规则

Lucy 侧的关键校验如下：

- `apiKey` 必须满足 `^[A-Za-z0-9_-]+$`
- `messageId` 与 `deviceId` 必须是 19 位数字字符串
- `text` 与 `media` 至少有一个
- `media.bucket` 必须匹配当前 Lucy 配置的 bucket
- `media.key` 必须满足 `^[-/=.\\w]+$`
- `media.transport` 固定为 `jetstream-object-store`
- `media.kind` 仅支持 `image`、`audio`

错误行为：

- JSON 结构非法：Lucy 在 `machine` subject 返回 `error`
- payload 中的 `apiKey` 与 subject 不一致：Lucy 返回 `error`，停止处理
- payload 中的 `deviceId` 与 subject 不一致：Lucy 返回 `error`，停止处理

## 5. 媒体上传协议

Lucy 不在 `client` 消息中承载媒体字节本体。正确顺序是：

1. App 先把文件上传到 JetStream Object Store
2. App 在入站 JSON 的 `media` 字段中携带 descriptor
3. Lucy 下载对象并注入 OpenClaw inbound context

descriptor 定义：


| 字段            | 必填  | 说明                                       |
| ------------- | --- | ---------------------------------------- |
| `transport`   | 是   | 固定为 `jetstream-object-store`             |
| `bucket`      | 是   | Object Store bucket 名，默认 `lucy_media_v2` |
| `key`         | 是   | 对象 key，必须是 ASCII-safe 路径片段               |
| `kind`        | 是   | `image` 或 `audio`                        |
| `contentType` | 否   | MIME 类型                                  |
| `size`        | 是   | 对象字节数                                    |
| `fileName`    | 否   | 原始文件名，给 UI 展示用                           |
| `sha256`      | 否   | 内容哈希，可用于完整性校验                            |


实现建议：

- 用 `fileName` 保留原始文件名，用 `key` 保留机器可消费的 ASCII-safe 路径
- 不要把 JetStream bucket 当作长期永久存储，默认保留时间是 7 天
- 如果你要支持图片与音频之外的类型，必须先扩展 Lucy 代码，而不是直接发新 `kind`

## 6. Lucy -> App：machine event 协议

所有 machine events 当前都使用 `version = 2`。

通用示例：

```json
{
  "version": 2,
  "eventId": "1000000000000000999",
  "type": "assistant.final",
  "timestamp": 1773158149000,
  "apiKey": "demo_user",
  "deviceId": "1234567890123456789",
  "sourceMessageId": "1000000000000000001",
  "runId": "run_abc123",
  "sessionKey": "agent:main:main",
  "text": "当前完整可见回答",
  "media": {
    "transport": "jetstream-object-store",
    "bucket": "lucy_media_v2",
    "key": "outbound/demo_user/1234567890123456789/1000000000000000999/reply.png",
    "kind": "image",
    "contentType": "image/png",
    "size": 20480,
    "fileName": "reply.png",
    "sha256": "ad91..."
  },
  "toolName": "read",
  "metadata": {
    "droppedMediaCount": 0
  }
}
```

### 6.1 公共字段


| 字段                | 说明                                       |
| ----------------- | ---------------------------------------- |
| `version`         | 当前固定为 `2`                                |
| `eventId`         | 机器事件唯一 id                                |
| `type`            | 事件类型                                     |
| `timestamp`       | 毫秒时间戳                                    |
| `apiKey`          | 当前命名空间                                   |
| `deviceId`        | 当前 Lucy 实例 id                            |
| `sourceMessageId` | 对应的入站消息 id；对工具主动推送或系统主动发送的事件，这个字段可能缺失 |
| `runId`           | 当前 OpenClaw 执行 id                        |
| `sessionKey`      | 当前 OpenClaw 会话键                          |
| `text`            | 文本内容，不是每种事件都有                            |
| `media`           | 单个媒体 descriptor，通常只出现在 `assistant.final` |
| `toolName`        | 工具名，通常出现在 `tool.start` / `tool.end`      |
| `metadata`        | 附加观测字段，例如媒体丢弃计数                          |


### 6.2 事件类型语义


| 类型                  | 含义                  | 客户端建议                             |
| ------------------- | ------------------- | --------------------------------- |
| `inbound.accepted`  | Lucy 已接收入站消息并完成基础路由 | 将消息状态标记为“已接收”                     |
| `assistant.start`   | 助手开始或恢复输出           | 只当作 typing / loading 信号；可能出现多次    |
| `assistant.partial` | 助手当前可见文本快照          | 用 `evt.text` 替换草稿，不要做字符串追加        |
| `assistant.final`   | 一段正式提交的最终回答块        | 追加到正式消息历史；可能出现多次                  |
| `reasoning.partial` | 推理文本快照              | 如需展示思考过程，同样按快照覆盖                  |
| `reasoning.final`   | 推理阶段结束              | 用于关闭“思考中”状态，可能没有文本                |
| `tool.start`        | 模型开始调用工具            | 展示工具 loading；当前稳定字段主要是 `toolName` |
| `tool.end`          | 某次工具调用结束            | 关闭对应工具 loading                    |
| `error`             | 入站校验失败或本次处理失败       | 标记失败并停止继续等待                       |


必须特别注意：

- `assistant.partial.text` 是完整快照，不是 delta
- `reasoning.partial.text` 也是完整快照，不是 delta
- `assistant.final` 可能不止一条，必须按接收顺序写入历史
- `assistant.final.media` 才是“返回了媒体”的权威信号
- `assistant.partial` 中可能短暂看到 `MEDIA:` 指令文本，不应据此下载媒体
- 某些工具主动推送出来的 `assistant.final` 可能没有 `sourceMessageId`；这类事件仍然是合法的，应按 `runId` 或 `eventId` 单独落成一条独立 assistant 消息，而不是直接丢弃

## 7. 媒体返回协议

当 Agent 返回图片或音频时，Lucy 会把真实对象上传到 JetStream Object Store，然后在 `assistant.final.media` 中返回 descriptor。

常见来源有两类：

1. OpenClaw reply payload 直接提供 `mediaUrl` / `mediaUrls`
2. Agent 文本中包含 `MEDIA: <path-or-url>` 指令

如果来源是 Gateway 本地绝对路径，这个路径必须位于 OpenClaw 允许的媒体根目录内。默认 roots 之外的路径需要事先加入 `channels.lucy.mediaLocalRoots`，否则会在上传到 Object Store 之前被安全检查拒绝。

App 侧不应自己解析 `MEDIA:` 文本，而应只处理标准 machine event。

实现建议：

- 若 `assistant.final.media` 存在，先将 descriptor 与这条 final block 绑定
- 再通过对应 bucket + key 下载对象
- 下载失败时，把文本消息保留，并单独标记媒体拉取失败

Lucy 当前每条 `assistant.final` 最多只返回一个媒体对象。若 Agent 产出多个候选，Lucy 只保留第一个受支持的图片或音频，并可能在 `metadata` 中返回：

- `droppedMediaCount`
- `skippedUnsupportedMediaCount`

## 8. 推荐状态机

### 8.1 最小稳定实现

如果你不需要流式预览，只处理以下事件即可：

- `inbound.accepted`
- `assistant.start`
- `tool.start`
- `tool.end`
- `assistant.final`
- `error`

优点是实现简单，基本不会遇到 partial/final 合并问题。

### 8.2 完整流式实现

建议按 `sourceMessageId` 聚合状态：

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

处理规则：

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
    state.activeTools = state.activeTools.filter((name) => name !== evt.toolName);
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

### 8.3 完成判定

Lucy 当前没有单独的 `assistant.done` 事件。更稳妥的完成判定是：

1. 先按 `sourceMessageId` 聚合同一轮事件
2. 至少收到一条 `assistant.final`
3. 再等待一个空闲窗口
4. 若没有新事件，再把这轮对话标记为完成

建议空闲窗口：`1000ms` 到 `2000ms`。

如果 `assistant.final` 缺少 `sourceMessageId`：

1. 不要把它当成非法事件直接忽略
2. 可优先用 `runId` 聚合；若 `runId` 也没有，再退化到 `eventId`
3. 这类消息通常来自工具主动推送或服务端主动发送，不一定对应某条用户入站消息

## 9. 文本清洗与防御性渲染

正常情况下，UI 应以事件类型为准，而不是解析文本标签。只有在需要兼容 provider 或 transcript 泄漏时，才做额外清洗。

常见模式：


| 文本模式                                         | 含义            | 处理建议                             |
| -------------------------------------------- | ------------- | -------------------------------- |
| `[[reply_to_current]]`                       | 回复当前触发消息      | 不直接展示；有引用回复能力时可转成引用目标            |
| `[[reply_to:<messageId>]]`                   | 回复指定消息 id     | 不直接展示；按你的引用模型映射                  |
| `<think>...</think>` 及同类标签                   | 推理块，不属于最终正文   | 单独渲染或直接过滤                        |
| `<final>...</final>`                         | 明示最终回答正文      | 去掉标签，仅保留内部文本                     |
| `<relevant_memories>...</relevant_memories>` | 内部记忆脚手架       | 直接过滤                             |
| `MEDIA: <path-or-url>`                       | Agent 的原始媒体指令 | 不直接消费；等待 `assistant.final.media` |


## 10. TypeScript 最小接入示例

```ts
import { connect, JSONCodec } from "nats";

type InboundMessage = {
  version: 2;
  messageId: string;
  text?: string;
  timestamp?: number;
};

const jc = JSONCodec();

const subjectPrefix = "cephalon.im.npc";
const apiKey = "demo_user";
const deviceId = "1234567890123456789";

const clientSubject = `${subjectPrefix}.${apiKey}.${deviceId}.client`;
const machineSubject = `${subjectPrefix}.${apiKey}.${deviceId}.machine`;

const nc = await connect({
  servers: ["nats://127.0.0.1:4222"],
  token: "YOUR_NATS_TOKEN",
});

const sourceMessageId = "1000000000000000001";

const sub = nc.subscribe(machineSubject);
(async () => {
  for await (const msg of sub) {
    const evt = jc.decode(msg.data) as Record<string, unknown>;
    if (evt.sourceMessageId !== sourceMessageId) continue;
    console.log("machine event:", evt);
  }
})();

const inbound: InboundMessage = {
  version: 2,
  messageId: sourceMessageId,
  text: "你好，做一个三点总结",
  timestamp: Date.now(),
};

nc.publish(clientSubject, jc.encode(inbound));
```

如果需要媒体下载，参考仓库中的 `scripts/demo-chat.ts`，其中的对象存储读写逻辑已经覆盖了上传、下载与 descriptor 组装。

## 11. 调试建议

出现问题时，优先按边界切分：

- 没有 `inbound.accepted`：先查 subject、NATS 鉴权、Gateway 运行状态
- 有 `inbound.accepted` 但没有 assistant 事件：传输层大概率正常，转去检查 OpenClaw 路由、Agent、模型 provider
- 有 `assistant.final` 但文本内容是上游鉴权失败：Lucy 正常，问题在 provider
- 同一条消息重复收到 accepted/final：优先怀疑 Gateway 自动重启导致重复 listener

如果你需要真实时序样例，可查看 `doc/raw-event-sequences.md`。该文档是观测样本，不是 schema 定义；字段版本和表现细节应始终以本指南与当前代码为准。
