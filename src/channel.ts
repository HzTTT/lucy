import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import {
  buildExecApprovalPendingReplyPayload,
  getExecApprovalReplyMetadata,
  resolveExecApprovalCommandDisplay,
} from "./exec-approval-helpers.js";
import { syncLucyBindingWithSdk, connectLucySdk } from "./auth-binding.js";
import { lucyChannelConfigSchema } from "./config-schema.js";
import { buildLucyImConfig, listLucyAccountIds, resolveLucyAccount, unconfiguredLucyReason } from "./config.js";
import { startLucyGateway } from "./gateway.js";
import { uploadLucyMediaFromSource } from "./media.js";
import {
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "./plugin-sdk-compat.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import { publishLucyMachineEvent } from "./send.js";
import {
  DEFAULT_ACCOUNT_ID,
  type LucyProbe,
  type ResolvedLucyAccount,
} from "./types.js";

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
  const sdkCfg = buildLucyImConfig(account);

  // Connect (will throw if not bound)
  const { client: session, cdi, userId, cuk } = await connectLucySdk({ cfg: sdkCfg });

  const targetCuk = normalizeLucyOutboundTarget(params.to) || cuk;
  const trimmedText = params.text?.trim() || undefined;
  const mediaLocalRoots = mergeLucyMediaLocalRoots(
    params.mediaLocalRoots,
    account.mediaLocalRoots,
  );

  try {
    const eventId = getProcessSnowflakeGenerator().nextId();
    const media = params.mediaUrl
      ? await uploadLucyMediaFromSource({
          eventId,
          mediaUrl: params.mediaUrl,
          maxBytes: account.mediaMaxBytes,
          mediaLocalRoots,
        })
      : undefined;

    if (!trimmedText && !media) {
      throw new Error("lucy outbound requires text or media");
    }

    const event = await publishLucyMachineEvent({
      session,
      userId,
      cuk: targetCuk,
      cdi,
      eventId,
      type: "assistant.final",
      text: trimmedText,
      media,
    });

    return {
      channel: "lucy",
      to: targetCuk,
      messageId: event.eventId,
    };
  } finally {
    await session.shutdown().catch(() => undefined);
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
    blurb: "DM-only chat over NATS subjects scoped by channel_user_key and channel_device_id.",
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
      audience: account.userCenterDomain,
      dmPolicy: account.dmPolicy,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveLucyAccount(cfg, accountId).allowFrom,
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.dmPolicy,
      allowFrom: account.dmPolicy === "allowlist" ? account.allowFrom : [],
      allowFromPath: "channels.lucy.allowFrom",
      policyPath: "channels.lucy.dmPolicy",
      approveHint: "Configure channels.lucy.allowFrom",
      normalizeEntry: (raw) => raw.trim(),
    }),
  },
  messaging: {
    normalizeTarget: (raw) => normalizeLucyOutboundTarget(raw),
    targetResolver: {
      looksLikeId: (raw) => raw.trim().length > 0,
      hint: "<channelUserKey>",
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
  execApprovals: {
    getInitiatingSurfaceState: ({ cfg, accountId }) =>
      resolveLucyAccount(cfg, accountId).configured
        ? { kind: "enabled" as const }
        : { kind: "disabled" as const },

    hasConfiguredDmRoute: ({ cfg }) =>
      Boolean(resolveLucyAccount(cfg).configured),

    shouldSuppressLocalPrompt: ({ payload }) =>
      getExecApprovalReplyMetadata(payload) !== null,

    shouldSuppressForwardingFallback: ({ cfg, target }) =>
      target.channel === "lucy" && resolveLucyAccount(cfg).configured,

    buildPendingPayload: ({ cfg, request, target, nowMs }) =>
      buildExecApprovalPendingReplyPayload({
        approvalId: request.id,
        approvalSlug: request.id.slice(0, 8),
        approvalCommandId: request.id,
        command: resolveExecApprovalCommandDisplay(request.request).commandText,
        cwd: request.request.cwd ?? undefined,
        host: request.request.host === "node" ? "node" : "gateway",
        nodeId: request.request.nodeId ?? undefined,
        expiresAtMs: request.expiresAtMs,
        nowMs,
      }),

    buildResolvedPayload: ({ cfg, resolved, target }) => ({
      text: `✅ 执行审批已${resolved.decision === "deny" ? "拒绝" : "通过"}`,
    }),
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("lucy", accounts),
    probeAccount: async ({ account }) => {
      // Read-only probe: inspect local homeDir state instead of opening a NATS
      // connection. A previous version called connectLucySdk() here, which made
      // the probe expensive (fetch NATS token + new connection + presence
      // spawn) and destructive — at typical web-UI polling rates it produced
      // 60+ fetch_nats_token_npc requests per minute and disrupted the
      // long-lived subscribe loop in startLucyGateway.
      const home = account.homeDir.startsWith("~")
        ? account.homeDir.replace("~", homedir())
        : account.homeDir;
      const channelIdsDir = join(home, "channel_ids");
      const readOptional = async (name: string): Promise<string | undefined> => {
        try {
          const value = (await readFile(join(channelIdsDir, name), "utf8")).trim();
          return value || undefined;
        } catch {
          return undefined;
        }
      };
      const [cdi, userId, cuk] = await Promise.all([
        readOptional("cdi"),
        readOptional("user_id"),
        readOptional("cuk"),
      ]);

      if (cdi && userId && cuk) {
        return {
          ok: true,
          bindingStatus: "bound" as const,
          connectedUrl: account.lucyServerDomain,
          clientSubject: `cephalon.im.npc.${userId}.${cdi}`,
          machineSubject: `cephalon.im.user.${userId}`,
          channelDeviceId: cdi,
          channelUserKey: cuk,
          bindingCheckUrl: `https://${account.userCenterDomain}/v1/channels/lucy/device-bindings/${encodeURIComponent(cdi)}`,
          userCenterBaseUrl: `https://${account.userCenterDomain}`,
          mediaBucket: "",
          mediaRetentionHours: 0,
        };
      }

      return {
        ok: true,
        bindingStatus: "pending" as const,
        connectedUrl: null,
        clientSubject: null,
        machineSubject: null,
        channelDeviceId: cdi ?? "unknown",
        bindingCheckUrl: `https://${account.userCenterDomain}/v1/channels/lucy/device-bindings/${encodeURIComponent(cdi ?? "unknown")}`,
        userCenterBaseUrl: `https://${account.userCenterDomain}`,
        mediaBucket: "",
        mediaRetentionHours: 0,
      };
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
      audience: account.userCenterDomain,
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
      baseUrl: account.lucyServerDomain,
      cliPath: (probe as LucyProbe | undefined)?.clientSubject ?? runtime?.cliPath ?? null,
      dbPath: (probe as LucyProbe | undefined)?.machineSubject ?? runtime?.dbPath ?? null,
      application: {
        channelDeviceId:
          (probe as LucyProbe | undefined)?.channelDeviceId ??
          (runtime?.application as { channelDeviceId?: string } | undefined)?.channelDeviceId ??
          null,
        bindingStatus:
          (probe as LucyProbe | undefined)?.bindingStatus ??
          (runtime?.application as { bindingStatus?: string } | undefined)?.bindingStatus ??
          null,
      },
      probe,
    }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      audience: snapshot.audience ?? null,
      channelDeviceId:
        (snapshot.application as { channelDeviceId?: string } | undefined)?.channelDeviceId ??
        null,
      bindingStatus:
        (snapshot.application as { bindingStatus?: string } | undefined)?.bindingStatus ?? null,
      clientSubject: snapshot.cliPath ?? null,
      machineSubject: snapshot.dbPath ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    logSelfId: ({ account, includeChannelPrefix }) => {
      const prefix = includeChannelPrefix === false ? "" : "[lucy] ";
      const sdkCfg = buildLucyImConfig(account);
      void import("lucy-im-sdk")
        .then(async ({ LucyImClient }) => {
          const imClient = new LucyImClient(sdkCfg);
          const identity = await imClient.deviceIdentity();
          console.log(
            `${prefix}channelDeviceId=${identity.cdi} userId=${identity.user_id ?? "pending"} bindingStatus=${identity.user_id ? "bound" : "pending"}`,
          );
        })
        .catch(() => {
          console.log(
            `${prefix}channelDeviceId=unavailable bindingStatus=pending`,
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
