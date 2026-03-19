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
import { hydrateLucyAccountFromState, syncLucyBindingState } from "./auth-binding.js";
import { buildLucySubjects, connectLucyNats, buildLucyDiscoverSubject, buildLucyPingSubject } from "./nats.js";
import { buildLucyMachineEvent, publishLucyMachineEvent } from "./send.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import type {
  LucyInboundMessage,
  LucyInboundMessageV2,
  ResolvedLucyAccount,
} from "./types.js";
import { LucyInboundMessageSchema } from "./types.js";
import { buildLucyBindingCheckUrl } from "./user-center.js";

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
    channelUserKey: inbound.channelUserKey ?? inbound.apiKey,
    channelDeviceId: inbound.channelDeviceId ?? inbound.deviceId,
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
    from: params.account.channelUserKey ?? "unknown",
    timestamp: params.inbound.timestamp,
    envelope: params.channelRuntime.reply.resolveEnvelopeFormatOptions(params.cfg),
    body: params.rawBody,
  });
  return params.channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.inbound.text?.trim() || params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.rawBody,
    From: `lucy:${params.account.channelUserKey}`,
    To: `lucy:${params.account.channelUserKey}`,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId ?? params.account.accountId,
    ChatType: "direct",
    ConversationLabel: params.account.channelUserKey,
    SenderId: params.account.channelUserKey,
    Provider: "lucy",
    Surface: "lucy",
    MessageSid: params.inbound.messageId,
    OriginatingChannel: "lucy",
    OriginatingTo: `lucy:${params.account.channelUserKey}`,
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
  if (!params.account.channelUserKey) {
    throw new Error("lucy channelUserKey is not configured");
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

    if (inbound.channelUserKey && inbound.channelUserKey !== params.account.channelUserKey) {
      await publishLucyMachineEvent({
        account: params.account,
        connection: params.connection,
        deviceId: params.deviceId,
        type: "error",
        sourceMessageId: inbound.messageId,
        text: "payload channelUserKey does not match subject namespace",
      });
      return;
    }
    if (inbound.channelDeviceId && inbound.channelDeviceId !== params.deviceId) {
      await publishLucyMachineEvent({
        account: params.account,
        connection: params.connection,
        deviceId: params.deviceId,
        type: "error",
        sourceMessageId: inbound.messageId,
        text: "payload channelDeviceId does not match subject namespace",
      });
      return;
    }

    const route = params.channelRuntime.routing.resolveAgentRoute({
      cfg: params.cfg,
      channel: "lucy",
      accountId: params.account.accountId,
      peer: {
        kind: "direct",
        id: params.account.channelUserKey,
      },
    });

    if (!route) {
      await publishLucyMachineEvent({
        account: params.account,
        connection: params.connection,
        deviceId: params.deviceId,
        type: "error",
        sourceMessageId: inbound.messageId,
        text: "no OpenClaw route matched for lucy channelUserKey",
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
  const deviceState = await syncLucyBindingState({
    account: ctx.account,
    signal: ctx.abortSignal,
    log: ctx.log,
    waitForBinding: true,
  });
  const boundAccount = hydrateLucyAccountFromState(ctx.account, deviceState);
  if (!boundAccount.channelUserKey) {
    throw new Error("lucy channelUserKey is not configured");
  }
  const subjects = buildLucySubjects({
    subjectPrefix: boundAccount.subjectPrefix,
    channelUserKey: boundAccount.channelUserKey,
    channelDeviceId: deviceState.channelDeviceId,
  });
  const connection = await connectLucyNats(boundAccount);
  await ensureLucyMediaStore({
    connection,
    account: boundAccount,
  });
  const subscription = connection.subscribe(subjects.clientSubject);
  let stopped = false;

  // Presence: build the _discover subject for heartbeat and offline notifications.
  const discoverSubject = buildLucyDiscoverSubject({
    subjectPrefix: boundAccount.subjectPrefix,
    channelUserKey: boundAccount.channelUserKey,
  });
  const clientId = connection.info?.client_id;

  // Publish presence registration so presence-bridge can map client_id → device.
  // This is required for the $SYS disconnect handler to broadcast offline.
  connection.publish(
    "client.status.report",
    JSON.stringify({
      client_id: clientId,
      apikey: boundAccount.channelUserKey,
      npc_id: deviceState.channelDeviceId,
    }),
  );
  // Immediately broadcast online.
  connection.publish(
    discoverSubject,
    `online\n${deviceState.channelDeviceId}`,
  );
  await connection.flush();

  // Heartbeat: re-publish online every 30 seconds.
  const heartbeatInterval = setInterval(() => {
    if (!stopped) {
      connection.publish(discoverSubject, `online\n${deviceState.channelDeviceId}`);
    }
  }, 30_000);

  // Ping responder: clients can request an immediate presence check instead of
  // waiting up to 30s for the next periodic heartbeat.
  const pingSubject = buildLucyPingSubject({
    subjectPrefix: boundAccount.subjectPrefix,
    channelUserKey: boundAccount.channelUserKey,
    channelDeviceId: deviceState.channelDeviceId,
  });
  const pingSubscription = connection.subscribe(pingSubject);
  (async () => {
    try {
      for await (const _msg of pingSubscription) {
        if (stopped) break;
        connection.publish(discoverSubject, `online\n${deviceState.channelDeviceId}`);
      }
    } catch {
      // subscription closed
    }
  })();

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(heartbeatInterval);
    pingSubscription.unsubscribe();
    // Best-effort offline notification before draining the connection.
    connection.publish(discoverSubject, `offline\n${deviceState.channelDeviceId}`);
    void connection.flush().catch(() => {});
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
    audience: boundAccount.channelUserKey,
    cliPath: subjects.clientSubject,
    dbPath: subjects.machineSubject,
    application: {
      channelDeviceId: deviceState.channelDeviceId,
      bindingStatus: deviceState.bindingStatus,
      bindingCheckUrl: buildLucyBindingCheckUrl(deviceState.channelDeviceId),
    },
  });
  ctx.log?.info(
    `[lucy] listening on ${subjects.clientSubject} and publishing to ${subjects.machineSubject} (media bucket: ${boundAccount.mediaBucket})`,
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
          account: boundAccount,
          channelRuntime: ctx.channelRuntime,
          log: ctx.log,
          inbound: payload,
          deviceId: deviceState.channelDeviceId,
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
          account: boundAccount,
          connection,
          deviceId: deviceState.channelDeviceId,
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
