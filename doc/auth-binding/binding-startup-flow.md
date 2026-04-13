# Lucy 绑定与启动：完整流程

## 阶段一：设备注册（一次性）

```
LucyImClient.init()
  │
  ├─ 本地生成 Ed25519 密钥对（持久化到 /var/lib/lucy/identity/bootstrap_token/）
  ├─ POST user-center /v1/devices/new { public_key }
  └─ 获得 cdi（channel_device_id），持久化到 /var/lib/lucy/identity/channel_ids/cdi
```

这一步幂等——已有 cdi 就跳过。

## 阶段二：OTP 发放 + 用户绑定

OTP 发放和 gateway 启动是两个独立进程，必须协同工作：

```
┌─────────────────────────────────┐    ┌──────────────────────────────────┐
│  进程 A: Gateway 启动            │    │  进程 B: OTP 发放（二选一）        │
│                                 │    │                                  │
│  startLucyGateway()             │    │  方式 1: 用户手动执行              │
│    │                            │    │  openclaw lucy auth-qrcode       │
│    ├─ syncLucyBindingWithSdk()  │    │    │                             │
│    │   ├─ client.init()         │    │    ├─ imClient.preBind()         │
│    │   │   → PendingBind        │    │    │   → POST lucy-server        │
│    │   │                        │    │    │     /v1/.../pre-bind         │
│    │   ├─ onPendingBind()       │    │    │   → { otp, expires_in }     │
│    │   │   → 启动 Pairing IPC   │    │    │                             │
│    │   │     (若配了 socket)     │    │    └─ 生成 QR:                   │
│    │   │                        │    │       lucy://bind?cdi=x&otp=y    │
│    │   └─ pollBinding() 循环    │    │                                  │
│    │       每 2s 查一次          │    │  方式 2: BLE 自动触发             │
│    │       getDeviceBinding()   │    │  blue-wifi → IPC bind.request    │
│    │       等待绑定完成...       │    │    → preBind() → otp.issued     │
│    │       ⏳ 阻塞中            │    │    → BLE 暴露给 iOS              │
│    │                            │    │                                  │
└────┼────────────────────────────┘    └──────────────────────────────────┘
     │
     │  iOS 客户端拿到 cdi + otp → 调 user-center bind API → 绑定完成
     │
     ▼  pollBinding() 检测到 bound → 持久化 cuk + user_id → 返回
```

**关键约束**：如果进程 B 没有发生（没配 BLE，用户也没执行 auth-qrcode），进程 A 会永远阻塞。

## 阶段三：NATS 连接

```
connectLucySdk()
  │
  ├─ 用 Ed25519 签名 { cdi, kind, nonce, ts, cuk }
  ├─ POST lucy-server /v1/.../nats/token/npc
  │   Body: { cdi, device_type, nonce, ts, sign }
  │   → 获取 NATS token + nats_url
  └─ 连接 NATS，启动 JetStream + 存活检测
```

其中 `kind` / `device_type` 是设备类型标识（`"lucy"` | `"nas"` | 自定义），决定服务端分配的 NATS 权限和 JetStream stream 配置。`cuk` 参与签名但不包含在请求体中。

## 阶段四：消息收发

```
订阅: cephalon.im.npc.<user_id>.<cdi>     ← iOS 发来的用户消息
发布: cephalon.im.user.<user_id>           ← 机器事件（assistant.*, tool.*, error 等）
```

## 整体生命周期一图总结

```
设备注册 ──→ 等待绑定（阻塞）──→ NATS 连接 ──→ 消息收发
  init()    syncBinding+poll     connect()    subscribe+publish
   │              │                  │              │
   │         需要外部触发 OTP:        │         自愈重连:
   │         · CLI auth-qrcode      │         · SDK 层 10 次
   │         · BLE pairing IPC      │         · Gateway 层无限次
   │                                │         · OpenClaw 框架兜底
   ▼              ▼                  ▼              ▼
 一次性        用户参与必需         自动完成       持续运行
```

- **绑定是整个流程中唯一需要人工参与的环节。** 之前和之后的所有步骤（注册、连接、消息收发、断线重连）都是全自动的。
- **绑定状态是持久的。** `cuk` 和 `user_id` 写入本地磁盘后，后续 gateway 重启走 `init()` → `Ready` 路径，直接跳过阶段二进入 NATS 连接，不再需要 OTP。
- **`reset-state` 是唯一的回退手段。** 执行后删除密钥对、cdi、cuk、user_id，整个流程从阶段一重新开始。
