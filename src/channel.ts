import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { lucyChannelConfigSchema } from "./config-schema.js";
import { listLucyAccountIds, resolveLucyAccount, unconfiguredLucyReason } from "./config.js";
import { startLucyGateway } from "./gateway.js";
import { ensureLucyMediaStore, uploadLucyMediaFromSource } from "./media.js";
import { buildLucySubjects, connectLucyNats } from "./nats.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import { publishLucyMachineEvent } from "./send.js";
import { loadOrCreateLucyDeviceState } from "./state.js";
import { DEFAULT_ACCOUNT_ID, type LucyProbe, type ResolvedLucyAccount } from "./types.js";

export function normalizeLucyOutboundTarget(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^lucy:/i, "").trim() || undefined;
}

export function mergeLucyMediaLocalRoots(
  runtimeRoots: readonly string[] | undefined,
  configuredRoots: readonly string[] | undefined,
): readonly string[] | undefined {
  const merged = [...(runtimeRoots ?? []), ...(configuredRoots ?? [])]
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
  return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
}

async function publishLucyOutboundAssistantFinal(params: {
  cfg: OpenClawConfig;
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string | null;
}) {
  const account = resolveLucyAccount(params.cfg, params.accountId);
  if (!account.apiKey) {
    throw new Error("lucy apiKey is not configured");
  }

  const deviceState = await loadOrCreateLucyDeviceState();
  const targetApiKey = normalizeLucyOutboundTarget(params.to) || account.apiKey;
  const targetAccount: ResolvedLucyAccount = {
    ...account,
    apiKey: targetApiKey,
  };
  const trimmedText = params.text?.trim() || undefined;
  const connection = await connectLucyNats(account);
  const mediaLocalRoots = mergeLucyMediaLocalRoots(
    params.mediaLocalRoots,
    account.mediaLocalRoots,
  );

  try {
    const eventId = getProcessSnowflakeGenerator().nextId();
    const media = params.mediaUrl
      ? await uploadLucyMediaFromSource({
          connection,
          account: targetAccount,
          deviceId: deviceState.deviceId,
          eventId,
          mediaUrl: params.mediaUrl,
          mediaLocalRoots,
        })
      : undefined;

    if (!trimmedText && !media) {
      throw new Error("lucy outbound requires text or media");
    }

    const event = await publishLucyMachineEvent({
      account: targetAccount,
      connection,
      deviceId: deviceState.deviceId,
      eventId,
      type: "assistant.final",
      text: trimmedText,
      media,
    });

    return {
      channel: "lucy",
      to: targetApiKey,
      messageId: event.eventId,
    };
  } finally {
    await connection.close();
  }
}

export const lucyPlugin: ChannelPlugin<ResolvedLucyAccount, LucyProbe> = {
  id: "lucy",
  meta: {
    id: "lucy",
    label: "Lucy",
    selectionLabel: "Lucy (NATS DM)",
    docsPath: "/channels/lucy",
    docsLabel: "lucy",
    blurb: "DM-only chat over NATS subjects scoped by apiKey and deviceId.",
    order: 95,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.lucy"] },
  configSchema: lucyChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listLucyAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveLucyAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    unconfiguredReason: (account) => unconfiguredLucyReason(account),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      audience: account.apiKey,
      dmPolicy: account.dmPolicy,
      mediaBucket: account.mediaBucket,
      mediaRetentionHours: account.mediaRetentionHours,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveLucyAccount(cfg, accountId).allowFrom,
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.dmPolicy,
      allowFrom: account.dmPolicy === "allowlist" ? account.allowFrom : [],
      allowFromPath: "channels.lucy.allowFrom",
      policyPath: "channels.lucy.dmPolicy",
      approveHint: "Configure channels.lucy.apiKey or channels.lucy.allowFrom",
      normalizeEntry: (raw) => raw.trim(),
    }),
  },
  messaging: {
    normalizeTarget: (raw) => normalizeLucyOutboundTarget(raw),
    targetResolver: {
      looksLikeId: (raw) => raw.trim().length > 0,
      hint: "<apiKey>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ cfg, to, text, accountId }) =>
      await publishLucyOutboundAssistantFinal({
        cfg,
        to,
        text,
        accountId,
      }),
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId }) =>
      await publishLucyOutboundAssistantFinal({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
      }),
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("lucy", accounts),
    probeAccount: async ({ account }) => {
      if (!account.apiKey) {
        throw new Error("lucy apiKey is not configured");
      }
      const deviceState = await loadOrCreateLucyDeviceState();
      const connection = await connectLucyNats(account);
      try {
        await connection.flush();
        await ensureLucyMediaStore({
          connection,
          account,
        });
        const subjects = buildLucySubjects({
          subjectPrefix: account.subjectPrefix,
          apiKey: account.apiKey,
          deviceId: deviceState.deviceId,
        });
        return {
          ok: true,
          connectedUrl: connection.getServer(),
          clientSubject: subjects.clientSubject,
          machineSubject: subjects.machineSubject,
          deviceId: deviceState.deviceId,
          mediaBucket: account.mediaBucket,
          mediaRetentionHours: account.mediaRetentionHours,
        };
      } finally {
        await connection.close();
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      lastError: runtime?.lastError ?? null,
      audience: account.apiKey,
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
      baseUrl: account.servers[0],
      mediaBucket: account.mediaBucket,
      mediaRetentionHours: account.mediaRetentionHours,
      cliPath: (probe as LucyProbe | undefined)?.clientSubject ?? runtime?.cliPath ?? null,
      dbPath: (probe as LucyProbe | undefined)?.machineSubject ?? runtime?.dbPath ?? null,
      application: {
        deviceId:
          (probe as LucyProbe | undefined)?.deviceId ??
          (runtime?.application as { deviceId?: string } | undefined)?.deviceId ??
          null,
      },
      probe,
    }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      audience: snapshot.audience ?? null,
      deviceId: (snapshot.application as { deviceId?: string } | undefined)?.deviceId ?? null,
      clientSubject: snapshot.cliPath ?? null,
      machineSubject: snapshot.dbPath ?? null,
      mediaBucket: (snapshot as { mediaBucket?: string } | undefined)?.mediaBucket ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    logSelfId: ({ account, includeChannelPrefix }) => {
      const prefix = includeChannelPrefix === false ? "" : "[lucy] ";
      void loadOrCreateLucyDeviceState()
        .then((deviceState) => {
          console.log(
            `${prefix}deviceId=${deviceState.deviceId} apiKey=${account.apiKey ?? "unset"} mediaBucket=${account.mediaBucket}`,
          );
        })
        .catch(() => {
          console.log(
            `${prefix}deviceId=unavailable apiKey=${account.apiKey ?? "unset"} mediaBucket=${account.mediaBucket}`,
          );
        });
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      return await startLucyGateway(ctx);
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
};
