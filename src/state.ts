import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getLucyRuntime } from "./runtime.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import type { LucyDeviceState } from "./types.js";
import { DEVICE_STATE_VERSION } from "./types.js";

let cachedState: LucyDeviceState | null = null;

function resolveLucyStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = getLucyRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(stateDir, "lucy", "device-state.json");
}

function isLucyDeviceState(value: unknown): value is LucyDeviceState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<LucyDeviceState>;
  return (
    record.version === DEVICE_STATE_VERSION &&
    typeof record.deviceId === "string" &&
    /^\d{19}$/.test(record.deviceId) &&
    typeof record.createdAtMs === "number"
  );
}

export async function readLucyDeviceState(params?: {
  env?: NodeJS.ProcessEnv;
  forceReload?: boolean;
}): Promise<LucyDeviceState | null> {
  if (!params?.forceReload && cachedState) {
    return cachedState;
  }

  const filePath = resolveLucyStatePath(params?.env);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isLucyDeviceState(parsed)) {
      return null;
    }
    cachedState = parsed;
    return parsed;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function writeLucyDeviceState(
  state: LucyDeviceState,
  params?: { env?: NodeJS.ProcessEnv },
): Promise<void> {
  const filePath = resolveLucyStatePath(params?.env);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.chmod(filePath, 0o600);
  cachedState = state;
}

export async function loadOrCreateLucyDeviceState(params?: {
  env?: NodeJS.ProcessEnv;
  forceReload?: boolean;
}): Promise<LucyDeviceState> {
  const existing = await readLucyDeviceState(params);
  if (existing) {
    return existing;
  }
  const state: LucyDeviceState = {
    version: DEVICE_STATE_VERSION,
    deviceId: getProcessSnowflakeGenerator().nextId(),
    createdAtMs: Date.now(),
  };
  await writeLucyDeviceState(state, params);
  return state;
}
