import { LucyImClient, type LucyImConfig } from "lucy-im-sdk";
import type { ConnectedClient } from "lucy-im-sdk";

export async function syncLucyBindingWithSdk(params: {
  cfg: LucyImConfig;
  signal?: AbortSignal;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  waitForBinding: boolean;
}): Promise<{ cdi: string; userId: string; cuk: string }> {
  const client = new LucyImClient(params.cfg);
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

  const otp = await client.preBind();
  params.log?.info?.(`[lucy] Binding OTP: ${otp.otp} (expires in ${otp.expires_in}s)`);

  const deadline = Date.now() + otp.expires_in * 1000;
  while (Date.now() < deadline) {
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
      }, 2000);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Lucy binding aborted"));
      };
      params.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  throw new Error("Lucy binding timed out");
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
  const cuk = result.client.accessToken() ?? "";
  return {
    client: result.client,
    cdi: identity.cdi,
    userId: identity.user_id!,
    cuk,
  };
}
