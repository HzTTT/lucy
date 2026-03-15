import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getLucyRuntime } from "./runtime.js";
import {
  LucyBindingStatusSchema,
  LucyMessageIdSchema,
  type LucyDeviceState,
} from "./types.js";

export const LucyPairingExportSchema = z.object({
  version: z.literal(1),
  channel: z.literal("lucy"),
  state: z.literal("ready"),
  channel_device_id: LucyMessageIdSchema,
  binding_status: LucyBindingStatusSchema,
  created_at_ms: z.number().int().nonnegative(),
});

export type LucyPairingExport = z.infer<typeof LucyPairingExportSchema>;

function buildLucyPairingExport(state: LucyDeviceState): LucyPairingExport {
  return {
    version: 1,
    channel: "lucy",
    state: "ready",
    channel_device_id: state.channelDeviceId,
    binding_status: state.bindingStatus,
    created_at_ms: state.createdAtMs,
  };
}

export function resolveLucyPairingExportPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = getLucyRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(stateDir, "lucy", "pairing-info.json");
}

export async function readLucyPairingExport(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<LucyPairingExport | null> {
  const filePath = resolveLucyPairingExportPath(params?.env);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return LucyPairingExportSchema.parse(JSON.parse(raw) as unknown);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function syncLucyPairingExport(
  state: LucyDeviceState,
  params?: { env?: NodeJS.ProcessEnv },
): Promise<void> {
  const filePath = resolveLucyPairingExportPath(params?.env);
  const nextExport = buildLucyPairingExport(state);
  const existing = await readLucyPairingExport(params);
  if (existing && JSON.stringify(existing) === JSON.stringify(nextExport)) {
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(nextExport, null, 2)}\n`, "utf8");
  await fs.chmod(filePath, 0o600);
}
