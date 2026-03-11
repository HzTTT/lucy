import { connect, JSONCodec, type ConnectionOptions, type NatsConnection } from "nats";
import { connectLucyWebSocketNats, isLucyWebSocketServer } from "./nats-websocket.js";
import type { LucyMachineEvent, LucySubjects, ResolvedLucyAccount } from "./types.js";

const jsonCodec = JSONCodec<LucyMachineEvent>();
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export function buildLucySubjects(params: {
  subjectPrefix: string;
  apiKey: string;
  deviceId: string;
}): LucySubjects {
  const prefix = params.subjectPrefix.trim();
  return {
    clientSubject: `${prefix}.${params.apiKey}.${params.deviceId}.client`,
    machineSubject: `${prefix}.${params.apiKey}.${params.deviceId}.machine`,
  };
}

export function buildLucyNatsConnectionOptions(account: ResolvedLucyAccount): ConnectionOptions {
  const options: ConnectionOptions = {
    servers: account.servers,
    name: `openclaw-lucy-${account.apiKey ?? "unconfigured"}`,
    timeout: DEFAULT_CONNECT_TIMEOUT_MS,
  };
  if (account.token) {
    options.token = account.token;
    return options;
  }
  if (account.username) {
    options.user = account.username;
  }
  if (account.password) {
    options.pass = account.password;
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

export function encodeLucyMachineEvent(event: LucyMachineEvent): Uint8Array {
  return jsonCodec.encode(event);
}
