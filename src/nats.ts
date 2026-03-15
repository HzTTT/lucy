import { connect, JSONCodec, type ConnectionOptions, type NatsConnection } from "nats";
import { connectLucyWebSocketNats, isLucyWebSocketServer } from "./nats-websocket.js";
import type { LucyMachineEvent, LucySubjects, ResolvedLucyAccount } from "./types.js";

const machineEventCodec = JSONCodec<Record<string, unknown>>();
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export function buildLucySubjects(params: {
  subjectPrefix: string;
  channelUserKey: string;
  channelDeviceId: string;
}): LucySubjects {
  const prefix = params.subjectPrefix.trim();
  return {
    clientSubject: `${prefix}.${params.channelUserKey}.${params.channelDeviceId}.client`,
    machineSubject: `${prefix}.${params.channelUserKey}.${params.channelDeviceId}.machine`,
  };
}

export function buildLucyNatsConnectionOptions(account: ResolvedLucyAccount): ConnectionOptions {
  const options: ConnectionOptions = {
    servers: account.servers,
    name: `openclaw-lucy-${account.channelUserKey ?? account.channelDeviceId ?? "unbound"}`,
    timeout: DEFAULT_CONNECT_TIMEOUT_MS,
  };
  if (account.channelUserKey) {
    options.user = account.channelUserKey;
  }
  if (account.channelDeviceId) {
    options.pass = account.channelDeviceId;
  }
  if (!options.user && account.username) {
    options.user = account.username;
  }
  if (!options.pass && account.password) {
    options.pass = account.password;
  }
  if (!options.user && !options.pass && account.token) {
    options.token = account.token;
  }
  return options;
}

export async function connectLucyNatsWithOptions(
  options: ConnectionOptions,
): Promise<NatsConnection> {
  const servers =
    typeof options.servers === "string" ? [options.servers] : (options.servers?.slice() ?? []);
  if (servers.some((server) => isLucyWebSocketServer(server))) {
    return await connectLucyWebSocketNats(options);
  }
  return await connect(options);
}

export async function connectLucyNats(account: ResolvedLucyAccount): Promise<NatsConnection> {
  return await connectLucyNatsWithOptions(buildLucyNatsConnectionOptions(account));
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
  };
}

export function encodeLucyMachineEvent(event: LucyMachineEvent): Uint8Array {
  return machineEventCodec.encode(serializeLucyMachineEvent(event));
}
