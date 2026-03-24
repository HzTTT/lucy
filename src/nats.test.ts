import { Buffer } from "node:buffer";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { buildLucyNatsConnectionOptions, connectLucyNats, encodeLucyMachineEvent } from "./nats.js";
import type { LucyMachineEvent } from "./types.js";
import type { ResolvedLucyAccount } from "./types.js";

type MockSession = {
  buffer: string;
  sid?: string;
  user?: string;
  pass?: string;
};

const serversToClose: WebSocketServer[] = [];

function createAccount(server: string): ResolvedLucyAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    channelUserKey: "cuk_demo_user",
    channelDeviceId: "2080563661542787073",
    servers: [server],
    subjectPrefix: "cephalon.im.npc",
    dmPolicy: "allowlist",
    allowFrom: ["cuk_demo_user"],
    mediaBucket: "lucy_media_v2",
    mediaRetentionHours: 168,
    mediaMaxBytes: 20 * 1024 * 1024,
  };
}

function createInfoFrame(port: number): Buffer {
  return Buffer.from(
    `INFO {"server_id":"S","server_name":"S","version":"2.10.22","proto":1,"go":"go1.22.8","host":"127.0.0.1","port":${port},"headers":true,"auth_required":true,"max_payload":1048576,"jetstream":true,"client_id":1,"client_ip":"127.0.0.1"} \r\n`,
    "utf8",
  );
}

function processClientFrames(
  session: MockSession,
  ws: import("ws").WebSocket,
): void {
  while (true) {
    const lineBreak = session.buffer.indexOf("\r\n");
    if (lineBreak === -1) {
      return;
    }
    const line = session.buffer.slice(0, lineBreak);
    if (line.startsWith("PUB ")) {
      const match = /^PUB\s+(\S+)\s+(\d+)$/.exec(line);
      if (!match) {
        throw new Error(`unexpected PUB line: ${line}`);
      }
      const [, subject, byteCountRaw] = match;
      const byteCount = Number(byteCountRaw);
      const requiredLength = lineBreak + 2 + byteCount + 2;
      if (session.buffer.length < requiredLength) {
        return;
      }
      const payloadStart = lineBreak + 2;
      const payload = session.buffer.slice(payloadStart, payloadStart + byteCount);
      session.buffer = session.buffer.slice(requiredLength);
      if (session.sid) {
        ws.send(Buffer.from(`MSG ${subject} ${session.sid} ${byteCount}\r\n${payload}\r\n`, "utf8"));
      }
      continue;
    }

    session.buffer = session.buffer.slice(lineBreak + 2);
    if (line.startsWith("CONNECT ")) {
      const payload = JSON.parse(line.slice("CONNECT ".length));
      session.user = payload.user;
      session.pass = payload.pass;
      if (session.user !== "cuk_demo_user" || session.pass !== "2080563661542787073") {
        ws.send(Buffer.from(`-ERR 'Authorization Violation'\r\n`, "utf8"));
        ws.close(1008, "Authentication Failure");
        return;
      }
      continue;
    }
    if (line === "PING") {
      ws.send(Buffer.from("PONG\r\n", "utf8"));
      continue;
    }
    if (line.startsWith("SUB ")) {
      const parts = line.split(/\s+/);
      session.sid = parts.at(-1);
      continue;
    }
  }
}

async function createMockNatsWebSocketServer(): Promise<string> {
  const wss = new WebSocketServer({
    port: 0,
    path: "/nats-ws",
    perMessageDeflate: false,
  });
  serversToClose.push(wss);

  wss.on("connection", (ws) => {
    const port = (wss.address() as AddressInfo).port;
    const session: MockSession = { buffer: "" };
    ws.send(createInfoFrame(port));
    ws.on("message", (data) => {
      session.buffer += Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      processClientFrames(session, ws);
    });
  });

  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  return `ws://127.0.0.1:${port}/nats-ws`;
}

afterEach(async () => {
  const current = serversToClose.splice(0, serversToClose.length);
  await Promise.all(
    current.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

describe("lucy nats transport", () => {
  it("encodes machine events with protocol field names from the auth-binding docs", () => {
    const event: LucyMachineEvent = {
      version: 2,
      eventId: "2031409944885334016",
      type: "assistant.final",
      timestamp: 1773160847289,
      channelUserKey: "cuk_demo_user",
      channelDeviceId: "2031378112080429056",
      sourceMessageId: "1773160841833000000",
      runId: "90366a44-cd81-4ff4-a10e-87a931c3e740",
      sessionKey: "agent:main:main",
      text: "hello",
      toolName: "read",
      metadata: { platform: "ios" },
    };

    expect(JSON.parse(Buffer.from(encodeLucyMachineEvent(event)).toString("utf8"))).toEqual({
      version: 2,
      eventId: "2031409944885334016",
      type: "assistant.final",
      timestamp: 1773160847289,
      channel_user_key: "cuk_demo_user",
      channel_device_id: "2031378112080429056",
      source_message_id: "1773160841833000000",
      run_id: "90366a44-cd81-4ff4-a10e-87a931c3e740",
      session_key: "agent:main:main",
      text: "hello",
      tool_name: "read",
      metadata: { platform: "ios" },
    });
  });

  it("encodes approval events with approval metadata fields", () => {
    const event: LucyMachineEvent = {
      version: 2,
      eventId: "2031409944885334017",
      type: "approval.pending",
      timestamp: 1773160847290,
      channelUserKey: "cuk_demo_user",
      channelDeviceId: "2031378112080429056",
      approvalId: "apv_abc123def456",
      approvalSlug: "apv_abc1",
      approvalCommand: "mkdir -p /home/lucy/data",
      approvalCwd: "/home/lucy",
      approvalHost: "gateway",
      approvalExpiresAtMs: 1773160900000,
      approvalAllowedDecisions: ["allow-once", "allow-always", "deny"],
    };

    expect(JSON.parse(Buffer.from(encodeLucyMachineEvent(event)).toString("utf8"))).toEqual({
      version: 2,
      eventId: "2031409944885334017",
      type: "approval.pending",
      timestamp: 1773160847290,
      channel_user_key: "cuk_demo_user",
      channel_device_id: "2031378112080429056",
      approvalId: "apv_abc123def456",
      approval_id: "apv_abc123def456",
      approvalSlug: "apv_abc1",
      approval_slug: "apv_abc1",
      approvalCommand: "mkdir -p /home/lucy/data",
      approval_command: "mkdir -p /home/lucy/data",
      approvalCwd: "/home/lucy",
      approval_cwd: "/home/lucy",
      approvalHost: "gateway",
      approval_host: "gateway",
      approvalExpiresAtMs: 1773160900000,
      approval_expires_at_ms: 1773160900000,
      approvalAllowedDecisions: ["allow-once", "allow-always", "deny"],
      approval_allowed_decisions: ["allow-once", "allow-always", "deny"],
    });
  });

  it("encodes approval resolution fields", () => {
    const event: LucyMachineEvent = {
      version: 2,
      eventId: "2031409944885334018",
      type: "approval.resolved",
      timestamp: 1773160847291,
      channelUserKey: "cuk_demo_user",
      channelDeviceId: "2031378112080429056",
      approvalId: "apv_abc123def456",
      approvalDecision: "allow-always",
      approvalResolvedBy: "cuk_demo_user",
    };

    expect(JSON.parse(Buffer.from(encodeLucyMachineEvent(event)).toString("utf8"))).toEqual({
      version: 2,
      eventId: "2031409944885334018",
      type: "approval.resolved",
      timestamp: 1773160847291,
      channel_user_key: "cuk_demo_user",
      channel_device_id: "2031378112080429056",
      approvalId: "apv_abc123def456",
      approval_id: "apv_abc123def456",
      approvalDecision: "allow-always",
      approval_decision: "allow-always",
      approvalResolvedBy: "cuk_demo_user",
      approval_resolved_by: "cuk_demo_user",
    });
  });

  it("sets a bounded connect timeout", () => {
    const options = buildLucyNatsConnectionOptions(createAccount("nats://127.0.0.1:4222"));
    expect(options.timeout).toBe(5_000);
    expect(options.user).toBe("cuk_demo_user");
    expect(options.pass).toBe("2080563661542787073");
  });

  it("connects to websocket-backed NATS and round-trips publish/subscribe", async () => {
    const server = await createMockNatsWebSocketServer();
    const connection = await connectLucyNats(createAccount(server));

    const subscription = connection.subscribe("lucy.test");
    const nextMessage = (async () => {
      for await (const message of subscription) {
        return message;
      }
      throw new Error("subscription closed without a message");
    })();

    await connection.flush();
    connection.publish("lucy.test", Buffer.from(JSON.stringify({ hello: "world" }), "utf8"));
    await connection.flush();

    const message = await nextMessage;
    expect(message.json<{ hello: string }>()).toEqual({ hello: "world" });

    subscription.unsubscribe();
    await connection.close();
  });
});
