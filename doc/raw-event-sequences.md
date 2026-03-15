# Lucy Raw Event Sequences

本文记录当前仍然有效的 Lucy raw event 观察结论。  
如果与历史 `jsonl` 样本冲突，以当前代码和这里的说明为准。

## 1. 当前有效事件形态

当前 Lucy machine event 使用：

- `version = 2`
- `channelUserKey`
- `channelDeviceId`

不要再把旧的：

- `version = 1`
- `apiKey`
- `deviceId`

当成当前权威格式。

## 2. 2026-03-15 实际联通样例

这次真实联通时，直接向绑定后的 Lucy `client` subject 发了一条：

```text
Reply with exactly LUCY_E2E_OK.
```

收到的 machine events 顺序如下：

1. `inbound.accepted`
2. `assistant.start`
3. `reasoning.final`
4. 多条 `assistant.partial`
5. `assistant.final`

### `inbound.accepted`

```json
{
  "version": 2,
  "eventId": "2033178461035806720",
  "type": "inbound.accepted",
  "timestamp": 1773582494397,
  "channelUserKey": "cuk_xxx",
  "channelDeviceId": "2033138771050475520",
  "sourceMessageId": "1773582494346106545",
  "sessionKey": "agent:main:main"
}
```

### `assistant.start`

```json
{
  "version": 2,
  "eventId": "2033178465280442368",
  "type": "assistant.start",
  "timestamp": 1773582495409,
  "channelUserKey": "cuk_xxx",
  "channelDeviceId": "2033138771050475520",
  "sourceMessageId": "1773582494346106545",
  "runId": "4f3ae523-b2d9-424f-bdd9-308c5eb75635",
  "sessionKey": "agent:main:main"
}
```

### `assistant.final`

```json
{
  "version": 2,
  "eventId": "2033178474344333312",
  "type": "assistant.final",
  "timestamp": 1773582497570,
  "channelUserKey": "cuk_xxx",
  "channelDeviceId": "2033138771050475520",
  "sourceMessageId": "1773582494346106545",
  "runId": "4f3ae523-b2d9-424f-bdd9-308c5eb75635",
  "sessionKey": "agent:main:main",
  "text": "LUCY_E2E_OK"
}
```

## 3. 观察结论

- `assistant.partial` 当前发送的是完整快照，不是 token diff
- `reasoning.final` 可能没有 `text`
- `assistant.final` 是真正可提交到 UI 的最终回复块
- `sourceMessageId` 仍然是 App 聚合同一轮回复的主键
- `runId` 适合拿来做同轮执行的调试关联

## 4. 客户端兼容要求

客户端 machine event decoder 至少要兼容这些字段名：

- `channelUserKey`
- `channelDeviceId`
- `sourceMessageId`
- `runId`
- `sessionKey`
- `toolName`

历史兼容可以保留：

- `channel_user_key`
- `channel_device_id`
- `apiKey`
- `deviceId`

但不能只支持旧字段。

旧的 `version = 1` / `apiKey` / `deviceId` 历史抓包样本已经从仓库正文档里清掉，不再保留为参考入口。
