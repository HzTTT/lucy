# Lucy E2E 测试

这些脚本在本地作为 **App 客户端**运行，通过网络连接到远程 `openclaw gateway` 所跑的 Lucy 插件（NPC），验证 App ↔ NPC 的完整链路。脚本通过 JetStream publish 把入站消息写进 `cephalon.im.npc.<user_id>.<cdi>`，然后订阅 `cephalon.im.user.<user_id>` 等 machine event。

## 前置条件

1. 某台服务器（例如 `cephalon@192.168.0.9`）已跑着 `openclaw gateway`，Lucy 插件已完成绑定并 `[lucy] listening on ...`
2. 本地网络能访问 `user-center` / `lucy-server` / `test-chat.lucy.run:4222`
3. 本地已构建 SDK：`cd extensions/lucy/lucy-im-sdk && npm run build`
4. Iroh Blob 原生模块在本地能加载（Mac arm64 已预打包 `index.darwin-arm64.node`）
5. 本地有一份与远程 NPC 一致的 `channel_ids/`（cdi / user_id / cuk）；推荐放在独立的 HOME 目录里以免污染真实家目录

## 使用前配置

在每个脚本顶部按需修改环境：

```js
const UC = "https://test.unicorn.org.cn/cephalon/user-center";
const LS = "https://test.unicorn.org.cn/aiden/lucy-server";
const PHONE = "18888888888";
const PWD = "xxx";
```

脚本（02/03）会从 `LUCY_HOME`（默认 `/var/lib/lucy/identity`）读取 `channel_ids/cdi`、`user_id`、`cuk`。可以用 `LUCY_HOME=` 覆盖到独立目录：

```bash
# 用临时目录种绑定状态（与远程 NPC 对齐）
mkdir -p /tmp/lucy-test/identity/channel_ids
echo -n "<远程的cdi>" > /tmp/lucy-test/identity/channel_ids/cdi
echo -n "<远程的user_id>" > /tmp/lucy-test/identity/channel_ids/user_id
echo -n "<远程的cuk>" > /tmp/lucy-test/identity/channel_ids/cuk
```

## 测试脚本

| 脚本 | 说明 | 预期耗时 |
|------|------|----------|
| `01-bind-flow.mjs` | 完整绑定流程：init → preBind → 登录 → 绑定 → pollBinding → connect | ~10s |
| `02-messaging.mjs` | 消息收发：文本、推理、工具调用、事件序列完整性 | 1-3 min |
| `03-media.mjs` | 媒体传输：Iroh Blob 往返 + App 发图片给 NPC + NPC 发图片给 App | 1-3 min |

## 运行

```bash
cd extensions/lucy

# 单独跑
LUCY_HOME=/tmp/lucy-test/identity npm run test:e2e:msg
LUCY_HOME=/tmp/lucy-test/identity npm run test:e2e:media

# 连跑 02 + 03
LUCY_HOME=/tmp/lucy-test/identity npm run test:e2e

# 首次绑定（用一份空的目录走完整 bind 流程，与 App 登录后扫码对齐）
npm run test:e2e:bind
```

## 关键原则

- **按 `sourceMessageId` 过滤事件**。`cephalon.im.user.<user_id>` 是该用户所有 NPC 回复的聚合通道，多条并发请求的事件会交叉到达。`sendAndCollect` 已按 messageId 做了分流，不要回退到"第一条 assistant.final 就结束"这种简化写法。
- **messageId 要唯一**。固定值的 messageId 会让同一条消息在重启后被 gateway 视作幂等重放。脚本里用的是 `` `23${Date.now()}${counter}` `` 这种带时间戳的方案。
- **远程 gateway 如果卡住或掉线**，先 `ssh <host> "pgrep -f openclaw-gateway | xargs -r kill -USR1"` 重启，再跑测试。
