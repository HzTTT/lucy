<!-- Parent: ../AGENTS.md -->
<!-- 最后核对：代码版本 ai-npc@2026-04-22，以 src/ 为事实源 -->

# scripts — Lucy 调试与测试脚本

## 用途

此目录包含 Lucy channel 插件的调试、测试和诊断脚本。详见 `docs/08-operations/debugging.md` 了解完整用法、示例和调试决策树。

所有 NATS 相关 probe 都用 **user-side 客户端模拟路径**（user-center 密码登录 → lucy-server 申请 user-side NATS token → NATS core sub 出站 / JetStream pub 入站）。NPC-side 凭证只属于 gateway 本身，外部脚本不要复用 — 二次申请 token 会被 lucy-server 以 `数据库服务异常` 拒绝。

## 脚本清单

| 脚本 | 用途 | 运行方式 |
|------|------|--------|
| `assistant-complete-probe.ts` | **协议契约验证（推荐入口）**：模拟 user-side 客户端发一条入站消息，订阅完整出站事件流，验证 `assistant.complete` 是最后一个事件、唯一一个，并核对 `sourceMessageId` / `runId` 链路 | `pnpm exec tsx scripts/assistant-complete-probe.ts` |
| `e2e-probe.mjs` | 端到端探针：6 个内置测试用例（plain reply、reasoning、tool use、长流式、错误分支等），独立 home `/tmp/lucy-test/identity/`，输出每个用例的 stop 原因和事件计数 | `node scripts/e2e-probe.mjs` |
| `correlation-probe.mjs` | 关联性验证：同一 inbound 的事件必须共享 `source_message_id`，发不同 prompt 验证排除串扰 | `node scripts/correlation-probe.mjs` |
| `consumer-info.mjs` | JetStream 消费者状态：转储 stream `IM_NPC` 和 durable `npc-<cdi>` 的 pending、ack、序列号，诊断消息积压或卡住的消费者 | `node scripts/consumer-info.mjs` |
| `print-probe-fields.mjs` | 配置解析：输出运行时探针字段（`channelDeviceId`、`clientSubject`、`machineSubject`、`mediaBucket`）为 JSON | `node scripts/print-probe-fields.mjs` |
| `auth-qrcode.ts` | 绑定 QR 码生成：读本地设备状态，输出 `channel_device_id`、binding URI、终端 QR 码 | `pnpm exec tsx scripts/auth-qrcode.ts --json` |
| `ble-test-flow.py` | BLE 配对流程验证（Python，用于 blue-wifi 测试）| `python3 scripts/ble-test-flow.py` |

## 脚本选择决策树

1. **协议契约 / `assistant.complete` 收尾验证** → `assistant-complete-probe.ts`
2. **多用例端到端冒烟** → `e2e-probe.mjs`
3. **消息关联性 / 串扰** → `correlation-probe.mjs`
4. **消费者积压 / 卡住的消息** → `consumer-info.mjs`
5. **配置字段验证** → `print-probe-fields.mjs`
6. **设备绑定 QR** → `auth-qrcode.ts`

## `assistant-complete-probe.ts` 推荐使用流程

1. 确认 gateway 已绑定：`ls ~/.lucy/identity/channel_ids/` 应有 `cdi`、`cuk`、`user_id`
2. 确认 gateway 与 probe 用同一环境（默认 test）。若 gateway 在 prod 环境运行，要么把 gateway 的 `channels.lucy.userCenterDomain` 和 `lucyServerDomain` 改成 prod，要么用 env var 让 probe 走 prod
3. 直接跑：`pnpm exec tsx scripts/assistant-complete-probe.ts`
4. 期望尾部输出 `VERDICT: PASS - exactly 1 assistant.complete is the LAST event`

支持的环境变量（不传则用默认值）：

```bash
LUCY_PROBE_USER_CENTER=https://test.unicorn.org.cn/cephalon/user-center
LUCY_PROBE_LUCY_SERVER=https://test.unicorn.org.cn/aiden/lucy-server
LUCY_PROBE_PHONE=19999999999     # test 环境账号
LUCY_PROBE_PWD=a123456
LUCY_PROBE_PROMPT="Reply with exactly one word: PROBE_OK"
LUCY_PROBE_WAIT_MS=90000         # 整体超时
LUCY_PROBE_CLIENT_ID=assistant-complete-probe   # NATS user-side token client_id
LUCY_IM_HOME_DIR=~/.lucy/identity                # 读 cdi / user_id 的目录
```

## 共享约定

- **凭证读取路径**：probe 脚本默认从 `~/.lucy/identity/channel_ids/` 读 `cdi`、`user_id`、`cuk`，与 gateway 共享同一身份；CI 用的 `e2e-probe.mjs` / `correlation-probe.mjs` / `consumer-info.mjs` 用隔离的 `/tmp/lucy-test/identity/` 不污染本机
- **认证路径对齐**：所有 probe 走 user-side login → lucy-server `/v1/channels/lucy/nats/token/user` → NATS token auth；不要再用 user/pass NATS 直连（旧协议已删）
- **主题格式**：入站 `cephalon.im.npc.<user_id>.<cdi>`（JetStream pub），出站 `cephalon.im.user.<user_id>`（core sub）。改动前同步更新 probe 脚本和 `src/gateway.ts` / `src/nats.ts`
- **`assistant.complete` 契约**：每个 inbound run 必须以恰好 1 个 `assistant.complete` 收尾；无论 happy path、block error、还是 fatal dispatcher throw，都不会有任何事件出现在 complete 之后

## 历史脚本

以下脚本已删除（旧 `user/pass` NATS 认证 + 旧 `.client/.machine` 主题，无法连接当前生产 NATS）：

- `demo-chat.ts`：交互式 NATS 聊天客户端，依赖已经被删的 `connectLucyNatsWithOptions`
- `raw-event-probe.mjs`：Docker 容器路径 + 旧主题命名

如果要做"模拟 App 主动发消息"，用 `assistant-complete-probe.ts`（自带 LUCY_PROBE_PROMPT 入口）。

---

**参考：** `docs/08-operations/debugging.md`、`docs/09-testing/test-strategy.md`
