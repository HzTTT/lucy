import type { NatsConnection } from "nats";
import { connectLucyNats, buildLucySubjects, encodeLucyMachineEvent } from "./nats.js";
import { getProcessSnowflakeGenerator } from "./snowflake.js";
import { loadOrCreateLucyDeviceState } from "./state.js";
import type {
  LucyMachineEvent,
  LucyMachineEventType,
  LucyMediaDescriptor,
  ResolvedLucyAccount,
} from "./types.js";

type BuildMachineEventParams = {
  account: ResolvedLucyAccount;
  deviceId: string;
  type: LucyMachineEventType;
  eventId?: string;
  sourceMessageId?: string;
  runId?: string;
  sessionKey?: string;
  text?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
  media?: LucyMediaDescriptor;
};

export function buildLucyMachineEvent(params: BuildMachineEventParams): LucyMachineEvent {
  if (!params.account.channelUserKey) {
    throw new Error("lucy channelUserKey is not configured");
  }
  return {
    version: 2,
    eventId: params.eventId ?? getProcessSnowflakeGenerator().nextId(),
    type: params.type,
    timestamp: Date.now(),
    channelUserKey: params.account.channelUserKey,
    channelDeviceId: params.deviceId,
    sourceMessageId: params.sourceMessageId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    text: params.text,
    toolName: params.toolName,
    metadata: params.metadata,
    media: params.media,
  };
}

export async function publishLucyMachineEvent(params: {
  account: ResolvedLucyAccount;
  connection?: NatsConnection;
  deviceId?: string;
  type: LucyMachineEventType;
  eventId?: string;
  sourceMessageId?: string;
  runId?: string;
  sessionKey?: string;
  text?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
  media?: LucyMediaDescriptor;
}): Promise<LucyMachineEvent> {
  if (!params.account.channelUserKey) {
    throw new Error("lucy channelUserKey is not configured");
  }
  const deviceState = params.deviceId
    ? { channelDeviceId: params.deviceId }
    : await loadOrCreateLucyDeviceState();
  const event = buildLucyMachineEvent({
    ...params,
    deviceId: deviceState.channelDeviceId,
  });
  const connection = params.connection ?? (await connectLucyNats(params.account));
  try {
    const subjects = buildLucySubjects({
      subjectPrefix: params.account.subjectPrefix,
      channelUserKey: params.account.channelUserKey,
      channelDeviceId: deviceState.channelDeviceId,
    });
    connection.publish(subjects.machineSubject, encodeLucyMachineEvent(event));
    await connection.flush();
    return event;
  } finally {
    if (!params.connection) {
      await connection.close();
    }
  }
}
