import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getLucyRuntime } from "./runtime.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import type { LucyDeviceState } from "./types.js";
import { DEVICE_STATE_VERSION } from "./types.js";

let cachedState: LucyDeviceState | null = null;

function resolveLucyStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = getLucyRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(stateDir, "lucy", "device-state.json");
}

type LegacyLucyDeviceState = {
  version: 1;
  deviceId: string;
  createdAtMs: number;
};

function isLucyDeviceState(value: unknown): value is LucyDeviceState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<LucyDeviceState>;
  return (
    record.version === DEVICE_STATE_VERSION &&
    typeof record.channelDeviceId === "string" &&
    /^\d{19}$/.test(record.channelDeviceId) &&
    typeof record.bootstrapToken === "string" &&
    record.bootstrapToken.length > 0 &&
    (record.bindingStatus === "pending" || record.bindingStatus === "bound") &&
    (record.channelUserKey === undefined || typeof record.channelUserKey === "string") &&
    typeof record.createdAtMs === "number"
  );
}

function isLegacyLucyDeviceState(value: unknown): value is LegacyLucyDeviceState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<LegacyLucyDeviceState>;
  return (
    record.version === 1 &&
    typeof record.deviceId === "string" &&
    /^\d{19}$/.test(record.deviceId) &&
    typeof record.createdAtMs === "number"
  );
}

function generateBootstrapToken(): string {
  return `cbt_${randomBytes(24).toString("base64url")}`;
}

function mergeLucyDeviceState(
  base: LucyDeviceState,
  overrides?: Partial<Pick<LucyDeviceState, "channelDeviceId" | "bootstrapToken" | "channelUserKey">>,
): LucyDeviceState {
  const nextChannelUserKey = overrides?.channelUserKey?.trim() || base.channelUserKey;
  return {
    ...base,
    channelDeviceId: overrides?.channelDeviceId?.trim() || base.channelDeviceId,
    bootstrapToken: overrides?.bootstrapToken?.trim() || base.bootstrapToken,
    channelUserKey: nextChannelUserKey,
    bindingStatus: nextChannelUserKey ? "bound" : "pending",
  };
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
      if (isLegacyLucyDeviceState(parsed)) {
        const migrated: LucyDeviceState = {
          version: DEVICE_STATE_VERSION,
          channelDeviceId: parsed.deviceId,
          bootstrapToken: generateBootstrapToken(),
          bindingStatus: "pending",
          createdAtMs: parsed.createdAtMs,
        };
        await writeLucyDeviceState(migrated, params);
        return migrated;
      }
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
  overrides?: Partial<Pick<LucyDeviceState, "channelDeviceId" | "bootstrapToken" | "channelUserKey">>;
}): Promise<LucyDeviceState> {
  const existing = await readLucyDeviceState(params);
  if (existing) {
    const merged = mergeLucyDeviceState(existing, params?.overrides);
    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      await writeLucyDeviceState(merged, params);
      return merged;
    }
    return existing;
  }
  const initial: LucyDeviceState = {
    version: DEVICE_STATE_VERSION,
    channelDeviceId: getProcessSnowflakeGenerator().nextId(),
    bootstrapToken: generateBootstrapToken(),
    bindingStatus: "pending",
    createdAtMs: Date.now(),
  };
  const state = mergeLucyDeviceState(initial, params?.overrides);
  await writeLucyDeviceState(state, params);
  return state;
}
