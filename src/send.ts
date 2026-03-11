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
  return {
    version: 2,
    eventId: params.eventId ?? getProcessSnowflakeGenerator().nextId(),
    type: params.type,
    timestamp: Date.now(),
    apiKey: params.account.apiKey ?? "",
    deviceId: params.deviceId,
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
  if (!params.account.apiKey) {
    throw new Error("lucy apiKey is not configured");
  }
  const deviceState = params.deviceId
    ? { deviceId: params.deviceId }
    : await loadOrCreateLucyDeviceState();
  const event = buildLucyMachineEvent({
    ...params,
    deviceId: deviceState.deviceId,
  });
  const connection = params.connection ?? (await connectLucyNats(params.account));
  try {
    const subjects = buildLucySubjects({
      subjectPrefix: params.account.subjectPrefix,
      apiKey: params.account.apiKey,
      deviceId: deviceState.deviceId,
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
