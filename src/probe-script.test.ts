import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/print-probe-fields.mjs", import.meta.url));

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "lucy-probe-script-"));
}

async function removeDir(dirPath: string) {
  await fs.rm(dirPath, { recursive: true, force: true });
}

describe("print-probe-fields script", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map(async (dirPath) => await removeDir(dirPath)));
  });

  it("prints the probe fields from config and device state files", async () => {
    const tempDir = await makeTempDir();
    cleanupDirs.push(tempDir);

    const configPath = path.join(tempDir, "openclaw.json");
    const deviceStatePath = path.join(tempDir, "device-state.json");
    await fs.writeFile(
      configPath,
      `{
        // JSON5 comments and trailing commas are allowed in OpenClaw config
        channels: {
          lucy: {
            channelUserKey: "cuk_demo_user",
            subjectPrefix: "cephalon.im.npc",
            mediaBucket: "lucy_media_v2",
            mediaRetentionHours: 72,
          },
        },
      }
`,
      "utf8",
    );
    await fs.writeFile(
      deviceStatePath,
      JSON.stringify({
        version: 2,
        channelDeviceId: "2031378112080429056",
        bootstrapToken: "cbt_test",
        bindingStatus: "bound",
        channelUserKey: "cuk_demo_user",
        createdAtMs: 1773160840000,
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--config",
      configPath,
      "--state",
      deviceStatePath,
    ]);

    expect(JSON.parse(stdout)).toEqual({
      channelDeviceId: "2031378112080429056",
      clientSubject: "cephalon.im.npc.cuk_demo_user.2031378112080429056.client",
      machineSubject: "cephalon.im.npc.cuk_demo_user.2031378112080429056.machine",
      mediaBucket: "lucy_media_v2",
      mediaRetentionHours: 72,
    });
  });

  it("falls back to Lucy defaults when optional config fields are missing", async () => {
    const tempDir = await makeTempDir();
    cleanupDirs.push(tempDir);

    const configPath = path.join(tempDir, "openclaw.json");
    const deviceStatePath = path.join(tempDir, "device-state.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        channels: {
          lucy: {
            channelUserKey: "cuk_demo_user",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      deviceStatePath,
      JSON.stringify({
        version: 2,
        channelDeviceId: "2031378112080429056",
        bootstrapToken: "cbt_test",
        bindingStatus: "bound",
        channelUserKey: "cuk_demo_user",
        createdAtMs: 1773160840000,
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--config",
      configPath,
      "--state",
      deviceStatePath,
    ]);

    expect(JSON.parse(stdout)).toEqual({
      channelDeviceId: "2031378112080429056",
      clientSubject: "cephalon.im.npc.cuk_demo_user.2031378112080429056.client",
      machineSubject: "cephalon.im.npc.cuk_demo_user.2031378112080429056.machine",
      mediaBucket: "lucy_media_v2",
      mediaRetentionHours: 168,
    });
  });
});
