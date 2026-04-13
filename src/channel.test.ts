import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadLucyMediaFromSourceMock = vi.hoisted(() => vi.fn());
const publishLucyMachineEventMock = vi.hoisted(() => vi.fn());
const getLucyActiveSessionMock = vi.hoisted(() => vi.fn(() => undefined as unknown));
const connectLucySdkMock = vi.hoisted(() => vi.fn());
const sessionShutdownMock = vi.hoisted(() => vi.fn(async () => undefined));

function makeFakeSession() {
  return {
    publishChannel: vi.fn(async () => undefined),
    subscribeChannel: vi.fn(async () => undefined),
    accessToken: vi.fn(() => "cuk_demo_user"),
    shutdown: sessionShutdownMock,
  };
}

vi.mock("./media.js", () => ({
  uploadLucyMediaFromSource: vi.fn((params) => uploadLucyMediaFromSourceMock(params)),
}));

vi.mock("./nats.js", () => ({
  buildNpcSubscribeSubject: vi.fn((userId: string, cdi: string) => `cephalon.im.npc.${userId}.${cdi}`),
  buildNpcPublishSubject: vi.fn((userId: string) => `cephalon.im.user.${userId}`),
  serializeLucyMachineEventJson: vi.fn(() => "{}"),
}));

vi.mock("./send.js", () => ({
  publishLucyMachineEvent: vi.fn(async (params) => {
    publishLucyMachineEventMock(params);
    return { eventId: "2080563661542787072" };
  }),
}));

vi.mock("./auth-binding.js", () => ({
  syncLucyBindingWithSdk: vi.fn(),
  connectLucySdk: vi.fn(async () => {
    connectLucySdkMock();
    return {
      client: makeFakeSession(),
      cdi: "2080563661542787073",
      userId: "user_demo",
      cuk: "cuk_demo_user",
    };
  }),
}));

vi.mock("./gateway.js", () => ({
  // startLucyGateway is referenced by channel.ts but never invoked in these
  // unit tests; a no-op stub is enough to let the import resolve.
  startLucyGateway: vi.fn(),
  getLucyActiveSession: getLucyActiveSessionMock,
}));

vi.mock("./snowflake.js", () => ({
  getProcessSnowflakeGenerator: vi.fn(() => ({
    nextId: () => "2080563661542787072",
  })),
}));

vi.mock("./exec-approval-helpers.js", () => ({
  buildExecApprovalPendingReplyPayload: vi.fn(),
  getExecApprovalReplyMetadata: vi.fn(() => null),
  resolveExecApprovalCommandDisplay: vi.fn(() => ({ commandText: "echo hello" })),
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
      transport: "iroh-blob",
      blob_ref: "blob:abc123",
      kind: "image",
      contentType: "image/png",
      size: 5,
      fileName: "reply.png",
    });
    publishLucyMachineEventMock.mockReset();
    connectLucySdkMock.mockReset();
    sessionShutdownMock.mockReset();
    getLucyActiveSessionMock.mockReset();
    getLucyActiveSessionMock.mockReturnValue(undefined as unknown);
  });

  it("strips the lucy: prefix used by message tool targets", () => {
    expect(normalizeLucyOutboundTarget("lucy:cuk_demo_user")).toBe("cuk_demo_user");
  });

  it("keeps already-normalized channelUserKeys unchanged", () => {
    expect(normalizeLucyOutboundTarget("cuk_demo_user")).toBe("cuk_demo_user");
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
            userCenterDomain: "user-center.lucy.run",
            lucyServerDomain: "chat.lucy.run",
            mediaLocalRoots: [" /srv/lucy-media ", "/tmp/openclaw-workspace"],
          },
        },
      } as OpenClawConfig,
      to: "cuk_demo_user",
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

  it("reuses the active gateway session when one is available", async () => {
    const sharedSession = makeFakeSession();
    getLucyActiveSessionMock.mockReturnValue({
      accountId: "default",
      session: sharedSession,
      cdi: "shared-cdi",
      userId: "shared-user",
      cuk: "shared-cuk",
    });

    const sendText = lucyPlugin.outbound?.sendText;
    expect(sendText).toBeTypeOf("function");
    const result = await sendText!({
      cfg: {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
            lucyServerDomain: "chat.lucy.run",
          },
        },
      } as OpenClawConfig,
      to: "lucy:cuk_remote",
      text: "hi there",
      accountId: "default",
    });

    // We did not need to open a fresh NATS connection:
    expect(connectLucySdkMock).not.toHaveBeenCalled();
    // …and we must not tear down the shared long-lived session afterwards:
    expect(sessionShutdownMock).not.toHaveBeenCalled();
    // The event is still published, and the cdi/userId/cuk come from the
    // shared session rather than a fresh connect.
    expect(publishLucyMachineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        session: sharedSession,
        cdi: "shared-cdi",
        userId: "shared-user",
        cuk: "cuk_remote",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ channel: "lucy", to: "cuk_remote" }),
    );
  });

  it("falls back to a fresh connect when no active session is registered", async () => {
    // Default beforeEach already sets getLucyActiveSession to undefined.
    const sendText = lucyPlugin.outbound?.sendText;
    expect(sendText).toBeTypeOf("function");
    await sendText!({
      cfg: {
        channels: {
          lucy: {
            userCenterDomain: "user-center.lucy.run",
            lucyServerDomain: "chat.lucy.run",
          },
        },
      } as OpenClawConfig,
      to: "cuk_demo_user",
      text: "fallback",
      accountId: "default",
    });

    expect(connectLucySdkMock).toHaveBeenCalledTimes(1);
    // Session was created by this call so it must be shut down in finally{}.
    expect(sessionShutdownMock).toHaveBeenCalledTimes(1);
  });
});

describe("lucyPlugin.execApprovals", () => {
  it("getInitiatingSurfaceState returns enabled for a configured account", () => {
    const cfg = {
      channels: {
        lucy: {
          enabled: true,
          userCenterDomain: "user-center.lucy.run",
          lucyServerDomain: "chat.lucy.run",
        },
      },
    } as any;
    const result = lucyPlugin.execApprovals?.getInitiatingSurfaceState?.({
      cfg,
      accountId: "default",
    });
    expect(result?.kind).toBe("enabled");
  });

  it("getInitiatingSurfaceState returns disabled for an unconfigured account", () => {
    const cfg = {
      channels: { lucy: { enabled: true, channelUserKey: "bad.token" } },
    } as any;
    const result = lucyPlugin.execApprovals?.getInitiatingSurfaceState?.({
      cfg,
      accountId: "default",
    });
    expect(result?.kind).toBe("disabled");
  });
});
