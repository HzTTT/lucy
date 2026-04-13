import { readFile } from "node:fs/promises";
import path from "node:path";
import { blobPut, blobFetch } from "lucy-im-sdk";
import { loadLucyOutboundMediaFromUrl } from "./outbound-media.js";
import type { LucyMediaDescriptor, LucyMediaKind } from "./types.js";
import { LUCY_MEDIA_TRANSPORT } from "./types.js";

// The current SDK exposes blobPut outcomes as plain descriptors (`blobRef`,
// `fileHash`) and relies on native-side LRU eviction instead of explicit close.
// Keep only timer state locally so callers can cancel pending cleanup when the
// event lifecycle finishes early.
const activeBlobCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const BLOB_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function clearBlobSessionTimer(eventId: string): void {
  const timer = activeBlobCleanupTimers.get(eventId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  activeBlobCleanupTimers.delete(eventId);
}

function scheduleSessionCleanup(eventId: string): void {
  clearBlobSessionTimer(eventId);
  const timer = setTimeout(() => {
    activeBlobCleanupTimers.delete(eventId);
  }, BLOB_SESSION_TIMEOUT_MS);
  activeBlobCleanupTimers.set(eventId, timer);
}

function inferMediaKindFromExt(ext: string): LucyMediaKind {
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) {
    return "image";
  }
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(ext)) {
    return "audio";
  }
  if (["mp4", "webm", "mov", "avi"].includes(ext)) {
    return "video";
  }
  return "document";
}

function inferMediaKindFromContentType(contentType: string | undefined): LucyMediaKind {
  const ct = contentType?.toLowerCase() ?? "";
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  return "document";
}

export async function uploadLucyMediaFromSource(params: {
  eventId: string;
  mediaUrl: string;
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
  trustedLocalPath?: boolean;
}): Promise<LucyMediaDescriptor> {
  let data: Uint8Array;
  let fileName: string;
  let contentType: string | undefined;
  let kind: LucyMediaKind;

  if (params.trustedLocalPath && path.isAbsolute(params.mediaUrl)) {
    const buffer = await readFile(params.mediaUrl);
    data = new Uint8Array(buffer);
    fileName = path.basename(params.mediaUrl);
    kind = inferMediaKindFromExt(path.extname(fileName).slice(1).toLowerCase());
  } else {
    const loaded = await loadLucyOutboundMediaFromUrl(params.mediaUrl, {
      maxBytes: params.maxBytes,
      mediaLocalRoots: params.mediaLocalRoots,
    });
    data = new Uint8Array(loaded.buffer);
    contentType = loaded.contentType;
    fileName = loaded.fileName ?? path.basename(params.mediaUrl).split("?")[0] ?? "file";
    kind = (loaded.kind as LucyMediaKind | undefined) ?? inferMediaKindFromContentType(contentType);
  }

  const session = blobPut(data, fileName);
  scheduleSessionCleanup(params.eventId);

  return {
    transport: LUCY_MEDIA_TRANSPORT,
    blob_ref: session.blobRef,
    kind,
    contentType,
    size: data.length,
    fileName,
  };
}

export async function downloadLucyMediaDescriptor(params: {
  descriptor: LucyMediaDescriptor;
}): Promise<{ buffer: Buffer; contentType: string; fileName?: string }> {
  if (params.descriptor.transport !== LUCY_MEDIA_TRANSPORT) {
    throw new Error(`Unsupported media transport: ${params.descriptor.transport}`);
  }
  const bytes = await blobFetch(params.descriptor.blob_ref);
  return {
    buffer: Buffer.from(bytes),
    contentType: params.descriptor.contentType ?? "application/octet-stream",
    fileName: params.descriptor.fileName,
  };
}

export function cleanupBlobSession(eventId: string): void {
  clearBlobSessionTimer(eventId);
}
