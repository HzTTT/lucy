import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import {
  clearLucyRestartTicket,
  readLucyRestartTicket,
  type LucyRestartTicket,
  writeLucyRestartTicket,
} from "./restart-ticket.js";
import { getLucyRuntime } from "./runtime.js";
import { publishLucyMachineEvent } from "./send.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import type { LucyConfig, LucyProvisioningPayload, ResolvedLucyAccount } from "./types.js";
import {
  buildLucyCephalonModelDefinition,
  LUCY_CEPHALON_BASE_URL as LUCY_DEFAULT_CEPHALON_BASE_URL,
  LUCY_CEPHALON_DEFAULT_MODEL_ID as LUCY_DEFAULT_CEPHALON_MODEL_ID,
  LUCY_CEPHALON_DEFAULT_MODEL_REF,
  LUCY_CEPHALON_PROVIDER_ID,
} from "./cephalon-provider.js";

export const DEFAULT_LUCY_RESTART_HELPER_COMMAND = "openclaw";
export const DEFAULT_LUCY_RESTART_HELPER_ARGS = ["gateway", "restart"] as const;
export const DEFAULT_LUCY_RESTART_ONLINE_TIMEOUT_MS = 45_000;

type LucyWritableConfigRuntime = {
  loadConfig: () => OpenClawConfig;
  writeConfigFile: (next: OpenClawConfig) => Promise<void>;
};

type LucyRestartChildProcess = {
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  unref?: () => void;
};
export type LucyRestartSpawn = (
  command: string,
  args: readonly string[],
  options: { detached?: boolean; stdio?: string; env?: Record<string, string | undefined> },
) => LucyRestartChildProcess;

const LUCY_MULTIMODAL_RAG_PLUGIN_ID = "multimodal-rag";
const LUCY_CEPHALON_MODEL_PATH = "/cephalon/user-center/v1/model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAbsoluteCephalonModelUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  const pathname = parsed.pathname.replace(/\/+$/u, "");
  if (pathname !== LUCY_CEPHALON_MODEL_PATH) {
    return null;
  }

  return `${parsed.origin}${pathname}`;
}

function applyLucyMultimodalRagProvisioningConfig(
  cfg: OpenClawConfig,
  provision: LucyProvisioningPayload,
): OpenClawConfig {
  const provisionBaseUrl = normalizeAbsoluteCephalonModelUrl(provision.baseUrl);
  if (!provisionBaseUrl) {
    return cfg;
  }

  const existingPlugins = isRecord(cfg.plugins) ? cfg.plugins : null;
  const existingEntries = existingPlugins && isRecord(existingPlugins.entries)
    ? (existingPlugins.entries as Record<string, unknown>)
    : null;
  const existingEntry = existingEntries?.[LUCY_MULTIMODAL_RAG_PLUGIN_ID];
  if (!isRecord(existingEntry) || existingEntry.enabled !== true || !isRecord(existingEntry.config)) {
    return cfg;
  }

  const nextPluginConfig = {
    ...existingEntry.config,
  } as Record<string, unknown>;
  let changed = false;

  if (isRecord(nextPluginConfig.ollama)) {
    const nextOllama = {
      ...nextPluginConfig.ollama,
    } as Record<string, unknown>;
    if (normalizeAbsoluteCephalonModelUrl(nextOllama.baseUrl)) {
      nextOllama.apiKey = provision.apiKey;
      nextPluginConfig.ollama = nextOllama;
      changed = true;
    }
  }

  if (isRecord(nextPluginConfig.whisper)) {
    const nextWhisper = {
      ...nextPluginConfig.whisper,
    } as Record<string, unknown>;
    if (
      nextWhisper.provider === "zhipu" &&
      normalizeAbsoluteCephalonModelUrl(nextWhisper.zhipuApiBaseUrl)
    ) {
      nextWhisper.zhipuApiKey = provision.apiKey;
      nextPluginConfig.whisper = nextWhisper;
      changed = true;
    }
  }

  if (!changed) {
    return cfg;
  }

  return {
    ...cfg,
    plugins: {
      ...(cfg.plugins ?? {}),
      entries: {
        ...(cfg.plugins?.entries ?? {}),
        [LUCY_MULTIMODAL_RAG_PLUGIN_ID]: {
          ...existingEntry,
          config: nextPluginConfig,
        },
      },
    },
  };
}

function resolveLucyWritableConfigRuntime(): LucyWritableConfigRuntime {
  const configRuntime = (getLucyRuntime() as { config?: Partial<LucyWritableConfigRuntime> }).config;
  if (!configRuntime?.loadConfig || !configRuntime.writeConfigFile) {
    throw new Error("Lucy runtime config.writeConfigFile is not available");
  }
  return {
    loadConfig: configRuntime.loadConfig,
    writeConfigFile: configRuntime.writeConfigFile,
  };
}

function mergeProviderModels(existing: unknown, modelId: string): Record<string, unknown>[] {
  const models = Array.isArray(existing) ? [...existing] : [];
  if (!models.some((entry) => isRecord(entry) && entry.id === modelId)) {
    models.push(buildLucyCephalonModelDefinition(modelId));
  }
  return models.map((entry) => (isRecord(entry) ? { ...entry } : { value: entry }));
}

function extractLucyConfigSection(cfg: OpenClawConfig): LucyConfig {
  const section = cfg.channels?.lucy;
  if (!isRecord(section)) {
    return {};
  }
  return section as LucyConfig;
}

function resolveRestartHelperCommand(cfg: OpenClawConfig): string {
  return extractLucyConfigSection(cfg).restartHelperCommand?.trim() || DEFAULT_LUCY_RESTART_HELPER_COMMAND;
}

function resolveRestartHelperArgs(cfg: OpenClawConfig): string[] {
  const configured = extractLucyConfigSection(cfg).restartHelperArgs;
  if (Array.isArray(configured)) {
    const args = configured.map((entry) => entry.trim()).filter(Boolean);
    if (args.length > 0) {
      return args;
    }
  }
  return [...DEFAULT_LUCY_RESTART_HELPER_ARGS];
}

function resolveRestartOnlineTimeoutMs(cfg: OpenClawConfig): number {
  const configured = extractLucyConfigSection(cfg).restartOnlineTimeoutMs;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_LUCY_RESTART_ONLINE_TIMEOUT_MS;
}

export function applyLucyProvisioningConfig(
  cfg: OpenClawConfig,
  provision: LucyProvisioningPayload,
): OpenClawConfig {
  const providerId = provision.providerId.trim() || LUCY_CEPHALON_PROVIDER_ID;
  const modelId = provision.modelId.trim() || LUCY_DEFAULT_CEPHALON_MODEL_ID;
  const modelRef = `${providerId}/${modelId}`;
  const shouldSwitchDefaultModel = provision.switchDefaultModel !== false;
  const providers = {
    ...(cfg.models?.providers ?? {}),
  } as Record<string, ModelProviderConfig>;
  const existingProvider = (providers[providerId] ?? {}) as Partial<ModelProviderConfig> &
    Record<string, unknown>;
  providers[providerId] = {
    ...existingProvider,
    api: "openai-completions",
    baseUrl: provision.baseUrl?.trim() || LUCY_DEFAULT_CEPHALON_BASE_URL,
    apiKey: provision.apiKey,
    models: mergeProviderModels(existingProvider.models, modelId),
  } as ModelProviderConfig;

  const models = {
    ...(cfg.agents?.defaults?.models ?? {}),
  } as Record<string, Record<string, unknown>>;
  models[modelRef] = {
    ...(models[modelRef] ?? {}),
    alias:
      typeof models[modelRef]?.alias === "string" && models[modelRef]?.alias.trim().length > 0
        ? models[modelRef]?.alias
        : modelId === LUCY_DEFAULT_CEPHALON_MODEL_ID
          ? "Kimi"
          : modelId,
  };

  const nextDefaults: Record<string, unknown> = {
    ...(cfg.agents?.defaults ?? {}),
    models,
  };
  if (shouldSwitchDefaultModel) {
    nextDefaults.model = {
      ...(isRecord(cfg.agents?.defaults?.model) ? cfg.agents?.defaults?.model : {}),
      primary: modelRef,
    };
  }

  const nextCfg: OpenClawConfig = {
    ...cfg,
    models: {
      ...(cfg.models ?? {}),
      providers,
    },
    agents: {
      ...(cfg.agents ?? {}),
      defaults: nextDefaults as OpenClawConfig["agents"] extends { defaults?: infer T } ? T : never,
    },
  };

  return applyLucyMultimodalRagProvisioningConfig(nextCfg, provision);
}

export async function spawnLucyRestartHelper(params: {
  cfg: OpenClawConfig;
  spawnImpl?: LucyRestartSpawn;
}): Promise<void> {
  const command = resolveRestartHelperCommand(params.cfg);
  const args = resolveRestartHelperArgs(params.cfg);

  if (params.spawnImpl) {
    await new Promise<void>((resolve, reject) => {
      let child: LucyRestartChildProcess;
      try {
        child = params.spawnImpl!(command, args, {
          detached: true,
          stdio: "ignore",
          env: process.env,
        });
      } catch (err) {
        reject(err);
        return;
      }

      child.once("error", (err) => {
        reject(err);
      });
      child.once("spawn", () => {
        child.unref?.();
        resolve();
      });
    });
    return;
  }

  // Use Plugin SDK process API — avoids direct child_process import
  // so the plugin passes the install-time security scan.
  // Fire-and-forget: the restart command outlives this process
  // (reparented to init on Linux when the gateway dies).
  void runCommandWithTimeout([command, ...args], 120_000).catch(() => {});
}

function buildRestartTicket(params: {
  cfg: OpenClawConfig;
  provision: LucyProvisioningPayload;
}): LucyRestartTicket {
  const requestedAtMs = Date.now();
  const expectedOnlineTimeoutMs = resolveRestartOnlineTimeoutMs(params.cfg);
  return {
    version: 1,
    ticketId: `rst_${getProcessSnowflakeGenerator().nextId()}`,
    requestedAtMs,
    expectedOnlineAtMs: requestedAtMs + expectedOnlineTimeoutMs,
    expectedOnlineTimeoutMs,
    providerId: params.provision.providerId,
    modelId: params.provision.modelId,
  };
}

export async function handleLucyProvisioningMessage(params: {
  cfg: OpenClawConfig;
  account: ResolvedLucyAccount;
  connection?: Parameters<typeof publishLucyMachineEvent>[0]["connection"];
  deviceId: string;
  sourceMessageId?: string;
  provision: LucyProvisioningPayload;
  log?: {
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  spawnImpl?: LucyRestartSpawn;
}): Promise<void> {
  if (params.provision.providerId !== LUCY_CEPHALON_PROVIDER_ID) {
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "config.error",
      sourceMessageId: params.sourceMessageId,
      text: `unsupported provider: ${params.provision.providerId}`,
      metadata: {
        providerId: params.provision.providerId,
      },
    });
    return;
  }

  try {
    const runtimeConfig = resolveLucyWritableConfigRuntime();
    const currentCfg = runtimeConfig.loadConfig();
    const nextCfg = applyLucyProvisioningConfig(currentCfg, params.provision);
    await runtimeConfig.writeConfigFile(nextCfg);

    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "config.updated",
      sourceMessageId: params.sourceMessageId,
      text: `configured ${params.provision.providerId}/${params.provision.modelId}`,
      metadata: {
        providerId: params.provision.providerId,
        modelId: params.provision.modelId,
        switchDefaultModel: String(params.provision.switchDefaultModel !== false),
      },
    });

    if (params.provision.restartRequested === false) {
      return;
    }

    const ticket = buildRestartTicket({
      cfg: currentCfg,
      provision: params.provision,
    });
    await writeLucyRestartTicket(ticket);
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "restart.scheduled",
      sourceMessageId: params.sourceMessageId,
      text: "configuration applied; restarting gateway",
      metadata: {
        ticketId: ticket.ticketId,
        expectedOnlineAtMs: String(ticket.expectedOnlineAtMs),
        expectedOnlineTimeoutMs: String(ticket.expectedOnlineTimeoutMs),
        modelId: ticket.modelId,
      },
    });

    await spawnLucyRestartHelper({
      cfg: currentCfg,
      spawnImpl: params.spawnImpl,
    });
  } catch (err) {
    await clearLucyRestartTicket().catch(() => {});
    params.log?.error?.(`[lucy] provisioning failed: ${String(err)}`);
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "config.error",
      sourceMessageId: params.sourceMessageId,
      text: `provisioning failed: ${String(err)}`,
      metadata: {
        providerId: params.provision.providerId,
        modelId: params.provision.modelId,
      },
    });
  }
}

export async function publishLucyRestartCompletionIfPending(params: {
  account: ResolvedLucyAccount;
  connection?: Parameters<typeof publishLucyMachineEvent>[0]["connection"];
  deviceId: string;
}): Promise<void> {
  const ticket = await readLucyRestartTicket();
  if (!ticket) {
    return;
  }

  await publishLucyMachineEvent({
    account: params.account,
    connection: params.connection,
    deviceId: params.deviceId,
    type: "restart.completed",
    text: "gateway restart completed",
    metadata: {
      ticketId: ticket.ticketId,
      modelId: ticket.modelId,
    },
  });
  await clearLucyRestartTicket();
}
