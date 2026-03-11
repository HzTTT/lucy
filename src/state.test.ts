import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLucyRuntime } from "./runtime.js";
import { loadOrCreateLucyDeviceState, readLucyDeviceState } from "./state.js";

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
    expect(first.deviceId).toMatch(/^\d{19}$/);
    expect(second.deviceId).toBe(first.deviceId);

    const stored = await readLucyDeviceState({ forceReload: true });
    expect(stored?.deviceId).toBe(first.deviceId);
  });
});
