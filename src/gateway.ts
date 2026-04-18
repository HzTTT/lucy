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

// Active long-lived Lucy session, published by startLucyGateway so that other
// code paths (e.g. outbound.sendText in channel.ts, exec approval handler) can
// reuse the same NATS connection instead of opening a fresh one per call.
// Keyed by accountId so multi-account configs don't collide.
interface LucyActiveSession {
  accountId: string;
  session: ConnectedClient;
  cdi: string;
  userId: string;
  cuk: string;
}
const lucyActiveSessions = new Map<string, LucyActiveSession>();

export function getLucyActiveSession(
  accountId: string,
): LucyActiveSession | undefined {
  return lucyActiveSessions.get(accountId);
}

import { syncLucyBindingWithSdk, connectLucySdk } from "./auth-binding.js";
import { buildLucyImConfig } from "./config.js";
import { buildNpcSubscribeSubject } from "./nats.js";
import {
  startPairingIpcClient,
  type PairingIpcClientHandle,
} from "./pairing-ipc-client.js";
import { runInLucyInboundContext } from "./run-context.js";
import { buildLucyMachineEvent, publishLucyMachineEvent } from "./send.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import { syncLucyPairingExport } from "./pairing-export.js";
import type {
  LucyInboundMessage,
  LucyInboundMessageV3,
  LucyInboundMessageV4,
  LucyInboundMessageV2,
  LucyMediaDescriptor,
  LucyMediaKind,
  ResolvedLucyAccount,
} from "./types.js";
import { LucyInboundMessageSchema } from "./types.js";

type LucyGatewayContext = ChannelGatewayContext<ResolvedLucyAccount>;
type PluginChannelRuntime = PluginRuntime["channel"];

/** Internal normalized form — decoupled from protocol version. */
type NormalizedLucyInbound = Omit<LucyInboundMessageV2, "media"> & {
  attachments: LucyMediaDescriptor[];
};

function resolveAttachments(inbound: LucyInboundMessage): LucyMediaDescriptor[] {
  if ("attachments" in inbound && (inbound as LucyInboundMessageV4).attachments?.length) {
    return (inbound as LucyInboundMessageV4).attachments!;
  }
  if ("media" in inbound && inbound.media) {
    return [inbound.media];
  }
  return [];
}

function normalizeLucyInboundMessage(inbound: LucyInboundMessage): NormalizedLucyInbound {
  return {
    version: 2,
    messageId: inbound.messageId,
    text: inbound.text?.trim() || undefined,
    attachments: resolveAttachments(inbound),
    timestamp: inbound.timestamp,
    metadata: inbound.metadata,
    channelUserKey: inbound.channelUserKey ?? inbound.apiKey,
    channelDeviceId: inbound.channelDeviceId ?? inbound.deviceId,
  };
}

function isLucyProvisioningInboundMessage(
  inbound: LucyInboundMessage,
): inbound is (LucyInboundMessageV3 | LucyInboundMessageV4) & { kind: "provision_model"; provision: NonNullable<LucyInboundMessageV3["provision"]> } {
  return (inbound.version === 3 || inbound.version === 4) && "kind" in inbound && inbound.kind === "provision_model";
}

function buildMediaPlaceholder(kind: LucyMediaKind): string {
  return `<media:${kind}>`;
}

function buildInboundRawBody(inbound: NormalizedLucyInbound): string {
  if (inbound.text?.trim()) {
    return inbound.text.trim();
  }
  if (inbound.attachments.length > 0) {
    return inbound.attachments.map((a) => buildMediaPlaceholder(a.kind)).join(" ");
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
  inbound: NormalizedLucyInbound;
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

  const uploaded: LucyMediaDescriptor[] = [];
  let skippedUnsupportedMediaCount = 0;
  let lastMediaWarning: string | undefined;

  for (const candidate of candidates) {
    try {
      const descriptor = await uploadLucyMediaFromSource({
        eventId: baseEvent.eventId,
        mediaUrl: candidate,
        maxBytes: params.account.mediaMaxBytes,
        mediaLocalRoots: params.account.mediaLocalRoots,
        trustedLocalPath: true,
      });
      uploaded.push(descriptor);
    } catch (err) {
      skippedUnsupportedMediaCount += 1;
      lastMediaWarning = String(err);
    }
  }

  if (!trimmedText && uploaded.length === 0) {
    if (lastMediaWarning) {
      await publishLucyMachineEvent({
        session: params.session,
        userId: params.userId,
        cuk: params.cuk,
        cdi: params.cdi,
        type: "error",
        sourceMessageId: params.sourceMessageId,
        runId: params.runId,
        sessionKey: params.sessionKey,
        text: `assistant media upload failed: ${lastMediaWarning}`,
      });
    }
    return;
  }

  if (lastMediaWarning) {
    await publishLucyMachineEvent({
      session: params.session,
      userId: params.userId,
      cuk: params.cuk,
      cdi: params.cdi,
      type: "error",
      sourceMessageId: params.sourceMessageId,
      runId: params.runId,
      sessionKey: params.sessionKey,
      text: `assistant media upload warning: ${lastMediaWarning}`,
    });
  }

  const metadata =
    skippedUnsupportedMediaCount > 0
      ? { skippedUnsupportedMediaCount }
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
    media: uploaded[0],
    attachments: uploaded,
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
  const effectiveAttachments = inbound.attachments.slice(0, params.account.maxAttachments);
  if (effectiveAttachments.length > 0) {
    const resolved = await Promise.all(
      effectiveAttachments.map((desc) => downloadLucyMediaDescriptor({ descriptor: desc })),
    );
    const saved = await Promise.all(
      resolved.map((r) =>
        params.channelRuntime.media.saveMediaBuffer(
          r.buffer,
          r.contentType,
          "lucy",
          params.account.mediaMaxBytes,
          r.fileName,
        ),
      ),
    );
    const mediaPaths = saved.map((s) => s.path);
    const mediaTypes = saved.map((s, i) => s.contentType ?? resolved[i].contentType);
    mediaPayload = {
      MediaPath: mediaPaths[0],
      MediaUrl: mediaPaths[0],
      MediaType: mediaTypes[0],
      MediaPaths: mediaPaths,
      MediaUrls: mediaPaths,
      MediaTypes: mediaTypes,
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
  const runIdRef: { current?: string } = {};

  await runInLucyInboundContext(
    {
      sourceMessageId: inbound.messageId!,
      cuk: params.cuk,
      cdi: params.cdi,
      sessionKey: route.sessionKey,
      runIdRef,
    },
    async () => {
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
        runIdRef.current = nextRunId;
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
    },
  );

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

  // Sync binding — waits until bound. When entering PendingBind state, stand
  // up the pairing IPC client if the account has one configured so the
  // blue-wifi BLE agent can trigger on-demand preBind() calls (and receive
  // the resulting OTP) while this function is polling for binding completion.
  //
  // The handle lives inside a ref object so TS's control-flow narrowing
  // tracks it correctly across the onPendingBind closure boundary.
  const pairingIpcRef: { handle: PairingIpcClientHandle | null } = { handle: null };
  try {
    await syncLucyBindingWithSdk({
      cfg: sdkCfg,
      signal: ctx.abortSignal,
      log: ctx.log,
      waitForBinding: true,
      onPendingBind: (sdkClient) => {
        // Write pairing-info.json early so blue-wifi can expose the cdi
        // via BLE before binding completes.
        syncLucyPairingExport(ctx.account.homeDir).catch(() => {});

        if (!ctx.account.pairingSocket) {
          ctx.log?.info?.(
            "[lucy] pairing IPC disabled (channels.lucy.pairingSocket is not set)",
          );
          return;
        }
        ctx.log?.info?.(
          `[lucy] pairing IPC: connecting to ${ctx.account.pairingSocket}`,
        );
        pairingIpcRef.handle = startPairingIpcClient({
          sockPath: ctx.account.pairingSocket,
          signal: ctx.abortSignal,
          client: sdkClient,
          log: ctx.log,
        });
      },
    });
  } catch (err) {
    if (pairingIpcRef.handle) {
      await pairingIpcRef.handle.stop().catch(() => undefined);
    }
    throw err;
  }

  // Connect to NATS via SDK
  let { client: session, cdi, userId, cuk } = await connectLucySdk({ cfg: sdkCfg });

  // Tell blue-wifi that binding is done so it can clear its OTP exposure,
  // then close the IPC channel — it is only useful during PendingBind.
  // NOTE: the write is best-effort. If the IPC is currently reconnecting
  // (e.g. blue-wifi restarted between pollBinding cycles), the bind.completed
  // frame is dropped and blue-wifi falls back on the OTP expires_at_ms guard
  // it already tracks locally to clean up stale state.
  if (pairingIpcRef.handle) {
    pairingIpcRef.handle.publishBindCompleted({ cuk, userId });
    await pairingIpcRef.handle.stop().catch(() => undefined);
    pairingIpcRef.handle = null;
  }

  // Publish the long-lived session so outbound send paths can reuse it instead
  // of opening a fresh NATS connection per outbound message.
  lucyActiveSessions.set(ctx.account.accountId, {
    accountId: ctx.account.accountId,
    session,
    cdi,
    userId,
    cuk,
  });

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
    lucyActiveSessions.delete(ctx.account.accountId);
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

  // ── Self-healing connection loop ──────────────────────────────────
  // Three recovery layers, each progressively heavier:
  //   Layer 1 (SDK):     handles transient NATS blips — 10 reconnects
  //                      with exponential backoff 2 s → 60 s, fresh
  //                      token each attempt. Fully internal to the SDK.
  //   Layer 2 (gateway): when the SDK exhausts reconnects, rebuild the
  //                      entire SDK session from scratch with longer
  //                      intervals. Unlimited retries, capped at 5 min.
  //   Layer 3 (OpenClaw): if startLucyGateway throws, the framework's
  //                      auto-restart kicks in as a last resort.

  const HEAL_BASE_DELAY_MS = 30_000;
  const HEAL_MAX_DELAY_MS = 300_000;

  /** Sleep that resolves `true` normally, or `false` when aborted. */
  const sleepOrAbort = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (ctx.abortSignal.aborted) {
        resolve(false);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        ctx.abortSignal.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
    });

  /** Subscribe to the inbound JetStream subject on the current session. */
  const subscribeInbound = async () => {
    ctx.log?.info?.(
      `[lucy] JetStream subscribe starting subject=${subscribeSubject}`,
    );
    await session.subscribeChannel(subscribeSubject, async (msg: JetStreamMessage) => {
      if (stopped) return;
      try {
        const inboundAt = Date.now();
        updateLucyStatus(ctx, { lastInboundAt: inboundAt });
        ctx.log?.debug?.(
          `[lucy] status patch lastInboundAt=${inboundAt} subject=${msg.subject} bytes=${msg.payload.byteLength}`,
        );
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
        const outboundAt = Date.now();
        updateLucyStatus(ctx, { lastOutboundAt: outboundAt });
        ctx.log?.debug?.(
          `[lucy] status patch lastOutboundAt=${outboundAt} (after inbound dispatch) subject=${msg.subject}`,
        );
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
    ctx.log?.info?.(
      `[lucy] JetStream subscribe registered (pull consumer running) subject=${subscribeSubject}`,
    );
  };

  try {
    await subscribeInbound();
    let healAttempt = 0;

    while (!stopped && !ctx.abortSignal.aborted) {
      // Race: normal shutdown (abort) vs SDK connection permanently lost
      const outcome = await Promise.race([
        new Promise<"abort">((resolve) => {
          if (ctx.abortSignal.aborted) {
            resolve("abort");
            return;
          }
          ctx.abortSignal.addEventListener("abort", () => resolve("abort"), {
            once: true,
          });
        }),
        session.connectionLost.then((reason: string) => reason),
      ]);

      if (outcome === "abort") {
        break;
      }

      // ── Layer 2: gateway-level self-heal ──
      ctx.log?.warn?.(
        `[lucy] NATS connection permanently lost: ${outcome}; starting gateway-level heal`,
      );
      updateLucyStatus(ctx, {
        running: false,
        lastError: `connection lost: ${outcome}`,
      });
      await session.shutdown().catch(() => {});

      let healed = false;
      while (!ctx.abortSignal.aborted) {
        healAttempt++;
        const delay = Math.min(
          HEAL_BASE_DELAY_MS * 2 ** Math.min(healAttempt - 1, 10),
          HEAL_MAX_DELAY_MS,
        );
        ctx.log?.info?.(
          `[lucy] gateway heal attempt ${healAttempt} in ${Math.round(delay / 1000)}s`,
        );

        if (!(await sleepOrAbort(delay))) {
          break;
        }

        try {
          const reconnected = await connectLucySdk({ cfg: sdkCfg });
          session = reconnected.client;

          lucyActiveSessions.set(ctx.account.accountId, {
            accountId: ctx.account.accountId,
            session,
            cdi,
            userId,
            cuk,
          });

          await subscribeInbound();

          updateLucyStatus(ctx, {
            running: true,
            lastStartAt: Date.now(),
          });
          ctx.log?.info?.(
            `[lucy] healed after ${healAttempt} gateway-level attempt(s)`,
          );
          healAttempt = 0;
          healed = true;
          break;
        } catch (err) {
          ctx.log?.warn?.(
            `[lucy] gateway heal attempt ${healAttempt} failed: ${String(err)}`,
          );
        }
      }

      if (!healed) {
        break;
      }
    }
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
