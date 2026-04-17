<!-- 最后核对：代码版本 ai-npc@2026-04-16，以 src/ 为事实源 -->

# 执行审批

## 概述

Lucy 通过执行审批机制为 OpenClaw 的高危命令（例如系统调用、代码执行）提供用户确认流程。当 OpenClaw runtime 需要执行受限命令时，Lucy 拦截并转换为 `approval.pending` 机器事件发给 App，用户选择后再由 runtime 继续执行。

审批事件流程图参见 [审批事件 pending → applied](../01-overview/diagrams.md#diagram-exec-approval)。

---

## 架构与职责

### Handler：LucyExecApprovalHandler

位置：`src/exec-approvals-handler.ts:50`

Lucy 的审批 Handler 实现 OpenClaw 的 `OperatorApprovalsHandler` 接口，监听以下事件：

- `exec.approval.requested` — 需要审批的高危命令
- `exec.approval.resolved` — 用户决定或超时

**关键实现：** Handler 的延迟加载

```typescript
const createOperatorApprovalsGatewayClient()
```

位置：`src/exec-approvals-handler.ts`（搜索该函数名）

**为什么延迟加载？** 支持旧版 OpenClaw（< 0.1.90）不包含 operator-approvals 控制面。Lucy 在启动时检查宿主是否提供该功能，如果不提供则优雅降级（无审批功能）。

---

## 审批流程详解

### 1. 审批请求到达

当 OpenClaw runtime 执行受限命令时，`operator-approvals` 控制面发出：

```typescript
{
  type: "exec.approval.requested",
  id: string,                // 审批唯一 ID（UUID）
  expiresAtMs: number,       // 过期时间戳
  request: {
    command: string,         // 完整命令行
    cwd?: string,           // 工作目录
    host: string,           // 执行主机名
    // ... 其他字段
  }
}
```

### 2. Handler 清理与转换

`LucyExecApprovalHandler.onApprovalRequested()` 接收事件后：

**步骤 1：** 清理命令文本

```typescript
resolveExecApprovalCommandDisplay(request.command)
```

位置：`src/exec-approval-helpers.ts`（搜索该函数名）

**作用：** 去掉不可见字符（控制字符、ANSI 转义码），确保 App 能正确显示。

**步骤 2：** 生成审批 slug

```typescript
const approvalSlug = approvalId.substring(0, 8);
```

用于 App 向 runtime 回复时使用 `/approve <slug> <decision>` 命令。

**步骤 3：** 构造待审批回复

```typescript
buildExecApprovalPendingReplyPayload({
  approvalId,
  command: cleanedCommand,
  host: request.host,
  cwd: request.cwd,
  expiresAtMs: request.expiresAtMs
})
```

位置：`src/exec-approval-helpers.ts`

**返回值：** `ReplyPayload` 对象，包含：

```typescript
{
  text: string,            // 用户可读的审批提示
  channelData?: {
    execApproval: {
      approvalId: string,
      approvalSlug: string,
      command: string,
      host: string,
      expiresAtMs: number
    }
  }
}
```

### 3. 发送 approval.pending 机器事件

Handler 通过 `publishLucyMachineEvent()` 发送：

```typescript
{
  type: "approval.pending",
  approvalId: string,
  approvalSlug: string,
  approvalCommand: string,      // 清理后的命令
  approvalHost: string,
  approvalCwd?: string,
  approvalExpiresAtMs: number,
  approvalAllowedDecisions: ["allow-once", "allow-always", "deny"]
}
```

**代码位置：** `src/exec-approvals-handler.ts:50`

### 4. App 用户交互

App 在 UI 中：
- 弹出审批气泡
- 显示命令、主机、工作目录、过期时间
- 提供三个按钮：Allow Once / Allow Always / Deny

用户选择后，App 通过 OpenClaw 的控制面 API 下发决定：

```
runtime.resolveExecApproval({
  id: approvalId,
  decision: "allow-once" | "allow-always" | "deny"
})
```

### 5. 审批结果回复

Runtime 处理用户决定后发出：

```typescript
{
  type: "exec.approval.resolved",
  id: string,                // 审批 ID
  decision: string,          // "allow-once" | "allow-always" | "deny"
  resolvedBy?: string        // 用户 ID 或 "timeout"
}
```

### 6. Handler 发送 approval.resolved 机器事件

Handler 接收 `exec.approval.resolved` 后：

```typescript
{
  type: "approval.resolved",
  approvalId: string,
  approvalDecision: string,  // "allow-once" | "allow-always" | "deny" | "timeout"
  approvalResolvedBy?: string
}
```

**代码位置：** `src/exec-approvals-handler.ts`（搜索 approval.resolved）

---

## 机器事件参考

### approval.pending

**含义：** 有待审批的高危命令。

**字段（完整）：**

```typescript
{
  version: 2,
  eventId: string,                    // 事件 ID
  type: "approval.pending",
  timestamp: number,
  channelUserKey: string,             // cuk
  channelDeviceId: string,            // cdi
  
  // 审批特定字段
  approvalId: string,                 // UUID 格式
  approvalSlug: string,               // approvalId 前 8 位
  approvalCommand: string,            // 清理后的命令行
  approvalHost: string,               // 执行主机
  approvalCwd?: string,               // 工作目录
  approvalExpiresAtMs: number,        // Unix 时间戳（ms）
  approvalAllowedDecisions: [
    "allow-once",
    "allow-always",
    "deny"
  ]
}
```

**App 消费方式：**
1. 解析 JSON 得到 `approvalId` 和 `approvalCommand`
2. 显示审批气泡，提示用户确认
3. 用户选择后，通过 OpenClaw runtime 下发决定

### approval.resolved

**含义：** 审批已解决。

**字段（完整）：**

```typescript
{
  version: 2,
  eventId: string,
  type: "approval.resolved",
  timestamp: number,
  channelUserKey: string,
  channelDeviceId: string,
  
  approvalId: string,
  approvalDecision: string,           // "allow-once" | "allow-always" | "deny" | "timeout"
  approvalResolvedBy?: string         // 用户 ID 或空
}
```

**App 消费方式：**
1. 匹配 `approvalId` 找到对应的待审批气泡
2. 标记气泡为"已处理"
3. 如果 `approvalDecision` 为 "deny"，显示拒绝提示

---

## 文本提示生成

### buildExecApprovalPendingReplyPayload()

位置：`src/exec-approval-helpers.ts`

**输入参数：**

```typescript
{
  approvalId: string,
  command: string,
  host: string,
  cwd?: string,
  expiresAtMs: number
}
```

**输出示例：**

```
审批需求：执行命令

命令：python script.py --verbose
主机：prod-server-01
目录：/opt/app

此审批请求将在 2026-04-16T12:30:00Z 过期

请选择：
  /approve <approvalSlug> allow-once     # 仅此次允许
  /approve <approvalSlug> allow-always   # 总是允许
  /approve <approvalSlug> deny           # 拒绝
```

### resolveExecApprovalCommandDisplay()

位置：`src/exec-approval-helpers.ts`

**作用：** 清理命令行中的不可见字符。

**处理示例：**

```
输入：  "python\x1b[32mscript.py\x1b[0m --verbose"
       (ANSI 颜色转义码)

输出：  "python script.py --verbose"
```

---

## 超时与降级

### 超时处理

如果用户在 `expiresAtMs` 之前未作出选择，runtime 自动发出：

```typescript
{
  type: "exec.approval.resolved",
  id: approvalId,
  decision: "timeout",
  resolvedBy: undefined
}
```

Lucy Handler 转换为：

```typescript
{
  type: "approval.resolved",
  approvalId,
  approvalDecision: "timeout"
}
```

App 可选择显示"审批超时，命令被拒绝"提示。

### 旧版 OpenClaw 兼容

如果宿主不支持 `operator-approvals` 控制面：

```typescript
const clientOrNull = await createOperatorApprovalsGatewayClient();
if (!clientOrNull) {
  // 旧版 OpenClaw，跳过审批注册
  return;
}
```

Lucy 无法监听审批事件，但不会崩溃。用户可手动通过其他渠道确认。

---

## 配置参考

Lucy 的审批功能不需要额外配置。审批由 OpenClaw runtime 的 `operator-approvals` 控制面驱动，Lucy 仅作为 transport 层。

相关 OpenClaw 配置键（不在 Lucy 控制范围内）：

| 配置键 | 说明 |
|--------|------|
| `hooks.internal.entries.operator-approvals` | 启用审批功能 |
| `agents.defaults.approvalPolicy` | 审批策略 |

---

## 故障排查

### 审批消息未到达 App

**可能原因：**

1. OpenClaw 版本过旧（< 0.1.90）—— 无 `operator-approvals` 支持
2. Lucy Handler 注册失败 —— 查看网关日志 `ERROR` 级别

**排查步骤：**

```bash
# 查看网关是否加载 Lucy 插件
openclaw channels status --probe

# 查看日志中是否有 approval 相关错误
openclaw gateway logs --tail=100 | grep -i approval
```

### App 无法下发审批决定

**可能原因：**

1. App 使用的 runtime API 版本不匹配
2. 审批已超时

**排查步骤：**

1. 检查 App 是否正确使用了 runtime 的 `resolveExecApproval()` API
2. 在 `approval.pending` 事件中检查 `approvalExpiresAtMs` 确认未超时

---

## 相关文档

- [机器事件字典](./machine-events.md#approval-events) — approval.pending / approval.resolved 字段详解
- [流程图](../01-overview/diagrams.md#diagram-exec-approval) — Mermaid 时序图
