import fs from "node:fs/promises";
import path from "node:path";

const UC = "https://test.unicorn.org.cn/cephalon/user-center";
const LS = "https://test.unicorn.org.cn/aiden/lucy-server";
const home = "/tmp/lucy-test/identity";
const cdi = (await fs.readFile(path.join(home, "channel_ids/cdi"), "utf8")).trim();
const userId = (await fs.readFile(path.join(home, "channel_ids/user_id"), "utf8")).trim();

const login = await (await fetch(UC + "/v1/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: "18888888888", pwd: "cephalon.boss", way: "phone_pwd" }),
})).json();
const tokenResp = await (await fetch(LS + "/v1/channels/lucy/nats/token/user", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + login.data.token },
})).json();
const { connect } = await import("nats");
const nc = await connect({ servers: tokenResp.nats_url, token: tokenResp.token, timeout: 10000 });
const js = nc.jetstream();
const enc = new TextEncoder();
const npcSub = `cephalon.im.npc.${userId}.${cdi}`;
const userSub = `cephalon.im.user.${userId}`;
console.log("connected");

// Use 02's exact messageId scheme
let msgIdCounter = 2200000000000000000n;

async function sendAndDump(text) {
  const messageId = String(msgIdCounter++);
  console.log(`\n-> publishing messageId=${messageId} text="${text}"`);
  const events = [];
  const sub = nc.subscribe(userSub);
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const timer = setTimeout(() => { sub.unsubscribe(); resolve(); }, 180000);

  (async () => {
    for await (const msg of sub) {
      try {
        const evt = JSON.parse(Buffer.from(msg.data).toString("utf8"));
        events.push(evt);
        const txt = (evt.text || "").slice(0, 80);
        console.log(`   <- ${evt.type} ${txt}`);
        if (evt.type === "assistant.final" || evt.type === "error") {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve();
          break;
        }
      } catch {}
    }
  })();

  await nc.flush();
  await new Promise(r => setTimeout(r, 200));
  await js.publish(npcSub, enc.encode(JSON.stringify({ version: 2, messageId, text, timestamp: Date.now() })));
  await done;
  console.log(`   total events: ${events.length}`);
}

await sendAndDump("Reply with exactly one word: PONG");
await sendAndDump("Think step by step: what is 17 * 23? Show reasoning then final answer.");
await sendAndDump("What is the current date and time? Use any available tool.");
await sendAndDump("Say hello");

await nc.close();
