import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleLucyInboundMessage } from "./gateway.js";
import { setLucyRuntime } from "./runtime.js";

const publishSpy = vi.fn();

vi.mock("./send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send.js")>();
  return {
    ...actual,
    publishLucyMachineEvent: vi.fn(async (params) => {
      publishSpy(params);
      return {
        version: 1,
        eventId: "2080563661542787072",
        type: params.type,
        timestamp: Date.now(),
        apiKey: params.account.apiKey ?? "",
        deviceId: params.deviceId ?? "2080563661542787073",
      };
    }),
  };
});

function createChannelRuntime() {
  return {
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
          await dispatcherOptions.deliver({ text: "final" });
          return { counts: {} };
        },
      ),
    },
    session: {
      resolveStorePath: vi.fn(() => "/tmp/lucy-session.jsonl"),
      recordInboundSession: vi.fn(async () => undefined),
    },
  } as unknown as PluginRuntime["channel"];
}

describe("handleLucyInboundMessage", () => {
  beforeEach(() => {
    publishSpy.mockClear();
    setLucyRuntime({} as unknown as PluginRuntime);
  });

  it("publishes accepted, tool, reasoning, partial, and final events", async () => {
    const channelRuntime = createChannelRuntime();
    await handleLucyInboundMessage({
      cfg: {
        channels: {
          lucy: {
            apiKey: "demo_user",
          },
        },
      } as OpenClawConfig,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        apiKey: "demo_user",
        servers: ["nats://127.0.0.1:4222"],
        subjectPrefix: "cephalon.im.npc",
        dmPolicy: "allowlist",
        allowFrom: ["demo_user"],
      },
      channelRuntime,
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

  it("emits an error when payload apiKey mismatches the subject namespace", async () => {
    const channelRuntime = createChannelRuntime();
    await handleLucyInboundMessage({
      cfg: {} as OpenClawConfig,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        apiKey: "demo_user",
        servers: ["nats://127.0.0.1:4222"],
        subjectPrefix: "cephalon.im.npc",
        dmPolicy: "allowlist",
        allowFrom: ["demo_user"],
      },
      channelRuntime,
      inbound: {
        version: 1,
        text: "hello",
        apiKey: "wrong",
      },
      deviceId: "2080563661542787073",
    });

    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        text: expect.stringContaining("apiKey"),
      }),
    );
  });
});
