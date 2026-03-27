import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { nanos, type ObjectResult, type ObjectStore } from "nats";
import { connectLucyNatsWithOptions } from "../src/nats.js";
import {
  DEFAULT_MEDIA_BUCKET,
  DEFAULT_MEDIA_RETENTION_HOURS,
  LUCY_MEDIA_TRANSPORT,
} from "../src/types.js";

type Args = {
  channelUserKey?: string;
  channelDeviceId?: string;
  server: string;
  subjectPrefix: string;
  token?: string;
  text?: string;
  media?: string;
  mediaBucket: string;
  downloadDir?: string;
  waitMs: number;
};

type MediaDescriptor = {
  transport: typeof LUCY_MEDIA_TRANSPORT;
  bucket: string;
  key: string;
  kind: "image" | "audio" | "video" | "document";
  contentType?: string;
  size: number;
  fileName?: string;
  sha256?: string;
};

type JetStreamManagerWithViews = {
  views: {
    os: (name: string, opts?: Record<string, unknown>) => Promise<ObjectStore>;
  };
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    server: "nats://127.0.0.1:4222",
    subjectPrefix: "cephalon.im.npc",
    mediaBucket: DEFAULT_MEDIA_BUCKET,
    waitMs: 15_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--channel-user-key" || token === "--api-key") {
      args.channelUserKey = value;
      i += 1;
    } else if (token === "--channel-device-id" || token === "--device-id") {
      args.channelDeviceId = value;
      i += 1;
    } else if (token === "--server") {
      args.server = value ?? args.server;
      i += 1;
    } else if (token === "--subject-prefix") {
      args.subjectPrefix = value ?? args.subjectPrefix;
      i += 1;
    } else if (token === "--token") {
      args.token = value ?? args.token;
      i += 1;
    } else if (token === "--text") {
      args.text = value;
      i += 1;
    } else if (token === "--media") {
      args.media = value;
      i += 1;
    } else if (token === "--media-bucket") {
      args.mediaBucket = value ?? args.mediaBucket;
      i += 1;
    } else if (token === "--download-dir") {
      args.downloadDir = value;
      i += 1;
    } else if (token === "--wait-ms") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.waitMs = parsed;
      }
      i += 1;
    }
  }
  return args;
}

function requireArg(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function buildSubjects(params: {
  subjectPrefix: string;
  channelUserKey: string;
  channelDeviceId: string;
}) {
  const prefix = params.subjectPrefix.trim();
  return {
    clientSubject: `${prefix}.${params.channelUserKey}.${params.channelDeviceId}.client`,
    machineSubject: `${prefix}.${params.channelUserKey}.${params.channelDeviceId}.machine`,
  };
}

function makeDemoId(): string {
  const suffix = BigInt(crypto.randomInt(0, 1_000_000));
  return (BigInt(Date.now()) * 1_000_000n + suffix).toString();
}

function normalizeFileName(name: string | undefined, fallbackBase = "attachment"): string {
  const candidate = path.basename(name?.trim() || fallbackBase).replace(/[^\w.-]+/g, "_");
  return candidate || fallbackBase;
}

function buildInboundMediaKey(params: {
  apiKey: string;
  deviceId: string;
  fileName?: string;
}): string {
  return [
    "inbound",
    params.apiKey,
    params.deviceId,
    `${makeDemoId()}-${normalizeFileName(params.fileName)}`,
  ].join("/");
}

function inferMediaDescriptor(
  filePath: string,
): { kind: "image" | "audio" | "video" | "document"; contentType: string } {
  const ext = path.extname(filePath).toLowerCase();
  const imageTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  const audioTypes: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
  };
  const videoTypes: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
  };
  const documentTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
  };

  const imageContentType = imageTypes[ext];
  if (imageContentType) {
    return { kind: "image", contentType: imageContentType };
  }
  const audioContentType = audioTypes[ext];
  if (audioContentType) {
    return { kind: "audio", contentType: audioContentType };
  }
  const videoContentType = videoTypes[ext];
  if (videoContentType) {
    return { kind: "video", contentType: videoContentType };
  }
  const documentContentType = documentTypes[ext];
  if (documentContentType) {
    return { kind: "document", contentType: documentContentType };
  }
  throw new Error(`Unsupported demo media extension: ${ext || "(none)"}`);
}

async function ensureMediaStore(
  nc: Awaited<ReturnType<typeof connectLucyNatsWithOptions>>,
  bucket: string,
): Promise<ObjectStore> {
  const js = nc.jetstream() as unknown as JetStreamManagerWithViews;
  return await js.views.os(bucket, {
    ttl: nanos(DEFAULT_MEDIA_RETENTION_HOURS * 60 * 60 * 1000),
    metadata: {
      channel: "lucy",
      version: "2",
    },
  });
}

async function readObjectStream(result: ObjectResult): Promise<Buffer> {
  const reader = result.data.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value?.length) {
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const streamError = await result.error;
  if (streamError) {
    throw streamError;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function uploadMedia(
  nc: Awaited<ReturnType<typeof connectLucyNatsWithOptions>>,
  args: Args,
  channelUserKey: string,
  channelDeviceId: string,
  mediaPath: string,
): Promise<MediaDescriptor> {
  const buffer = await fs.readFile(mediaPath);
  const fileName = path.basename(mediaPath);
  const { kind, contentType } = inferMediaDescriptor(fileName);
  const bucket = args.mediaBucket.trim();
  const key = buildInboundMediaKey({
    apiKey: channelUserKey,
    deviceId: channelDeviceId,
    fileName,
  });
  const store = await ensureMediaStore(nc, bucket);

  await store.putBlob(
    {
      name: key,
      metadata: {
        channel: "lucy",
        kind,
        contentType,
        fileName,
        version: "2",
      },
    },
    buffer,
  );

  return {
    transport: LUCY_MEDIA_TRANSPORT,
    bucket,
    key,
    kind,
    contentType,
    size: buffer.byteLength,
    fileName,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

async function maybeDownloadMedia(
  nc: Awaited<ReturnType<typeof connectLucyNatsWithOptions>>,
  descriptor: MediaDescriptor,
  downloadDir: string,
): Promise<string> {
  await fs.mkdir(downloadDir, { recursive: true });
  const store = await ensureMediaStore(nc, descriptor.bucket);
  const object = await store.get(descriptor.key);
  if (!object) {
    throw new Error(`Object store entry not found: ${descriptor.bucket}/${descriptor.key}`);
  }
  const buffer = await readObjectStream(object);
  const fileName = descriptor.fileName || path.basename(descriptor.key);
  const outputPath = path.join(downloadDir, fileName);
  await fs.writeFile(outputPath, buffer);
  return outputPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const channelUserKey = requireArg(args.channelUserKey, "--channel-user-key");
  const channelDeviceId = requireArg(args.channelDeviceId, "--channel-device-id");
  const nc = await connectLucyNatsWithOptions({
    servers: [args.server],
    name: `lucy-demo-${channelUserKey}`,
    user: channelUserKey,
    pass: channelDeviceId,
    timeout: 5_000,
  });
  const subjects = buildSubjects({
    subjectPrefix: args.subjectPrefix,
    channelUserKey,
    channelDeviceId,
  });
  const sub = nc.subscribe(subjects.machineSubject);
  void (async () => {
    for await (const msg of sub) {
      const raw = msg.string();
      console.log(`[machine] ${raw}`);
      if (!args.downloadDir) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as { media?: MediaDescriptor };
        if (!parsed.media) {
          continue;
        }
        const savedPath = await maybeDownloadMedia(nc, parsed.media, args.downloadDir);
        console.log(`[media] saved to ${savedPath}`);
      } catch (err) {
        console.error(`[media] download failed: ${String(err)}`);
      }
    }
  })();

  const publishOnce = async (text: string | undefined, mediaPath?: string) => {
    const payload: Record<string, unknown> = {
      version: 2,
      messageId: makeDemoId(),
    };
    if (text?.trim()) {
      payload.text = text.trim();
    }
    if (mediaPath) {
      payload.media = await uploadMedia(nc, args, channelUserKey, channelDeviceId, mediaPath);
    }
    if (!payload.text && !payload.media) {
      throw new Error("Either text or media is required");
    }
    nc.publish(subjects.clientSubject, JSON.stringify(payload));
    await nc.flush();
  };

  if (args.text?.trim() || args.media) {
    await publishOnce(args.text, args.media);
    setTimeout(() => {
      void nc.close();
    }, args.waitMs);
    return;
  }

  const rl = createInterface({ input, output });
  console.log(`Connected. Publishing to ${subjects.clientSubject}`);
  console.log(`Listening on ${subjects.machineSubject}`);
  console.log(`Media bucket: ${args.mediaBucket}`);
  console.log("Using user/pass authentication");
  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) {
        continue;
      }
      if (line === "/quit" || line === "/exit") {
        break;
      }
      await publishOnce(line);
    }
  } finally {
    rl.close();
    await nc.close();
  }
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
