import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import {
  buildExecApprovalPendingReplyPayload,
  getExecApprovalReplyMetadata,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/infra-runtime";
import { hydrateLucyAccountFromState, syncLucyBindingState } from "./auth-binding.js";
import { lucyChannelConfigSchema } from "./config-schema.js";
import { listLucyAccountIds, resolveLucyAccount, unconfiguredLucyReason } from "./config.js";
import { startLucyGateway } from "./gateway.js";
import { ensureLucyMediaStore, uploadLucyMediaFromSource } from "./media.js";
import { buildLucySubjects, connectLucyNats } from "./nats.js";
import {
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "./plugin-sdk-compat.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import { publishLucyMachineEvent } from "./send.js";
import {
  DEFAULT_ACCOUNT_ID,
  LUCY_USER_CENTER_BASE_URL,
  type LucyProbe,
  type ResolvedLucyAccount,
} from "./types.js";
import { buildLucyBindingCheckUrl } from "./user-center.js";

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
  const deviceState = await syncLucyBindingState({
    account,
    waitForBinding: false,
  });
  const boundAccount = hydrateLucyAccountFromState(account, deviceState);
  if (!boundAccount.channelUserKey) {
    throw new Error("lucy channelUserKey is not bound yet");
  }

  const targetChannelUserKey = normalizeLucyOutboundTarget(params.to) || boundAccount.channelUserKey;
  const targetAccount: ResolvedLucyAccount = {
    ...boundAccount,
    channelUserKey: targetChannelUserKey,
  };
  const trimmedText = params.text?.trim() || undefined;
  const connection = await connectLucyNats(boundAccount);
  const mediaLocalRoots = mergeLucyMediaLocalRoots(
    params.mediaLocalRoots,
    boundAccount.mediaLocalRoots,
  );

  try {
    const eventId = getProcessSnowflakeGenerator().nextId();
    const media = params.mediaUrl
      ? await uploadLucyMediaFromSource({
          connection,
          account: targetAccount,
          deviceId: deviceState.channelDeviceId,
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
      deviceId: deviceState.channelDeviceId,
      eventId,
      type: "assistant.final",
      text: trimmedText,
      media,
    });

    return {
      channel: "lucy",
      to: targetChannelUserKey,
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
      audience: account.channelUserKey,
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
      approveHint: "Configure channels.lucy.channelUserKey or channels.lucy.allowFrom",
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
      const deviceState = await syncLucyBindingState({
        account,
        waitForBinding: false,
      });
      const boundAccount = hydrateLucyAccountFromState(account, deviceState);
      if (!boundAccount.channelUserKey) {
        return {
          ok: true,
          bindingStatus: deviceState.bindingStatus,
          connectedUrl: null,
          clientSubject: null,
          machineSubject: null,
          channelDeviceId: deviceState.channelDeviceId,
          bindingCheckUrl: buildLucyBindingCheckUrl(deviceState.channelDeviceId),
          userCenterBaseUrl: LUCY_USER_CENTER_BASE_URL,
          mediaBucket: account.mediaBucket,
          mediaRetentionHours: account.mediaRetentionHours,
        };
      }
      const connection = await connectLucyNats(boundAccount);
      try {
        await connection.flush();
        await ensureLucyMediaStore({
          connection,
          account: boundAccount,
        });
        const subjects = buildLucySubjects({
          subjectPrefix: boundAccount.subjectPrefix,
          channelUserKey: boundAccount.channelUserKey,
          channelDeviceId: deviceState.channelDeviceId,
        });
        return {
          ok: true,
          bindingStatus: deviceState.bindingStatus,
          connectedUrl: connection.getServer(),
          clientSubject: subjects.clientSubject,
          machineSubject: subjects.machineSubject,
          channelDeviceId: deviceState.channelDeviceId,
          channelUserKey: boundAccount.channelUserKey,
          bindingCheckUrl: buildLucyBindingCheckUrl(deviceState.channelDeviceId),
          userCenterBaseUrl: LUCY_USER_CENTER_BASE_URL,
          mediaBucket: boundAccount.mediaBucket,
          mediaRetentionHours: boundAccount.mediaRetentionHours,
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
      audience: account.channelUserKey,
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
      baseUrl: account.servers[0],
      mediaBucket: account.mediaBucket,
      mediaRetentionHours: account.mediaRetentionHours,
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
      mediaBucket: (snapshot as { mediaBucket?: string } | undefined)?.mediaBucket ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    logSelfId: ({ account, includeChannelPrefix }) => {
      const prefix = includeChannelPrefix === false ? "" : "[lucy] ";
      void syncLucyBindingState({
        account,
        waitForBinding: false,
      })
        .then((deviceState) => {
          console.log(
            `${prefix}channelDeviceId=${deviceState.channelDeviceId} channelUserKey=${deviceState.channelUserKey ?? "pending"} bindingStatus=${deviceState.bindingStatus} mediaBucket=${account.mediaBucket}`,
          );
        })
        .catch(() => {
          console.log(
            `${prefix}channelDeviceId=unavailable channelUserKey=${account.channelUserKey ?? "pending"} mediaBucket=${account.mediaBucket}`,
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
