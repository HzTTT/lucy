import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { loadOrCreateLucyDeviceState, writeLucyDeviceState } from "./state.js";
import type { LucyDeviceState, ResolvedLucyAccount } from "./types.js";
import { fetchLucyDeviceBinding, mergeLucyBindingIntoState, registerLucyDevice } from "./user-center.js";

const LUCY_BINDING_POLL_INITIAL_MS = 3_000;
const LUCY_BINDING_POLL_MAX_MS = 30_000;
const LUCY_STARTUP_HTTP_TIMEOUT_MS = 5_000;

function didLucyBindingStateChange(current: LucyDeviceState, next: LucyDeviceState): boolean {
  return JSON.stringify(current) !== JSON.stringify(next);
}

async function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Lucy binding aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Lucy binding aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function hydrateLucyAccountFromState(
  account: ResolvedLucyAccount,
  state: LucyDeviceState,
): ResolvedLucyAccount {
  return {
    ...account,
    channelDeviceId: state.channelDeviceId,
    bootstrapToken: state.bootstrapToken,
    channelUserKey: state.channelUserKey ?? account.channelUserKey,
  };
}

export async function ensureLucyBootstrapState(account: ResolvedLucyAccount): Promise<LucyDeviceState> {
  return await loadOrCreateLucyDeviceState({
    overrides: {
      channelDeviceId: account.channelDeviceId,
      bootstrapToken: account.bootstrapToken,
      channelUserKey: account.channelUserKey,
    },
  });
}

export async function syncLucyBindingState(params: {
  account: ResolvedLucyAccount;
  signal?: AbortSignal;
  log?: Pick<NonNullable<ChannelGatewayContext<ResolvedLucyAccount>["log"]>, "info" | "warn" | "error">;
  waitForBinding: boolean;
}): Promise<LucyDeviceState> {
  let state = await ensureLucyBootstrapState(params.account);
  if (state.channelUserKey) {
    return state;
  }

  let pollDelayMs = LUCY_BINDING_POLL_INITIAL_MS;

  while (true) {
    if (params.signal?.aborted) {
      throw new Error("Lucy binding aborted");
    }

    try {
      const registration = await registerLucyDevice({
        channelDeviceId: state.channelDeviceId,
        bootstrapToken: state.bootstrapToken,
        signal: params.signal,
        timeoutMs: LUCY_STARTUP_HTTP_TIMEOUT_MS,
      });
      // Mark as registered so iOS knows the device is known to user-center.
      // registration_status from the server is always "pending" here (registration,
      // not binding), so we promote the local state to "registered" unconditionally.
      const mergedRegistration = mergeLucyBindingIntoState(state, registration);
      const registeredState: LucyDeviceState = {
        ...mergedRegistration,
        bindingStatus:
          mergedRegistration.bindingStatus === "bound" ? "bound" :
          state.bindingStatus === "bound" ? "bound" :
          "registered",
      };
      if (didLucyBindingStateChange(state, registeredState)) {
        await writeLucyDeviceState(registeredState);
        state = registeredState;
      }

      const binding = await fetchLucyDeviceBinding({
        channelDeviceId: state.channelDeviceId,
        bootstrapToken: state.bootstrapToken,
        signal: params.signal,
        timeoutMs: LUCY_STARTUP_HTTP_TIMEOUT_MS,
      });
      const nextState = mergeLucyBindingIntoState(state, binding);
      if (didLucyBindingStateChange(state, nextState)) {
        await writeLucyDeviceState(nextState);
        state = nextState;
      }
      if (state.channelUserKey) {
        return state;
      }

      // Reset backoff after a successful round-trip.
      pollDelayMs = LUCY_BINDING_POLL_INITIAL_MS;
    } catch (err) {
      params.log?.warn?.(`[lucy] user-center binding sync failed: ${String(err)}`);
      if (!params.waitForBinding) {
        throw err;
      }
      // Exponential backoff: 3s -> 6s -> 12s -> 30s cap.
      pollDelayMs = Math.min(pollDelayMs * 2, LUCY_BINDING_POLL_MAX_MS);
    }

    if (!params.waitForBinding) {
      return state;
    }
    await sleepWithAbort(pollDelayMs, params.signal);
  }
}
