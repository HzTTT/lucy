type LucyPresenceConnection = {
  info?: { client_id?: number | undefined } | undefined;
  publish: (subject: string, payload: string) => void;
  flush: () => Promise<void>;
  subscribe: (subject: string) => AsyncIterable<unknown> & { unsubscribe: () => void };
};

type LucyPresenceTimer = ReturnType<typeof setInterval>;
type LucyPresenceSetInterval = (callback: () => void, delayMs: number) => LucyPresenceTimer;
type LucyPresenceClearInterval = (timer: LucyPresenceTimer) => void;

type LucyPresenceLoopParams = {
  connection: LucyPresenceConnection;
  discoverSubject: string;
  pingSubject: string;
  channelUserKey: string;
  channelDeviceId: string;
  heartbeatIntervalMs?: number;
  setIntervalImpl?: LucyPresenceSetInterval;
  clearIntervalImpl?: LucyPresenceClearInterval;
  log?: {
    warn?: (message: string) => void;
  };
};

type LucyPresenceLoop = {
  ready: Promise<void>;
  stop: () => void;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

function buildPresencePayload(
  state: "online" | "offline",
  channelDeviceId: string,
): string {
  return `${state}\n${channelDeviceId}`;
}

export function startLucyPresenceLoop(params: LucyPresenceLoopParams): LucyPresenceLoop {
  const setIntervalImpl = params.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = params.clearIntervalImpl ?? clearInterval;
  let stopped = false;
  let flushQueue = Promise.resolve();

  const publishAndFlush = (subject: string, payload: string, label: string): Promise<void> => {
    params.connection.publish(subject, payload);
    flushQueue = flushQueue
      .catch(() => {})
      .then(async () => {
        try {
          await params.connection.flush();
        } catch (err) {
          params.log?.warn?.(`[lucy] ${label} flush failed: ${String(err)}`);
        }
      });
    return flushQueue;
  };

  params.connection.publish(
    "client.status.report",
    JSON.stringify({
      client_id: params.connection.info?.client_id,
      apikey: params.channelUserKey,
      npc_id: params.channelDeviceId,
    }),
  );
  const ready = publishAndFlush(
    params.discoverSubject,
    buildPresencePayload("online", params.channelDeviceId),
    "presence startup",
  );

  const heartbeatTimer = setIntervalImpl(() => {
    if (stopped) {
      return;
    }
    void publishAndFlush(
      params.discoverSubject,
      buildPresencePayload("online", params.channelDeviceId),
      "presence heartbeat",
    );
  }, params.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);

  const pingSubscription = params.connection.subscribe(params.pingSubject);
  void (async () => {
    try {
      for await (const _msg of pingSubscription) {
        if (stopped) {
          break;
        }
        void publishAndFlush(
          params.discoverSubject,
          buildPresencePayload("online", params.channelDeviceId),
          "presence ping",
        );
      }
    } catch (err) {
      if (!stopped) {
        params.log?.warn?.(`[lucy] presence ping loop failed: ${String(err)}`);
      }
    }
  })();

  return {
    ready,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearIntervalImpl(heartbeatTimer);
      pingSubscription.unsubscribe();
      void publishAndFlush(
        params.discoverSubject,
        buildPresencePayload("offline", params.channelDeviceId),
        "presence shutdown",
      );
    },
  };
}
