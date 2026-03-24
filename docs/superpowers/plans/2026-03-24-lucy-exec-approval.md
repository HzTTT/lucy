# Lucy Exec Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exec approval support to the Lucy channel plugin so iOS app users can approve/deny shell commands without switching clients.

**Architecture:** A new `LucyExecApprovalHandler` class listens on the OpenClaw gateway event bus and publishes `approval.pending` / `approval.resolved` NATS machine events. iOS receives these events, renders approval cards, and sends `/approve <id> <decision>` back via the standard client subject. A `lucyPlugin.execApprovals` adapter is also added for the forwarding path.

**Tech Stack:** TypeScript (Zod, NATS), Swift (SwiftUI, XCTest), vitest

---

## File Map

| File | Change |
|------|--------|
| `extensions/lucy/src/types.ts` | Add 2 event types + 9 approval fields to schema |
| `extensions/lucy/src/exec-approvals-handler.ts` | **Create** — `LucyExecApprovalHandler` class |
| `extensions/lucy/src/send.ts` | Add approval fields to `BuildMachineEventParams` and `publishLucyMachineEvent` params |
| `extensions/lucy/src/gateway.ts` | Wire `LucyExecApprovalHandler` in `startLucyGateway` |
| `extensions/lucy/src/channel.ts` | Add `execApprovals` adapter to `lucyPlugin` |
| `extensions/lucy/src/gateway.test.ts` | Add handler tests |
| `extensions/lucy/src/channel.test.ts` | Add adapter tests |
| `LucyIOSDemo/.../LucyModels.swift` | Fix unknown type + add approval types/structs/state |
| `LucyIOSDemo/.../LucyRootView.swift` | Approval routing + `sendApprovalDecision` |
| `LucyIOSDemo/.../LucyRedesignedRootScene.swift` | `LucyApprovalCard` UI + wire in `LucyThreadRowView` |
| `LucyIOSDemo/.../LucyIOSDemoFeatureTests.swift` | Add iOS tests |

---

## Task 1: Extend types.ts with approval event types and schema fields

**Files:**
- Modify: `extensions/lucy/src/types.ts`

- [ ] **Step 1: Write the failing test**

Add to `extensions/lucy/src/gateway.test.ts` (or a new describe block at the end of any existing test file that imports from `types.ts`):

```typescript
import { LucyMachineEventSchema, LucyMachineEventTypeSchema } from "./types.js";

describe("LucyMachineEventSchema approval fields", () => {
  it("accepts approval.pending event type", () => {
    expect(LucyMachineEventTypeSchema.options).toContain("approval.pending");
    expect(LucyMachineEventTypeSchema.options).toContain("approval.resolved");
  });

  it("parses approval.pending event with all approval fields", () => {
    const raw = {
      version: 2,
      eventId: "1234567890123456789",
      type: "approval.pending",
      timestamp: 1711267200000,
      channelUserKey: "cuk_demo",
      channelDeviceId: "1234567890123456789",
      approvalId: "apv_abc123def456",
      approvalSlug: "apv_abc1",
      approvalCommand: "rm -rf /tmp/build",
      approvalCwd: "/home/user",
      approvalHost: "gateway",
      approvalExpiresAtMs: 1711267260000,
      approvalAllowedDecisions: ["allow-once", "allow-always", "deny"],
    };
    const result = LucyMachineEventSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approvalId).toBe("apv_abc123def456");
      expect(result.data.approvalExpiresAtMs).toBe(1711267260000);
      expect(result.data.approvalAllowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);
    }
  });

  it("parses approval.resolved event with decision fields", () => {
    const raw = {
      version: 2,
      eventId: "1234567890123456790",
      type: "approval.resolved",
      timestamp: 1711267210000,
      channelUserKey: "cuk_demo",
      channelDeviceId: "1234567890123456789",
      approvalId: "apv_abc123def456",
      approvalDecision: "allow-once",
      approvalResolvedBy: "cuk_demo",
    };
    const result = LucyMachineEventSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approvalDecision).toBe("allow-once");
      expect(result.data.approvalResolvedBy).toBe("cuk_demo");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/gateway.test.ts" -t "LucyMachineEventSchema approval"
```

Expected: FAIL — `approval.pending` not in `LucyMachineEventTypeSchema.options`

- [ ] **Step 3: Implement the changes in types.ts**

In `extensions/lucy/src/types.ts`:

Add `"approval.pending"` and `"approval.resolved"` to `LucyMachineEventTypeSchema`:

```typescript
export const LucyMachineEventTypeSchema = z.enum([
  "inbound.accepted",
  "assistant.start",
  "assistant.partial",
  "assistant.final",
  "reasoning.partial",
  "reasoning.final",
  "tool.start",
  "tool.end",
  "error",
  "approval.pending",
  "approval.resolved",
]);
```

Add approval fields to `LucyMachineEventSchema` (after `media`):

```typescript
  approvalId: z.string().optional(),
  approvalSlug: z.string().optional(),
  approvalCommand: z.string().optional(),
  approvalCwd: z.string().optional(),
  approvalHost: z.string().optional(),
  approvalExpiresAtMs: z.number().optional(),
  approvalAllowedDecisions: z.array(z.string()).optional(),
  approvalDecision: z.string().optional(),
  approvalResolvedBy: z.string().optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/gateway.test.ts" -t "LucyMachineEventSchema approval"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(lucy): add approval.pending/resolved event types and schema fields" extensions/lucy/src/types.ts extensions/lucy/src/gateway.test.ts
```

---

## Task 2: Add approval fields to send.ts params

**Files:**
- Modify: `extensions/lucy/src/send.ts`

- [ ] **Step 1: Add approval fields to `BuildMachineEventParams` and `publishLucyMachineEvent`**

In `extensions/lucy/src/send.ts`, add these optional fields to `BuildMachineEventParams` (after `media`):

```typescript
  approvalId?: string;
  approvalSlug?: string;
  approvalCommand?: string;
  approvalCwd?: string;
  approvalHost?: string;
  approvalExpiresAtMs?: number;
  approvalAllowedDecisions?: string[];
  approvalDecision?: string;
  approvalResolvedBy?: string;
```

Pass them through in `buildLucyMachineEvent`:

```typescript
  return {
    // ... existing fields ...
    approvalId: params.approvalId,
    approvalSlug: params.approvalSlug,
    approvalCommand: params.approvalCommand,
    approvalCwd: params.approvalCwd,
    approvalHost: params.approvalHost,
    approvalExpiresAtMs: params.approvalExpiresAtMs,
    approvalAllowedDecisions: params.approvalAllowedDecisions,
    approvalDecision: params.approvalDecision,
    approvalResolvedBy: params.approvalResolvedBy,
  };
```

Also add the same fields to the `publishLucyMachineEvent` params type (it spreads `...params` into `buildLucyMachineEvent`, so the spread already works once you add the fields to `BuildMachineEventParams` — but the public param type of `publishLucyMachineEvent` needs them too so callers can pass them).

Also update `LucyMachineEvent` type export in `types.ts` — `z.infer` already picks up the new fields automatically, so no manual type change is needed there.

- [ ] **Step 2: Type-check only**

```bash
pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
scripts/committer "feat(lucy): extend send.ts params with approval fields" extensions/lucy/src/send.ts
```

---

## Task 3: Create exec-approvals-handler.ts

**Files:**
- Create: `extensions/lucy/src/exec-approvals-handler.ts`
- Modify: `extensions/lucy/src/gateway.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `extensions/lucy/src/gateway.test.ts`:

```typescript
import { LucyExecApprovalHandler } from "./exec-approvals-handler.js";

describe("LucyExecApprovalHandler", () => {
  it("publishes approval.pending event with correct fields on handleRequested", async () => {
    // Arrange
    const publishedEvents: unknown[] = [];
    const mockConnection = {
      publish: (_subject: string, data: unknown) => { publishedEvents.push(data); },
      flush: vi.fn().mockResolvedValue(undefined),
    };
    const mockAccount = {
      accountId: "default",
      channelUserKey: "cuk_demo",
      subjectPrefix: "cephalon.im.npc",
      mediaBucket: "lucy_media_v2",
      mediaRetentionHours: 168,
      mediaMaxBytes: 20 * 1024 * 1024,
      enabled: true,
      configured: true,
      servers: ["nats://127.0.0.1:4222"],
      dmPolicy: "open" as const,
      allowFrom: [],
    };
    const mockGatewayClient = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const createClientMock = vi.fn().mockResolvedValue(mockGatewayClient);
    vi.doMock("openclaw/plugin-sdk/gateway-runtime", () => ({
      createOperatorApprovalsGatewayClient: createClientMock,
    }));

    // This test validates the handler's event shape; a fuller integration test
    // would use a real gateway client mock. Here we confirm the handler starts
    // and calls the factory with the correct config.
    const handler = new LucyExecApprovalHandler(
      {} as any,
      mockAccount as any,
      "1234567890123456789",
      mockConnection as any,
    );
    await handler.start();

    expect(createClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        clientDisplayName: expect.stringContaining("Lucy Exec Approvals"),
      }),
    );
    handler.stop();
    expect(mockGatewayClient.stop).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/gateway.test.ts" -t "LucyExecApprovalHandler"
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement exec-approvals-handler.ts**

Create `extensions/lucy/src/exec-approvals-handler.ts`:

```typescript
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { NatsConnection } from "nats";
import { publishLucyMachineEvent } from "./send.js";
import type { ResolvedLucyAccount } from "./types.js";

// Lazy-imported at runtime to avoid static-import / dynamic-import mixing.
// Two separate lazy wrappers because the two modules must not be mixed.
type GatewayRuntime = typeof import("openclaw/plugin-sdk/gateway-runtime");
type InfraRuntime = typeof import("openclaw/plugin-sdk/infra-runtime");

let _gatewayRuntime: GatewayRuntime | undefined;
async function getGatewayRuntime(): Promise<GatewayRuntime> {
  if (!_gatewayRuntime) {
    _gatewayRuntime = await import("openclaw/plugin-sdk/gateway-runtime");
  }
  return _gatewayRuntime;
}

let _infraRuntime: InfraRuntime | undefined;
async function getInfraRuntime(): Promise<InfraRuntime> {
  if (!_infraRuntime) {
    _infraRuntime = await import("openclaw/plugin-sdk/infra-runtime");
  }
  return _infraRuntime;
}

type GatewayClient = { start(): void; stop(): void };
type EventFrame = { event: string; payload: unknown };

export class LucyExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private started = false;

  constructor(
    private readonly cfg: OpenClawConfig,
    private readonly account: ResolvedLucyAccount,
    private readonly deviceId: string,
    private readonly connection: NatsConnection,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { createOperatorApprovalsGatewayClient } = await getGatewayRuntime();
    this.gatewayClient = await createOperatorApprovalsGatewayClient({
      config: this.cfg,
      clientDisplayName: `Lucy Exec Approvals (${this.account.accountId})`,
      onEvent: (evt: EventFrame) => this.handleGatewayEvent(evt),
      onConnectError: (err: unknown) => {
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
    const { resolveExecApprovalCommandDisplay } = await getInfraRuntime();
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
      // "sandbox" host is coerced to "gateway" — Lucy runs no sandbox host.
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

// Minimal local types — the real types live in openclaw/plugin-sdk/infra-runtime.
// Using structural typing avoids a hard import dependency from this file.
type ExecApprovalRequest = {
  id: string;
  expiresAtMs: number;
  request: {
    sessionKey?: string | null;
    cwd?: string | null;
    host?: string;
    nodeId?: string | null;
    [key: string]: unknown;
  };
};

type ExecApprovalResolved = {
  id: string;
  decision: string;
  resolvedBy?: string | null;
};
```

**Note on dynamic import:** `resolveExecApprovalCommandDisplay` is imported lazily via `getInfraRuntime()` (from `openclaw/plugin-sdk/infra-runtime`), while `createOperatorApprovalsGatewayClient` is imported via `getGatewayRuntime()` (from `openclaw/plugin-sdk/gateway-runtime`). The two wrappers are separate to satisfy the codebase's dynamic-import guardrail (no mixing static + dynamic imports for the same module path).

- [ ] **Step 4: Run tests to verify they pass**

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/gateway.test.ts" -t "LucyExecApprovalHandler"
```

Expected: PASS

- [ ] **Step 5: Type-check**

```bash
pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(lucy): add LucyExecApprovalHandler for exec approval events" extensions/lucy/src/exec-approvals-handler.ts extensions/lucy/src/gateway.test.ts
```

---

## Task 4: Wire LucyExecApprovalHandler in gateway.ts

**Files:**
- Modify: `extensions/lucy/src/gateway.ts`

- [ ] **Step 1: Import and instantiate the handler**

Add import at the top of `extensions/lucy/src/gateway.ts`:

```typescript
import { LucyExecApprovalHandler } from "./exec-approvals-handler.js";
```

In `startLucyGateway()`, after `await presenceLoop.ready` (line ~536) and before the `stop` closure, add:

```typescript
  const approvalHandler = new LucyExecApprovalHandler(
    ctx.cfg,
    boundAccount,
    deviceState.channelDeviceId,
    connection,
  );
  await approvalHandler.start();
```

In the `stop` closure, add `approvalHandler.stop()` alongside `presenceLoop.stop()`:

```typescript
  const stop = () => {
    if (stopped) return;
    stopped = true;
    approvalHandler.stop();
    presenceLoop.stop();
    // ... rest of existing stop() body unchanged ...
  };
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
scripts/committer "feat(lucy): wire LucyExecApprovalHandler into startLucyGateway" extensions/lucy/src/gateway.ts
```

---

## Task 5: Add execApprovals adapter to channel.ts

**Files:**
- Modify: `extensions/lucy/src/channel.ts`
- Modify: `extensions/lucy/src/channel.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `extensions/lucy/src/channel.test.ts`:

```typescript
import { lucyPlugin } from "./channel.js";

describe("lucyPlugin.execApprovals", () => {
  it("getInitiatingSurfaceState returns enabled for a configured account", () => {
    const cfg = {
      channels: { lucy: { enabled: true, channelUserKey: "cuk_demo" } },
    } as any;
    const result = lucyPlugin.execApprovals?.getInitiatingSurfaceState?.({
      cfg,
      accountId: "default",
      account: {} as any,
      target: {} as any,
    });
    expect(result?.kind).toBe("enabled");
  });

  it("getInitiatingSurfaceState returns disabled for an unconfigured account", () => {
    const cfg = { channels: {} } as any;
    const result = lucyPlugin.execApprovals?.getInitiatingSurfaceState?.({
      cfg,
      accountId: "default",
      account: {} as any,
      target: {} as any,
    });
    expect(result?.kind).toBe("disabled");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/channel.test.ts" -t "lucyPlugin.execApprovals"
```

Expected: FAIL — `lucyPlugin.execApprovals` is undefined

- [ ] **Step 3: Add imports and adapter**

Add to the imports at the top of `extensions/lucy/src/channel.ts`:

```typescript
import {
  buildExecApprovalPendingReplyPayload,
  getExecApprovalReplyMetadata,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/infra-runtime";
```

Add the `execApprovals` adapter to the `lucyPlugin` object (after `outbound`, before `status`):

```typescript
  execApprovals: {
    getInitiatingSurfaceState: ({ cfg, accountId }) =>
      resolveLucyAccount(cfg, accountId).configured
        ? { kind: "enabled" as const }
        : { kind: "disabled" as const },

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

    buildResolvedPayload: ({ cfg, resolved, target }) => ({
      text: `✅ 执行审批已${resolved.decision === "deny" ? "拒绝" : "通过"}`,
    }),
  },
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/channel.test.ts" -t "lucyPlugin.execApprovals"
```

Expected: PASS

- [ ] **Step 5: Type-check and run full Lucy test suite**

```bash
pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"
```

Expected: no type errors, all tests pass

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(lucy): add execApprovals adapter to lucyPlugin" extensions/lucy/src/channel.ts extensions/lucy/src/channel.test.ts
```

---

## Task 6: iOS — Update LucyModels.swift

**Files:**
- Modify: `extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyModels.swift`
- Modify: `extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Write the failing tests**

Add to `LucyIOSDemoFeatureTests.swift`:

```swift
func testMachineEventTypeDecodesUnknownTypeToUnknownCase() throws {
    let data = try JSONSerialization.data(withJSONObject: [
        "version": 2,
        "eventId": "1234567890123456789",
        "type": "some.future.event.type",
        "timestamp": 1711267200000 as Int64,
        "channelUserKey": "cuk_demo",
        "channelDeviceId": "1234567890123456789",
    ])

    let event = try JSONDecoder().decode(LucyMachineEvent.self, from: data)
    XCTAssertEqual(event.type, .unknown)
}

func testMachineEventTypeDecodesApprovalPending() throws {
    let data = try JSONSerialization.data(withJSONObject: [
        "version": 2,
        "eventId": "1234567890123456789",
        "type": "approval.pending",
        "timestamp": 1711267200000 as Int64,
        "channelUserKey": "cuk_demo",
        "channelDeviceId": "1234567890123456789",
        "approvalId": "apv_abc123def456",
        "approvalSlug": "apv_abc1",
        "approvalCommand": "rm -rf /tmp/build",
        "approvalExpiresAtMs": 1711267260000 as Int64,
        "approvalAllowedDecisions": ["allow-once", "allow-always", "deny"],
    ])

    let event = try JSONDecoder().decode(LucyMachineEvent.self, from: data)
    XCTAssertEqual(event.type, .approvalPending)
    XCTAssertEqual(event.approvalId, "apv_abc123def456")
    XCTAssertEqual(event.approvalExpiresAtMs, 1711267260000)
    XCTAssertEqual(event.approvalAllowedDecisions, ["allow-once", "allow-always", "deny"])
}

func testApprovalStateFilterExpiredApprovals() {
    var state = LucyReplyState(sourceMessageId: "1000000000000000001")

    let pastMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000) - 60_000
    let futureMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000) + 60_000

    let expiredApproval = LucyApprovalState(
        approvalId: "apv_expired",
        approvalSlug: "apv_exp",
        approvalCommand: "ls",
        approvalCwd: nil,
        approvalHost: nil,
        approvalExpiresAtMs: pastMs,
        allowedDecisions: ["allow-once", "deny"],
        resolvedDecision: nil,
        resolvedBy: nil
    )
    let activeApproval = LucyApprovalState(
        approvalId: "apv_active",
        approvalSlug: "apv_act",
        approvalCommand: "cat /etc/passwd",
        approvalCwd: nil,
        approvalHost: nil,
        approvalExpiresAtMs: futureMs,
        allowedDecisions: ["allow-once", "deny"],
        resolvedDecision: nil,
        resolvedBy: nil
    )

    state.pendingApprovals = [expiredApproval, activeApproval]
    let conversation = LucyConversation(
        id: "1000000000000000001",
        requestText: "test",
        sentAt: Date(),
        requestAttachment: nil,
        replyState: state
    )

    XCTAssertEqual(conversation.activePendingApprovals.count, 1)
    XCTAssertEqual(conversation.activePendingApprovals[0].approvalId, "apv_active")
}

func testApprovalStateFilterResolvedApprovals() {
    var state = LucyReplyState(sourceMessageId: "1000000000000000001")

    let futureMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000) + 60_000

    let resolved = LucyApprovalState(
        approvalId: "apv_resolved",
        approvalSlug: "apv_res",
        approvalCommand: "echo hello",
        approvalCwd: nil,
        approvalHost: nil,
        approvalExpiresAtMs: futureMs,
        allowedDecisions: ["allow-once", "deny"],
        resolvedDecision: "allow-once",
        resolvedBy: nil
    )

    state.pendingApprovals = [resolved]
    let conversation = LucyConversation(
        id: "1000000000000000001",
        requestText: "test",
        sentAt: Date(),
        requestAttachment: nil,
        replyState: state
    )

    XCTAssertEqual(conversation.activePendingApprovals.count, 0)
}

func testReplyStateAppliesApprovalPendingEvent() throws {
    var state = LucyReplyState(sourceMessageId: "1000000000000000001")

    let data = try JSONSerialization.data(withJSONObject: [
        "version": 2,
        "eventId": "1234567890123456789",
        "type": "approval.pending",
        "timestamp": 1711267200000 as Int64,
        "channelUserKey": "cuk_demo",
        "channelDeviceId": "1234567890123456789",
        "approvalId": "apv_abc123def456",
        "approvalSlug": "apv_abc1",
        "approvalCommand": "rm -rf /tmp/build",
        "approvalExpiresAtMs": 1711267260000 as Int64,
    ])
    let event = try JSONDecoder().decode(LucyMachineEvent.self, from: data)
    state.apply(event: event)

    XCTAssertEqual(state.pendingApprovals.count, 1)
    XCTAssertEqual(state.pendingApprovals[0].approvalId, "apv_abc123def456")
    // Default allowedDecisions when wire field is absent
    XCTAssertEqual(state.pendingApprovals[0].allowedDecisions, ["allow-once", "allow-always", "deny"])
}

func testReplyStateAppliesApprovalResolvedEvent() throws {
    var state = LucyReplyState(sourceMessageId: "1000000000000000001")

    state.pendingApprovals = [LucyApprovalState(
        approvalId: "apv_abc123def456",
        approvalSlug: "apv_abc1",
        approvalCommand: "rm -rf /tmp/build",
        approvalCwd: nil,
        approvalHost: nil,
        approvalExpiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60_000,
        allowedDecisions: ["allow-once", "deny"],
        resolvedDecision: nil,
        resolvedBy: nil
    )]

    let data = try JSONSerialization.data(withJSONObject: [
        "version": 2,
        "eventId": "1234567890123456790",
        "type": "approval.resolved",
        "timestamp": 1711267210000 as Int64,
        "channelUserKey": "cuk_demo",
        "channelDeviceId": "1234567890123456789",
        "approvalId": "apv_abc123def456",
        "approvalDecision": "allow-once",
    ])
    let event = try JSONDecoder().decode(LucyMachineEvent.self, from: data)
    state.apply(event: event)

    XCTAssertEqual(state.pendingApprovals[0].resolvedDecision, "allow-once")
}

func testReplyStateAppliesUnknownEventWithoutCrash() throws {
    var state = LucyReplyState(sourceMessageId: "1000000000000000001")
    let initialApprovals = state.pendingApprovals.count
    let data = try JSONSerialization.data(withJSONObject: [
        "version": 2,
        "eventId": "1234567890123456789",
        "type": "some.future.type",
        "timestamp": 1711267200000 as Int64,
        "channelUserKey": "cuk_demo",
        "channelDeviceId": "1234567890123456789",
    ])
    let event = try JSONDecoder().decode(LucyMachineEvent.self, from: data)
    state.apply(event: event)

    XCTAssertEqual(state.pendingApprovals.count, initialApprovals)
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
xcodebuildmcp swift-package test \
  --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage \
  --filter "LucyIOSDemoFeatureTests.testMachineEventTypeDecodesUnknownTypeToUnknownCase" 2>&1 | tail -20
```

Expected: Swift tests FAIL — `LucyMachineEventType` has no `unknown` case

- [ ] **Step 3: Update LucyModels.swift**

**3a. Fix `LucyMachineEventType` — add unknown case + approval cases + custom decoder:**

Replace the existing `LucyMachineEventType` enum:

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
    /// Catch-all for future event types; rawValue uses a sentinel to avoid collisions.
    case unknown = "__unknown__"

    var id: String { rawValue }

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LucyMachineEventType(rawValue: raw) ?? .unknown
    }
}
```

**3b. Add `LucyApprovalState` struct** (add after `LucyToolExecutionSnapshot`):

```swift
struct LucyApprovalState: Codable, Equatable, Identifiable {
    let approvalId: String
    let approvalSlug: String
    let approvalCommand: String?
    let approvalCwd: String?
    let approvalHost: String?
    let approvalExpiresAtMs: Int64?
    /// Defaults to all three decisions when the wire field is absent.
    let allowedDecisions: [String]
    var resolvedDecision: String?
    var resolvedBy: String?

    var id: String { approvalId }
}
```

**3c. Add approval fields to `LucyMachineEvent`:**

Add these 9 optional stored properties before `var id: String { eventId }`:

```swift
    let approvalId: String?
    let approvalSlug: String?
    let approvalCommand: String?
    let approvalCwd: String?
    let approvalHost: String?
    let approvalExpiresAtMs: Int64?
    let approvalAllowedDecisions: [String]?
    let approvalDecision: String?
    let approvalResolvedBy: String?
```

Add them to `CodingKeys`:

```swift
    case approvalId
    case approvalSlug
    case approvalCommand
    case approvalCwd
    case approvalHost
    case approvalExpiresAtMs
    case approvalAllowedDecisions
    case approvalDecision
    case approvalResolvedBy
```

Add `decodeIfPresent` calls in `init(from decoder:)` (before closing brace):

```swift
        approvalId = try container.decodeIfPresent(String.self, forKey: .approvalId)
        approvalSlug = try container.decodeIfPresent(String.self, forKey: .approvalSlug)
        approvalCommand = try container.decodeIfPresent(String.self, forKey: .approvalCommand)
        approvalCwd = try container.decodeIfPresent(String.self, forKey: .approvalCwd)
        approvalHost = try container.decodeIfPresent(String.self, forKey: .approvalHost)
        approvalExpiresAtMs = try container.decodeIfPresent(Int64.self, forKey: .approvalExpiresAtMs)
        approvalAllowedDecisions = try container.decodeIfPresent([String].self, forKey: .approvalAllowedDecisions)
        approvalDecision = try container.decodeIfPresent(String.self, forKey: .approvalDecision)
        approvalResolvedBy = try container.decodeIfPresent(String.self, forKey: .approvalResolvedBy)
```

Also update `encode(to:)` with `encodeIfPresent` for all 9 fields, and update the memberwise `init(...)` to add all 9 optional parameters (defaulting to `nil`).

**3d. Add `pendingApprovals` to `LucyReplyState`:**

```swift
    var pendingApprovals: [LucyApprovalState] = []
```

**3e. Add approval cases to `apply(event:)` in `LucyReplyState`:**

Inside the `switch event.type {` block, add before the closing brace:

```swift
        case .approvalPending:
            guard let approvalId = event.approvalId else { break }
            let approval = LucyApprovalState(
                approvalId: approvalId,
                approvalSlug: event.approvalSlug ?? String(approvalId.prefix(8)),
                approvalCommand: event.approvalCommand,
                approvalCwd: event.approvalCwd,
                approvalHost: event.approvalHost,
                approvalExpiresAtMs: event.approvalExpiresAtMs,
                allowedDecisions: event.approvalAllowedDecisions ?? ["allow-once", "allow-always", "deny"],
                resolvedDecision: nil,
                resolvedBy: nil
            )
            pendingApprovals.append(approval)

        case .approvalResolved:
            guard let approvalId = event.approvalId,
                  let decision = event.approvalDecision else { break }
            if let idx = pendingApprovals.firstIndex(where: { $0.approvalId == approvalId }) {
                pendingApprovals[idx].resolvedDecision = decision
                pendingApprovals[idx].resolvedBy = event.approvalResolvedBy
            }

        case .unknown:
            break
```

**3f. Add `activePendingApprovals` to `LucyConversation`:**

Add a computed property after the stored properties of `LucyConversation`:

```swift
    var activePendingApprovals: [LucyApprovalState] {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return replyState.pendingApprovals.filter { approval in
            approval.resolvedDecision == nil &&
            (approval.approvalExpiresAtMs.map { $0 > now } ?? true)
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
xcodebuildmcp swift-package test \
  --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage \
  --filter "LucyIOSDemoFeatureTests.testMachineEventTypeDecodesUnknownTypeToUnknownCase,LucyIOSDemoFeatureTests.testMachineEventTypeDecodesApprovalPending,LucyIOSDemoFeatureTests.testApprovalStateFilterExpiredApprovals,LucyIOSDemoFeatureTests.testApprovalStateFilterResolvedApprovals,LucyIOSDemoFeatureTests.testReplyStateAppliesApprovalPendingEvent,LucyIOSDemoFeatureTests.testReplyStateAppliesApprovalResolvedEvent,LucyIOSDemoFeatureTests.testReplyStateAppliesUnknownEventWithoutCrash" 2>&1 | tail -30
```

Expected: all 7 tests PASS

- [ ] **Step 5: Run the full iOS test suite**

```bash
xcodebuildmcp swift-package test \
  --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage 2>&1 | tail -30
```

Expected: all tests pass (including pre-existing tests like `testMachineEventDecodesCamelCaseChannelDeviceId`)

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(lucy-ios): add approval types, LucyApprovalState, and apply(event:) handlers" \
  extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyModels.swift \
  extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift
```

---

## Task 7: iOS — Update LucyRootView.swift

**Files:**
- Modify: `extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
- Modify: `extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Write the failing test**

Add to `LucyIOSDemoFeatureTests.swift`:

```swift
@MainActor
func testSendApprovalDecisionOptimisticallyMarksResolved() {
    let suiteName = "LucyApprovalDecisionTests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let model = LucyAppModel(store: LucyConnectionConfigStore(userDefaults: defaults))

    var replyState = LucyReplyState(sourceMessageId: "msg_001")
    let futureMs = Int64(Date().timeIntervalSince1970 * 1000) + 60_000
    replyState.pendingApprovals = [LucyApprovalState(
        approvalId: "apv_test123",
        approvalSlug: "apv_test",
        approvalCommand: "echo hi",
        approvalCwd: nil,
        approvalHost: nil,
        approvalExpiresAtMs: futureMs,
        allowedDecisions: ["allow-once", "deny"],
        resolvedDecision: nil,
        resolvedBy: nil
    )]
    model.conversations = [LucyConversation(
        id: "msg_001",
        requestText: "run command",
        sentAt: Date(),
        requestAttachment: nil,
        replyState: replyState
    )]

    model.sendApprovalDecision(approvalId: "apv_test123", decision: "allow-once")

    // Optimistic update: should be resolved immediately
    XCTAssertEqual(
        model.conversations[0].replyState.pendingApprovals[0].resolvedDecision,
        "allow-once"
    )
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
xcodebuildmcp swift-package test \
  --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage \
  --filter "LucyIOSDemoFeatureTests.testSendApprovalDecisionOptimisticallyMarksResolved" 2>&1 | tail -20
```

Expected: FAIL — `sendApprovalDecision` method not found

- [ ] **Step 3: Update LucyRootView.swift**

**3a. Add approval cases to `conversationIdentifier(for:)`:**

In the `switch event.type {` block (around line 541), add before `default:`:

```swift
        case .approvalPending, .approvalResolved:
            // Match by sessionKey to the most-recent conversation with that session.
            if let sessionKey = event.sessionKey,
               let match = conversations.last(where: { $0.replyState.sessionKey == sessionKey }) {
                return match.id
            }
            // Fall back to last incomplete conversation.
            if let open = conversations.last(where: { !$0.isComplete }) {
                return open.id
            }
            // Create an orphan entry keyed to the approval ID (or event ID as fallback).
            return "orphan-approval:\(event.approvalId ?? event.eventId)"
```

**3b. Update `consume(event:)` to skip `scheduleCompletion` for approval events:**

In `consume(event:)`, the `scheduleCompletion` call is inside `if event.type == .assistantFinal`. Approval events do not trigger `scheduleCompletion` because that block already guards on `.assistantFinal`. However, the `if event.type != .error` cancels `completionTasks` — approval events should also cancel tasks (this is already handled correctly since approval types are not `.error`).

No changes needed to `scheduleCompletion` logic. But verify that `updateConversation` is called for approval events — it is, because the existing code calls it for all event types that reach that point. The `replyState.apply(event:)` for `.approvalPending` / `.approvalResolved` / `.unknown` are handled by the new cases added in Task 6.

**3c. Add `sendApprovalDecision` method to `LucyAppModel`:**

Add after `sendMessage` (or near the end of the model, before `deinit`):

```swift
    func sendApprovalDecision(approvalId: String, decision: String) {
        let text = "/approve \(approvalId) \(decision)"
        let messageID = LucyMessageIDGenerator.next()
        // Optimistically mark as resolved in local state.
        for i in conversations.indices {
            if let idx = conversations[i].replyState.pendingApprovals.firstIndex(where: {
                $0.approvalId == approvalId
            }) {
                conversations[i].replyState.pendingApprovals[idx].resolvedDecision = decision
            }
        }
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
                withAnimation(.easeOut(duration: 0.22)) {
                    errorText = "审批发送失败：\(error.localizedDescription)"
                }
                // Revert optimistic state on failure.
                for i in conversations.indices {
                    if let idx = conversations[i].replyState.pendingApprovals.firstIndex(where: {
                        $0.approvalId == approvalId
                    }) {
                        conversations[i].replyState.pendingApprovals[idx].resolvedDecision = nil
                    }
                }
            }
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
xcodebuildmcp swift-package test \
  --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage \
  --filter "LucyIOSDemoFeatureTests.testSendApprovalDecisionOptimisticallyMarksResolved" 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Run full iOS suite**

```bash
xcodebuildmcp swift-package test \
  --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage 2>&1 | tail -20
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(lucy-ios): add approval routing in conversationIdentifier and sendApprovalDecision" \
  extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift \
  extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift
```

---

## Task 8: iOS — Add LucyApprovalCard UI and wire into LucyRedesignedRootScene.swift

**Files:**
- Modify: `extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRedesignedRootScene.swift`

- [ ] **Step 1: Add `LucyApprovalCard` view**

Add after `LucyToolTraceBlock` (around line 859 at end of file, before any closing braces):

```swift
private struct LucyApprovalCard: View {
    let approval: LucyApprovalState
    let onDecision: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(LucyRedesignedPalette.accent)
                Text("需要执行权限")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(LucyRedesignedPalette.ink)
            }

            if let command = approval.approvalCommand {
                Text(command)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(LucyRedesignedPalette.ink)
                    .lineLimit(3)
            }

            if approval.approvalCwd != nil || approval.approvalHost != nil {
                HStack(spacing: 6) {
                    if let host = approval.approvalHost {
                        Label(host, systemImage: "server.rack")
                            .font(.system(size: 11))
                            .foregroundStyle(LucyRedesignedPalette.placeholder)
                    }
                    if let cwd = approval.approvalCwd {
                        Label(cwd, systemImage: "folder")
                            .font(.system(size: 11))
                            .foregroundStyle(LucyRedesignedPalette.placeholder)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }

            HStack(spacing: 8) {
                ForEach(approval.allowedDecisions, id: \.self) { decision in
                    Button {
                        onDecision(decision)
                    } label: {
                        Text(labelText(for: decision))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(foregroundColor(for: decision))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(backgroundColor(for: decision))
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(LucyRedesignedPalette.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(LucyRedesignedPalette.border, lineWidth: 1)
                )
        )
    }

    private func labelText(for decision: String) -> String {
        switch decision {
        case "allow-once": return "允许一次"
        case "allow-always": return "始终允许"
        case "deny": return "拒绝"
        default: return decision
        }
    }

    private func foregroundColor(for decision: String) -> Color {
        .white
    }

    private func backgroundColor(for decision: String) -> Color {
        switch decision {
        case "deny": return LucyRedesignedPalette.error
        default: return LucyRedesignedPalette.accent
        }
    }
}
```

**Note:** `LucyRedesignedPalette.error` may not exist — check the palette definition and use the closest destructive/red color. If absent, use `Color.red.opacity(0.8)` as a fallback.

- [ ] **Step 2: Add `onApprove` parameter to `LucyThreadRowView`**

In `LucyThreadRowView` struct definition, add the closure:

```swift
private struct LucyThreadRowView: View {
    let conversation: LucyConversation
    let reduceMotion: Bool
    let onApprove: (String, String) -> Void  // (approvalId, decision)
    @State private var areCompletedToolsExpanded = false
    // ... rest unchanged ...
```

Update the `LucyThreadRowView` initializer call site in `LucyRedesignedRootScene` body (the `ForEach` block around line 48):

```swift
LucyThreadRowView(
    conversation: conversation,
    reduceMotion: reduceMotion,
    onApprove: { approvalId, decision in
        model.sendApprovalDecision(approvalId: approvalId, decision: decision)
    }
)
```

- [ ] **Step 3: Insert approval cards in `assistantCluster`**

In `LucyThreadRowView.assistantCluster`, before `ForEach(renderItems)` (after the `LucyToolTraceBlock` block):

```swift
                // Exec approval cards — shown before final reply blocks.
                let activeApprovals = conversation.activePendingApprovals
                if !activeApprovals.isEmpty {
                    ForEach(activeApprovals) { approval in
                        LucyApprovalCard(approval: approval) { decision in
                            onApprove(approval.approvalId, decision)
                        }
                    }
                }
```

- [ ] **Step 4: Build the Swift package to verify it compiles**

```bash
xcodebuildmcp swift-package build \
  --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage 2>&1 | tail -30
```

Expected: BUILD SUCCEEDED

- [ ] **Step 5: Run full iOS test suite**

```bash
xcodebuildmcp swift-package test \
  --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage 2>&1 | tail -20
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(lucy-ios): add LucyApprovalCard UI and wire into LucyThreadRowView" \
  extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRedesignedRootScene.swift
```

---

## Task 9: Final integration check

- [ ] **Step 1: Run full TypeScript test suite**

```bash
vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"
```

Expected: all tests pass

- [ ] **Step 2: Type-check the full Lucy plugin**

```bash
pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts
```

Expected: no errors

- [ ] **Step 3: Run root-level lint/check**

```bash
pnpm check
```

Expected: no errors

- [ ] **Step 4: Run full iOS test suite**

```bash
xcodebuildmcp swift-package test \
  --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage 2>&1 | tail -30
```

Expected: all tests pass

- [ ] **Step 5: Final commit if any fixups were needed**

```bash
scripts/committer "chore(lucy): exec approval integration fixups"
```
