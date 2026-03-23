import { describe, expect, it, vi } from "vitest";
import { defineLucyChannelPluginEntry } from "./channel-plugin-entry.js";

describe("defineLucyChannelPluginEntry", () => {
  it("skips full-only registration outside full mode", () => {
    const plugin = { id: "lucy-test-plugin" };
    const setRuntime = vi.fn();
    const registerFull = vi.fn();
    const registerChannel = vi.fn();
    const entry = defineLucyChannelPluginEntry({
      id: "lucy",
      name: "Lucy",
      description: "Lucy test entry",
      plugin,
      setRuntime,
      registerFull,
    });
    const api = {
      runtime: { log: vi.fn() },
      registerChannel,
      registrationMode: "setup-only",
    } as any;

    entry.register(api);

    expect(setRuntime).toHaveBeenCalledWith(api.runtime);
    expect(registerChannel).toHaveBeenCalledWith({ plugin });
    expect(registerFull).not.toHaveBeenCalled();
  });

  it("treats missing registrationMode as full for older hosts", () => {
    const plugin = { id: "lucy-test-plugin" };
    const setRuntime = vi.fn();
    const registerFull = vi.fn();
    const registerChannel = vi.fn();
    const entry = defineLucyChannelPluginEntry({
      id: "lucy",
      name: "Lucy",
      description: "Lucy test entry",
      plugin,
      setRuntime,
      registerFull,
    });
    const api = {
      runtime: { log: vi.fn() },
      registerChannel,
    } as any;

    entry.register(api);

    expect(setRuntime).toHaveBeenCalledWith(api.runtime);
    expect(registerChannel).toHaveBeenCalledWith({ plugin });
    expect(registerFull).toHaveBeenCalledWith(api);
  });
});
