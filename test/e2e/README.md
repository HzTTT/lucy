# Lucy E2E 测试

这些脚本用于在真实环境中验证 Lucy 插件的完整链路。需要一台已部署 OpenClaw + Lucy 的服务器。

## 前置条件

1. 远程服务器已安装 OpenClaw 和 Lucy 插件
2. 配置好 `channels.lucy.userCenterDomain` 和 `channels.lucy.lucyServerDomain`
3. `lucy-im-sdk` 已构建（`npm run build`）
4. Iroh Blob 原生模块已编译（`cd lucy-im-sdk/lucy-blob/lucy-blob-node-native && npm install && npm run build`）

## 使用前配置

在每个脚本顶部修改环境变量：

```js
const UC = "https://test.unicorn.org.cn/cephalon/user-center";
const LS = "https://test.unicorn.org.cn/aiden/lucy-server";
const PHONE = "18888888888";
const PWD = "xxx";
```

## 测试脚本

| 脚本 | 说明 | 预期耗时 |
|------|------|----------|
| `01-bind-flow.mjs` | 完整绑定流程：init → preBind → 登录 → 绑定 → pollBinding → connect | 10s |
| `02-messaging.mjs` | 消息收发：文本、推理、工具调用 | 90s |
| `03-media.mjs` | 媒体传输：Iroh Blob 往返 + App 发图片给 NPC + NPC 发图片给 App | 60s |

## 运行

```bash
# 在远程服务器上运行（需要在 Lucy 插件目录下）
cd ~/.openclaw/extensions/lucy
node test/e2e/01-bind-flow.mjs
node test/e2e/02-messaging.mjs
node test/e2e/03-media.mjs
```

或从本地 SSH 运行：

```bash
ssh user@host "cd ~/.openclaw/extensions/lucy && node test/e2e/01-bind-flow.mjs"
```
