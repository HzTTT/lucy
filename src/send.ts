import type { ConnectedClient } from "lucy-im-sdk";
import { buildNpcPublishSubject, serializeLucyMachineEventJson } from "./nats.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import type {
  LucyMachineEvent,
  LucyMachineEventType,
  LucyMediaDescriptor,
} from "./types.js";

type BuildMachineEventParams = {
  cuk: string;
  cdi: string;
  type: LucyMachineEventType;
  eventId?: string;
  sourceMessageId?: string;
  runId?: string;
  sessionKey?: string;
  text?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
  media?: LucyMediaDescriptor;
  approvalId?: string;
  approvalSlug?: string;
  approvalCommand?: string;
  approvalCwd?: string;
  approvalHost?: string;
  approvalExpiresAtMs?: number;
  approvalAllowedDecisions?: string[];
  approvalDecision?: string;
  approvalResolvedBy?: string;
};

export function buildLucyMachineEvent(params: BuildMachineEventParams): LucyMachineEvent {
  return {
    version: 2,
    eventId: params.eventId ?? getProcessSnowflakeGenerator().nextId(),
    type: params.type,
    timestamp: Date.now(),
    channelUserKey: params.cuk,
    channelDeviceId: params.cdi,
    sourceMessageId: params.sourceMessageId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    text: params.text,
    toolName: params.toolName,
    metadata: params.metadata,
    media: params.media,
    approvalId: params.approvalId,
    approvalSlug: params.approvalSlug,
    approvalCommand: params.approvalCommand,
    approvalCwd: params.approvalCwd,
    approvalHost: params.approvalHost,
    approvalExpiresAtMs: params.approvalExpiresAtMs,
    approvalAllowedDecisions: params.approvalAllowedDecisions,
    approvalDecision: params.approvalDecision,
    approvalResolvedBy: params.approvalResolvedBy,
  };
}

export async function publishLucyMachineEvent(params: {
  session: ConnectedClient;
  userId: string;
  cuk: string;
  cdi: string;
  type: LucyMachineEventType;
  eventId?: string;
  sourceMessageId?: string;
  runId?: string;
  sessionKey?: string;
  text?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
  media?: LucyMediaDescriptor;
  approvalId?: string;
  approvalSlug?: string;
  approvalCommand?: string;
  approvalCwd?: string;
  approvalHost?: string;
  approvalExpiresAtMs?: number;
  approvalAllowedDecisions?: string[];
  approvalDecision?: string;
  approvalResolvedBy?: string;
}): Promise<LucyMachineEvent> {
  const event = buildLucyMachineEvent(params);
  const subject = buildNpcPublishSubject(params.userId);
  await params.session.publishChannel(subject, serializeLucyMachineEventJson(event));
  return event;
}
