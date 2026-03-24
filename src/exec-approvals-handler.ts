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
    const client = await createOperatorApprovalsGatewayClient({
      config: this.cfg,
      clientDisplayName: `Lucy Exec Approvals (${this.account.accountId})`,
      onEvent: (evt: EventFrame) => this.handleGatewayEvent(evt),
      onConnectError: (err: unknown) => {
        this.started = false;
        this.gatewayClient = null;
        console.error(`[lucy] exec approvals connect error: ${String(err)}`);
      },
    });
    if (!this.started) {
      // stop() was called while we were starting up — discard the client
      client.stop();
      return;
    }
    this.gatewayClient = client;
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
      const req = evt.payload as ExecApprovalRequest;
      if (typeof req?.id === "string") {
        void this.handleRequested(req).catch((err: unknown) => {
          console.error(`[lucy] exec approval handleRequested error: ${String(err)}`);
        });
      }
    } else if (evt.event === "exec.approval.resolved") {
      const res = evt.payload as ExecApprovalResolved;
      if (typeof res?.id === "string") {
        void this.handleResolved(res).catch((err: unknown) => {
          console.error(`[lucy] exec approval handleResolved error: ${String(err)}`);
        });
      }
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
      // Any non-"node" host (including "sandbox" or unknown future values) is coerced to "gateway".
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
