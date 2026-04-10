import { createRequire } from "node:module";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ConnectedClient } from "lucy-im-sdk";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-helpers.js";
import { publishLucyMachineEvent } from "./send.js";
import type { ResolvedLucyAccount } from "./types.js";

type GatewayClient = { start(): void; stop(): void };
type EventFrame = { event: string; payload: unknown };
type GatewayRuntimeModule = {
  createOperatorApprovalsGatewayClient: (params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
    onEvent: (evt: EventFrame) => void;
    onConnectError?: (err: unknown) => void;
  }) => Promise<GatewayClient>;
};

let _gatewayRuntime: GatewayRuntimeModule | undefined;

function getGatewayRuntime(): GatewayRuntimeModule {
  if (_gatewayRuntime) {
    return _gatewayRuntime;
  }

  const candidates = [
    process.argv[1],
    `${process.cwd()}/index.js`,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const hostRequire = createRequire(candidate);
      _gatewayRuntime = hostRequire("openclaw/plugin-sdk/gateway-runtime") as GatewayRuntimeModule;
      return _gatewayRuntime;
    } catch (err) {
      errors.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `unable to resolve host openclaw gateway runtime (${errors.join(" | ") || "no candidates"})`,
  );
}

export class LucyExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private started = false;

  constructor(
    private readonly cfg: OpenClawConfig,
    private readonly account: ResolvedLucyAccount,
    private readonly cdi: string,
    private readonly session: ConnectedClient,
    private readonly userId: string,
    private readonly cuk: string,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { createOperatorApprovalsGatewayClient } = getGatewayRuntime();
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
    const commandDisplay = resolveExecApprovalCommandDisplay(request.request);
    await publishLucyMachineEvent({
      session: this.session,
      userId: this.userId,
      cuk: this.cuk,
      cdi: this.cdi,
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
      session: this.session,
      userId: this.userId,
      cuk: this.cuk,
      cdi: this.cdi,
      type: "approval.resolved",
      approvalId: resolved.id,
      approvalDecision: resolved.decision,
      approvalResolvedBy: resolved.resolvedBy ?? undefined,
    });
  }
}

// Minimal local types for external-plugin runtime safety.
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
