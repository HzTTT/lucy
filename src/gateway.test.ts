import { Buffer } from "node:buffer";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleLucyInboundMessage } from "./gateway.js";
import { setLucyRuntime } from "./runtime.js";
import { LucyMachineEventSchema, LucyMachineEventTypeSchema } from "./types.js";

const publishSpy = vi.fn();
const downloadMediaSpy = vi.fn();
const uploadMediaSpy = vi.fn();

vi.mock("./media.js", () => ({
  downloadLucyMediaDescriptor: vi.fn((params) => downloadMediaSpy(params)),
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
        channelUserKey: params.cuk ?? "",
        channelDeviceId: params.cdi ?? "2080563661542787073",
        media: params.media,
      };
    }),
  };
});

// Stub nats.ts (no longer exports connectLucyNats etc., but the mock keeps tests isolated)
vi.mock("./nats.js", () => ({
  buildNpcSubscribeSubject: vi.fn((userId: string, cdi: string) => `cephalon.im.npc.${userId}.${cdi}`),
  buildNpcPublishSubject: vi.fn((userId: string) => `cephalon.im.user.${userId}`),
  serializeLucyMachineEventJson: vi.fn(() => "{}"),
}));

function createMockSession() {
  return {
    publishChannel: vi.fn(async () => undefined),
    subscribeChannel: vi.fn(async () => undefined),
    accessToken: vi.fn(() => "cuk_demo_user"),
    shutdown: vi.fn(async () => undefined),
  };
}

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
    userCenterDomain: "user-center.lucy.run",
    lucyServerDomain: "chat.lucy.run",
    homeDir: "~/.lucy/identity/",
    deviceType: "cloud",
    subjectPrefix: "cephalon.im.npc",
    dmPolicy: "allowlist" as const,
    allowFrom: ["cuk_demo_user"],
    mediaMaxBytes: 20 * 1024 * 1024,
    maxAttachments: 10,
  };
}

describe("handleLucyInboundMessage", () => {
  beforeEach(() => {
    publishSpy.mockClear();
    downloadMediaSpy.mockReset();
    uploadMediaSpy.mockReset();
    downloadMediaSpy.mockResolvedValue({
      buffer: Buffer.from("image"),
      contentType: "image/png",
      fileName: "photo.png",
    });
    uploadMediaSpy.mockResolvedValue({
      transport: "iroh-blob",
      blob_ref: "blob:abc123",
      kind: "image",
      contentType: "image/png",
      size: 5,
      fileName: "reply.png",
    });
    setLucyRuntime({} as unknown as PluginRuntime);
  });

  it("publishes accepted, tool, reasoning, partial, and final events", async () => {
    const { runtime } = createChannelRuntime();
    const session = createMockSession();
    await handleLucyInboundMessage({
      cfg: {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
          },
        },
      } as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: {
        version: 1,
        text: "hello",
      },
      session: session as unknown as Parameters<typeof handleLucyInboundMessage>[0]["session"],
      userId: "user_demo",
      cuk: "cuk_demo_user",
      cdi: "2080563661542787073",
    });

    const types = publishSpy.mock.calls.map(([params]) => params.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "inbound.accepted",
        "tool.start",
        "tool.end",
        "assistant.start",
        "assistant.partial",
        "reasoning.partial",
        "reasoning.final",
        "assistant.final",
        "assistant.complete",
      ]),
    );
    expect(types[types.length - 1]).toBe("assistant.complete");
    const completeCall = publishSpy.mock.calls.find(
      ([params]) => params.type === "assistant.complete",
    )?.[0];
    expect(completeCall).toMatchObject({
      sourceMessageId: expect.any(String),
      runId: "run-1",
    });
  });

  it("emits assistant.complete in finally even when dispatcher throws", async () => {
    const recordInboundSession = vi.fn(async () => undefined);
    const runtime = {
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
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ replyOptions }) => {
          replyOptions?.onAgentRunStart?.("run-err");
          throw new Error("upstream provider 401");
        }),
      },
      media: { saveMediaBuffer: vi.fn() },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/lucy-session.jsonl"),
        recordInboundSession,
      },
    } as unknown as PluginRuntime["channel"];
    const session = createMockSession();

    await expect(
      handleLucyInboundMessage({
        cfg: {
          channels: { lucy: { userCenterDomain: "user-center.lucy.run" } },
        } as OpenClawConfig,
        account: createAccount(),
        channelRuntime: runtime,
        inbound: { version: 1, text: "hi" },
        session: session as unknown as Parameters<typeof handleLucyInboundMessage>[0]["session"],
        userId: "user_demo",
        cuk: "cuk_demo_user",
        cdi: "2080563661542787073",
      }),
    ).rejects.toThrow("upstream provider 401");

    const types = publishSpy.mock.calls.map(([params]) => params.type);
    expect(types[types.length - 1]).toBe("assistant.complete");
    // Contract: error event must be emitted BEFORE assistant.complete so the
    // last event for any inbound run is always assistant.complete.
    const errorIdx = types.lastIndexOf("error");
    const completeIdx = types.lastIndexOf("assistant.complete");
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(completeIdx);
    const errorCall = publishSpy.mock.calls.find(
      ([params]) => params.type === "error",
    )?.[0];
    expect(errorCall).toMatchObject({
      runId: "run-err",
      sourceMessageId: expect.any(String),
    });
    const completeCall = publishSpy.mock.calls.find(
      ([params]) => params.type === "assistant.complete",
    )?.[0];
    expect(completeCall).toMatchObject({ runId: "run-err" });
  });

  it("pairs every tool.start with a tool.end on consecutive tool calls", async () => {
    const recordInboundSession = vi.fn(async () => undefined);
    const runtime = {
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
            replyOptions?.onAgentRunStart?.("run-tools");
            // Two consecutive tool calls without an intervening assistant
            // message, then a third tool call after a message, then end.
            await replyOptions?.onToolStart?.({ name: "tool_a", phase: "start" });
            await replyOptions?.onToolStart?.({ name: "tool_b", phase: "start" });
            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onToolStart?.({ name: "tool_c", phase: "start" });
            await dispatcherOptions.deliver({ text: "done" });
            return { counts: {} };
          },
        ),
      },
      media: { saveMediaBuffer: vi.fn() },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/lucy-session.jsonl"),
        recordInboundSession,
      },
    } as unknown as PluginRuntime["channel"];
    const session = createMockSession();

    await handleLucyInboundMessage({
      cfg: {
        channels: { lucy: { userCenterDomain: "user-center.lucy.run" } },
      } as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: { version: 1, text: "trigger consecutive tools" },
      session: session as unknown as Parameters<typeof handleLucyInboundMessage>[0]["session"],
      userId: "user_demo",
      cuk: "cuk_demo_user",
      cdi: "2080563661542787073",
    });

    const types = publishSpy.mock.calls.map(([params]) => params.type);
    const startCount = types.filter((t) => t === "tool.start").length;
    const endCount = types.filter((t) => t === "tool.end").length;
    expect(startCount).toBe(3);
    expect(endCount).toBe(3);
    expect(types[types.length - 1]).toBe("assistant.complete");
  });

  it("emits one assistant.final per delivered block but exactly one assistant.complete at the end", async () => {
    const recordInboundSession = vi.fn(async () => undefined);
    const runtime = {
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
            replyOptions?.onAgentRunStart?.("run-multi");
            // Mirror real "media + text" multi-block flow: dispatcher
            // delivers the media block immediately, then the text block at
            // the end. Each deliver() should emit its own assistant.final.
            await dispatcherOptions.deliver({ text: undefined, mediaUrl: "/tmp/photo.png" });
            await dispatcherOptions.deliver({ text: "here is the photo" });
            return { counts: {} };
          },
        ),
      },
      media: { saveMediaBuffer: vi.fn() },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/lucy-session.jsonl"),
        recordInboundSession,
      },
    } as unknown as PluginRuntime["channel"];
    const session = createMockSession();

    await handleLucyInboundMessage({
      cfg: {
        channels: { lucy: { userCenterDomain: "user-center.lucy.run" } },
      } as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: { version: 1, text: "send a photo" },
      session: session as unknown as Parameters<typeof handleLucyInboundMessage>[0]["session"],
      userId: "user_demo",
      cuk: "cuk_demo_user",
      cdi: "2080563661542787073",
    });

    const types = publishSpy.mock.calls.map(([params]) => params.type);
    const finalCount = types.filter((t) => t === "assistant.final").length;
    const completeCount = types.filter((t) => t === "assistant.complete").length;
    expect(finalCount).toBe(2);
    expect(completeCount).toBe(1);
    expect(types[types.length - 1]).toBe("assistant.complete");
  });

  it("hydrates inbound media and publishes assistant.final with media descriptor", async () => {
    const { runtime, recordInboundSession, saveMediaBuffer } = createChannelRuntime({
      finalPayload: {
        text: "final with image",
        mediaUrl: "/tmp/reply.png",
      },
    });
    const session = createMockSession();
    await handleLucyInboundMessage({
      cfg: {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
          },
        },
      } as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: {
        version: 2,
        text: "describe this image",
        media: {
          transport: "iroh-blob",
          blob_ref: "blob:inbound_photo",
          kind: "image",
          contentType: "image/png",
          size: 5,
          fileName: "photo.png",
        },
      },
      session: session as unknown as Parameters<typeof handleLucyInboundMessage>[0]["session"],
      userId: "user_demo",
      cuk: "cuk_demo_user",
      cdi: "2080563661542787073",
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
          blob_ref: "blob:abc123",
          kind: "image",
        }),
      }),
    );
  });

  it("accepts document media descriptors in inbound and outbound flows", async () => {
    downloadMediaSpy.mockResolvedValueOnce({
      buffer: Buffer.from("%PDF"),
      contentType: "application/pdf",
      fileName: "spec.pdf",
    });
    uploadMediaSpy.mockResolvedValueOnce({
      transport: "iroh-blob",
      blob_ref: "blob:spec_pdf",
      kind: "document",
      contentType: "application/pdf",
      size: 4,
      fileName: "spec.pdf",
    });
    const { runtime, recordInboundSession, saveMediaBuffer } = createChannelRuntime({
      finalPayload: {
        text: "final with document",
        mediaUrl: "/tmp/spec.pdf",
      },
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/spec.pdf",
      contentType: "application/pdf",
    });

    const session = createMockSession();
    await handleLucyInboundMessage({
      cfg: {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
          },
        },
      } as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: {
        version: 2,
        text: "summarize this document",
        media: {
          transport: "iroh-blob",
          blob_ref: "blob:inbound_spec",
          kind: "document",
          contentType: "application/pdf",
          size: 4,
          fileName: "spec.pdf",
        },
      },
      session: session as unknown as Parameters<typeof handleLucyInboundMessage>[0]["session"],
      userId: "user_demo",
      cuk: "cuk_demo_user",
      cdi: "2080563661542787073",
    });

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "lucy",
      20 * 1024 * 1024,
      "spec.pdf",
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaPath: "/tmp/spec.pdf",
          MediaUrl: "/tmp/spec.pdf",
          MediaType: "application/pdf",
        }),
      }),
    );
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant.final",
        media: expect.objectContaining({
          kind: "document",
          fileName: "spec.pdf",
        }),
      }),
    );
  });

  it("supports v4 multi-attachment inbound and outbound payloads", async () => {
    downloadMediaSpy
      .mockResolvedValueOnce({
        buffer: Buffer.from("image-1"),
        contentType: "image/png",
        fileName: "photo-1.png",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("image-2"),
        contentType: "image/jpeg",
        fileName: "photo-2.jpg",
      });
    uploadMediaSpy
      .mockResolvedValueOnce({
        transport: "iroh-blob",
        blob_ref: "blob:reply_1",
        kind: "image",
        contentType: "image/png",
        size: 7,
        fileName: "reply-1.png",
      })
      .mockResolvedValueOnce({
        transport: "iroh-blob",
        blob_ref: "blob:reply_2",
        kind: "image",
        contentType: "image/jpeg",
        size: 9,
        fileName: "reply-2.jpg",
      });
    const { runtime, recordInboundSession, saveMediaBuffer } = createChannelRuntime({
      finalPayload: {
        text: "final with images",
        mediaUrls: ["/tmp/reply-1.png", "/tmp/reply-2.jpg"],
      },
    });
    saveMediaBuffer
      .mockResolvedValueOnce({
        path: "/tmp/photo-1.png",
        contentType: "image/png",
      })
      .mockResolvedValueOnce({
        path: "/tmp/photo-2.jpg",
        contentType: "image/jpeg",
      });

    const session = createMockSession();
    await handleLucyInboundMessage({
      cfg: {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
          },
        },
      } as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: {
        version: 4,
        kind: "chat",
        text: "describe these images",
        attachments: [
          {
            transport: "iroh-blob",
            blob_ref: "blob:inbound_photo_1",
            kind: "image",
            contentType: "image/png",
            size: 7,
            fileName: "photo-1.png",
          },
          {
            transport: "iroh-blob",
            blob_ref: "blob:inbound_photo_2",
            kind: "image",
            contentType: "image/jpeg",
            size: 9,
            fileName: "photo-2.jpg",
          },
        ],
      },
      session: session as unknown as Parameters<typeof handleLucyInboundMessage>[0]["session"],
      userId: "user_demo",
      cuk: "cuk_demo_user",
      cdi: "2080563661542787073",
    });

    expect(downloadMediaSpy).toHaveBeenCalledTimes(2);
    expect(saveMediaBuffer).toHaveBeenCalledTimes(2);
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaPath: "/tmp/photo-1.png",
          MediaPaths: ["/tmp/photo-1.png", "/tmp/photo-2.jpg"],
          MediaType: "image/png",
          MediaTypes: ["image/png", "image/jpeg"],
        }),
      }),
    );
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant.final",
        media: expect.objectContaining({
          blob_ref: "blob:reply_1",
        }),
        attachments: [
          expect.objectContaining({ blob_ref: "blob:reply_1" }),
          expect.objectContaining({ blob_ref: "blob:reply_2" }),
        ],
      }),
    );
  });

  it("emits an error when payload channelUserKey mismatches the subject namespace", async () => {
    const { runtime } = createChannelRuntime();
    const session = createMockSession();
    await handleLucyInboundMessage({
      cfg: {} as OpenClawConfig,
      account: createAccount(),
      channelRuntime: runtime,
      inbound: {
        version: 1,
        text: "hello",
        channelUserKey: "wrong",
      },
      session: session as unknown as Parameters<typeof handleLucyInboundMessage>[0]["session"],
      userId: "user_demo",
      cuk: "cuk_demo_user",
      cdi: "2080563661542787073",
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
  it("start() loads gateway runtime from the host openclaw entry and stop() delegates to client", async () => {
    // Arrange
    const mockGatewayClient = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const createClientMock = vi.fn().mockResolvedValue(mockGatewayClient);
    const hostRequireMock = vi.fn((specifier: string) => {
      if (specifier === "openclaw/plugin-sdk/gateway-runtime") {
        return {
          createOperatorApprovalsGatewayClient: createClientMock,
        };
      }
      throw new Error(`unexpected host require: ${specifier}`);
    });
    const createRequireMock = vi.fn(() => hostRequireMock);

    vi.resetModules();
    vi.doMock("node:module", () => ({
      createRequire: createRequireMock,
    }));

    const mockAccount = {
      accountId: "default",
      userCenterDomain: "user-center.lucy.run",
      lucyServerDomain: "chat.lucy.run",
      homeDir: "~/.lucy/identity/",
      deviceType: "cloud",
      subjectPrefix: "cephalon.im.npc",
      mediaMaxBytes: 20 * 1024 * 1024,
      maxAttachments: 10,
      enabled: true,
      configured: true,
      dmPolicy: "open" as const,
      allowFrom: [],
    };

    const mockSession = {
      publishChannel: vi.fn(async () => undefined),
      subscribeChannel: vi.fn(async () => undefined),
      accessToken: vi.fn(() => "cuk_demo"),
      shutdown: vi.fn(async () => undefined),
    };

    // Dynamically import after mocks are set so the module cache is clean
    const { LucyExecApprovalHandler } = await import("./exec-approvals-handler.js");

    const handler = new LucyExecApprovalHandler(
      {} as ConstructorParameters<typeof LucyExecApprovalHandler>[0],
      mockAccount as unknown as ConstructorParameters<typeof LucyExecApprovalHandler>[1],
      "1234567890123456789",
      mockSession as unknown as ConstructorParameters<typeof LucyExecApprovalHandler>[3],
      "user_demo",
      "cuk_demo",
    );
    await handler.start();

    expect(createRequireMock).toHaveBeenCalled();
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
