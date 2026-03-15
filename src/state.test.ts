import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLucyRuntime } from "./runtime.js";
import { loadOrCreateLucyDeviceState, readLucyDeviceState, resetLucyDeviceState } from "./state.js";

describe("lucy device state", () => {
  const stateDir = path.join(os.tmpdir(), `openclaw-lucy-test-${Date.now()}`);

  beforeEach(() => {
    setLucyRuntime({
      state: {
        resolveStateDir: () => stateDir,
      },
    } as unknown as PluginRuntime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists and reuses a generated device id", async () => {
    const first = await loadOrCreateLucyDeviceState({ forceReload: true });
    const second = await loadOrCreateLucyDeviceState({ forceReload: true });
    expect(first.channelDeviceId).toMatch(/^\d{19}$/);
    expect(first.bootstrapToken).toMatch(/^cbt_/);
    expect(first.bindingStatus).toBe("pending");
    expect(second.channelDeviceId).toBe(first.channelDeviceId);

    const stored = await readLucyDeviceState({ forceReload: true });
    expect(stored?.channelDeviceId).toBe(first.channelDeviceId);
    expect(stored?.bootstrapToken).toBe(first.bootstrapToken);
  });

  it("resets local binding state and regenerates device credentials", async () => {
    const existing = await loadOrCreateLucyDeviceState({
      forceReload: true,
      overrides: {
        channelUserKey: "cuk_demo_user",
      },
    });

    const { previousState, state } = await resetLucyDeviceState();

    expect(previousState?.channelDeviceId).toBe(existing.channelDeviceId);
    expect(previousState?.channelUserKey).toBe("cuk_demo_user");
    expect(state.channelDeviceId).toMatch(/^\d{19}$/);
    expect(state.channelDeviceId).not.toBe(existing.channelDeviceId);
    expect(state.bootstrapToken).toMatch(/^cbt_/);
    expect(state.bootstrapToken).not.toBe(existing.bootstrapToken);
    expect(state.channelUserKey).toBeUndefined();
    expect(state.bindingStatus).toBe("pending");

    const stored = await readLucyDeviceState({ forceReload: true });
    expect(stored).toEqual(state);
  });
});
