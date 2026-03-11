import {
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { lucyChannelConfigSchema } from "./config-schema.js";
import { listLucyAccountIds, resolveLucyAccount, unconfiguredLucyReason } from "./config.js";
import { startLucyGateway } from "./gateway.js";
import { buildLucySubjects, connectLucyNats, encodeLucyMachineEvent } from "./nats.js";
import { buildLucyMachineEvent } from "./send.js";
import { loadOrCreateLucyDeviceState } from "./state.js";
import { DEFAULT_ACCOUNT_ID, type LucyProbe, type ResolvedLucyAccount } from "./types.js";

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
    media: false,
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
    normalizeTarget: (raw) => raw.trim() || undefined,
    targetResolver: {
      looksLikeId: (raw) => raw.trim().length > 0,
      hint: "<apiKey>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveLucyAccount(cfg, accountId);
      if (!account.apiKey) {
        throw new Error("lucy apiKey is not configured");
      }
      const deviceState = await loadOrCreateLucyDeviceState();
      const targetApiKey = to?.trim() || account.apiKey;
      const event = buildLucyMachineEvent({
        account: {
          ...account,
          apiKey: targetApiKey,
        },
        deviceId: deviceState.deviceId,
        type: "assistant.final",
        text,
      });
      const connection = await connectLucyNats(account);
      try {
        const subjects = buildLucySubjects({
          subjectPrefix: account.subjectPrefix,
          apiKey: targetApiKey,
          deviceId: deviceState.deviceId,
        });
        connection.publish(subjects.machineSubject, encodeLucyMachineEvent(event));
        await connection.flush();
      } finally {
        await connection.close();
      }
      return {
        channel: "lucy",
        to: targetApiKey,
        messageId: event.eventId,
      };
    },
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
      lastError: snapshot.lastError ?? null,
    }),
    logSelfId: ({ account, includeChannelPrefix }) => {
      const prefix = includeChannelPrefix === false ? "" : "[lucy] ";
      void loadOrCreateLucyDeviceState()
        .then((deviceState) => {
          console.log(
            `${prefix}deviceId=${deviceState.deviceId} apiKey=${account.apiKey ?? "unset"}`,
          );
        })
        .catch(() => {
          console.log(`${prefix}deviceId=unavailable apiKey=${account.apiKey ?? "unset"}`);
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
