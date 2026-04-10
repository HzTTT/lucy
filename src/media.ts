import { readFile } from "node:fs/promises";
import path from "node:path";
import { blobPut, blobFetch, type BlobProviderSession } from "lucy-im-sdk";
import { loadLucyOutboundMediaFromUrl } from "./outbound-media.js";
import type { LucyMediaDescriptor, LucyMediaKind } from "./types.js";
import { LUCY_MEDIA_TRANSPORT } from "./types.js";

// Track active blob sessions for outbound media
const activeBlobSessions: Map<string, BlobProviderSession> = new Map();
const BLOB_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function scheduleSessionCleanup(eventId: string): void {
  setTimeout(() => {
    const session = activeBlobSessions.get(eventId);
    if (session) {
      session.close();
      activeBlobSessions.delete(eventId);
    }
  }, BLOB_SESSION_TIMEOUT_MS);
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
  activeBlobSessions.set(params.eventId, session);
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
  const session = activeBlobSessions.get(eventId);
  if (session) {
    session.close();
    activeBlobSessions.delete(eventId);
  }
}
