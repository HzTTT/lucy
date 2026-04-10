import type { LucyMachineEvent } from "./types.js";

export function buildNpcSubscribeSubject(userId: string, cdi: string): string {
  return `cephalon.im.npc.${userId}.${cdi}`;
}

export function buildNpcPublishSubject(userId: string): string {
  return `cephalon.im.user.${userId}`;
}

function serializeLucyMachineEvent(event: LucyMachineEvent): Record<string, unknown> {
  return {
    version: event.version,
    eventId: event.eventId,
    type: event.type,
    timestamp: event.timestamp,
    channel_user_key: event.channelUserKey,
    channel_device_id: event.channelDeviceId,
    ...(event.sourceMessageId ? { source_message_id: event.sourceMessageId } : {}),
    ...(event.runId ? { run_id: event.runId } : {}),
    ...(event.sessionKey ? { session_key: event.sessionKey } : {}),
    ...(event.text ? { text: event.text } : {}),
    ...(event.toolName ? { tool_name: event.toolName } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
    ...(event.media ? { media: event.media } : {}),
    ...(event.approvalId
      ? {
          approvalId: event.approvalId,
          approval_id: event.approvalId,
        }
      : {}),
    ...(event.approvalSlug
      ? {
          approvalSlug: event.approvalSlug,
          approval_slug: event.approvalSlug,
        }
      : {}),
    ...(event.approvalCommand
      ? {
          approvalCommand: event.approvalCommand,
          approval_command: event.approvalCommand,
        }
      : {}),
    ...(event.approvalCwd
      ? {
          approvalCwd: event.approvalCwd,
          approval_cwd: event.approvalCwd,
        }
      : {}),
    ...(event.approvalHost
      ? {
          approvalHost: event.approvalHost,
          approval_host: event.approvalHost,
        }
      : {}),
    ...(typeof event.approvalExpiresAtMs === "number" && Number.isFinite(event.approvalExpiresAtMs)
      ? {
          approvalExpiresAtMs: event.approvalExpiresAtMs,
          approval_expires_at_ms: event.approvalExpiresAtMs,
        }
      : {}),
    ...(event.approvalAllowedDecisions
      ? {
          approvalAllowedDecisions: event.approvalAllowedDecisions,
          approval_allowed_decisions: event.approvalAllowedDecisions,
        }
      : {}),
    ...(event.approvalDecision
      ? {
          approvalDecision: event.approvalDecision,
          approval_decision: event.approvalDecision,
        }
      : {}),
    ...(event.approvalResolvedBy
      ? {
          approvalResolvedBy: event.approvalResolvedBy,
          approval_resolved_by: event.approvalResolvedBy,
        }
      : {}),
  };
}

export function serializeLucyMachineEventJson(event: LucyMachineEvent): string {
  return JSON.stringify(serializeLucyMachineEvent(event));
}
