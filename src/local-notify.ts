import http from "node:http";
import type { NatsConnection } from "nats";
import { publishLucyMachineEvent } from "./send.js";
import {
  LucyLocalNotifyPayloadSchema,
  type LucyLocalNotifyPayload,
  type ResolvedLucyAccount,
} from "./types.js";

const LOCAL_NOTIFY_MAX_BYTES = 64 * 1024;

const LOCAL_NOTIFY_CODE_NAME: Record<LucyLocalNotifyPayload["code"], string> = {
  1: "usb.inserted",
  2: "usb.syncing",
  3: "usb.synced",
  4: "usb.failed",
  5: "usb.removed",
};

const LOCAL_NOTIFY_TEXT_PREFIX: Record<LucyLocalNotifyPayload["code"], string> = {
  1: "U盘已插入",
  2: "U盘同步中",
  3: "U盘同步完成",
  4: "U盘同步失败",
  5: "U盘已拔出",
};

type LucyLocalNotifyLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type StartLucyLocalNotifyServerParams = {
  account: ResolvedLucyAccount;
  connection: NatsConnection;
  deviceId: string;
  notify: NonNullable<ResolvedLucyAccount["localNotify"]>;
  log?: LucyLocalNotifyLog;
};

type LucyLocalNotifyServer = {
  url: string;
  stop: () => Promise<void>;
};

function buildJsonResponse(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function normalizeNotifyPath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "/") {
    return trimmed;
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

async function readRequestJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > LOCAL_NOTIFY_MAX_BYTES) {
      throw new Error("payload too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error("request body is required");
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

export function buildLucyLocalNotifyText(payload: LucyLocalNotifyPayload): string {
  const prefix = LOCAL_NOTIFY_TEXT_PREFIX[payload.code];
  const suffix = payload.message.trim();
  if (suffix) {
    return `${prefix}（${payload.device}）：${suffix}`;
  }
  return `${prefix}（${payload.device}）`;
}

async function handleLucyLocalNotifyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: StartLucyLocalNotifyServerParams,
): Promise<void> {
  const requestPath = normalizeNotifyPath(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
  if (requestPath !== params.notify.path) {
    buildJsonResponse(res, 404, { ok: false, error: "Not Found" });
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = await readRequestJson(req);
  } catch (err) {
    buildJsonResponse(res, 400, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const parsedPayload = LucyLocalNotifyPayloadSchema.safeParse(parsedBody);
  if (!parsedPayload.success) {
    buildJsonResponse(res, 400, {
      ok: false,
      error: `invalid notify payload: ${parsedPayload.error.issues[0]?.message ?? "unknown error"}`,
    });
    return;
  }

  const payload = parsedPayload.data;

  try {
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "assistant.final",
      text: buildLucyLocalNotifyText(payload),
      metadata: {
        localNotifyCode: String(payload.code),
        localNotifyCodeName: LOCAL_NOTIFY_CODE_NAME[payload.code],
        localNotifyDevice: payload.device,
        localNotifyTimestamp: payload.timestamp,
        localNotifyMessage: payload.message,
      },
    });
    buildJsonResponse(res, 202, { ok: true });
  } catch (err) {
    params.log?.error?.(`[lucy] local notify publish failed: ${String(err)}`);
    buildJsonResponse(res, 500, { ok: false, error: "failed to publish Lucy machine event" });
  }
}

function resolveListeningUrl(server: http.Server, bind: string, path: string): string {
  const address = server.address();
  if (address && typeof address === "object") {
    const host = address.address && address.address.length > 0 ? address.address : bind;
    const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `http://${normalizedHost}:${address.port}${path}`;
  }
  return `http://${bind}:${0}${path}`;
}

export async function startLucyLocalNotifyServer(
  params: StartLucyLocalNotifyServerParams,
): Promise<LucyLocalNotifyServer> {
  const server = http.createServer((req, res) => {
    void handleLucyLocalNotifyRequest(req, res, params).catch((err) => {
      params.log?.error?.(`[lucy] local notify request failed: ${String(err)}`);
      buildJsonResponse(res, 500, { ok: false, error: "internal server error" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.notify.port, params.notify.bind, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const url = resolveListeningUrl(server, params.notify.bind, params.notify.path);
  params.log?.info?.(`[lucy] local notify server listening on ${url}`);

  return {
    url,
    stop: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
