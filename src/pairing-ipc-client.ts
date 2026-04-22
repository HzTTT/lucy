import { access, constants as fsConstants } from "node:fs/promises";
import { Socket, createConnection } from "node:net";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { LucyImClient } from "lucy-im-sdk";
import {
  PairingIpcFrameError,
  decodePairingIpcLine,
  encodePairingIpcMessage,
  type PairingIpcMessage,
} from "./pairing-ipc-types.js";

// Backoff schedule (ms) used between reconnect attempts. The last value is
// reused indefinitely.
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;

// Heartbeat cadence. Ping every HEARTBEAT_INTERVAL_MS; if no pong within
// HEARTBEAT_TIMEOUT_MS, drop the connection and reconnect.
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

// Max request_ids remembered for idempotency. An OTP request that reuses a
// recent request_id simply replays the last response instead of hitting
// preBind() again.
const IDEMPOTENCY_CACHE_SIZE = 32;

export interface PairingIpcClientLog {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface PairingIpcClientParams {
  sockPath: string;
  signal: AbortSignal;
  client: Pick<LucyImClient, "preBind">;
  /**
   * Milliseconds to delay between reconnect attempts. Defaults to the baked-in
   * backoff schedule; override for tests.
   */
  reconnectDelaysMs?: readonly number[];
  /** Heartbeat cadence (ms). Override for tests. */
  heartbeatIntervalMs?: number;
  /** Heartbeat timeout (ms). Override for tests. */
  heartbeatTimeoutMs?: number;
  log?: PairingIpcClientLog;
}

export interface PairingIpcClientHandle {
  /** Close the socket and stop all timers. Idempotent. */
  stop: () => Promise<void>;
  /**
   * Push bind.completed to the server side. Noop if the socket is not currently
   * connected — blue-wifi will discover it on the next reconnect or the next
   * BLE read.
   */
  publishBindCompleted: (info: { cuk: string; userId: string }) => void;
  /** Push bind.cleared to the server side. Noop if not connected. */
  publishBindCleared: () => void;
  /** Visible mostly for tests; exposes whether the socket is writable. */
  isConnected: () => boolean;
}

type CachedResponse =
  | { kind: "otp.issued"; otp: string; expires_at_ms: number }
  | { kind: "otp.error"; error: string };

type Connection = {
  socket: Socket;
  readline: ReadlineInterface;
  /** Flipped true only after the socket 'connect' event fires. */
  ready: boolean;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  pongDeadlineTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Starts a long-lived NDJSON client connected to the blue-wifi pairing IPC
 * server. Handles connect, reconnect with backoff, heartbeats, and routes
 * bind.request messages into LucyImClient.preBind() with idempotency.
 *
 * The returned handle is the only public surface. Lifecycle follows the
 * supplied AbortSignal: aborting the signal stops the client cleanly.
 */
export function startPairingIpcClient(
  params: PairingIpcClientParams,
): PairingIpcClientHandle {
  const log = params.log ?? {};
  const reconnectDelays =
    params.reconnectDelaysMs && params.reconnectDelaysMs.length > 0
      ? [...params.reconnectDelaysMs]
      : [...RECONNECT_BACKOFF_MS];
  const heartbeatIntervalMs = params.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = params.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  let stopped = false;
  let connection: Connection | undefined;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // Insertion-ordered idempotency cache. Keyed by request_id.
  const responseCache = new Map<string, CachedResponse>();
  // request_ids currently being processed (preBind in flight).
  const inflight = new Set<string>();

  const rememberResponse = (requestId: string, response: CachedResponse): void => {
    if (responseCache.has(requestId)) {
      responseCache.delete(requestId);
    }
    responseCache.set(requestId, response);
    while (responseCache.size > IDEMPOTENCY_CACHE_SIZE) {
      const oldest = responseCache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      responseCache.delete(oldest);
    }
  };

  const writeMessage = (msg: PairingIpcMessage): boolean => {
    if (!connection || !connection.ready) {
      return false;
    }
    try {
      const frame = encodePairingIpcMessage(msg);
      connection.socket.write(frame);
      return true;
    } catch (err) {
      log.warn?.(`[lucy] pairing-ipc: encode failed (${msg.type}): ${String(err)}`);
      return false;
    }
  };

  const resetHeartbeat = (conn: Connection): void => {
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = undefined;
    }
    if (conn.pongDeadlineTimer) {
      clearTimeout(conn.pongDeadlineTimer);
      conn.pongDeadlineTimer = undefined;
    }
  };

  const armHeartbeat = (conn: Connection): void => {
    resetHeartbeat(conn);
    conn.heartbeatTimer = setInterval(() => {
      if (!writeMessage({ type: "ping" })) {
        return;
      }
      if (conn.pongDeadlineTimer) {
        clearTimeout(conn.pongDeadlineTimer);
      }
      conn.pongDeadlineTimer = setTimeout(() => {
        log.warn?.("[lucy] pairing-ipc: pong timeout, reconnecting");
        conn.socket.destroy(new Error("pairing-ipc pong timeout"));
      }, heartbeatTimeoutMs);
    }, heartbeatIntervalMs);
  };

  const closeConnection = (reason?: string): void => {
    if (!connection) {
      return;
    }
    const conn = connection;
    connection = undefined;
    resetHeartbeat(conn);
    try {
      conn.readline.removeAllListeners();
      conn.readline.close();
    } catch {
      /* ignore */
    }
    if (!conn.socket.destroyed) {
      conn.socket.destroy();
    }
    if (reason) {
      log.info?.(`[lucy] pairing-ipc: disconnected (${reason})`);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== undefined) {
      return;
    }
    const idx = Math.min(reconnectAttempt, reconnectDelays.length - 1);
    const delay = reconnectDelays[idx] ?? reconnectDelays[reconnectDelays.length - 1]!;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openConnection();
    }, delay);
  };

  const handleBindRequest = async (requestId: string): Promise<void> => {
    // Idempotency fast-path: replay previous response for a known request_id.
    const cached = responseCache.get(requestId);
    if (cached) {
      if (cached.kind === "otp.issued") {
        writeMessage({
          type: "otp.issued",
          request_id: requestId,
          otp: cached.otp,
          expires_at_ms: cached.expires_at_ms,
        });
      } else {
        writeMessage({
          type: "otp.error",
          request_id: requestId,
          error: cached.error,
        });
      }
      return;
    }

    if (inflight.has(requestId)) {
      // Duplicate delivery while preBind() is still running; drop silently,
      // the original invocation will reply.
      return;
    }
    inflight.add(requestId);

    try {
      const result = await params.client.preBind();
      const expiresAtMs = Date.now() + result.expires_in * 1_000;
      rememberResponse(requestId, {
        kind: "otp.issued",
        otp: result.otp,
        expires_at_ms: expiresAtMs,
      });
      log.info?.(
        `[lucy] pairing-ipc: otp issued (request_id=${requestId}, expires_in=${result.expires_in}s)`,
      );
      writeMessage({
        type: "otp.issued",
        request_id: requestId,
        otp: result.otp,
        expires_at_ms: expiresAtMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const truncated = message.length > 400 ? `${message.slice(0, 400)}…` : message;
      rememberResponse(requestId, { kind: "otp.error", error: truncated });
      log.warn?.(
        `[lucy] pairing-ipc: preBind failed (request_id=${requestId}): ${truncated}`,
      );
      writeMessage({
        type: "otp.error",
        request_id: requestId,
        error: truncated,
      });
    } finally {
      inflight.delete(requestId);
    }
  };

  const handleMessage = (msg: PairingIpcMessage, conn: Connection): void => {
    switch (msg.type) {
      case "bind.request":
        void handleBindRequest(msg.request_id);
        return;
      case "ping":
        writeMessage({ type: "pong" });
        return;
      case "pong":
        if (conn.pongDeadlineTimer) {
          clearTimeout(conn.pongDeadlineTimer);
          conn.pongDeadlineTimer = undefined;
        }
        return;
      case "bind.cleared":
      case "bind.completed":
      case "otp.issued":
      case "otp.error":
        // These messages are produced by Lucy and never consumed here. If a
        // blue-wifi server echoes one back by mistake, log a warning and
        // drop it so we stay in sync.
        log.warn?.(`[lucy] pairing-ipc: unexpected inbound message type ${msg.type}`);
        return;
    }
  };

  const openSocket = (): void => {
    const socket = createConnection({ path: params.sockPath });
    const readline = createInterface({ input: socket, crlfDelay: Infinity });
    const conn: Connection = { socket, readline, ready: false };
    connection = conn;

    socket.once("connect", () => {
      conn.ready = true;
      reconnectAttempt = 0;
      log.info?.(`[lucy] pairing-ipc: connected to ${params.sockPath}`);
      armHeartbeat(conn);
    });

    // `on` rather than `once`: a destroyed socket can re-emit error during
    // teardown, and a second unhandled 'error' event would crash the process.
    socket.on("error", (err) => {
      // Swallow ENOENT / ECONNREFUSED noise — these are expected when
      // blue-wifi is not running yet.
      log.info?.(`[lucy] pairing-ipc: socket error: ${err.message}`);
    });

    socket.once("close", () => {
      if (connection === conn) {
        closeConnection("socket closed");
      }
      scheduleReconnect();
    });

    readline.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const msg = decodePairingIpcLine(trimmed);
        handleMessage(msg, conn);
      } catch (err) {
        if (err instanceof PairingIpcFrameError) {
          log.warn?.(`[lucy] pairing-ipc: dropping malformed frame (${err.code}): ${err.message}`);
          // frame_too_large forces a reconnect because we might be out of sync.
          if (err.code === "frame_too_large") {
            socket.destroy(new Error("pairing-ipc frame too large"));
          }
          return;
        }
        log.error?.(`[lucy] pairing-ipc: handler crashed: ${String(err)}`);
      }
    });
  };

  const openConnection = (): void => {
    if (stopped || connection) {
      return;
    }

    // Precheck the socket path before calling createConnection. A missing
    // socket triggers an ENOENT whose async emit path (combined with
    // readline.createInterface's synchronous wiring to the socket stream)
    // bypasses the socket 'error' listener and surfaces as an uncaught
    // exception — bringing the whole gateway down. This is the normal state
    // on macOS / dev machines without a blue-wifi BLE agent, so log once and
    // schedule another retry instead.
    access(params.sockPath, fsConstants.F_OK).then(
      () => {
        if (stopped || connection) {
          return;
        }
        openSocket();
      },
      (err: NodeJS.ErrnoException) => {
        if (stopped) {
          return;
        }
        log.info?.(
          `[lucy] pairing-ipc: socket not available at ${params.sockPath} (${err?.code ?? "ENOENT"}); will retry later`,
        );
        scheduleReconnect();
      },
    );
  };

  const onAbort = (): void => {
    void handle.stop();
  };

  if (params.signal.aborted) {
    stopped = true;
  } else {
    params.signal.addEventListener("abort", onAbort, { once: true });
  }

  const handle: PairingIpcClientHandle = {
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      params.signal.removeEventListener("abort", onAbort);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      closeConnection("stopped");
    },
    publishBindCompleted: (info) => {
      writeMessage({
        type: "bind.completed",
        cuk: info.cuk,
        user_id: info.userId,
      });
    },
    publishBindCleared: () => {
      writeMessage({ type: "bind.cleared" });
    },
    isConnected: () => Boolean(connection && connection.ready && !connection.socket.destroyed),
  };

  // Fire-and-forget first connect attempt. Any failures path through
  // socket.on('close') → scheduleReconnect.
  if (!stopped) {
    openConnection();
  }

  return handle;
}
