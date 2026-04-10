import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import type { ConnectedClient, JetStreamMessage } from "lucy-im-sdk";
import { downloadLucyMediaDescriptor, uploadLucyMediaFromSource } from "./media.js";
import { startLucyLocalNotifyServer } from "./local-notify.js";
import {
  handleLucyProvisioningMessage,
  publishLucyRestartCompletionIfPending,
} from "./provider-provisioning.js";
// Import handler with lazy loading for backward compatibility
// (older openclaw versions may not have gateway-runtime / infra-runtime)
let _approvalHandler: unknown = null;
let _loadAttempted = false;
import { syncLucyBindingWithSdk, connectLucySdk } from "./auth-binding.js";
import { buildLucyImConfig } from "./config.js";
import { buildNpcSubscribeSubject } from "./nats.js";
import { buildLucyMachineEvent, publishLucyMachineEvent } from "./send.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import { syncLucyPairingExport } from "./pairing-export.js";
import type {
  LucyInboundMessage,
  LucyInboundMessageV3,
  LucyInboundMessageV2,
  LucyMediaKind,
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
    channelUserKey: inbound.channelUserKey ?? inbound.apiKey,
    channelDeviceId: inbound.channelDeviceId ?? inbound.deviceId,
  };
}

function isLucyProvisioningInboundMessage(
  inbound: LucyInboundMessage,
): inbound is LucyInboundMessageV3 & { kind: "provision_model"; provision: NonNullable<LucyInboundMessageV3["provision"]> } {
  return inbound.version === 3 && "kind" in inbound && inbound.kind === "provision_model";
}

function buildMediaPlaceholder(kind: LucyMediaKind): string {
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
  cuk: string;
  cdi: string;
  rawBody: string;
  mediaPayload?: Record<string, unknown>;
}) {
  const body = params.channelRuntime.reply.formatAgentEnvelope({
    channel: "Lucy",
    from: params.cuk || "unknown",
    timestamp: params.inbound.timestamp,
    envelope: params.channelRuntime.reply.resolveEnvelopeFormatOptions(params.cfg),
    body: params.rawBody,
  });
  return params.channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.inbound.text?.trim() || params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.rawBody,
    From: `lucy:${params.cuk}`,
    To: `lucy:${params.cuk}`,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId ?? params.account.accountId,
    ChatType: "direct",
    ConversationLabel: params.cuk,
    SenderId: params.cuk,
    Provider: "lucy",
    Surface: "lucy",
    MessageSid: params.inbound.messageId,
    OriginatingChannel: "lucy",
    OriginatingTo: `lucy:${params.cuk}`,
    CommandAuthorized: true,
    DeviceId: params.cdi,
    ...(params.mediaPayload ?? {}),
  });
}

async function publishAssistantFinalEvent(params: {
  account: ResolvedLucyAccount;
  session: ConnectedClient;
  userId: string;
  cuk: string;
  cdi: string;
  sourceMessageId: string;
  runId?: string;
  sessionKey?: string;
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}): Promise<void> {
  const trimmedText = params.text?.trim() || undefined;
  const baseEvent = buildLucyMachineEvent({
    cuk: params.cuk,
    cdi: params.cdi,
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
        eventId: baseEvent.eventId,
        mediaUrl: candidate,
        maxBytes: params.account.mediaMaxBytes,
        mediaLocalRoots: params.account.mediaLocalRoots,
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
        session: params.session,
        userId: params.userId,
        cuk: params.cuk,
        cdi: params.cdi,
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
      session: params.session,
      userId: params.userId,
      cuk: params.cuk,
      cdi: params.cdi,
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
    session: params.session,
    userId: params.userId,
    cuk: params.cuk,
    cdi: params.cdi,
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
  session: ConnectedClient;
  userId: string;
  cuk: string;
  cdi: string;
}): Promise<void> {
  const parsed = LucyInboundMessageSchema.safeParse(params.inbound);
  if (!parsed.success) {
    await publishLucyMachineEvent({
      session: params.session,
      userId: params.userId,
      cuk: params.cuk,
      cdi: params.cdi,
      type: "error",
      text: `invalid inbound message: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
      metadata: {
        issues: parsed.error.issues.map((issue) => issue.message),
      },
    });
    return;
  }

  const parsedInbound = {
    ...parsed.data,
    messageId: parsed.data.messageId ?? getProcessSnowflakeGenerator().nextId(),
  } as LucyInboundMessage;

  if (isLucyProvisioningInboundMessage(parsedInbound)) {
    const inboundChannelUserKey = parsedInbound.channelUserKey ?? parsedInbound.apiKey;
    const inboundChannelDeviceId = parsedInbound.channelDeviceId ?? parsedInbound.deviceId;
    if (inboundChannelUserKey && inboundChannelUserKey !== params.cuk) {
      await publishLucyMachineEvent({
        session: params.session,
        userId: params.userId,
        cuk: params.cuk,
        cdi: params.cdi,
        type: "config.error",
        sourceMessageId: parsedInbound.messageId,
        text: "payload channelUserKey does not match subject namespace",
      });
      return;
    }
    if (inboundChannelDeviceId && inboundChannelDeviceId !== params.cdi) {
      await publishLucyMachineEvent({
        session: params.session,
        userId: params.userId,
        cuk: params.cuk,
        cdi: params.cdi,
        type: "config.error",
        sourceMessageId: parsedInbound.messageId,
        text: "payload channelDeviceId does not match subject namespace",
      });
      return;
    }

    await handleLucyProvisioningMessage({
      cfg: params.cfg,
      account: params.account,
      session: params.session,
      userId: params.userId,
      cuk: params.cuk,
      cdi: params.cdi,
      sourceMessageId: parsedInbound.messageId,
      provision: parsedInbound.provision,
      log: params.log,
    });
    return;
  }

  const inbound = normalizeLucyInboundMessage(parsedInbound);

  if (inbound.channelUserKey && inbound.channelUserKey !== params.cuk) {
    await publishLucyMachineEvent({
      session: params.session,
      userId: params.userId,
      cuk: params.cuk,
      cdi: params.cdi,
      type: "error",
      sourceMessageId: inbound.messageId,
      text: "payload channelUserKey does not match subject namespace",
    });
    return;
  }
  if (inbound.channelDeviceId && inbound.channelDeviceId !== params.cdi) {
    await publishLucyMachineEvent({
      session: params.session,
      userId: params.userId,
      cuk: params.cuk,
      cdi: params.cdi,
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
      id: params.cuk,
    },
  });

  if (!route) {
    await publishLucyMachineEvent({
      session: params.session,
      userId: params.userId,
      cuk: params.cuk,
      cdi: params.cdi,
      type: "error",
      sourceMessageId: inbound.messageId,
      text: "no OpenClaw route matched for lucy channelUserKey",
    });
    return;
  }

  let mediaPayload: Record<string, unknown> | undefined;
  if (inbound.media) {
    const resolvedMedia = await downloadLucyMediaDescriptor({
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
    cuk: params.cuk,
    cdi: params.cdi,
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
    session: params.session,
    userId: params.userId,
    cuk: params.cuk,
    cdi: params.cdi,
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
          session: params.session,
          userId: params.userId,
          cuk: params.cuk,
          cdi: params.cdi,
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
          session: params.session,
          userId: params.userId,
          cuk: params.cuk,
          cdi: params.cdi,
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
          session: params.session,
          userId: params.userId,
          cuk: params.cuk,
          cdi: params.cdi,
          type: "reasoning.partial",
          sourceMessageId: inbound.messageId,
          runId,
          sessionKey: route.sessionKey,
          text: payload.text,
        });
      },
      onReasoningEnd: async () => {
        await publishLucyMachineEvent({
          session: params.session,
          userId: params.userId,
          cuk: params.cuk,
          cdi: params.cdi,
          type: "reasoning.final",
          sourceMessageId: inbound.messageId,
          runId,
          sessionKey: route.sessionKey,
        });
      },
      onToolStart: async ({ name }) => {
        activeToolName = name?.trim() || undefined;
        await publishLucyMachineEvent({
          session: params.session,
          userId: params.userId,
          cuk: params.cuk,
          cdi: params.cdi,
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
            session: params.session,
            userId: params.userId,
            cuk: params.cuk,
            cdi: params.cdi,
            type: "tool.end",
            sourceMessageId: inbound.messageId,
            runId,
            sessionKey: route.sessionKey,
            toolName: activeToolName,
          });
          activeToolName = undefined;
        }
        await publishLucyMachineEvent({
          session: params.session,
          userId: params.userId,
          cuk: params.cuk,
          cdi: params.cdi,
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
      session: params.session,
      userId: params.userId,
      cuk: params.cuk,
      cdi: params.cdi,
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

  const sdkCfg = buildLucyImConfig(ctx.account);

  // Sync binding — waits until bound
  await syncLucyBindingWithSdk({
    cfg: sdkCfg,
    signal: ctx.abortSignal,
    log: ctx.log,
    waitForBinding: true,
  });

  // Connect to NATS via SDK
  const { client: session, cdi, userId, cuk } = await connectLucySdk({ cfg: sdkCfg });

  // Sync pairing export with SDK home dir
  await syncLucyPairingExport(ctx.account.homeDir).catch(() => {
    // Non-fatal: pairing export is for BLE handoff only
  });

  let localNotifyServer: Awaited<ReturnType<typeof startLucyLocalNotifyServer>> | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    (_approvalHandler as { stop?: () => void } | null)?.stop?.();
    void localNotifyServer?.stop().catch((err) => {
      ctx.log?.warn?.(`[lucy] local notify shutdown failed: ${String(err)}`);
    });
    void session.shutdown().catch(() => undefined);
    updateLucyStatus(ctx, {
      running: false,
      lastStopAt: Date.now(),
    });
  };

  try {
    localNotifyServer = ctx.account.localNotify
      ? await startLucyLocalNotifyServer({
          account: ctx.account,
          session,
          userId,
          cuk,
          cdi,
          notify: ctx.account.localNotify,
          log: ctx.log,
        })
      : null;

    await publishLucyRestartCompletionIfPending({
      session,
      userId,
      cuk,
      cdi,
    });
  } catch (err) {
    await localNotifyServer?.stop().catch(() => undefined);
    void session.shutdown().catch(() => undefined);
    throw err;
  }

  // Try to load and start approval handler (backward compatible with older openclaw)
  if (!_loadAttempted) {
    _loadAttempted = true;
    try {
      const { LucyExecApprovalHandler } = await import("./exec-approvals-handler.js");
      _approvalHandler = new LucyExecApprovalHandler(
        ctx.cfg,
        ctx.account,
        cdi,
        session,
        userId,
        cuk,
      );
      await (_approvalHandler as { start(): Promise<void> }).start();
    } catch (err) {
      ctx.log?.info?.(
        `[lucy] exec approvals not available (requires newer openclaw): ${err instanceof Error ? err.message : String(err)}`,
      );
      _approvalHandler = null;
    }
  }

  if (ctx.abortSignal.aborted) {
    stop();
  } else {
    ctx.abortSignal.addEventListener("abort", stop, { once: true });
  }

  const subscribeSubject = buildNpcSubscribeSubject(userId, cdi);
  const publishSubject = `cephalon.im.user.${userId}`;

  updateLucyStatus(ctx, {
    running: true,
    lastStartAt: Date.now(),
    audience: cuk,
    cliPath: subscribeSubject,
    dbPath: publishSubject,
    application: {
      channelDeviceId: cdi,
      bindingStatus: "bound",
      localNotifyUrl: localNotifyServer?.url ?? null,
    },
  });
  ctx.log?.info(
    `[lucy] listening on ${subscribeSubject} and publishing to ${publishSubject}`,
  );

  try {
    await session.subscribeChannel(subscribeSubject, async (msg: JetStreamMessage) => {
      if (stopped) return;
      try {
        updateLucyStatus(ctx, { lastInboundAt: Date.now() });
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.from(msg.payload).toString("utf8")) as unknown;
        } catch {
          payload = msg.payload;
        }
        await handleLucyInboundMessage({
          cfg: ctx.cfg,
          account: ctx.account,
          channelRuntime: ctx.channelRuntime!,
          log: ctx.log,
          inbound: payload,
          session,
          userId,
          cuk,
          cdi,
        });
        updateLucyStatus(ctx, { lastOutboundAt: Date.now() });
      } catch (err) {
        updateLucyStatus(ctx, { lastError: String(err) });
        ctx.log?.error?.(`[lucy] inbound dispatch failed: ${String(err)}`);
        await publishLucyMachineEvent({
          session,
          userId,
          cuk,
          cdi,
          type: "error",
          text: `inbound dispatch failed: ${String(err)}`,
        });
      }
    });

    // Block until abortSignal fires — subscribeChannel runs in background,
    // so we must keep startLucyGateway alive to prevent OpenClaw auto-restart.
    await new Promise<void>((resolve) => {
      if (ctx.abortSignal.aborted) {
        resolve();
        return;
      }
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  } catch (err) {
    if (!stopped) {
      updateLucyStatus(ctx, {
        running: false,
        lastError: String(err),
        lastStopAt: Date.now(),
      });
      ctx.log?.error?.(`[lucy] subscription loop failed: ${String(err)}`);
      throw err;
    }
  } finally {
    stop();
  }
}
