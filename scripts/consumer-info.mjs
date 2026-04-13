import fs from "node:fs/promises";
import path from "node:path";

const UC = "https://test.unicorn.org.cn/cephalon/user-center";
const LS = "https://test.unicorn.org.cn/aiden/lucy-server";
const home = "/tmp/lucy-client-home/data/lucy_im";
const cdi = (await fs.readFile(path.join(home, "channel_ids/cdi"), "utf8")).trim();

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

try {
  const jsm = await nc.jetstreamManager({ checkAPI: false });
  const si = await jsm.streams.info("IM_NPC");
  console.log("stream.messages =", si.state.messages, "first_seq =", si.state.first_seq, "last_seq =", si.state.last_seq);
} catch (e) {
  console.log("stream info err:", e.message);
}

try {
  const jsm = await nc.jetstreamManager({ checkAPI: false });
  const ci = await jsm.consumers.info("IM_NPC", `npc-${cdi}`);
  console.log("consumer num_pending =", ci.num_pending, "num_ack_pending =", ci.num_ack_pending, "delivered.stream_seq =", ci.delivered?.stream_seq, "ack_floor.stream_seq =", ci.ack_floor?.stream_seq);
} catch (e) {
  console.log("consumer info err:", e.message);
}

await nc.close();
