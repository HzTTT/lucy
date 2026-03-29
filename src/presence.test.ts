import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { startLucyPresenceLoop } from "./presence.js";

type PresenceMessage = {
  subject: string;
  payload: string;
};

class ManualSubscription implements AsyncIterable<{ data: Uint8Array }> {
  #queue: Uint8Array[] = [];
  #waiting: Array<(value: IteratorResult<{ data: Uint8Array }>) => void> = [];
  #closed = false;

  push(payload: string) {
    const data = new TextEncoder().encode(payload);
    const waiting = this.#waiting.shift();
    if (waiting) {
      waiting({ value: { data }, done: false });
      return;
    }
    this.#queue.push(data);
  }

  unsubscribe() {
    this.#closed = true;
    while (this.#waiting.length > 0) {
      this.#waiting.shift()?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: async (): Promise<IteratorResult<{ data: Uint8Array }>> => {
        if (this.#queue.length > 0) {
          return {
            value: { data: this.#queue.shift() as Uint8Array },
            done: false,
          };
        }
        if (this.#closed) {
          return { value: undefined, done: true };
        }
        return await new Promise<IteratorResult<{ data: Uint8Array }>>((resolve) => {
          this.#waiting.push(resolve);
        });
      },
    };
  }
}

class FakePresenceConnection {
  info = { client_id: 42 };
  publishes: PresenceMessage[] = [];
  flushCount = 0;
  subscription = new ManualSubscription();
  operations: string[] = [];

  publish(subject: string, payload: string) {
    this.operations.push(`publish:${subject}`);
    this.publishes.push({ subject, payload });
  }

  async flush(): Promise<void> {
    this.operations.push("flush");
    this.flushCount += 1;
  }

  subscribe(subject: string) {
    assert.equal(subject, "cephalon.im.npc.cuk_test.2036075953145073664.ping");
    this.operations.push(`subscribe:${subject}`);
    return this.subscription;
  }
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("presence loop flushes startup, heartbeat, ping response, and offline broadcasts", async () => {
  const connection = new FakePresenceConnection();
  let heartbeatCallback: (() => void) | null = null;
  let clearedTimer: unknown = null;
  const fakeTimer = {} as unknown as ReturnType<typeof setInterval>;

  const loop = startLucyPresenceLoop({
    connection,
    discoverSubject: "cephalon.im.npc.cuk_test._discover",
    pingSubject: "cephalon.im.npc.cuk_test.2036075953145073664.ping",
    channelUserKey: "cuk_test",
    channelDeviceId: "2036075953145073664",
    heartbeatIntervalMs: 30_000,
    setIntervalImpl(callback) {
      heartbeatCallback = callback;
      return fakeTimer;
    },
    clearIntervalImpl(timer) {
      clearedTimer = timer;
    },
  });

  await loop.ready;

  assert.deepEqual(connection.publishes.slice(0, 2), [
    {
      subject: "client.status.report",
      payload: JSON.stringify({
        client_id: 42,
        apikey: "cuk_test",
        npc_id: "2036075953145073664",
      }),
    },
    {
      subject: "cephalon.im.npc.cuk_test._discover",
      payload: "online\n2036075953145073664",
    },
  ]);
  assert.equal(connection.flushCount, 1);

  const invokeHeartbeat =
    heartbeatCallback ??
    (() => {
      throw new Error("heartbeat callback was not registered");
    });
  invokeHeartbeat();
  await nextTick();

  assert.equal(connection.flushCount, 2);
  assert.deepEqual(connection.publishes.at(-1), {
    subject: "cephalon.im.npc.cuk_test._discover",
    payload: "online\n2036075953145073664",
  });

  connection.subscription.push("probe");
  await nextTick();

  assert.equal(connection.flushCount, 3);
  assert.deepEqual(connection.publishes.at(-1), {
    subject: "cephalon.im.npc.cuk_test._discover",
    payload: "online\n2036075953145073664",
  });

  loop.stop();
  await nextTick();

  assert.equal(connection.flushCount, 4);
  assert.equal(clearedTimer, fakeTimer);
  assert.deepEqual(connection.publishes.at(-1), {
    subject: "cephalon.im.npc.cuk_test._discover",
    payload: "offline\n2036075953145073664",
  });
});

test("presence loop registers ping subscription before startup ready resolves", async () => {
  const connection = new FakePresenceConnection();

  const loop = startLucyPresenceLoop({
    connection,
    discoverSubject: "cephalon.im.npc.cuk_test._discover",
    pingSubject: "cephalon.im.npc.cuk_test.2036075953145073664.ping",
    channelUserKey: "cuk_test",
    channelDeviceId: "2036075953145073664",
  });

  await loop.ready;

  const subscribeIndex = connection.operations.indexOf(
    "subscribe:cephalon.im.npc.cuk_test.2036075953145073664.ping",
  );
  const firstFlushIndex = connection.operations.indexOf("flush");

  assert.notEqual(subscribeIndex, -1);
  assert.notEqual(firstFlushIndex, -1);
  assert.ok(
    subscribeIndex < firstFlushIndex,
    "ping subscription should be registered before startup ready flush resolves",
  );

  loop.stop();
  await nextTick();
});

test("presence source declares ping subscription before startup ready publish", () => {
  const source = fs.readFileSync(new URL("./presence.ts", import.meta.url), "utf8");
  const subscribeIndex = source.indexOf(
    "const pingSubscription = params.connection.subscribe(params.pingSubject);",
  );
  const readyIndex = source.indexOf("const ready = publishAndFlush(");

  assert.notEqual(subscribeIndex, -1);
  assert.notEqual(readyIndex, -1);
  assert.ok(
    subscribeIndex < readyIndex,
    "ping subscription should be declared before startup ready publish in source",
  );
});
