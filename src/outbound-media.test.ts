import type { PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { loadLucyOutboundMediaFromUrl } from "./outbound-media.js";
import { setLucyRuntime } from "./runtime.js";

describe("loadLucyOutboundMediaFromUrl", () => {
  beforeEach(() => {
    setLucyRuntime({
      media: {
        detectMime: async ({ buffer }: { buffer: Buffer }) =>
          buffer.toString("utf8") === "Hello" ? "text/plain" : "video/mp4",
      },
    } as unknown as PluginRuntime);
  });

  it("classifies text media as document", async () => {
    const loaded = await loadLucyOutboundMediaFromUrl("data:text/plain;base64,SGVsbG8=");

    expect(loaded.contentType).toBe("text/plain");
    expect(loaded.kind).toBe("document");
  });

  it("classifies video media as video", async () => {
    const loaded = await loadLucyOutboundMediaFromUrl("data:video/mp4;base64,AAAA");

    expect(loaded.contentType).toBe("video/mp4");
    expect(loaded.kind).toBe("video");
  });
});
