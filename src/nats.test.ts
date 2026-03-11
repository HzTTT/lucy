import { Buffer } from "node:buffer";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { buildLucyNatsConnectionOptions, connectLucyNats } from "./nats.js";
import type { ResolvedLucyAccount } from "./types.js";

type MockSession = {
  buffer: string;
  sid?: string;
  authToken?: string;
};

const serversToClose: WebSocketServer[] = [];

function createAccount(server: string): ResolvedLucyAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    apiKey: "demo_user",
    servers: [server],
    subjectPrefix: "cephalon.im.npc",
    token: "secret-token",
    dmPolicy: "allowlist",
    allowFrom: ["demo_user"],
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
      session.authToken = JSON.parse(line.slice("CONNECT ".length)).auth_token;
      if (session.authToken !== "secret-token") {
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
  it("sets a bounded connect timeout", () => {
    const options = buildLucyNatsConnectionOptions(createAccount("nats://127.0.0.1:4222"));
    expect(options.timeout).toBe(5_000);
    expect(options.token).toBe("secret-token");
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
