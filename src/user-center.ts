import type { LucyBindingStatus, LucyDeviceState } from "./types.js";
import { LUCY_USER_CENTER_BASE_URL } from "./types.js";

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

type LucyRegistrationResponse = {
  channel: "lucy";
  channel_device_id: string;
  binding_status: LucyBindingStatus;
};

type LucyBindingResponse = LucyRegistrationResponse & {
  channel_user_key?: string;
};

type LucyUserCenterEnvelope<T> = {
  code: number;
  msg?: string;
  message?: string;
  data?: T;
};

function buildTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

async function parseLucyUserCenterError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as Record<string, unknown>;
      const message =
        (typeof payload.msg === "string" && payload.msg) ||
        (typeof payload.message === "string" && payload.message) ||
        (typeof payload.error === "string" && payload.error) ||
        (typeof payload.code === "string" && payload.code);
      if (message) {
        return `${response.status} ${message}`;
      }
    } catch {
      // Ignore malformed error bodies and fall back to response text below.
    }
  }
  const text = (await response.text()).trim();
  return text ? `${response.status} ${text}` : `${response.status} ${response.statusText}`;
}

async function fetchLucyUserCenterJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${LUCY_USER_CENTER_BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
    signal: init?.signal ?? buildTimeoutSignal(DEFAULT_HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Lucy user-center request failed: ${await parseLucyUserCenterError(response)}`);
  }
  const payload = (await response.json()) as LucyUserCenterEnvelope<T> | T;
  if (
    payload &&
    typeof payload === "object" &&
    "code" in payload &&
    typeof payload.code === "number"
  ) {
    if (payload.code !== 20000) {
      const message =
        (typeof payload.msg === "string" && payload.msg) ||
        (typeof payload.message === "string" && payload.message) ||
        `code=${payload.code}`;
      throw new Error(`Lucy user-center request failed: ${message}`);
    }
    return payload.data as T;
  }
  return payload as T;
}

export function buildLucyBindingCheckUrl(channelDeviceId: string): string {
  return `${LUCY_USER_CENTER_BASE_URL}/v1/channels/lucy/device-bindings/${encodeURIComponent(channelDeviceId)}`;
}

export async function registerLucyDevice(params: {
  channelDeviceId: string;
  bootstrapToken: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LucyRegistrationResponse> {
  const signal =
    params.signal ??
    buildTimeoutSignal(params.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  return await fetchLucyUserCenterJson<LucyRegistrationResponse>(
    "/v1/channels/lucy/devices/registrations",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel_device_id: params.channelDeviceId,
        bootstrap_token: params.bootstrapToken,
      }),
      signal,
    },
  );
}

export async function fetchLucyDeviceBinding(params: {
  channelDeviceId: string;
  bootstrapToken: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LucyBindingResponse> {
  const signal =
    params.signal ??
    buildTimeoutSignal(params.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  return await fetchLucyUserCenterJson<LucyBindingResponse>(
    `/v1/channels/lucy/device-bindings/${encodeURIComponent(params.channelDeviceId)}`,
    {
      headers: {
        "X-Bootstrap-Token": params.bootstrapToken,
      },
      signal,
    },
  );
}

export function mergeLucyBindingIntoState(
  state: LucyDeviceState,
  binding: { binding_status: LucyBindingStatus; channel_user_key?: string },
): LucyDeviceState {
  const nextChannelUserKey = binding.channel_user_key?.trim() || state.channelUserKey;
  let bindingStatus: LucyBindingStatus;
  if (nextChannelUserKey) {
    bindingStatus = "bound";
  } else if (state.bindingStatus === "registered" || binding.binding_status === "registered") {
    // Preserve registered state — don't regress to pending.
    bindingStatus = "registered";
  } else {
    bindingStatus = binding.binding_status;
  }
  return {
    ...state,
    channelUserKey: nextChannelUserKey,
    bindingStatus,
  };
}
