import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import {
  downloadLucyMediaDescriptor,
  ensureLucyMediaStore,
  uploadLucyMediaFromSource,
} from "./media.js";
import { buildLucySubjects, connectLucyNats } from "./nats.js";
import { buildLucyMachineEvent, publishLucyMachineEvent } from "./send.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import { loadOrCreateLucyDeviceState } from "./state.js";
import type {
  LucyInboundMessage,
  LucyInboundMessageV2,
  ResolvedLucyAccount,
} from "./types.js";
import { LucyInboundMessageSchema } from "./types.js";

type LucyGatewayContext = ChannelGatewayContext<ResolvedLucyAccount>;
type PluginChannelRuntime = PluginRuntime["channel"];

function normalizeLucyInboundMessage(inbound: LucyInboundMessage): LucyInboundMessageV2 {
  return {
    version: 2,
    messageId: inbound.messageId,
    text: inbound.text?.trim() || undefined,
    media: "media" in inbound ? inbound.media : undefined,
    timestamp: inbound.timestamp,
    metadata: inbound.metadata,
    apiKey: inbound.apiKey,
    deviceId: inbound.deviceId,
  };
}

function buildMediaPlaceholder(kind: "image" | "audio"): string {
  return `<media:${kind}>`;
}

function buildInboundRawBody(inbound: LucyInboundMessageV2): string {
  if (inbound.text?.trim()) {
    return inbound.text.trim();
  }
  if (inbound.media) {
    return buildMediaPlaceholder(inbound.media.kind);
  }
  return "";
}

function buildReplyMediaSources(payload: { mediaUrl?: string; mediaUrls?: string[] }): string[] {
  const values = [payload.mediaUrl, ...(payload.mediaUrls ?? [])]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(values));
}

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
  inbound: LucyInboundMessageV2;
  deviceId: string;
  rawBody: string;
  mediaPayload?: Record<string, unknown>;
}) {
  const body = params.channelRuntime.reply.formatAgentEnvelope({
    channel: "Lucy",
    from: params.account.apiKey ?? "unknown",
    timestamp: params.inbound.timestamp,
    envelope: params.channelRuntime.reply.resolveEnvelopeFormatOptions(params.cfg),
    body: params.rawBody,
  });
  return params.channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.inbound.text?.trim() || params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.rawBody,
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
    ...(params.mediaPayload ?? {}),
  });
}

async function publishAssistantFinalEvent(params: {
  account: ResolvedLucyAccount;
  connection: Awaited<ReturnType<typeof connectLucyNats>>;
  deviceId: string;
  sourceMessageId: string;
  runId?: string;
  sessionKey?: string;
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}): Promise<void> {
  const trimmedText = params.text?.trim() || undefined;
  const baseEvent = buildLucyMachineEvent({
    account: params.account,
    deviceId: params.deviceId,
    type: "assistant.final",
    sourceMessageId: params.sourceMessageId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    text: trimmedText,
  });
  const candidates = buildReplyMediaSources({
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
  });

  let media;
  let skippedUnsupportedMediaCount = 0;
  let mediaWarning: string | undefined;
  let selectedMediaIndex = -1;

  for (const [index, candidate] of candidates.entries()) {
    try {
      media = await uploadLucyMediaFromSource({
        connection: params.connection,
        account: params.account,
        deviceId: params.deviceId,
        eventId: baseEvent.eventId,
        mediaUrl: candidate,
        trustedLocalPath: true,
      });
      selectedMediaIndex = index;
      break;
    } catch (err) {
      skippedUnsupportedMediaCount += 1;
      mediaWarning = String(err);
    }
  }

  if (!trimmedText && !media) {
    if (mediaWarning) {
      await publishLucyMachineEvent({
        account: params.account,
        connection: params.connection,
        deviceId: params.deviceId,
        type: "error",
        sourceMessageId: params.sourceMessageId,
        runId: params.runId,
        sessionKey: params.sessionKey,
        text: `assistant media upload failed: ${mediaWarning}`,
      });
    }
    return;
  }

  if (mediaWarning) {
    await publishLucyMachineEvent({
      account: params.account,
      connection: params.connection,
      deviceId: params.deviceId,
      type: "error",
      sourceMessageId: params.sourceMessageId,
      runId: params.runId,
      sessionKey: params.sessionKey,
      text: `assistant media upload warning: ${mediaWarning}`,
    });
  }

  const metadata =
    candidates.length > 1 || skippedUnsupportedMediaCount > 0
      ? {
          droppedMediaCount:
            selectedMediaIndex >= 0
              ? Math.max(candidates.length - selectedMediaIndex - 1, 0)
              : 0,
          skippedUnsupportedMediaCount,
        }
      : undefined;
  await publishLucyMachineEvent({
    account: params.account,
    connection: params.connection,
    deviceId: params.deviceId,
    eventId: baseEvent.eventId,
    type: "assistant.final",
    sourceMessageId: params.sourceMessageId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    text: trimmedText,
    media,
    metadata,
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

  let ownedConnection: Awaited<ReturnType<typeof connectLucyNats>> | undefined;
  const getConnection = async () => {
    if (params.connection) {
      return params.connection;
    }
    ownedConnection ??= await connectLucyNats(params.account);
    return ownedConnection;
  };

  try {
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

    const inbound = normalizeLucyInboundMessage({
      ...parsed.data,
      messageId: parsed.data.messageId ?? getProcessSnowflakeGenerator().nextId(),
    });

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

    let mediaPayload: Record<string, unknown> | undefined;
    if (inbound.media) {
      const resolvedMedia = await downloadLucyMediaDescriptor({
        connection: await getConnection(),
        account: params.account,
        descriptor: inbound.media,
      });
      const saved = await params.channelRuntime.media.saveMediaBuffer(
        resolvedMedia.buffer,
        resolvedMedia.contentType,
        "lucy",
        params.account.mediaMaxBytes,
        resolvedMedia.fileName,
      );
      const savedContentType = saved.contentType ?? resolvedMedia.contentType;
      mediaPayload = {
        MediaPath: saved.path,
        MediaUrl: saved.path,
        MediaType: savedContentType,
        MediaPaths: [saved.path],
        MediaUrls: [saved.path],
        MediaTypes: savedContentType ? [savedContentType] : undefined,
      };
    }

    const rawBody = buildInboundRawBody(inbound);
    const ctxPayload = buildInboundContext({
      cfg: params.cfg,
      account: params.account,
      channelRuntime: params.channelRuntime,
      route,
      inbound,
      deviceId: params.deviceId,
      rawBody,
      mediaPayload,
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
          if (payload.isReasoning) {
            return;
          }
          await publishAssistantFinalEvent({
            account: params.account,
            connection: await getConnection(),
            deviceId: params.deviceId,
            sourceMessageId: inbound.messageId!,
            runId,
            sessionKey: route.sessionKey,
            text: payload.text,
            mediaUrl: payload.mediaUrl,
            mediaUrls: payload.mediaUrls,
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
  } finally {
    if (ownedConnection) {
      await ownedConnection.close();
    }
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
  await ensureLucyMediaStore({
    connection,
    account: ctx.account,
  });
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
    `[lucy] listening on ${subjects.clientSubject} and publishing to ${subjects.machineSubject} (media bucket: ${ctx.account.mediaBucket})`,
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
          channelRuntime: ctx.channelRuntime,
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
