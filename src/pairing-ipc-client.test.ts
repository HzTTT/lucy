import { promises as fs } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodePairingIpcLine,
  encodePairingIpcMessage,
  type PairingIpcMessage,
} from "./pairing-ipc-types.js";
import { startPairingIpcClient } from "./pairing-ipc-client.js";

type FakeServerHandle = {
  server: Server;
  sockPath: string;
  messages: PairingIpcMessage[];
  acceptedConnections: Socket[];
  waitForMessage: (predicate: (msg: PairingIpcMessage) => boolean, timeoutMs?: number) => Promise<PairingIpcMessage>;
  send: (msg: PairingIpcMessage) => void;
  forceCloseActive: () => void;
  close: () => Promise<void>;
};

async function makeSockPath(label: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), `lucy-pairing-ipc-${label}-`));
  return join(dir, "pairing.sock");
}

async function startFakeServer(sockPath: string): Promise<FakeServerHandle> {
  const messages: PairingIpcMessage[] = [];
  const pending: Array<{
    predicate: (msg: PairingIpcMessage) => boolean;
    resolve: (msg: PairingIpcMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const acceptedConnections: Socket[] = [];
  let activeSocket: Socket | undefined;

  const pushMessage = (msg: PairingIpcMessage): void => {
    messages.push(msg);
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const waiter = pending[i]!;
      if (waiter.predicate(msg)) {
        clearTimeout(waiter.timer);
        pending.splice(i, 1);
        waiter.resolve(msg);
      }
    }
  };

  const server = createServer((socket) => {
    acceptedConnections.push(socket);
    activeSocket = socket;
    const rl = createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        pushMessage(decodePairingIpcLine(trimmed));
      } catch {
        /* ignore in fake server */
      }
    });
    socket.on("close", () => {
      if (activeSocket === socket) {
        activeSocket = undefined;
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    sockPath,
    messages,
    acceptedConnections,
    waitForMessage: (predicate, timeoutMs = 2_000) =>
      new Promise<PairingIpcMessage>((resolve, reject) => {
        for (const msg of messages) {
          if (predicate(msg)) {
            resolve(msg);
            return;
          }
        }
        const timer = setTimeout(() => {
          const idx = pending.findIndex((p) => p.resolve === resolve);
          if (idx >= 0) {
            pending.splice(idx, 1);
          }
          reject(new Error("waitForMessage timed out"));
        }, timeoutMs);
        pending.push({ predicate, resolve, reject, timer });
      }),
    send: (msg) => {
      if (!activeSocket || activeSocket.destroyed) {
        throw new Error("fake server: no active client socket");
      }
      activeSocket.write(encodePairingIpcMessage(msg));
    },
    forceCloseActive: () => {
      activeSocket?.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const p of pending) {
          clearTimeout(p.timer);
          p.reject(new Error("fake server closed"));
        }
        pending.length = 0;
        for (const conn of acceptedConnections) {
          if (!conn.destroyed) {
            conn.destroy();
          }
        }
        server.close(() => resolve());
      }),
  };
}

function makeFakeLucyClient(
  overrides: Partial<{
    preBind: () => Promise<{ otp: string; expires_in: number }>;
  }> = {},
) {
  const preBind = overrides.preBind
    ? vi.fn(overrides.preBind)
    : vi.fn(async () => ({ otp: "123456", expires_in: 300 }));
  return { preBind };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

describe("startPairingIpcClient", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const fn = cleanupFns.pop()!;
      try {
        await fn();
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  it("routes bind.request to preBind and replies otp.issued", async () => {
    const sockPath = await makeSockPath("happy");
    const fake = await startFakeServer(sockPath);
    cleanupFns.push(() => fake.close());

    const client = makeFakeLucyClient();
    const abortCtl = new AbortController();
    const handle = startPairingIpcClient({
      sockPath,
      signal: abortCtl.signal,
      client,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    });
    cleanupFns.push(() => handle.stop());

    await waitFor(() => handle.isConnected());
    fake.send({ type: "bind.request", request_id: "req-1", requested_at_ms: 1 });

    const reply = await fake.waitForMessage((m) => m.type === "otp.issued");
    expect(reply).toMatchObject({
      type: "otp.issued",
      request_id: "req-1",
      otp: "123456",
    });
    expect(client.preBind).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across duplicate request_ids", async () => {
    const sockPath = await makeSockPath("idem");
    const fake = await startFakeServer(sockPath);
    cleanupFns.push(() => fake.close());

    const client = makeFakeLucyClient();
    const abortCtl = new AbortController();
    const handle = startPairingIpcClient({
      sockPath,
      signal: abortCtl.signal,
      client,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    });
    cleanupFns.push(() => handle.stop());

    await waitFor(() => handle.isConnected());
    fake.send({ type: "bind.request", request_id: "req-dup", requested_at_ms: 1 });
    await fake.waitForMessage((m) => m.type === "otp.issued");
    fake.send({ type: "bind.request", request_id: "req-dup", requested_at_ms: 2 });

    // Second bind.request must produce a second otp.issued (replayed) without
    // invoking preBind again.
    await waitFor(
      () => fake.messages.filter((m) => m.type === "otp.issued").length === 2,
    );
    expect(client.preBind).toHaveBeenCalledTimes(1);
  });

  it("replies otp.error when preBind throws", async () => {
    const sockPath = await makeSockPath("err");
    const fake = await startFakeServer(sockPath);
    cleanupFns.push(() => fake.close());

    const client = makeFakeLucyClient({
      preBind: async () => {
        throw new Error("upstream 502 bad gateway");
      },
    });
    const abortCtl = new AbortController();
    const handle = startPairingIpcClient({
      sockPath,
      signal: abortCtl.signal,
      client,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    });
    cleanupFns.push(() => handle.stop());

    await waitFor(() => handle.isConnected());
    fake.send({ type: "bind.request", request_id: "req-err", requested_at_ms: 1 });

    const reply = await fake.waitForMessage((m) => m.type === "otp.error");
    expect(reply).toMatchObject({
      type: "otp.error",
      request_id: "req-err",
    });
    expect((reply as { error: string }).error).toContain("upstream 502");
  });

  it("drops Lucy-produced messages that arrive in the wrong direction", async () => {
    // bind.completed / bind.cleared / otp.issued / otp.error are published by
    // Lucy only. If blue-wifi echoes one back by mistake, the client should
    // stay alive and ignore it instead of crashing.
    const sockPath = await makeSockPath("wrongdir");
    const fake = await startFakeServer(sockPath);
    cleanupFns.push(() => fake.close());

    const abortCtl = new AbortController();
    const handle = startPairingIpcClient({
      sockPath,
      signal: abortCtl.signal,
      client: makeFakeLucyClient(),
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    });
    cleanupFns.push(() => handle.stop());

    await waitFor(() => handle.isConnected());

    fake.send({ type: "bind.completed", cuk: "cuk_x", user_id: "user_x" });
    fake.send({ type: "bind.cleared" });
    fake.send({ type: "otp.issued", request_id: "r", otp: "1", expires_at_ms: 1 });
    fake.send({ type: "otp.error", request_id: "r", error: "oops" });

    // Ping-pong afterwards to confirm the connection is still healthy.
    fake.send({ type: "ping" });
    await fake.waitForMessage((m) => m.type === "pong");
    expect(handle.isConnected()).toBe(true);
  });

  it("reconnects after the server drops the connection", async () => {
    const sockPath = await makeSockPath("reconnect");
    const fake = await startFakeServer(sockPath);
    cleanupFns.push(() => fake.close());

    const abortCtl = new AbortController();
    const handle = startPairingIpcClient({
      sockPath,
      signal: abortCtl.signal,
      client: makeFakeLucyClient(),
      reconnectDelaysMs: [20, 20, 20, 20, 20],
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    });
    cleanupFns.push(() => handle.stop());

    await waitFor(() => handle.isConnected());
    expect(fake.acceptedConnections.length).toBe(1);

    fake.forceCloseActive();
    await waitFor(() => !handle.isConnected());

    // Client should reconnect and the fake server accepts a new socket.
    await waitFor(() => fake.acceptedConnections.length >= 2, 3_000);
    await waitFor(() => handle.isConnected());
  });

  it("responds to ping with pong", async () => {
    const sockPath = await makeSockPath("ping");
    const fake = await startFakeServer(sockPath);
    cleanupFns.push(() => fake.close());

    const abortCtl = new AbortController();
    const handle = startPairingIpcClient({
      sockPath,
      signal: abortCtl.signal,
      client: makeFakeLucyClient(),
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    });
    cleanupFns.push(() => handle.stop());

    await waitFor(() => handle.isConnected());
    fake.send({ type: "ping" });
    await fake.waitForMessage((m) => m.type === "pong");
  });

  it("stops cleanly when the abort signal fires", async () => {
    const sockPath = await makeSockPath("abort");
    const fake = await startFakeServer(sockPath);
    cleanupFns.push(() => fake.close());

    const abortCtl = new AbortController();
    const handle = startPairingIpcClient({
      sockPath,
      signal: abortCtl.signal,
      client: makeFakeLucyClient(),
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    });

    await waitFor(() => handle.isConnected());
    abortCtl.abort();
    await waitFor(() => !handle.isConnected());
  });

  it("publishBindCompleted emits bind.completed message", async () => {
    const sockPath = await makeSockPath("pub");
    const fake = await startFakeServer(sockPath);
    cleanupFns.push(() => fake.close());

    const abortCtl = new AbortController();
    const handle = startPairingIpcClient({
      sockPath,
      signal: abortCtl.signal,
      client: makeFakeLucyClient(),
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    });
    cleanupFns.push(() => handle.stop());

    await waitFor(() => handle.isConnected());
    handle.publishBindCompleted({ cuk: "cuk_pub", userId: "user_pub" });

    const msg = await fake.waitForMessage((m) => m.type === "bind.completed");
    expect(msg).toEqual({
      type: "bind.completed",
      cuk: "cuk_pub",
      user_id: "user_pub",
    });
  });
});
