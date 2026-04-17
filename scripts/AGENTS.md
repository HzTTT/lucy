<!-- Parent: ../AGENTS.md -->
<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# scripts — Lucy 调试与测试脚本

## 用途

此目录包含 Lucy channel 插件的调试、测试和诊断脚本。详见 `docs/08-operations/debugging.md` 了解完整用法、示例和调试决策树。

## 脚本清单

| 脚本 | 用途 | 运行方式 |
|------|------|--------|
| `e2e-probe.mjs` | 端到端探针：user-center 登录、NATS 连接、4 个测试用例（plain reply、reasoning、tool use、greeting）、验证完整事件链。Lucy 健康检查首选脚本 | `node scripts/e2e-probe.mjs [--server <nats_url>]` |
| `correlation-probe.mjs` | 关联验证：发消息带唯一标签，等待标签在 `assistant.final` 出现。验证消息关联性和排除串扰 | `node scripts/correlation-probe.mjs` |
| `consumer-info.mjs` | 消费者状态：转储 JetStream `IM_NPC` stream 和 `npc-<cdi>` consumer 状态（pending、ack、序列号）。诊断消息积压或卡住的消费者 | `node scripts/consumer-info.mjs` |
| `raw-event-probe.mjs` | Docker 探针：从容器路径读取配置和设备状态，运行 6 个测试用例，输出 JSON 报告 | `node scripts/raw-event-probe.mjs` |
| `print-probe-fields.mjs` | 配置解析：输出运行时探针字段（`channelDeviceId`、`clientSubject`、`machineSubject`、`mediaBucket`）为 JSON | `node scripts/print-probe-fields.mjs` |
| `demo-chat.ts` | 交互式 NATS 聊天客户端，支持媒体上传/下载。直接连接 NATS（user/pass 认证）。用于手工测试和 CI 烟测 | `pnpm exec tsx scripts/demo-chat.ts [--channel-user-key <cuk> ...]` |
| `auth-qrcode.ts` | 绑定 QR 码生成：读本地设备状态，输出 `channel_device_id`、binding URI、终端 QR 码 | `pnpm exec tsx scripts/auth-qrcode.ts --json` |
| `ble-test-flow.py` | BLE 配对流程验证（Python，用于 blue-wifi 测试）| `python3 scripts/ble-test-flow.py` |

## 脚本选择决策树

1. **快速健康检查** → `e2e-probe.mjs`（总是从这里开始）
2. **消息路由正确性** → `correlation-probe.mjs`
3. **消费者积压 / 卡住的消息** → `consumer-info.mjs`
4. **手工交互测试** → `demo-chat.ts`
5. **Docker/容器验证** → `raw-event-probe.mjs`
6. **配置验证** → `print-probe-fields.mjs`
7. **设备绑定** → `auth-qrcode.ts`

## 环境变量

- `LUCY_DEVICE_STATE_PATH`：设备状态根目录（默认 `~/.lucy/identity/`）
- `OPENCLAW_CONFIG_PATH`：OpenClaw 配置目录（默认 `/var/lib/openclaw/` 或 `~/.openclaw/`）
- `NATS_URL`：NATS 服务器地址（默认从 token 接口获取）
- `VITEST`：测试模式标记

## 修改规则

- **凭证读取**：probe 脚本从 `/tmp/lucy-test/identity/channel_ids/` 或 `LUCY_DEVICE_STATE_PATH` 读取 `cdi`、`user_id`、`cuk`，不要硬编码
- **认证路径对齐**：probe 脚本（e2e/correlation/consumer-info）用 user-center 登录 + lucy-server token 交换；demo-chat 和 raw-event-probe 用 NATS direct 认证。修改时保持两条路径一致
- **主题格式约定**：入站 `cephalon.im.npc.<user_id>.<cdi>`，出站 `cephalon.im.user.<user_id>`。改动前同步更新 probe 脚本和 `src/gateway.ts`

---

**参考：** `docs/08-operations/debugging.md`、`docs/09-testing/test-strategy.md`
