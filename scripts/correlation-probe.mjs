import fs from "node:fs/promises";
import path from "node:path";

const UC = "https://test.unicorn.org.cn/cephalon/user-center";
const LS = "https://test.unicorn.org.cn/aiden/lucy-server";
const home = "/tmp/lucy-client-home/data/lucy_im";
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

const myMessageId = `23${Date.now()}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
console.log("myMessageId =", myMessageId);

const uniqueTag = `UNIQ-${Date.now()}-VERIFY`;
const sub = nc.subscribe(userSub);
let matched = null;
const done = new Promise((resolve) => {
  const timer = setTimeout(() => { sub.unsubscribe(); resolve("timeout"); }, 90000);
  (async () => {
    for await (const m of sub) {
      try {
        const evt = JSON.parse(new TextDecoder().decode(m.data));
        const txt = (evt.text || "").slice(0, 80);
        console.log(`  ${evt.type} ${txt}`);
        if (evt.type === "assistant.final" && (evt.text || "").includes(uniqueTag)) {
          matched = evt;
          clearTimeout(timer);
          sub.unsubscribe();
          resolve("matched");
          break;
        }
      } catch {}
    }
  })();
});

await new Promise(r => setTimeout(r, 300));
await js.publish(npcSub, enc.encode(JSON.stringify({
  version: 2,
  messageId: myMessageId,
  text: `Please echo back exactly this token: ${uniqueTag}`,
  timestamp: Date.now(),
})));
console.log("published, waiting for a final containing", uniqueTag);
const result = await done;
console.log("\nresult:", result);
if (matched) {
  console.log("final text:", matched.text);
}
await nc.close();
process.exit(result === "matched" ? 0 : 1);
