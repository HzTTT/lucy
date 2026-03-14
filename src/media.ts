import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk";
import {
  nanos,
  type NatsConnection,
  type ObjectResult,
  type ObjectStore,
} from "nats";
import { getLucyRuntime } from "./runtime.js";
import type {
  LucyMediaDescriptor,
  LucyMediaKind,
  ResolvedLucyAccount,
} from "./types.js";

const OBJECT_STORE_METADATA_VERSION = "2";
const OBJECT_STORE_STREAM_PREFIX = "OBJ_";

type JetStreamClientWithViews = ReturnType<NatsConnection["jetstream"]> & {
  views: {
    os: (
      name: string,
      opts?: Record<string, unknown>,
    ) => Promise<ObjectStore>;
  };
};

function resolveExpectedMediaTtl(account: ResolvedLucyAccount): number {
  return nanos(account.mediaRetentionHours * 60 * 60 * 1000);
}

function buildObjectStoreStreamName(bucket: string): string {
  return `${OBJECT_STORE_STREAM_PREFIX}${bucket}`;
}

function normalizeFileName(name: string | undefined, fallbackBase = "attachment"): string {
  const candidate = path.basename(name?.trim() || fallbackBase).replace(/[^\w.-]+/g, "_");
  return candidate || fallbackBase;
}

function inferMediaKind(params: { contentType?: string; fallbackKind?: string }): LucyMediaKind | undefined {
  const contentType = params.contentType?.toLowerCase() || "";
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType.startsWith("audio/")) {
    return "audio";
  }
  if (params.fallbackKind === "image" || params.fallbackKind === "audio") {
    return params.fallbackKind;
  }
  return undefined;
}

function assertSupportedMediaKind(kind: LucyMediaKind | undefined, source: string): LucyMediaKind {
  if (!kind) {
    throw new Error(`unsupported Lucy media type for ${source}`);
  }
  return kind;
}

function toBuffer(chunks: Uint8Array[]): Buffer {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function readObjectStream(result: ObjectResult, maxBytes: number): Promise<Buffer> {
  const reader = result.data.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel("Lucy media exceeds configured limit");
        throw new Error(`Lucy media exceeds configured limit (${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const streamError = await result.error;
  if (streamError) {
    throw streamError;
  }
  return toBuffer(chunks);
}

async function ensureMediaStoreTtl(params: {
  jsm: Awaited<ReturnType<NatsConnection["jetstreamManager"]>>;
  bucket: string;
  expectedTtl: number;
}): Promise<void> {
  const stream = buildObjectStoreStreamName(params.bucket);
  const info = await params.jsm.streams.info(stream);
  if ((info.config.max_age ?? 0) === params.expectedTtl) {
    return;
  }
  await params.jsm.streams.update(stream, {
    ...info.config,
    max_age: params.expectedTtl,
  });
}

export async function ensureLucyMediaStore(params: {
  connection: NatsConnection;
  account: ResolvedLucyAccount;
}): Promise<{ store: ObjectStore; jsm: Awaited<ReturnType<NatsConnection["jetstreamManager"]>> }> {
  const expectedTtl = resolveExpectedMediaTtl(params.account);
  const js = params.connection.jetstream() as unknown as JetStreamClientWithViews;
  const jsm = await params.connection.jetstreamManager();
  const store = await js.views.os(params.account.mediaBucket, {
    ttl: expectedTtl,
    metadata: {
      channel: "lucy",
      version: OBJECT_STORE_METADATA_VERSION,
    },
  });
  await ensureMediaStoreTtl({
    jsm,
    bucket: params.account.mediaBucket,
    expectedTtl,
  });
  return { store, jsm };
}

function buildLucyMediaDescriptor(params: {
  account: ResolvedLucyAccount;
  key: string;
  kind: LucyMediaKind;
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
}): LucyMediaDescriptor {
  return {
    transport: "jetstream-object-store",
    bucket: params.account.mediaBucket,
    key: params.key,
    kind: params.kind,
    contentType: params.contentType,
    size: params.buffer.byteLength,
    fileName: params.fileName,
    sha256: crypto.createHash("sha256").update(params.buffer).digest("hex"),
  };
}

async function uploadLucyMediaBuffer(params: {
  store: ObjectStore;
  account: ResolvedLucyAccount;
  key: string;
  kind: LucyMediaKind;
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
}): Promise<LucyMediaDescriptor> {
  await params.store.putBlob(
    {
      name: params.key,
      metadata: {
        channel: "lucy",
        kind: params.kind,
        contentType: params.contentType ?? "",
        fileName: params.fileName ?? "",
        version: OBJECT_STORE_METADATA_VERSION,
      },
    },
    params.buffer,
  );

  return buildLucyMediaDescriptor({
    account: params.account,
    key: params.key,
    kind: params.kind,
    buffer: params.buffer,
    contentType: params.contentType,
    fileName: params.fileName,
  });
}

export function buildLucyMediaObjectKey(params: {
  account: ResolvedLucyAccount;
  deviceId: string;
  eventId: string;
  fileName?: string;
}): string {
  return [
    "outbound",
    params.account.channelUserKey ?? "unknown",
    params.deviceId,
    params.eventId,
    normalizeFileName(params.fileName),
  ].join("/");
}

async function readTrustedLocalFile(params: {
  sourcePath: string;
  maxBytes: number;
}): Promise<{
  buffer: Buffer;
  contentType?: string;
  fileName: string;
  kind: LucyMediaKind;
}> {
  const stats = await fs.stat(params.sourcePath);
  if (!stats.isFile()) {
    throw new Error(`Lucy media source is not a file: ${params.sourcePath}`);
  }
  if (stats.size > params.maxBytes) {
    throw new Error(`Lucy media exceeds configured limit (${params.maxBytes} bytes)`);
  }

  const buffer = await fs.readFile(params.sourcePath);
  const runtime = getLucyRuntime();
  const contentType = await runtime.media.detectMime({ buffer });
  const kind = assertSupportedMediaKind(
    inferMediaKind({ contentType }),
    params.sourcePath,
  );

  return {
    buffer,
    contentType,
    fileName: normalizeFileName(params.sourcePath),
    kind,
  };
}

async function resolveOutboundMediaForUpload(params: {
  mediaUrl: string;
  maxBytes: number;
  mediaLocalRoots?: readonly string[];
  trustedLocalPath?: boolean;
}): Promise<{
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  kind: LucyMediaKind;
}> {
  if (params.trustedLocalPath && path.isAbsolute(params.mediaUrl)) {
    return await readTrustedLocalFile({
      sourcePath: params.mediaUrl,
      maxBytes: params.maxBytes,
    });
  }

  const loaded = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: params.maxBytes,
    mediaLocalRoots: params.mediaLocalRoots,
  });
  const kind = assertSupportedMediaKind(
    inferMediaKind({
      contentType: loaded.contentType,
      fallbackKind: loaded.kind,
    }),
    params.mediaUrl,
  );

  return {
    buffer: loaded.buffer,
    contentType: loaded.contentType,
    fileName: loaded.fileName,
    kind,
  };
}

export async function uploadLucyMediaFromSource(params: {
  connection: NatsConnection;
  account: ResolvedLucyAccount;
  deviceId: string;
  eventId: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  trustedLocalPath?: boolean;
}): Promise<LucyMediaDescriptor> {
  const { store } = await ensureLucyMediaStore({
    connection: params.connection,
    account: params.account,
  });
  const resolved = await resolveOutboundMediaForUpload({
    mediaUrl: params.mediaUrl,
    maxBytes: params.account.mediaMaxBytes,
    mediaLocalRoots: params.mediaLocalRoots,
    trustedLocalPath: params.trustedLocalPath,
  });
  const key = buildLucyMediaObjectKey({
    account: params.account,
    deviceId: params.deviceId,
    eventId: params.eventId,
    fileName: resolved.fileName,
  });

  return await uploadLucyMediaBuffer({
    store,
    account: params.account,
    key,
    kind: resolved.kind,
    buffer: resolved.buffer,
    contentType: resolved.contentType,
    fileName: normalizeFileName(resolved.fileName, `${resolved.kind}.bin`),
  });
}

export async function downloadLucyMediaDescriptor(params: {
  connection: NatsConnection;
  account: ResolvedLucyAccount;
  descriptor: LucyMediaDescriptor;
}): Promise<{
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  kind: LucyMediaKind;
}> {
  if (params.descriptor.bucket !== params.account.mediaBucket) {
    throw new Error("payload media bucket does not match configured Lucy bucket");
  }
  if (params.descriptor.size > params.account.mediaMaxBytes) {
    throw new Error(`Lucy media exceeds configured limit (${params.account.mediaMaxBytes} bytes)`);
  }

  const { store } = await ensureLucyMediaStore({
    connection: params.connection,
    account: params.account,
  });
  const object = await store.get(params.descriptor.key);
  if (!object) {
    throw new Error("Lucy media object not found");
  }

  const buffer = await readObjectStream(object, params.account.mediaMaxBytes);
  if (buffer.byteLength !== params.descriptor.size) {
    throw new Error("payload media size does not match stored object");
  }
  if (params.descriptor.sha256) {
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (digest !== params.descriptor.sha256) {
      throw new Error("payload media sha256 does not match stored object");
    }
  }
  const runtime = getLucyRuntime();
  const detectedContentType =
    params.descriptor.contentType || (await runtime.media.detectMime({ buffer }));
  const detectedKind = assertSupportedMediaKind(
    inferMediaKind({
      contentType: detectedContentType,
      fallbackKind: params.descriptor.kind,
    }),
    params.descriptor.key,
  );

  if (detectedKind !== params.descriptor.kind) {
    throw new Error("payload media kind does not match stored object content");
  }

  return {
    buffer,
    contentType: detectedContentType,
    fileName: normalizeFileName(params.descriptor.fileName, `${detectedKind}.bin`),
    kind: detectedKind,
  };
}
