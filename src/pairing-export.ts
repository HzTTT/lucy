import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LucyBindingStatus } from "./types.js";
import { LucyBindingStatusSchema } from "./types.js";

export const LucyPairingExportSchema = z.object({
  version: z.literal(1),
  channel: z.literal("lucy"),
  state: z.literal("ready"),
  channel_device_id: z.string().min(1),
  binding_status: LucyBindingStatusSchema,
  created_at_ms: z.number().int().nonnegative(),
});

export type LucyPairingExport = z.infer<typeof LucyPairingExportSchema>;

function expandHomeDir(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "/tmp", p.slice(2));
  }
  return p;
}

async function readFileOptional(filePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function resolveLucyPairingExportPath(homeDir: string): string {
  return path.join(expandHomeDir(homeDir), "pairing-info.json");
}

export async function readLucyPairingExport(homeDir: string): Promise<LucyPairingExport | null> {
  const filePath = resolveLucyPairingExportPath(homeDir);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return LucyPairingExportSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export async function syncLucyPairingExport(homeDir: string): Promise<void> {
  const resolvedHome = expandHomeDir(homeDir);
  const cdi = await readFileOptional(path.join(resolvedHome, "channel_ids", "cdi"));
  if (!cdi) {
    // Not initialized yet — skip silently
    return;
  }

  const cuk = await readFileOptional(path.join(resolvedHome, "channel_ids", "cuk"));
  const bindingStatus: LucyBindingStatus = cuk ? "bound" : "pending";

  const exportData: LucyPairingExport = {
    version: 1,
    channel: "lucy",
    state: "ready",
    channel_device_id: cdi,
    binding_status: bindingStatus,
    created_at_ms: Date.now(),
  };

  const filePath = resolveLucyPairingExportPath(homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(exportData, null, 2)}\n`, "utf8");
  await fs.chmod(filePath, 0o600);
}
