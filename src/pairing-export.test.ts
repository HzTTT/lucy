import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readLucyPairingExport, resolveLucyPairingExportPath, syncLucyPairingExport } from "./pairing-export.js";

describe("lucy pairing export", () => {
  function makeTempHome(): string {
    return path.join(os.tmpdir(), `openclaw-lucy-pairing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  it("resolveLucyPairingExportPath returns pairing-info.json inside homeDir", () => {
    const exportPath = resolveLucyPairingExportPath("/tmp/lucy-home");
    expect(exportPath).toBe("/tmp/lucy-home/pairing-info.json");
  });

  it("readLucyPairingExport returns null when file does not exist", async () => {
    const homeDir = makeTempHome();
    const result = await readLucyPairingExport(homeDir);
    expect(result).toBeNull();
  });

  it("syncLucyPairingExport skips silently when cdi file is missing", async () => {
    const homeDir = makeTempHome();
    await fs.mkdir(homeDir, { recursive: true });
    // No channel_ids/cdi file — should not throw
    await expect(syncLucyPairingExport(homeDir)).resolves.toBeUndefined();
    const exportPath = resolveLucyPairingExportPath(homeDir);
    await expect(fs.access(exportPath)).rejects.toThrow();
  });

  it("syncLucyPairingExport writes pairing export from cdi file (pending)", async () => {
    const homeDir = makeTempHome();
    const channelIdsDir = path.join(homeDir, "channel_ids");
    await fs.mkdir(channelIdsDir, { recursive: true });
    await fs.writeFile(path.join(channelIdsDir, "cdi"), "2031655882831360000\n", "utf8");

    await syncLucyPairingExport(homeDir);

    const exportPath = resolveLucyPairingExportPath(homeDir);
    const exported = JSON.parse(await fs.readFile(exportPath, "utf8")) as Record<string, unknown>;

    expect(exported.version).toBe(1);
    expect(exported.channel).toBe("lucy");
    expect(exported.state).toBe("ready");
    expect(exported.channel_device_id).toBe("2031655882831360000");
    expect(exported.binding_status).toBe("pending");
    expect(typeof exported.created_at_ms).toBe("number");
    expect(exported).not.toHaveProperty("bootstrap_token");
    expect(exported).not.toHaveProperty("channel_user_key");
  });

  it("syncLucyPairingExport writes bound status when cuk file present", async () => {
    const homeDir = makeTempHome();
    const channelIdsDir = path.join(homeDir, "channel_ids");
    await fs.mkdir(channelIdsDir, { recursive: true });
    await fs.writeFile(path.join(channelIdsDir, "cdi"), "2031655882831360001\n", "utf8");
    await fs.writeFile(path.join(channelIdsDir, "cuk"), "cuk_demo_user\n", "utf8");

    await syncLucyPairingExport(homeDir);

    const exportPath = resolveLucyPairingExportPath(homeDir);
    const exported = JSON.parse(await fs.readFile(exportPath, "utf8")) as Record<string, unknown>;

    expect(exported.channel_device_id).toBe("2031655882831360001");
    expect(exported.binding_status).toBe("bound");
  });

  it("readLucyPairingExport parses a valid pairing export file", async () => {
    const homeDir = makeTempHome();
    await fs.mkdir(homeDir, { recursive: true });
    const exportPath = resolveLucyPairingExportPath(homeDir);
    const data = {
      version: 1,
      channel: "lucy",
      state: "ready",
      channel_device_id: "2031655882831360002",
      binding_status: "pending",
      created_at_ms: 1_763_000_000_000,
    };
    await fs.writeFile(exportPath, JSON.stringify(data), "utf8");

    const result = await readLucyPairingExport(homeDir);
    expect(result).toEqual(data);
  });
});
