// Probe whether `assistant.complete` is published as the LAST machine event
// for a single inbound message, by simulating the iOS / user-side client
// (login -> user NATS token -> JetStream publish inbound + core subscribe
// outbound). Adapted from scripts/e2e-probe.mjs but waits for
// `assistant.complete` instead of stopping at `assistant.final`.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const UC =
  process.env.LUCY_PROBE_USER_CENTER ??
  "https://test.unicorn.org.cn/cephalon/user-center";
const LS =
  process.env.LUCY_PROBE_LUCY_SERVER ??
  "https://test.unicorn.org.cn/aiden/lucy-server";
const CLIENT_ID = process.env.LUCY_PROBE_CLIENT_ID ?? "assistant-complete-probe";
const PHONE = process.env.LUCY_PROBE_PHONE ?? "19999999999";
const PWD = process.env.LUCY_PROBE_PWD ?? "a123456";
const HOME = process.env.LUCY_IM_HOME_DIR ?? path.join(os.homedir(), ".lucy/identity");
const PROMPT = process.env.LUCY_PROBE_PROMPT ?? "Reply with exactly one word: PROBE_OK";
const WAIT_MS = Number(process.env.LUCY_PROBE_WAIT_MS ?? 90_000);

async function readId(name: string): Promise<string> {
  return (await fs.readFile(path.join(HOME, "channel_ids", name), "utf8")).trim();
}

function makeMessageId(): string {
  // Same shape as e2e scripts: 19-digit decimal, monotonic-ish.
  const ms = BigInt(Date.now());
  const rand = BigInt(Math.floor(Math.random() * 1_000_000));
  return (ms * 1_000_000n + rand).toString();
}

type Captured = {
  type?: string;
  sourceMessageId?: string;
  runId?: string;
  eventId?: string;
  textPreview?: string;
};

async function main() {
  const [cdi, userId] = await Promise.all([readId("cdi"), readId("user_id")]);
  console.log(
    `[probe] env=${UC.includes("test") ? "test" : "prod"} cdi=${cdi} user_id=${userId}`,
  );

  // 1. login -> user-center session token
  const loginResp = await fetch(`${UC}/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PHONE, pwd: PWD, way: "phone_pwd" }),
  });
  const loginJson = (await loginResp.json()) as { data?: { token?: string } };
  if (!loginJson?.data?.token) {
    console.error("[probe] login failed:", JSON.stringify(loginJson));
    process.exit(2);
  }
  const userToken = loginJson.data.token;
  console.log(`[probe] logged in (token prefix=${userToken.slice(0, 16)}...)`);

  // 2. lucy-server -> user-side NATS token
  const tokenResp = await fetch(`${LS}/v1/channels/lucy/nats/token/user`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const tokenJson = (await tokenResp.json()) as { token?: string; nats_url?: string };
  if (!tokenJson?.token || !tokenJson?.nats_url) {
    console.error("[probe] nats token request failed:", JSON.stringify(tokenJson));
    process.exit(3);
  }
  console.log(`[probe] got user NATS token, server=${tokenJson.nats_url}`);

  // 3. connect NATS as user-side identity
  const natsLib = (await import("nats")) as typeof import("nats");
  const nc = await natsLib.connect({
    servers: tokenJson.nats_url,
    token: tokenJson.token,
    timeout: 10_000,
  });
  console.log(`[probe] NATS connected`);

  const npcSub = `cephalon.im.npc.${userId}.${cdi}`;
  const userSub = `cephalon.im.user.${userId}`;

  const messageId = makeMessageId();
  const events: Captured[] = [];
  let sawComplete = false;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  // 4. subscribe outbound BEFORE publishing inbound
  const sub = nc.subscribe(userSub);
  const overallTimer = setTimeout(() => {
    console.log(`[probe] hard timeout after ${WAIT_MS}ms`);
    sub.unsubscribe();
    resolveDone?.();
  }, WAIT_MS);

  void (async () => {
    for await (const msg of sub) {
      let evt: {
        type?: string;
        source_message_id?: string;
        run_id?: string;
        eventId?: string;
        text?: string;
      } = {};
      try {
        evt = JSON.parse(Buffer.from(msg.data).toString("utf8"));
      } catch {
        continue;
      }
      // Only count events that belong to our inbound run.
      if (evt.source_message_id && evt.source_message_id !== messageId) continue;
      const captured: Captured = {
        type: evt.type,
        sourceMessageId: evt.source_message_id,
        runId: evt.run_id,
        eventId: evt.eventId,
        textPreview: (evt.text || "").slice(0, 60),
      };
      events.push(captured);
      console.log(
        `[event #${events.length}] type=${captured.type} sourceMessageId=${captured.sourceMessageId ?? "-"} runId=${captured.runId ?? "-"}${captured.textPreview ? ` text="${captured.textPreview}"` : ""}`,
      );
      if (captured.type === "assistant.complete") {
        sawComplete = true;
        // Longer grace window so any duplicate complete or trailing event
        // would be captured before we stop.
        setTimeout(() => {
          clearTimeout(overallTimer);
          sub.unsubscribe();
          resolveDone?.();
        }, 3000);
      }
    }
  })();

  await nc.flush();
  // Let the sub register on server-side before publishing.
  await new Promise((r) => setTimeout(r, 300));

  // 5. publish inbound message via JetStream
  const js = nc.jetstream();
  const enc = new TextEncoder();
  const inboundPayload = JSON.stringify({
    version: 2,
    messageId,
    text: PROMPT,
    timestamp: Date.now(),
  });
  console.log(`[probe] publishing messageId=${messageId} prompt="${PROMPT}"`);
  await js.publish(npcSub, enc.encode(inboundPayload));

  await done;

  // 6. summary
  console.log("\n[probe] ===== summary =====");
  console.log(`[probe] events received: ${events.length}`);
  const counts = events.reduce<Record<string, number>>((acc, e) => {
    if (e.type) acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[probe] counts: ${JSON.stringify(counts)}`);
  console.log(`[probe] types in order:\n  ${events.map((e) => e.type).join("\n  -> ")}`);
  const last = events[events.length - 1];
  const completeCount = counts["assistant.complete"] ?? 0;
  const finalCount = counts["assistant.final"] ?? 0;
  let exitCode = 1;
  if (events.length === 0) {
    console.log("[probe] VERDICT: NO_EVENTS - subscription never received any inbound-scoped event");
  } else if (
    sawComplete &&
    last?.type === "assistant.complete" &&
    completeCount === 1
  ) {
    console.log(
      `[probe] VERDICT: PASS - exactly 1 assistant.complete is the LAST event (${finalCount} assistant.final blocks before it)`,
    );
    console.log(
      `[probe] complete carries: sourceMessageId=${last.sourceMessageId} runId=${last.runId} eventId=${last.eventId}`,
    );
    exitCode = 0;
  } else if (sawComplete && completeCount > 1) {
    console.log(
      `[probe] VERDICT: FAIL - assistant.complete fired ${completeCount} times (should be exactly 1)`,
    );
  } else if (sawComplete) {
    console.log(
      `[probe] VERDICT: WEAK_PASS - assistant.complete present but not last (last=${last?.type})`,
    );
  } else {
    console.log("[probe] VERDICT: FAIL - assistant.complete never seen");
  }

  await nc.close();
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
