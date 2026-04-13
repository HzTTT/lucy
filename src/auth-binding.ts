import { LucyImClient, type LucyImConfig } from "lucy-im-sdk";
import type { ConnectedClient } from "lucy-im-sdk";

/**
 * Waits until the Lucy device is bound to a user and returns the resolved
 * identity triple. Polls the device-binding API every 2 seconds until either
 * the device becomes bound, the supplied abort signal fires, or the optional
 * deadline elapses. The OTP generation path is no longer driven from inside
 * this function — on-demand OTP issuance now flows through the pairing IPC
 * client (see src/pairing-ipc-client.ts), and pollBinding remains the
 * transport-agnostic fallback that also covers out-of-band binding paths
 * like QR scanning.
 */
export async function syncLucyBindingWithSdk(params: {
  cfg: LucyImConfig;
  /** Optional pre-constructed client. When omitted a fresh one is created. */
  client?: LucyImClient;
  signal?: AbortSignal;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  waitForBinding: boolean;
  /**
   * Invoked once the device is confirmed to be in PendingBind state. The
   * caller uses this hook to start the pairing IPC client (or any other
   * binding initiator) before polling begins.
   */
  onPendingBind?: (client: LucyImClient) => void;
  /**
   * Poll interval in milliseconds. Defaults to 2000; override for tests.
   */
  pollIntervalMs?: number;
}): Promise<{ cdi: string; userId: string; cuk: string }> {
  const client = params.client ?? new LucyImClient(params.cfg);
  const init = await client.init();

  if (init.kind === "Ready") {
    const identity = await client.deviceIdentity();
    if (!identity.user_id) {
      throw new Error("Lucy device ready but no user_id");
    }
    // cuk comes from connect; return empty string here — caller must connect before sending
    return { cdi: identity.cdi, userId: identity.user_id, cuk: "" };
  }

  // PendingBind
  if (!params.waitForBinding) {
    throw new Error("Lucy device not bound and waitForBinding=false");
  }

  params.onPendingBind?.(client);
  params.log?.info?.(
    `[lucy] device pending bind (cdi=${init.cdi}); waiting for user to complete binding`,
  );

  const pollIntervalMs = params.pollIntervalMs ?? 2_000;
  while (true) {
    if (params.signal?.aborted) {
      throw new Error("Lucy binding aborted");
    }

    const bound = await client.pollBinding();
    if (bound) {
      return { cdi: init.cdi, userId: bound.user_id, cuk: bound.cuk };
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        params.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, pollIntervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Lucy binding aborted"));
      };
      params.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export async function connectLucySdk(params: {
  cfg: LucyImConfig;
}): Promise<{ client: ConnectedClient; cdi: string; userId: string; cuk: string }> {
  const imClient = new LucyImClient(params.cfg);
  const result = await imClient.connect();
  if (result.kind === "PendingBind") {
    throw new Error("Lucy not bound");
  }
  const identity = await imClient.deviceIdentity();
  return {
    client: result.client,
    cdi: identity.cdi,
    userId: identity.user_id!,
    cuk: result.cuk,
  };
}
