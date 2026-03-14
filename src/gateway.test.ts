import { Buffer } from "node:buffer";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleLucyInboundMessage } from "./gateway.js";
import { setLucyRuntime } from "./runtime.js";

const publishSpy = vi.fn();
const downloadMediaSpy = vi.fn();
const uploadMediaSpy = vi.fn();
const closeConnectionSpy = vi.fn();

vi.mock("./media.js", () => ({
  downloadLucyMediaDescriptor: vi.fn((params) => downloadMediaSpy(params)),
  ensureLucyMediaStore: vi.fn(async () => ({
    store: {},
    jsm: {},
  })),
  uploadLucyMediaFromSource: vi.fn((params) => uploadMediaSpy(params)),
}));

vi.mock("./send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send.js")>();
  return {
    ...actual,
    publishLucyMachineEvent: vi.fn(async (params) => {
    publishSpy(params);
    return {
      version: 2,
      eventId: params.eventId ?? "2080563661542787072",
      type: params.type,
      timestamp: Date.now(),
      channelUserKey: params.account.channelUserKey ?? "",
      channelDeviceId: params.deviceId ?? "2080563661542787073",
      media: params.media,
    };
  }),
  };
});

vi.mock("./nats.js", () => ({
  buildLucySubjects: vi.fn(),
  connectLucyNats: vi.fn(async () => ({
    close: closeConnectionSpy,
  })),
}));

function createChannelRuntime(options?: {
  finalPayload?: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
}) {
  const recordInboundSession = vi.fn(async () => undefined);
  const saveMediaBuffer = vi.fn(async () => ({
    path: "/tmp/lucy-media.png",
    contentType: "image/png",
  }));

  return {
    runtime: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          sessionKey: "agent:main:main",
          accountId: "default",
        })),
      },
      reply: {
        formatAgentEnvelope: vi.fn(({ body }) => body),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(
          async ({ replyOptions, dispatcherOptions }) => {
            replyOptions?.onAgentRunStart?.("run-1");
            await replyOptions?.onToolStart?.({ name: "web_search", phase: "start" });
            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPartialReply?.({ text: "partial" });
            await replyOptions?.onReasoningStream?.({ text: "thinking", isReasoning: true });
            await replyOptions?.onReasoningEnd?.();
            await dispatcherOptions.deliver(options?.finalPayload ?? { text: "final" });
            return { counts: {} };
          },
        ),
      },
      media: {
        saveMediaBuffer,
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/lucy-session.jsonl"),
        recordInboundSession,
      },
    } as unknown as PluginRuntime["channel"],
    recordInboundSession,
    saveMediaBuffer,
  };
}

function createAccount() {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    channelUserKey: "cuk_demo_user",
    channelDeviceId: "2080563661542787073",
    servers: ["nats://127.0.0.1:4222"],
    subjectPrefix: "cephalon.im.npc",
    dmPolicy: "allowlist" as const,
    allowFrom: ["cuk_demo_user"],
    mediaBucket: "lucy_media_v2",
    mediaRetentionHours: 168,
    mediaMaxBytes: 20 * 1024 * 1024,
  };
}

describe("handleLucyInboundMessage", () => {
  beforeEach(() => {
    publishSpy.mockClear();
    downloadMediaSpy.mockReset();
    uploadMediaSpy.mockReset();
    closeConnectionSpy.mockReset();
    closeConnectionSpy.mockResolvedValue(undefined);
    downloadMediaSpy.mockResolvedValue({
      buffer: Buffer.from("image"),
      contentType: "image/png",
      fileName: "photo.png",
      kind: "image",
    });
    uploadMediaSpy.mockResolvedValue({
      transport: "jetstream-object-store",
      bucket: "lucy_media_v2",
      key: "outbound/demo_user/device/event/reply.png",
      kind: "image",
      contentType: "image/png",
      size: 5,
      fileName: "reply.png",
      sha256: "abc123",
    });
    setLucyRuntime({} as unknown as PluginRuntime);
  });

  it("publishes accepted, tool, reasoning, partial, and final events", async () => {
    const { runtime } = createChannelRuntime();
    await handleLucyInboundMessage({
      cfg: {
        channels: {
          lucy: {
            channelUserKey: "cuk_demo_user",
          },
        },
      } as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: {
        version: 1,
        text: "hello",
      },
      deviceId: "2080563661542787073",
    });

    expect(publishSpy.mock.calls.map(([params]) => params.type)).toEqual(
      expect.arrayContaining([
        "inbound.accepted",
        "tool.start",
        "tool.end",
        "assistant.start",
        "assistant.partial",
        "reasoning.partial",
        "reasoning.final",
        "assistant.final",
      ]),
    );
  });

  it("hydrates inbound media and publishes assistant.final with media descriptor", async () => {
    const { runtime, recordInboundSession, saveMediaBuffer } = createChannelRuntime({
      finalPayload: {
        text: "final with image",
        mediaUrl: "/tmp/reply.png",
      },
    });
    await handleLucyInboundMessage({
      cfg: {
        channels: {
          lucy: {
            channelUserKey: "cuk_demo_user",
          },
        },
      } as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: {
        version: 2,
        text: "describe this image",
        media: {
          transport: "jetstream-object-store",
          bucket: "lucy_media_v2",
          key: "inbound/demo_user/device/photo.png",
          kind: "image",
          contentType: "image/png",
          size: 5,
          fileName: "photo.png",
          sha256: "abc123",
        },
      },
      deviceId: "2080563661542787073",
    });

    expect(downloadMediaSpy).toHaveBeenCalled();
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/png",
      "lucy",
      20 * 1024 * 1024,
      "photo.png",
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaPath: "/tmp/lucy-media.png",
          MediaUrl: "/tmp/lucy-media.png",
          MediaType: "image/png",
        }),
      }),
    );
    expect(uploadMediaSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "/tmp/reply.png",
        trustedLocalPath: true,
      }),
    );
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant.final",
        media: expect.objectContaining({
          key: "outbound/demo_user/device/event/reply.png",
          kind: "image",
        }),
      }),
    );
  });

  it("emits an error when payload channelUserKey mismatches the subject namespace", async () => {
    const { runtime } = createChannelRuntime();
    await handleLucyInboundMessage({
      cfg: {} as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: {
        version: 1,
        text: "hello",
        channelUserKey: "wrong",
      },
      deviceId: "2080563661542787073",
    });

    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        text: expect.stringContaining("channelUserKey"),
      }),
    );
  });
});
