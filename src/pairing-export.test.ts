import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { readLucyPairingExport, resolveLucyPairingExportPath } from "./pairing-export.js";
import { setLucyRuntime } from "./runtime.js";
import { loadOrCreateLucyDeviceState, resetLucyDeviceState } from "./state.js";

describe("lucy pairing export", () => {
  const stateDir = path.join(os.tmpdir(), `openclaw-lucy-pairing-${Date.now()}`);

  beforeEach(() => {
    setLucyRuntime({
      state: {
        resolveStateDir: () => stateDir,
      },
    } as unknown as PluginRuntime);
  });

  it("writes a sanitized pairing export for the current device state", async () => {
    const state = await loadOrCreateLucyDeviceState({
      forceReload: true,
      overrides: {
        channelUserKey: "cuk_demo_user",
      },
    });

    const pairingInfo = await readLucyPairingExport();
    expect(pairingInfo).toEqual({
      version: 1,
      channel: "lucy",
      state: "ready",
      channel_device_id: state.channelDeviceId,
      binding_status: "bound",
      created_at_ms: state.createdAtMs,
    });
  });

  it("materializes the pairing export for existing state written before the feature", async () => {
    const deviceStatePath = path.join(stateDir, "lucy", "device-state.json");
    await fs.mkdir(path.dirname(deviceStatePath), { recursive: true });
    await fs.writeFile(
      deviceStatePath,
      `${JSON.stringify(
        {
          version: 2,
          channelDeviceId: "2031655882831360000",
          bootstrapToken: "cbt_test",
          bindingStatus: "pending",
          createdAtMs: 1_763_000_000_000,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const state = await loadOrCreateLucyDeviceState({ forceReload: true });
    const exportPath = resolveLucyPairingExportPath();
    const exported = JSON.parse(await fs.readFile(exportPath, "utf8")) as Record<string, unknown>;

    expect(state.channelDeviceId).toBe("2031655882831360000");
    expect(exported).toEqual({
      version: 1,
      channel: "lucy",
      state: "ready",
      channel_device_id: "2031655882831360000",
      binding_status: "pending",
      created_at_ms: 1_763_000_000_000,
    });
    expect(exported).not.toHaveProperty("bootstrap_token");
    expect(exported).not.toHaveProperty("channel_user_key");
  });

  it("refreshes the pairing export after reset-state generates a new device identity", async () => {
    const first = await loadOrCreateLucyDeviceState({ forceReload: true });

    const { previousState, state } = await resetLucyDeviceState();
    const pairingInfo = await readLucyPairingExport();

    expect(previousState?.channelDeviceId).toBe(first.channelDeviceId);
    expect(state.channelDeviceId).not.toBe(first.channelDeviceId);
    expect(pairingInfo).toEqual({
      version: 1,
      channel: "lucy",
      state: "ready",
      channel_device_id: state.channelDeviceId,
      binding_status: "pending",
      created_at_ms: state.createdAtMs,
    });
  });
});
