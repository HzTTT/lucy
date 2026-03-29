import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { setLucyRuntime } from "./runtime.js";
import {
  clearLucyRestartTicket,
  readLucyRestartTicket,
  writeLucyRestartTicket,
} from "./restart-ticket.js";

describe("lucy restart ticket", () => {
  const stateDir = path.join(os.tmpdir(), `openclaw-lucy-restart-ticket-${Date.now()}`);

  beforeEach(() => {
    setLucyRuntime({
      state: {
        resolveStateDir: () => stateDir,
      },
    } as unknown as PluginRuntime);
  });

  it("persists and clears a restart ticket used to announce restart completion after boot", async () => {
    await writeLucyRestartTicket({
      version: 1,
      ticketId: "rst_2080563661542787073",
      requestedAtMs: 1_773_000_000_000,
      expectedOnlineAtMs: 1_773_000_045_000,
      expectedOnlineTimeoutMs: 45_000,
      providerId: "cephalon",
      modelId: "kimi-k2.5",
    });

    expect(await readLucyRestartTicket()).toEqual({
      version: 1,
      ticketId: "rst_2080563661542787073",
      requestedAtMs: 1_773_000_000_000,
      expectedOnlineAtMs: 1_773_000_045_000,
      expectedOnlineTimeoutMs: 45_000,
      providerId: "cephalon",
      modelId: "kimi-k2.5",
    });

    await clearLucyRestartTicket();
    expect(await readLucyRestartTicket()).toBeNull();
  });
});
