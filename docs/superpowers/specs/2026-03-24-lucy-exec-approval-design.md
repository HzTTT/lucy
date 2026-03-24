# Lucy Exec Approval Support

**Date:** 2026-03-24
**Status:** Approved
**Scope:** `extensions/lucy` (TypeScript plugin) + `LucyIOSDemo` (Swift iOS app)

---

## Problem

When an OpenClaw agent running over Lucy triggers a shell command that requires exec approval, the system returns:

> "Exec approval is required, but Lucy does not support chat exec approvals."

This happens because `lucyPlugin` in `extensions/lucy/src/channel.ts` has no `execApprovals` adapter. Telegram and Discord both implement this adapter; Lucy does not. The user must switch to a different client (Web UI, terminal, Telegram) to approve the command.

---

## Goal

Allow Lucy users on iOS to approve or deny exec requests directly from the app, with native UI — no context switching required.

---

## Non-Goals

- Changes to `npc-im-server/auth-callout` (confirmed not needed — auth-callout is a connection-time gatekeeper only, subject permissions already cover the approval response path)
- Support for group/channel approvals (Lucy is DM-only)
- Approval history or audit log in the iOS app

---

## Architecture

### Key Design Point: Handler vs. Adapter

OpenClaw's exec approval system has **two separate integration points**:

1. **`LucyExecApprovalHandler`** (new class, like `TelegramExecApprovalHandler`) — listens on the OpenClaw gateway event bus via `createOperatorApprovalsGatewayClient`. Receives `exec.approval.requested` and `exec.approval.resolved` events and directly publishes the corresponding NATS machine events. This is the **primary publication path**.

2. **`execApprovals` adapter** on `lucyPlugin` — registers Lucy as an approval-capable channel for the forwarding path. The `buildPendingPayload` / `buildResolvedPayload` methods build `ReplyPayload` objects used when the forwarder routes approvals to Lucy via the standard outbound delivery path.

Both are needed. The handler covers the primary case (approval triggered by a Lucy session). The adapter covers forwarding fallbacks from other channels.

### Flow

```
Agent executes shell command
  → OpenClaw gateway emits exec.approval.requested event
  → LucyExecApprovalHandler.handleRequested()
  → publishLucyMachineEvent({ type: "approval.pending", approvalId, ... })
  → iOS receives event, checks expiresAtMs > now
  → if expired: discard silently (not shown)
  → if valid: show LucyApprovalCard in matching conversation
  → user taps button (允许一次 / 始终允许 / 拒绝)
  → LucyAppModel.sendApprovalDecision() publishes:
     {version:2, text:"/approve <id> <decision>"} to client subject
  → gateway.ts handleLucyInboundMessage() processes it
     (CommandAuthorized: true already set in buildInboundContext)
  → /approve command handler calls exec.approval.resolve on gateway
  → gateway emits exec.approval.resolved event
  → LucyExecApprovalHandler.handleResolved()
  → publishLucyMachineEvent({ type: "approval.resolved", approvalId, decision, ... })
  → iOS receives event, removes approval card from conversation
```

---

## TypeScript Changes

### `extensions/lucy/src/types.ts`

Add two new machine event types:

```typescript
"approval.pending"   // handler → iOS: approval request
"approval.resolved"  // handler → iOS: approval decision made
```

Add optional approval fields to `LucyMachineEventSchema` (all `z.string().optional()` / `z.number().optional()` / `z.array(z.string()).optional()`):

| Field | Type | Purpose |
|-------|------|---------|
| `approvalId` | `string` | Full approval ID for `/approve` command |
| `approvalSlug` | `string` | Short display ID |
| `approvalCommand` | `string` | Shell command awaiting approval |
| `approvalCwd` | `string` | Working directory |
| `approvalHost` | `string` | `"gateway"` or `"node"` |
| `approvalExpiresAtMs` | `number` | Expiry timestamp (ms) |
| `approvalAllowedDecisions` | `string[]` | `["allow-once","allow-always","deny"]` |
| `approvalDecision` | `string` | Decision (resolved events only) |
| `approvalResolvedBy` | `string` | Who approved (resolved events only) |

All fields optional; existing `sessionKey` field (already on the schema) is reused for conversation matching on iOS — no new `approvalSessionKey` field needed.

### New file: `extensions/lucy/src/exec-approvals-handler.ts`

Mirrors the pattern of `extensions/telegram/src/exec-approvals-handler.ts`.

```typescript
import { createOperatorApprovalsGatewayClient, GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import type { EventFrame } from "openclaw/plugin-sdk/gateway-runtime";
import {
  resolveExecApprovalCommandDisplay,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { NatsConnection } from "nats";
import { publishLucyMachineEvent } from "./send.js";
import type { ResolvedLucyAccount } from "./types.js";

export class LucyExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private started = false;

  constructor(
    private readonly cfg: OpenClawConfig,        // required by createOperatorApprovalsGatewayClient
    private readonly account: ResolvedLucyAccount,
    private readonly deviceId: string,
    private readonly connection: NatsConnection,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.gatewayClient = await createOperatorApprovalsGatewayClient({
      config: this.cfg,                           // mandatory param
      clientDisplayName: `Lucy Exec Approvals (${this.account.accountId})`,
      onEvent: (evt) => this.handleGatewayEvent(evt),
      onConnectError: (err) => {
        console.error(`[lucy] exec approvals connect error: ${String(err)}`);
      },
    });
    this.gatewayClient.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.gatewayClient?.stop();
    this.gatewayClient = null;
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      void this.handleRequested(evt.payload as ExecApprovalRequest);
    } else if (evt.event === "exec.approval.resolved") {
      void this.handleResolved(evt.payload as ExecApprovalResolved);
    }
  }

  private async handleRequested(request: ExecApprovalRequest): Promise<void> {
    const commandDisplay = resolveExecApprovalCommandDisplay(request.request);
    await publishLucyMachineEvent({
      account: this.account,
      connection: this.connection,
      deviceId: this.deviceId,
      type: "approval.pending",
      sessionKey: request.request.sessionKey ?? undefined,
      approvalId: request.id,
      approvalSlug: request.id.slice(0, 8),
      approvalCommand: commandDisplay.commandText,
      approvalCwd: request.request.cwd ?? undefined,
      // Coerce "sandbox" to "gateway" — Lucy runs no sandbox host.
      approvalHost: request.request.host === "node" ? "node" : "gateway",
      approvalExpiresAtMs: request.expiresAtMs,
      approvalAllowedDecisions: ["allow-once", "allow-always", "deny"],
    });
  }

  private async handleResolved(resolved: ExecApprovalResolved): Promise<void> {
    await publishLucyMachineEvent({
      account: this.account,
      connection: this.connection,
      deviceId: this.deviceId,
      type: "approval.resolved",
      approvalId: resolved.id,
      approvalDecision: resolved.decision,
      approvalResolvedBy: resolved.resolvedBy ?? undefined,
    });
  }
}
```

`publishLucyMachineEvent` (in `send.ts`) also needs the new approval fields added to its params type.

### `extensions/lucy/src/gateway.ts`

In `startLucyGateway()`, after establishing the NATS connection (`ctx.cfg` is available in the gateway context):

```typescript
const approvalHandler = new LucyExecApprovalHandler(ctx.cfg, boundAccount, deviceState.channelDeviceId, connection);
await approvalHandler.start();

// Add to stop():
approvalHandler.stop();
```

### `extensions/lucy/src/channel.ts`

Add `execApprovals` adapter to `lucyPlugin`. This covers the forwarding path (when the forwarder routes approvals to Lucy via `deliverOutboundPayloads`).

Required imports in `channel.ts`:
```typescript
import {
  buildExecApprovalPendingReplyPayload,
  getExecApprovalReplyMetadata,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/infra-runtime";
```

```typescript
execApprovals: {
  getInitiatingSurfaceState: ({ cfg, accountId }) =>
    resolveLucyAccount(cfg, accountId).configured
      ? { kind: "enabled" }
      : { kind: "disabled" },

  hasConfiguredDmRoute: ({ cfg }) =>
    Boolean(resolveLucyAccount(cfg).configured),

  shouldSuppressLocalPrompt: ({ payload }) =>
    getExecApprovalReplyMetadata(payload) !== null,

  shouldSuppressForwardingFallback: ({ cfg, target }) =>
    target.channel === "lucy" && resolveLucyAccount(cfg).configured,

  buildPendingPayload: ({ cfg, request, target, nowMs }) =>
    buildExecApprovalPendingReplyPayload({
      approvalId: request.id,
      approvalSlug: request.id.slice(0, 8),
      approvalCommandId: request.id,
      command: resolveExecApprovalCommandDisplay(request.request).commandText,
      cwd: request.request.cwd ?? undefined,
      host: request.request.host === "node" ? "node" : "gateway",
      nodeId: request.request.nodeId ?? undefined,
      expiresAtMs: request.expiresAtMs,
      nowMs,
    }),
    // Returns a ReplyPayload with channelData.execApproval set.
    // The standard outbound.sendText path delivers this as an assistant.final
    // text message. The iOS app will show it as plain text fallback if
    // the approval.pending NATS event was not received.

  buildResolvedPayload: ({ cfg, resolved, target }) => ({
    text: `✅ 执行审批已${resolved.decision === "deny" ? "拒绝" : "通过"}`,
  }),
},
```

Note: `cfg` and `target` are included in all adapter callbacks to match the `ChannelExecApprovalAdapter` SDK interface.

---

## iOS Changes

### `LucyModels.swift`

**Fix `LucyMachineEventType` unknown-case handling (pre-existing issue, fix in this PR):**

Add `case unknown` with custom `init(from:)` so unknown event types don't cause decode failures:

```swift
enum LucyMachineEventType: String, Codable, CaseIterable, Identifiable {
    case inboundAccepted = "inbound.accepted"
    case assistantStart = "assistant.start"
    case assistantPartial = "assistant.partial"
    case assistantFinal = "assistant.final"
    case reasoningPartial = "reasoning.partial"
    case reasoningFinal = "reasoning.final"
    case toolStart = "tool.start"
    case toolEnd = "tool.end"
    case error
    case approvalPending = "approval.pending"
    case approvalResolved = "approval.resolved"
    case unknown = "__unknown__"  // catch-all for future/unknown types; avoid "unknown" to prevent collision

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LucyMachineEventType(rawValue: raw) ?? .unknown
    }
}
```

`LucyReplyState.apply(event:)` must add `case .unknown: break` and `case .approvalPending`, `case .approvalResolved` cases.

**New `LucyApprovalState` struct:**
```swift
struct LucyApprovalState: Codable, Equatable, Identifiable {
    let approvalId: String
    let approvalSlug: String
    let approvalCommand: String?
    let approvalCwd: String?
    let approvalHost: String?
    let approvalExpiresAtMs: Int64?
    // Default to all three decisions if the field is absent from the wire event.
    let allowedDecisions: [String]  // default: ["allow-once", "allow-always", "deny"]
    var resolvedDecision: String?
    var resolvedBy: String?
    var id: String { approvalId }
}
```

**`LucyMachineEvent` additions:**
Add all approval fields as optional (`decodeIfPresent`):
`approvalId`, `approvalSlug`, `approvalCommand`, `approvalCwd`, `approvalHost`, `approvalExpiresAtMs`, `approvalAllowedDecisions: [String]?`, `approvalDecision`, `approvalResolvedBy`

Note: conversation matching uses the existing `sessionKey` field — no new `approvalSessionKey` needed.

**`LucyReplyState` additions:**
```swift
var pendingApprovals: [LucyApprovalState] = []
```

In `apply(event:)`:
- `.approvalPending` → build `LucyApprovalState` from event fields, append to `pendingApprovals`; if `approvalAllowedDecisions` is nil on the wire, default to `["allow-once", "allow-always", "deny"]`
- `.approvalResolved` → find matching approval by `approvalId`, set `resolvedDecision`
- `.unknown` → `break` (no-op)

**Computed property on `LucyConversation`:**
```swift
var activePendingApprovals: [LucyApprovalState] {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    return replyState.pendingApprovals.filter { approval in
        approval.resolvedDecision == nil &&
        (approval.approvalExpiresAtMs.map { $0 > now } ?? true)
    }
}
```

Expired and resolved approvals are filtered at render time. Known limitation: in a `LazyVStack`, off-screen conversations are not re-rendered — expired approvals in non-visible conversations remain in the model until the user scrolls back. This is accepted as a minor edge case since approvals time out server-side regardless.

### `LucyRootView.swift`

**`conversationIdentifier(for:)` additions:**
```swift
case .approvalPending, .approvalResolved:
    // 1. Match by sessionKey (existing field, set on approval events from handler)
    if let sessionKey = event.sessionKey,
       let match = conversations.last(where: { $0.replyState.sessionKey == sessionKey }) {
        return match.id
    }
    // 2. Attach to last incomplete conversation
    if let open = conversations.last(where: { !$0.isComplete }) {
        return open.id
    }
    // 3. Create orphan conversation
    return "orphan-approval:\(event.approvalId ?? event.eventId)"
```

**`consume(event:)` additions:**
- Handle `.approvalPending` and `.approvalResolved` without triggering `scheduleCompletion`

**New `LucyAppModel.sendApprovalDecision()`:**
```swift
func sendApprovalDecision(approvalId: String, decision: String) {
    let text = "/approve \(approvalId) \(decision)"
    let messageID = LucyMessageIDGenerator.next()
    // Optimistically mark as resolved in local state
    for i in conversations.indices {
        if let idx = conversations[i].replyState.pendingApprovals.firstIndex(where: { $0.approvalId == approvalId }) {
            conversations[i].replyState.pendingApprovals[idx].resolvedDecision = decision
        }
    }
    // Publish silently — no new conversation entry
    Task { [weak self] in
        guard let self else { return }
        do {
            try await session.publishInbound(
                config: config,
                messageID: messageID,
                text: text,
                attachment: nil
            )
        } catch {
            // Surface error to user if publish fails
            withAnimation(.easeOut(duration: 0.22)) {
                errorText = "审批发送失败：\(error.localizedDescription)"
            }
            // Revert optimistic state
            for i in conversations.indices {
                if let idx = conversations[i].replyState.pendingApprovals.firstIndex(where: { $0.approvalId == approvalId }) {
                    conversations[i].replyState.pendingApprovals[idx].resolvedDecision = nil
                }
            }
        }
    }
}
```

Error is surfaced to user (same pattern as the existing `errorText` banner). Optimistic removal is reverted on failure.

### `LucyRedesignedRootScene.swift`

**New `LucyApprovalCard` view:**

```
┌─────────────────────────────────────┐
│ 🔐 需要执行权限                       │
│                                     │
│  $ rm -rf /tmp/build                │
│  Host: gateway · CWD: /home/user    │
│                                     │
│  [允许一次]  [始终允许]  [拒绝]       │
└─────────────────────────────────────┘
```

- Styled consistent with `LucyToolTraceBlock` (same background, radius, palette)
- Command text in monospace font
- Buttons: allow-once = accent color, allow-always = accent color, deny = destructive color
- On tap: call `onApprove(approvalId, decision)` — optimistic removal handled in `sendApprovalDecision()`

**Integration in `LucyThreadRowView`:**
- Add `onApprove: (String, String) -> Void` closure parameter
- In `assistantCluster`, before `ForEach(renderItems)`:
  ```swift
  ForEach(conversation.activePendingApprovals) { approval in
      LucyApprovalCard(approval: approval) { decision in
          onApprove(approval.approvalId, decision)
      }
  }
  ```

**In `LucyRedesignedRootScene`:**
```swift
LucyThreadRowView(
    conversation: conversation,
    reduceMotion: reduceMotion,
    onApprove: { approvalId, decision in
        model.sendApprovalDecision(approvalId: approvalId, decision: decision)
    }
)
```

---

## Testing

### TypeScript

- `extensions/lucy/src/gateway.test.ts`:
  - `LucyExecApprovalHandler.handleRequested()` publishes `approval.pending` NATS event with correct fields
  - `LucyExecApprovalHandler.handleResolved()` publishes `approval.resolved` NATS event with decision
  - Handler's `start()` / `stop()` lifecycle correctly creates and tears down the gateway client
- `extensions/lucy/src/channel.test.ts`:
  - `execApprovals.getInitiatingSurfaceState` returns `enabled` for configured account, `disabled` for unconfigured
  - `execApprovals.buildPendingPayload` returns payload with `channelData.execApproval` set

### iOS (`LucyIOSDemoFeatureTests`)

- `LucyApprovalState` decode/encode round-trip
- `activePendingApprovals` filters expired approvals (expiresAtMs in the past)
- `activePendingApprovals` filters resolved approvals (resolvedDecision != nil)
- `apply(event:)` handles `.approvalPending` → appended to `pendingApprovals`
- `apply(event:)` handles `.approvalResolved` → marks matching approval as resolved
- `apply(event:)` handles `.unknown` → no crash, state unchanged
- `sendApprovalDecision` reverts optimistic state on publish failure
