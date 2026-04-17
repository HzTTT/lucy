/**
 * Lucy E2E Test 02: 消息收发
 *
 * 测试: 文本消息、推理输出、工具调用
 *
 * 前置: 已完成绑定（01-bind-flow.mjs），gateway 正在运行
 * 运行: node test/e2e/02-messaging.mjs
 */

import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// ── 配置 ──
const UC = "https://test.unicorn.org.cn/cephalon/user-center";
const LS = "https://test.unicorn.org.cn/aiden/lucy-server";
const PHONE = "18888888888";
const PWD = "cephalon.boss";

const home = process.env.LUCY_HOME || path.join(homedir(), ".lucy/identity");
const cdi = (await fs.readFile(path.join(home, "channel_ids/cdi"), "utf8")).trim();
const userId = (await fs.readFile(path.join(home, "channel_ids/user_id"), "utf8")).trim();

// ── 连接 NATS ──
const login = await (await fetch(UC + "/v1/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: PHONE, pwd: PWD, way: "phone_pwd" }),
})).json();
const tokenResp = await (await fetch(LS + "/v1/channels/lucy/nats/token/user", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + login.data.token },
})).json();

const { connect } = await import("nats");
const nc = await connect({ servers: tokenResp.nats_url, token: tokenResp.token, timeout: 10000 });
const js = nc.jetstream();
const enc = new TextEncoder();
const npcSub = "cephalon.im.npc." + userId + "." + cdi;
const userSub = "cephalon.im.user." + userId;
console.log("Connected as user\n");

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.error(`  ❌ ${label}: ${detail || ""}`); }
}

// ── 发消息并收集事件 ──
let msgIdCounter = 0;
async function sendAndCollect(text, timeoutMs = 180000) {
  // Use a timestamp-based messageId so every test run is unique — important
  // because gateway replays any unacked backlog through the agent.
  const messageId = `23${Date.now()}${String(msgIdCounter++ % 10000).padStart(4, "0")}`;
  const events = [];
  const sub = nc.subscribe(userSub);
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const timer = setTimeout(() => { sub.unsubscribe(); resolve(); }, timeoutMs);

  (async () => {
    for await (const msg of sub) {
      try {
        const evt = JSON.parse(Buffer.from(msg.data).toString("utf8"));
        // Filter events by sourceMessageId so we only see the reply for *this*
        // publish. Without this filter we would latch onto whatever final
        // event arrives first on the user subject, which may belong to an
        // earlier test or a backlog replay.
        if (evt.sourceMessageId && evt.sourceMessageId !== messageId) {
          continue;
        }
        events.push(evt);
        if (evt.type === "assistant.final" || evt.type === "error") {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve();
          break;
        }
      } catch {}
    }
  })();

  // Give the SUB protocol a moment to flush to the server before publishing,
  // otherwise fast machine events may race the subscription registration.
  await nc.flush();
  await new Promise(r => setTimeout(r, 200));

  await js.publish(npcSub, enc.encode(JSON.stringify({ version: 2, messageId, text, timestamp: Date.now() })));
  await done;
  return events;
}

// ── Test 1: 简单文本 ──
console.log("=== Test 1: 简单文本回复 ===");
const t1 = await sendAndCollect("Reply with exactly one word: PONG");
const t1Final = t1.find(e => e.type === "assistant.final");
check("got inbound.accepted", t1.some(e => e.type === "inbound.accepted"));
check("got assistant.start", t1.some(e => e.type === "assistant.start"));
check("got assistant.final", Boolean(t1Final));
check("final text contains PONG", t1Final?.text?.includes("PONG"), t1Final?.text?.slice(0, 50));

// ── Test 2: 推理 ──
console.log("\n=== Test 2: 推理输出 ===");
const t2 = await sendAndCollect("Think step by step: what is 17 * 23? Show reasoning then final answer.");
const t2Final = t2.find(e => e.type === "assistant.final");
const hasReasoning = t2.some(e => e.type === "reasoning.partial" || e.type === "reasoning.final");
check("got assistant.final", Boolean(t2Final));
check("has reasoning events", hasReasoning);
check("answer contains 391", t2Final?.text?.includes("391"), t2Final?.text?.slice(0, 80));

// ── Test 3: 工具调用 ──
console.log("\n=== Test 3: 工具调用 ===");
const t3 = await sendAndCollect("What is the current date and time? Use any available tool.");
const t3Final = t3.find(e => e.type === "assistant.final");
const hasToolStart = t3.some(e => e.type === "tool.start");
const hasToolEnd = t3.some(e => e.type === "tool.end");
check("got assistant.final", Boolean(t3Final));
check("has tool.start", hasToolStart);
check("has tool.end", hasToolEnd);
check("response has content", t3Final?.text?.length > 5, t3Final?.text?.slice(0, 80));

// ── Test 4: 完整事件序列检查 ──
console.log("\n=== Test 4: 事件序列完整性 ===");
const t4 = await sendAndCollect("Say hello");
const types = t4.map(e => e.type);
const acceptedIdx = types.indexOf("inbound.accepted");
const startIdx = types.indexOf("assistant.start");
const finalIdx = types.indexOf("assistant.final");
check("accepted before start", acceptedIdx < startIdx, `accepted=${acceptedIdx} start=${startIdx}`);
check("start before final", startIdx < finalIdx, `start=${startIdx} final=${finalIdx}`);
check("all events have version=2", t4.every(e => e.version === 2));
check("all events have eventId", t4.every(e => e.eventId || e.type === "inbound.accepted"));
check("all events have timestamp", t4.every(e => typeof e.timestamp === "number"));

// ── Summary ──
await nc.close();
console.log(`\n========== SUMMARY ==========`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`==============================`);
process.exit(failed > 0 ? 1 : 0);
