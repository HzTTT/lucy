import { describe, it, expect, vi } from "vitest";
import {
  autoBindByEnv,
  signBindRequest,
  tryAutoBindWithRetry,
} from "./auto-bind.js";
import { readAutoBindEnvConfig } from "./auto-bind-env.js";

describe("readAutoBindEnvConfig", () => {
  it("returns undefined when any of the three vars is missing or empty", () => {
    expect(readAutoBindEnvConfig({})).toBeUndefined();
    expect(
      readAutoBindEnvConfig({ LUCY_USER_ID: "123", LUCY_MISSION_ID: "456" }),
    ).toBeUndefined();
    expect(
      readAutoBindEnvConfig({
        LUCY_USER_ID: "123",
        LUCY_MISSION_ID: "456",
        LUCY_BIND_SECRET: "  ",
      }),
    ).toBeUndefined();
  });

  it("trims and returns the triple when all three are set", () => {
    expect(
      readAutoBindEnvConfig({
        LUCY_USER_ID: " 123 ",
        LUCY_MISSION_ID: "456",
        LUCY_BIND_SECRET: "sekrit",
      }),
    ).toEqual({ userId: "123", missionId: "456", secret: "sekrit" });
  });
});

describe("signBindRequest", () => {
  it("computes md5(secret + timestamp) in lowercase hex", () => {
    // md5("sekrit1713700000") pre-computed
    const expected = "a54afa9d309ce536d83f62d6188ee381";
    expect(signBindRequest("sekrit", 1_713_700_000)).toBe(expected);
    expect(signBindRequest("sekrit", "1713700000")).toBe(expected);
  });
});

describe("autoBindByEnv", () => {
  const env = { userId: "123", missionId: "456", secret: "sekrit" };

  it("sends POST to /v1/devices/bind with sign query + cdi/mission_id body", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ code: 20000, msg: "ok", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const outcome = await autoBindByEnv({
      userCenterDomain: "https://uc.example.com/",
      cdi: "dev_cdi",
      env,
      now: () => 1_713_700_000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const firstCall = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe(
      "https://uc.example.com/v1/devices/bind?user_id=123&timestamp=1713700000&sign=a54afa9d309ce536d83f62d6188ee381",
    );
    expect(firstCall[1]?.method).toBe("POST");
    expect(JSON.parse(firstCall[1]?.body as string)).toEqual({
      cdi: "dev_cdi",
      mission_id: "456",
    });
  });

  it("returns a failure reason when envelope code is not 20000", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ code: 40019, msg: "设备未就绪" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const outcome = await autoBindByEnv({
      userCenterDomain: "https://uc.example.com",
      cdi: "dev_cdi",
      env,
      now: () => 0,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("40019");
    expect((outcome as { reason: string }).reason).toContain("设备未就绪");
  });

  it("returns a failure reason on non-2xx HTTP status", async () => {
    const fetchFn = vi.fn(async () => new Response("gateway timeout", { status: 504 }));
    const outcome = await autoBindByEnv({
      userCenterDomain: "https://uc.example.com",
      cdi: "dev_cdi",
      env,
      now: () => 0,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("http 504");
  });

  it("returns a failure reason on network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await autoBindByEnv({
      userCenterDomain: "https://uc.example.com",
      cdi: "dev_cdi",
      env,
      now: () => 0,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("network error");
  });
});

describe("tryAutoBindWithRetry", () => {
  const env = { userId: "123", missionId: "456", secret: "sekrit" };

  it("stops on first success and returns ok", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ code: 20000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const sleepFn = vi.fn(async () => undefined);
    const outcome = await tryAutoBindWithRetry({
      userCenterDomain: "https://uc.example.com",
      cdi: "dev_cdi",
      env,
      now: () => 0,
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
      maxAttempts: 3,
    });
    expect(outcome).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("retries up to maxAttempts and returns the last failure reason", async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call++;
      return new Response(JSON.stringify({ code: 40019, msg: `try${call}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const sleepFn = vi.fn(async () => undefined);
    const outcome = await tryAutoBindWithRetry({
      userCenterDomain: "https://uc.example.com",
      cdi: "dev_cdi",
      env,
      now: () => 0,
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
      maxAttempts: 3,
      retryDelayMs: 10,
    });
    expect(outcome.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect((outcome as { reason: string }).reason).toContain("try3");
  });

  it("bails out immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn();
    const outcome = await tryAutoBindWithRetry({
      userCenterDomain: "https://uc.example.com",
      cdi: "dev_cdi",
      env,
      signal: controller.signal,
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: async () => undefined,
      maxAttempts: 3,
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("aborted");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
