import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLucyRuntime } from "./runtime.js";

export type LucyOutboundMediaLoadOptions = {
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
};

type LucyOutboundMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind?: string;
  fileName?: string;
};

function stripMediaPrefix(mediaUrl: string): string {
  return mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}

function normalizeMediaSource(mediaUrl: string): { url?: URL; localPath?: string } {
  const stripped = stripMediaPrefix(mediaUrl);
  if (stripped.startsWith("file://")) {
    return { localPath: fileURLToPath(stripped) };
  }

  try {
    return { url: new URL(stripped) };
  } catch {
    return { localPath: path.resolve(stripped) };
  }
}

async function resolveRealPath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

async function assertLocalPathAllowed(
  localPath: string,
  mediaLocalRoots: readonly string[] | undefined,
): Promise<void> {
  if (!mediaLocalRoots || mediaLocalRoots.length === 0) {
    throw new Error(`Local media path is not allowed without mediaLocalRoots: ${localPath}`);
  }

  const resolvedPath = await resolveRealPath(localPath);
  for (const root of mediaLocalRoots) {
    const resolvedRoot = await resolveRealPath(root);
    if (
      resolvedPath === resolvedRoot ||
      resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      return;
    }
  }

  throw new Error(`Local media path is not under an allowed directory: ${localPath}`);
}

function inferMediaKind(params: { contentType?: string; fileName?: string }): string | undefined {
  const contentType = params.contentType?.toLowerCase() || "";
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType.startsWith("audio/")) {
    return "audio";
  }
  if (contentType.startsWith("video/")) {
    return "video";
  }
  if (contentType.startsWith("text/") || contentType.startsWith("application/")) {
    return "document";
  }

  const extension = path.extname(params.fileName ?? "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif"].includes(extension)) {
    return "image";
  }
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(extension)) {
    return "audio";
  }
  if ([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"].includes(extension)) {
    return "video";
  }
  if (
    [
      ".pdf",
      ".txt",
      ".md",
      ".json",
      ".csv",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",
      ".zip",
    ].includes(extension)
  ) {
    return "document";
  }
  return undefined;
}

async function detectContentType(buffer: Buffer, fallback?: string): Promise<string | undefined> {
  const runtime = getLucyRuntime();
  return fallback || (await runtime.media.detectMime({ buffer }));
}

function extractRemoteFileName(response: Response, url: URL): string | undefined {
  const contentDisposition = response.headers.get("content-disposition")?.trim();
  if (contentDisposition) {
    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      return path.basename(decodeURIComponent(utf8Match[1]));
    }
    const quotedMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
    if (quotedMatch?.[1]) {
      return path.basename(quotedMatch[1]);
    }
  }

  const pathname = decodeURIComponent(url.pathname || "");
  const baseName = path.basename(pathname);
  return baseName && baseName !== "/" ? baseName : undefined;
}

async function readResponseBodyWithLimit(response: Response, maxBytes?: number): Promise<Buffer> {
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (maxBytes && Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Lucy media exceeds configured limit (${maxBytes} bytes)`);
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (maxBytes && buffer.byteLength > maxBytes) {
      throw new Error(`Lucy media exceeds configured limit (${maxBytes} bytes)`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
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
      if (maxBytes && total > maxBytes) {
        await reader.cancel("Lucy media exceeds configured limit");
        throw new Error(`Lucy media exceeds configured limit (${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function loadLocalMedia(
  localPath: string,
  options: LucyOutboundMediaLoadOptions,
): Promise<LucyOutboundMediaResult> {
  await assertLocalPathAllowed(localPath, options.mediaLocalRoots);

  const stats = await fs.stat(localPath);
  if (!stats.isFile()) {
    throw new Error(`Lucy media source is not a file: ${localPath}`);
  }
  if (options.maxBytes && stats.size > options.maxBytes) {
    throw new Error(`Lucy media exceeds configured limit (${options.maxBytes} bytes)`);
  }

  const buffer = await fs.readFile(localPath);
  const fileName = path.basename(localPath);
  const contentType = await detectContentType(buffer);
  return {
    buffer,
    contentType,
    kind: inferMediaKind({ contentType, fileName }),
    fileName,
  };
}

async function loadRemoteMedia(
  url: URL,
  options: LucyOutboundMediaLoadOptions,
): Promise<LucyOutboundMediaResult> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Lucy media request failed with ${response.status} ${response.statusText}`);
  }

  const buffer = await readResponseBodyWithLimit(response, options.maxBytes);
  const headerContentType = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
  const fileName = extractRemoteFileName(response, url);
  const contentType = await detectContentType(buffer, headerContentType);
  return {
    buffer,
    contentType,
    kind: inferMediaKind({ contentType, fileName }),
    fileName,
  };
}

export async function loadLucyOutboundMediaFromUrl(
  mediaUrl: string,
  options: LucyOutboundMediaLoadOptions = {},
): Promise<LucyOutboundMediaResult> {
  const source = normalizeMediaSource(mediaUrl);
  if (source.localPath) {
    return await loadLocalMedia(source.localPath, options);
  }

  if (!source.url || !["http:", "https:", "data:"].includes(source.url.protocol)) {
    throw new Error(`Unsupported Lucy media URL: ${mediaUrl}`);
  }

  return await loadRemoteMedia(source.url, options);
}
