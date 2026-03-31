import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLucyLocalNotifyText,
  startLucyLocalNotifyServer,
} from "./local-notify.js";

const publishSpy = vi.fn();

vi.mock("./send.js", () => ({
  publishLucyMachineEvent: vi.fn(async (params) => {
    publishSpy(params);
    return {
      version: 2,
      eventId: "2080563661542787072",
      type: params.type,
      timestamp: Date.now(),
      channelUserKey: params.account.channelUserKey ?? "",
      channelDeviceId: params.deviceId ?? "2080563661542787073",
      text: params.text,
      metadata: params.metadata,
    };
  }),
}));

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

const serversToStop: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  publishSpy.mockReset();
  await Promise.all(serversToStop.splice(0).map(async (server) => await server.stop()));
});

describe("Lucy local notify text mapping", () => {
  it("builds a readable failure message from the daemon payload", () => {
    expect(
      buildLucyLocalNotifyText({
        code: 4,
        device: "/dev/sdb1",
        timestamp: "2026-03-30T19:02:00.000000",
        message: "磁盘空间不足",
      }),
    ).toBe("U盘同步失败（/dev/sdb1）：磁盘空间不足");
  });
});

describe("Lucy local notify server", () => {
  it("accepts POST JSON and publishes a proactive assistant.final event", async () => {
    const server = await startLucyLocalNotifyServer({
      account: createAccount(),
      connection: {} as never,
      deviceId: "2080563661542787073",
      notify: {
        enabled: true,
        bind: "127.0.0.1",
        port: 0,
        path: "/usb-events",
      },
    });
    serversToStop.push(server);

    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        code: 1,
        device: "/dev/sdb1",
        timestamp: "2026-03-30T19:02:00.000000",
        message: "",
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant.final",
        text: "U盘已插入（/dev/sdb1）",
        metadata: {
          localNotifyCode: "1",
          localNotifyCodeName: "usb.inserted",
          localNotifyDevice: "/dev/sdb1",
          localNotifyTimestamp: "2026-03-30T19:02:00.000000",
          localNotifyMessage: "",
        },
      }),
    );
  });

  it("rejects unsupported methods", async () => {
    const server = await startLucyLocalNotifyServer({
      account: createAccount(),
      connection: {} as never,
      deviceId: "2080563661542787073",
      notify: {
        enabled: true,
        bind: "127.0.0.1",
        port: 0,
        path: "/usb-events",
      },
    });
    serversToStop.push(server);

    const response = await fetch(server.url);

    expect(response.status).toBe(405);
    expect(await response.text()).toContain("Method Not Allowed");
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid payloads without publishing events", async () => {
    const server = await startLucyLocalNotifyServer({
      account: createAccount(),
      connection: {} as never,
      deviceId: "2080563661542787073",
      notify: {
        enabled: true,
        bind: "127.0.0.1",
        port: 0,
        path: "/usb-events",
      },
    });
    serversToStop.push(server);

    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        code: 99,
        device: "/dev/sdb1",
        timestamp: "2026-03-30T19:02:00.000000",
        message: "",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("invalid notify payload");
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
