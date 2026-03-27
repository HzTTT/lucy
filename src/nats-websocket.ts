import { Buffer } from "node:buffer";
import type { ConnectionOptions, NatsConnection } from "nats";
import {
  DataBuffer,
  ErrorCode,
  INFO,
  NatsConnectionImpl,
  NatsError,
  checkOptions,
  deferred,
  extractProtocolMessage,
  setTransportFactory,
  type ConnectionOptions as InternalConnectionOptions,
  type Server as InternalServer,
  type Transport,
  type TransportFactory,
} from "nats/lib/nats-base-client/internal_mod.js";
import WebSocket from "ws";

const DEFAULT_WEB_SOCKET_PORT = "80";
const DEFAULT_SECURE_WEB_SOCKET_PORT = "443";

function rawDataToUint8Array(data: WebSocket.RawData): Uint8Array {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return Buffer.from(String(data), "utf8");
}

function closeReasonToString(reason: Buffer | string | undefined): string {
  if (!reason) {
    return "";
  }
  if (typeof reason === "string") {
    return reason;
  }
  return reason.toString("utf8");
}

function normalizeConnectError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(String(err));
}

function closeErrorFromSocket(
  code: number,
  reason: Buffer | string | undefined,
  prior?: Error,
): Error {
  if (prior) {
    return prior;
  }
  const renderedReason = closeReasonToString(reason);
  if (code === 1008 && renderedReason.toLowerCase().includes("auth")) {
    return NatsError.errorForCode(ErrorCode.BadAuthentication, new Error(renderedReason));
  }
  if (code === 1006) {
    return NatsError.errorForCode(ErrorCode.ConnectionRefused);
  }
  if (renderedReason) {
    return new Error(renderedReason);
  }
  return new Error(`websocket closed with code ${code}`);
}

export function isLucyWebSocketServer(server: string): boolean {
  const value = server.trim().toLowerCase();
  return value.startsWith("ws://") || value.startsWith("wss://");
}

function extractDefaultWebSocketPath(servers: string[]): string {
  const firstServer = servers.find((server) => isLucyWebSocketServer(server));
  if (!firstServer) {
    return "";
  }
  const url = new URL(firstServer);
  return url.pathname === "/" ? "" : url.pathname;
}

function normalizeWebSocketServerUrl(
  input: string,
  encrypted = true,
  defaultPath = "",
): string {
  const trimmed = input.trim();
  const raw = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `${encrypted ? "wss" : "ws"}://${trimmed}`;
  const url = new URL(raw);
  if (!url.port) {
    url.port = url.protocol === "ws:" ? DEFAULT_WEB_SOCKET_PORT : DEFAULT_SECURE_WEB_SOCKET_PORT;
  }
  if ((url.pathname === "/" || !url.pathname) && defaultPath) {
    url.pathname = defaultPath;
  }
  return url.toString();
}

class LucyWebSocketTransport implements Transport {
  yields: Uint8Array[] = [];
  signal = deferred<void | Error>();
  closedNotification = deferred<void | Error>();
  connected = false;
  done = false;
  closeError?: Error;
  socket?: WebSocket;
  connectedUrl?: string;
  options?: InternalConnectionOptions;
  lang = "nats.ws";
  version = "lucy";

  async connect(server: InternalServer, options: InternalConnectionOptions): Promise<void> {
    this.options = options;
    this.connectedUrl = server.src;

    const timeoutMs = Math.max(1_000, options.timeout ?? 5_000);
    const ws = new WebSocket(server.src, {
      handshakeTimeout: timeoutMs,
      perMessageDeflate: false,
    });
    this.socket = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let socketError: Error | undefined;

      const finishResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.connected = true;
        this.setupHandlers();
        this.signal.resolve();
        resolve();
      };

      const finishReject = (err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          ws.terminate();
        } catch {}
        reject(normalizeConnectError(err));
      };

      const timer = setTimeout(() => {
        finishReject(NatsError.errorForCode(ErrorCode.Timeout));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("error", onError);
      };

      const onMessage = (data: WebSocket.RawData) => {
        const frame = rawDataToUint8Array(data);
        this.yields.push(frame);
        const protocolMessage = extractProtocolMessage(DataBuffer.concat(...this.yields));
        if (!protocolMessage) {
          return;
        }
        try {
          const match = INFO.exec(protocolMessage);
          if (!match) {
            throw new Error("unexpected response from server");
          }
          checkOptions(JSON.parse(match[1]), options);
          finishResolve();
        } catch (err) {
          finishReject(err);
        }
      };

      const onClose = (code: number, reason: Buffer) => {
        const err = closeErrorFromSocket(code, reason, socketError);
        if (!settled) {
          finishReject(err);
          return;
        }
        void this._closed(err, false);
      };

      const onError = (err: unknown) => {
        socketError = normalizeConnectError(err);
      };

      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", onError);
    });
  }

  get isClosed(): boolean {
    return this.done;
  }

  close(err?: Error): Promise<void> {
    return this._closed(err, true);
  }

  isEncrypted(): boolean {
    return this.connectedUrl?.startsWith("wss://") ?? false;
  }

  setupHandlers(): void {
    let connectionError: Error | undefined;
    this.socket?.on("message", (data: WebSocket.RawData) => {
      this.yields.push(rawDataToUint8Array(data));
      this.signal.resolve();
    });
    this.socket?.on("error", (err: Error) => {
      connectionError = normalizeConnectError(err);
    });
    this.socket?.on("close", (code: number, reason: Buffer) => {
      void this._closed(closeErrorFromSocket(code, reason, connectionError), false);
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    while (true) {
      if (this.yields.length === 0) {
        await this.signal;
      }
      const yields = this.yields;
      this.yields = [];
      for (const frame of yields) {
        yield frame;
      }
      if (this.done) {
        break;
      }
      if (this.yields.length === 0) {
        yields.length = 0;
        this.yields = yields;
        this.signal = deferred<void | Error>();
      }
    }
  }

  send(frame: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(frame, { binary: true }, (err?: Error) => {
      if (err && this.options?.debug) {
        console.error(`lucy websocket send failed: ${String(err)}`);
      }
    });
  }

  disconnect(): void {
    void this._closed(undefined, true);
  }

  closed(): Promise<void | Error> {
    return this.closedNotification;
  }

  discard(): void {
    // The ws transport doesn't require backpressure discard handling here.
  }

  private async _closed(err?: Error, internal = true): Promise<void> {
    if (!this.connected || this.done) {
      return;
    }
    this.closeError = err;
    const socket = this.socket;
    this.socket = undefined;
    this.done = true;
    this.connected = false;

    if (socket) {
      socket.removeAllListeners();
      try {
        if (internal && socket.readyState === WebSocket.OPEN) {
          socket.close(1000);
        } else {
          socket.terminate();
        }
      } catch {}
    }

    this.closedNotification.resolve(this.closeError);
  }
}

function createLucyWebSocketTransportFactory(servers: string[]): TransportFactory {
  const defaultPath = extractDefaultWebSocketPath(servers);
  return {
    factory: () => new LucyWebSocketTransport(),
    defaultPort: 443,
    urlParseFn: (server, encrypted = true) =>
      normalizeWebSocketServerUrl(server, encrypted, defaultPath),
  };
}

export async function connectLucyWebSocketNats(
  options: ConnectionOptions,
): Promise<NatsConnection> {
  const servers =
    typeof options.servers === "string"
      ? [options.servers]
      : (options.servers?.slice() ?? []);
  setTransportFactory(createLucyWebSocketTransportFactory(servers));
  return (await NatsConnectionImpl.connect(
    options as InternalConnectionOptions,
  )) as unknown as NatsConnection;
}
