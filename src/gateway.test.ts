import { Buffer } from "node:buffer";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleLucyInboundMessage } from "./gateway.js";
import { setLucyRuntime } from "./runtime.js";
import { LucyMachineEventSchema, LucyMachineEventTypeSchema } from "./types.js";

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

describe("LucyMachineEventSchema approval fields", () => {
  it("accepts approval.pending event type", () => {
    expect(LucyMachineEventTypeSchema.options).toContain("approval.pending");
    expect(LucyMachineEventTypeSchema.options).toContain("approval.resolved");
  });

  it("parses approval.pending event with all approval fields", () => {
    const raw = {
      version: 2,
      eventId: "1234567890123456789",
      type: "approval.pending",
      timestamp: 1711267200000,
      channelUserKey: "cuk_demo",
      channelDeviceId: "1234567890123456789",
      approvalId: "apv_abc123def456",
      approvalSlug: "apv_abc1",
      approvalCommand: "rm -rf /tmp/build",
      approvalCwd: "/home/user",
      approvalHost: "gateway",
      approvalExpiresAtMs: 1711267260000,
      approvalAllowedDecisions: ["allow-once", "allow-always", "deny"],
    };
    const result = LucyMachineEventSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approvalId).toBe("apv_abc123def456");
      expect(result.data.approvalExpiresAtMs).toBe(1711267260000);
      expect(result.data.approvalAllowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);
    }
  });

  it("parses approval.resolved event with decision fields", () => {
    const raw = {
      version: 2,
      eventId: "1234567890123456790",
      type: "approval.resolved",
      timestamp: 1711267210000,
      channelUserKey: "cuk_demo",
      channelDeviceId: "1234567890123456789",
      approvalId: "apv_abc123def456",
      approvalDecision: "allow-once",
      approvalResolvedBy: "cuk_demo",
    };
    const result = LucyMachineEventSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approvalDecision).toBe("allow-once");
      expect(result.data.approvalResolvedBy).toBe("cuk_demo");
    }
  });
});

describe("LucyExecApprovalHandler", () => {
  it("publishes approval.pending event with correct fields on handleRequested", async () => {
    // Arrange
    const mockGatewayClient = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const createClientMock = vi.fn().mockResolvedValue(mockGatewayClient);

    vi.resetModules();
    vi.doMock("openclaw/plugin-sdk/gateway-runtime", () => ({
      createOperatorApprovalsGatewayClient: createClientMock,
    }));

    const mockAccount = {
      accountId: "default",
      channelUserKey: "cuk_demo",
      subjectPrefix: "cephalon.im.npc",
      mediaBucket: "lucy_media_v2",
      mediaRetentionHours: 168,
      mediaMaxBytes: 20 * 1024 * 1024,
      enabled: true,
      configured: true,
      servers: ["nats://127.0.0.1:4222"],
      dmPolicy: "open" as const,
      allowFrom: [],
    };

    // Dynamically import after mocks are set so the module cache is clean
    const { LucyExecApprovalHandler } = await import("./exec-approvals-handler.js");

    const handler = new LucyExecApprovalHandler(
      {} as any, // oxlint-disable-line typescript/no-explicit-any
      mockAccount as any, // oxlint-disable-line typescript/no-explicit-any
      "1234567890123456789",
      {} as any, // oxlint-disable-line typescript/no-explicit-any
    );
    await handler.start();

    expect(createClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        clientDisplayName: expect.stringContaining("Lucy Exec Approvals"),
      }),
    );
    handler.stop();
    expect(mockGatewayClient.stop).toHaveBeenCalled();
  });
});
