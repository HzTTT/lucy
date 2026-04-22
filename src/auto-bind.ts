import { createHash } from "node:crypto";
import type { AutoBindEnvConfig } from "./auto-bind-env.js";

export const DEFAULT_AUTO_BIND_MAX_ATTEMPTS = 3;
export const DEFAULT_AUTO_BIND_RETRY_DELAY_MS = 2_000;

export type { AutoBindEnvConfig };

export function signBindRequest(secret: string, timestamp: number | string): string {
  return createHash("md5").update(`${secret}${timestamp}`).digest("hex");
}

export interface AutoBindRequestParams {
  userCenterDomain: string;
  cdi: string;
  env: AutoBindEnvConfig;
  now?: () => number;
  fetchFn?: typeof fetch;
}

export type AutoBindOutcome = { ok: true } | { ok: false; reason: string };

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…(truncated)` : value;
}

/**
 * One-shot call to user-center's `POST /v1/devices/bind` using the sign
 * query rule documented in api-v1-devices-bind.md:
 *   user_id, timestamp (seconds), sign=md5(secret+timestamp).
 * Body carries { cdi, mission_id }. Expects envelope code=20000 on success.
 */
export async function autoBindByEnv(
  params: AutoBindRequestParams,
): Promise<AutoBindOutcome> {
  const nowSec = params.now ?? (() => Math.floor(Date.now() / 1_000));
  const timestamp = String(nowSec());
  const sign = signBindRequest(params.env.secret, timestamp);
  const base = params.userCenterDomain.replace(/\/+$/, "");
  const query = new URLSearchParams({
    user_id: params.env.userId,
    timestamp,
    sign,
  });
  const url = `${base}/v1/devices/bind?${query.toString()}`;
  const body = JSON.stringify({
    cdi: params.cdi,
    mission_id: params.env.missionId,
  });

  const doFetch = params.fetchFn ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (e) {
    return { ok: false, reason: `network error: ${String(e)}` };
  }

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, reason: `http ${resp.status}: ${truncate(text, 500)}` };
  }

  let envelope: { code?: number; msg?: string };
  try {
    envelope = JSON.parse(text) as typeof envelope;
  } catch {
    return { ok: false, reason: `invalid json: ${truncate(text, 500)}` };
  }
  if (envelope.code !== 20000) {
    return {
      ok: false,
      reason: `code=${envelope.code ?? "?"} msg=${envelope.msg ?? ""}`,
    };
  }
  return { ok: true };
}

export interface TryAutoBindParams extends AutoBindRequestParams {
  maxAttempts?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retries autoBindByEnv up to `maxAttempts` times with a fixed delay, then
 * returns the last failure reason. Caller decides whether to fall back to
 * the interactive binding path — this function itself never throws for
 * business-level failures (only for abort-via-signal if you wire it in).
 */
export async function tryAutoBindWithRetry(
  params: TryAutoBindParams,
): Promise<AutoBindOutcome> {
  const maxAttempts = params.maxAttempts ?? DEFAULT_AUTO_BIND_MAX_ATTEMPTS;
  const retryDelayMs = params.retryDelayMs ?? DEFAULT_AUTO_BIND_RETRY_DELAY_MS;
  const sleep = params.sleepFn ?? defaultSleep;

  let lastReason = "no attempts executed";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (params.signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }
    const outcome = await autoBindByEnv(params);
    if (outcome.ok) {
      params.log?.info?.(
        `[lucy] auto-bind succeeded on attempt ${attempt}/${maxAttempts}`,
      );
      return outcome;
    }
    lastReason = outcome.reason;
    params.log?.warn?.(
      `[lucy] auto-bind attempt ${attempt}/${maxAttempts} failed: ${outcome.reason}`,
    );
    if (attempt < maxAttempts) {
      await sleep(retryDelayMs, params.signal);
    }
  }
  return { ok: false, reason: lastReason };
}
