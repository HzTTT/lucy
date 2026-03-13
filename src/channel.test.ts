import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadLucyMediaFromSourceMock = vi.hoisted(() => vi.fn());
const publishLucyMachineEventMock = vi.hoisted(() => vi.fn());
const closeConnectionMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  ensureLucyMediaStore: vi.fn(),
  uploadLucyMediaFromSource: vi.fn((params) => uploadLucyMediaFromSourceMock(params)),
}));

vi.mock("./nats.js", () => ({
  buildLucySubjects: vi.fn(),
  connectLucyNats: vi.fn(async () => ({
    close: closeConnectionMock,
  })),
}));

vi.mock("./send.js", () => ({
  publishLucyMachineEvent: vi.fn(async (params) => {
    publishLucyMachineEventMock(params);
    return { eventId: "2080563661542787072" };
  }),
}));

vi.mock("./state.js", () => ({
  loadOrCreateLucyDeviceState: vi.fn(async () => ({
    deviceId: "2080563661542787073",
  })),
}));

vi.mock("./snowflake.js", () => ({
  getProcessSnowflakeGenerator: vi.fn(() => ({
    nextId: () => "2080563661542787072",
  })),
}));

import {
  lucyPlugin,
  mergeLucyMediaLocalRoots,
  normalizeLucyOutboundTarget,
} from "./channel.js";

describe("normalizeLucyOutboundTarget", () => {
  beforeEach(() => {
    uploadLucyMediaFromSourceMock.mockReset();
    uploadLucyMediaFromSourceMock.mockResolvedValue({
      transport: "jetstream-object-store",
      bucket: "lucy_media_v2",
      key: "outbound/demo_user/device/reply.png",
      kind: "image",
      contentType: "image/png",
      size: 5,
      fileName: "reply.png",
      sha256: "abc123",
    });
    publishLucyMachineEventMock.mockReset();
    closeConnectionMock.mockReset();
    closeConnectionMock.mockResolvedValue(undefined);
  });

  it("strips the lucy: prefix used by message tool targets", () => {
    expect(normalizeLucyOutboundTarget("lucy:demo_user")).toBe("demo_user");
  });

  it("keeps already-normalized apiKeys unchanged", () => {
    expect(normalizeLucyOutboundTarget("demo_user")).toBe("demo_user");
  });

  it("returns undefined for empty targets", () => {
    expect(normalizeLucyOutboundTarget("   ")).toBeUndefined();
  });

  it("merges runtime and configured mediaLocalRoots without duplicates", () => {
    expect(
      mergeLucyMediaLocalRoots(
        ["/tmp/openclaw-workspace", "/srv/shared"],
        [" /srv/shared ", "/mnt/lucy-media"],
      ),
    ).toEqual(["/tmp/openclaw-workspace", "/srv/shared", "/mnt/lucy-media"]);
  });

  it("passes merged mediaLocalRoots to outbound media uploads", async () => {
    const sendMedia = lucyPlugin.outbound?.sendMedia;
    expect(sendMedia).toBeTypeOf("function");
    await sendMedia!({
      cfg: {
        channels: {
          lucy: {
            apiKey: "demo_user",
            mediaLocalRoots: [" /srv/lucy-media ", "/tmp/openclaw-workspace"],
          },
        },
      } as OpenClawConfig,
      to: "demo_user",
      text: "caption",
      mediaUrl: "/srv/lucy-media/photo.png",
      mediaLocalRoots: ["/tmp/openclaw-workspace", "/var/lib/openclaw/media"],
      accountId: "default",
    });

    expect(uploadLucyMediaFromSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "/srv/lucy-media/photo.png",
        mediaLocalRoots: [
          "/tmp/openclaw-workspace",
          "/var/lib/openclaw/media",
          "/srv/lucy-media",
        ],
      }),
    );
  });
});
