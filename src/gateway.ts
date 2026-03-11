import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import { connectLucyNats, buildLucySubjects } from "./nats.js";
import { publishLucyMachineEvent } from "./send.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import { loadOrCreateLucyDeviceState } from "./state.js";
import type { LucyInboundMessage, ResolvedLucyAccount } from "./types.js";
import { LucyInboundMessageSchema } from "./types.js";

type LucyGatewayContext = ChannelGatewayContext<ResolvedLucyAccount>;
type PluginChannelRuntime = PluginRuntime["channel"];

export function updateLucyStatus(
  ctx: Pick<LucyGatewayContext, "getStatus" | "setStatus">,
  patch: Partial<ChannelAccountSnapshot>,
): void {
  ctx.setStatus({
    ...ctx.getStatus(),
    ...patch,
  });
}

function buildInboundContext(params: {
  cfg: OpenClawConfig;
  account: ResolvedLucyAccount;
  channelRuntime: PluginChannelRuntime;
  route: { agentId: string; sessionKey: string; accountId?: string };
  inbound: LucyInboundMessage;
  deviceId: string;
}) {
  const rawBody = params.inbound.text;
  const body = params.channelRuntime.reply.formatAgentEnvelope({
    channel: "Lucy",
    from: params.account.apiKey ?? "unknown",
    timestamp: params.inbound.timestamp,
    envelope: params.channelRuntime.reply.resolveEnvelopeFormatOptions(params.cfg),
    body: rawBody,
  });
  return params.channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `lucy:${params.account.apiKey}`,
    To: `lucy:${params.account.apiKey}`,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId ?? params.account.accountId,
    ChatType: "direct",
    ConversationLabel: params.account.apiKey,
    SenderId: params.account.apiKey,
    Provider: "lucy",
    Surface: "lucy",
    MessageSid: params.inbound.messageId,
    OriginatingChannel: "lucy",
    OriginatingTo: `lucy:${params.account.apiKey}`,
    CommandAuthorized: true,
    DeviceId: params.deviceId,
  });
}

export async function handleLucyInboundMessage(params: {
  cfg: OpenClawConfig;
  account: ResolvedLucyAccount;
  channelRuntime: PluginChannelRuntime;
  log?: LucyGatewayContext["log"];
  inbound: unknown;
  deviceId: string;
  connection?: Awaited<ReturnType<typeof connectLucyNats>>;
}): Promise<void> {
  if (!params.account.apiKey) {
    throw new Error("lucy apiKey is not configured");
  }

  const parsed = LucyInboundMessageSchema.safeParse(params.inbound);
  if (!parsed.success) {
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "error",
      text: `invalid inbound message: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
      metadata: {
        issues: parsed.error.issues.map((issue) => issue.message),
      },
    });
    return;
  }

  const inbound = {
    ...parsed.data,
    messageId: parsed.data.messageId ?? getProcessSnowflakeGenerator().nextId(),
  };

  if (inbound.apiKey && inbound.apiKey !== params.account.apiKey) {
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "error",
      sourceMessageId: inbound.messageId,
      text: "payload apiKey does not match subject namespace",
    });
    return;
  }
  if (inbound.deviceId && inbound.deviceId !== params.deviceId) {
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "error",
      sourceMessageId: inbound.messageId,
      text: "payload deviceId does not match subject namespace",
    });
    return;
  }

  const route = params.channelRuntime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "lucy",
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: params.account.apiKey,
    },
  });

  if (!route) {
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "error",
      sourceMessageId: inbound.messageId,
      text: "no OpenClaw route matched for lucy apiKey",
    });
    return;
  }

  const ctxPayload = buildInboundContext({
    cfg: params.cfg,
    account: params.account,
    channelRuntime: params.channelRuntime,
    route,
    inbound,
    deviceId: params.deviceId,
  });
  const storePath = params.channelRuntime.session.resolveStorePath(params.cfg.session?.store, {
    agentId: route.agentId,
  });
  await params.channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      params.log?.error?.(`lucy: failed updating session meta: ${String(err)}`);
    },
  });

  await publishLucyMachineEvent({
    account: params.account,
    connection: params.connection,
    deviceId: params.deviceId,
    type: "inbound.accepted",
    sourceMessageId: inbound.messageId,
    sessionKey: route.sessionKey,
  });

  let runId: string | undefined;
  let activeToolName: string | undefined;

  await params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        if (payload.isReasoning || !payload.text?.trim()) {
          return;
        }
        await publishLucyMachineEvent({
          account: params.account,
          connection: params.connection,
          deviceId: params.deviceId,
          type: "assistant.final",
          sourceMessageId: inbound.messageId,
          runId,
          sessionKey: route.sessionKey,
          text: payload.text,
        });
      },
      onError: (err, info) => {
        params.log?.error?.(`[lucy] ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onAgentRunStart: (nextRunId) => {
        runId = nextRunId;
      },
      onPartialReply: async (payload) => {
        if (!payload.text?.trim()) {
          return;
        }
        await publishLucyMachineEvent({
          account: params.account,
          connection: params.connection,
          deviceId: params.deviceId,
          type: "assistant.partial",
          sourceMessageId: inbound.messageId,
          runId,
          sessionKey: route.sessionKey,
          text: payload.text,
        });
      },
      onReasoningStream: async (payload) => {
        if (!payload.text?.trim()) {
          return;
        }
        await publishLucyMachineEvent({
          account: params.account,
          connection: params.connection,
          deviceId: params.deviceId,
          type: "reasoning.partial",
          sourceMessageId: inbound.messageId,
          runId,
          sessionKey: route.sessionKey,
          text: payload.text,
        });
      },
      onReasoningEnd: async () => {
        await publishLucyMachineEvent({
          account: params.account,
          connection: params.connection,
          deviceId: params.deviceId,
          type: "reasoning.final",
          sourceMessageId: inbound.messageId,
          runId,
          sessionKey: route.sessionKey,
        });
      },
      onToolStart: async ({ name }) => {
        activeToolName = name?.trim() || undefined;
        await publishLucyMachineEvent({
          account: params.account,
          connection: params.connection,
          deviceId: params.deviceId,
          type: "tool.start",
          sourceMessageId: inbound.messageId,
          runId,
          sessionKey: route.sessionKey,
          toolName: activeToolName,
        });
      },
      onAssistantMessageStart: async () => {
        if (activeToolName) {
          await publishLucyMachineEvent({
            account: params.account,
            connection: params.connection,
            deviceId: params.deviceId,
            type: "tool.end",
            sourceMessageId: inbound.messageId,
            runId,
            sessionKey: route.sessionKey,
            toolName: activeToolName,
          });
          activeToolName = undefined;
        }
        await publishLucyMachineEvent({
          account: params.account,
          connection: params.connection,
          deviceId: params.deviceId,
          type: "assistant.start",
          sourceMessageId: inbound.messageId,
          runId,
          sessionKey: route.sessionKey,
        });
      },
    },
  });

  if (activeToolName) {
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "tool.end",
      sourceMessageId: inbound.messageId,
      runId,
      sessionKey: route.sessionKey,
      toolName: activeToolName,
    });
  }
}

export async function startLucyGateway(ctx: LucyGatewayContext): Promise<void> {
  if (!ctx.channelRuntime) {
    throw new Error("channelRuntime not available");
  }
  const deviceState = await loadOrCreateLucyDeviceState();
  if (!ctx.account.apiKey) {
    throw new Error("lucy apiKey is not configured");
  }

  const subjects = buildLucySubjects({
    subjectPrefix: ctx.account.subjectPrefix,
    apiKey: ctx.account.apiKey,
    deviceId: deviceState.deviceId,
  });
  const connection = await connectLucyNats(ctx.account);
  const subscription = connection.subscribe(subjects.clientSubject);
  let stopped = false;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    subscription.unsubscribe();
    void connection.drain().catch(async () => {
      await connection.close();
    });
    updateLucyStatus(ctx, {
      running: false,
      lastStopAt: Date.now(),
    });
  };

  if (ctx.abortSignal.aborted) {
    stop();
  } else {
    ctx.abortSignal.addEventListener("abort", stop, { once: true });
  }

  updateLucyStatus(ctx, {
    running: true,
    lastStartAt: Date.now(),
    audience: ctx.account.apiKey,
    cliPath: subjects.clientSubject,
    dbPath: subjects.machineSubject,
    application: { deviceId: deviceState.deviceId },
  });
  ctx.log?.info(
    `[lucy] listening on ${subjects.clientSubject} and publishing to ${subjects.machineSubject}`,
  );

  try {
    for await (const msg of subscription) {
      try {
        updateLucyStatus(ctx, {
          lastInboundAt: Date.now(),
        });
        const payload = msg.json<unknown>();
        await handleLucyInboundMessage({
          cfg: ctx.cfg,
          account: ctx.account,
          channelRuntime: ctx.channelRuntime!,
          log: ctx.log,
          inbound: payload,
          deviceId: deviceState.deviceId,
          connection,
        });
        updateLucyStatus(ctx, {
          lastOutboundAt: Date.now(),
        });
      } catch (err) {
        updateLucyStatus(ctx, {
          lastError: String(err),
        });
        ctx.log?.error?.(`[lucy] inbound dispatch failed: ${String(err)}`);
        await publishLucyMachineEvent({
          account: ctx.account,
          connection,
          deviceId: deviceState.deviceId,
          type: "error",
          text: `inbound dispatch failed: ${String(err)}`,
        });
      }
    }
  } catch (err) {
    if (!stopped) {
      updateLucyStatus(ctx, {
        running: false,
        lastError: String(err),
        lastStopAt: Date.now(),
      });
      ctx.log?.error?.(`[lucy] NATS loop failed: ${String(err)}`);
      throw err;
    }
  } finally {
    stop();
  }
}
