/**
 * Lucy E2E Test 01: 完整绑定流程
 *
 * 测试: SDK init → preBind(OTP) → App登录 → lucy-server绑定 → pollBinding → connect
 *
 * 前置: ~/data/lucy_im 目录为空（会自动清理）
 * 运行: node test/e2e/01-bind-flow.mjs
 */

import { LucyImClient, LucyImConfig } from "lucy-im-sdk";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ── 配置 ──
const UC = "https://test.unicorn.org.cn/cephalon/user-center";
const LS = "https://test.unicorn.org.cn/aiden/lucy-server";
const PHONE = "18888888888";
const PWD = "cephalon.boss";
const HOME_DIR = "~/data/lucy_im/";

// ── 清理旧状态 ──
const resolvedHome = HOME_DIR.replace("~", homedir());
try { rmSync(resolvedHome, { recursive: true, force: true }); } catch {}
console.log("Cleaned", resolvedHome);

const cfg = new LucyImConfig({ homeDir: HOME_DIR, userCenterDomain: UC, lucyServerDomain: LS, kind: "lucy" });
const client = new LucyImClient(cfg);

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.error(`  ❌ ${label}: ${detail}`); }
}

// Step 1: SDK init
console.log("\n=== Step 1: SDK init ===");
const init = await client.init();
check("init returns PendingBind", init.kind === "PendingBind", `got ${init.kind}`);
check("cdi is 19-digit string", /^\d{19,}$/.test(init.cdi), init.cdi);
const cdi = init.cdi;

// Step 2: SDK preBind
console.log("\n=== Step 2: SDK preBind ===");
const preBind = await client.preBind();
check("OTP is 6 digits", /^\d{6}$/.test(preBind.otp), preBind.otp);
check("expires_in > 0", preBind.expires_in > 0, String(preBind.expires_in));
console.log(`  OTP: ${preBind.otp} (expires in ${preBind.expires_in}s)`);

// Step 3: App login
console.log("\n=== Step 3: App login ===");
const loginResp = await (await fetch(UC + "/v1/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: PHONE, pwd: PWD, way: "phone_pwd" }),
})).json();
check("login code 20000", loginResp.code === 20000, `code=${loginResp.code}`);
const userToken = loginResp.data?.token;
check("got user token", Boolean(userToken), "no token");

// Step 4: Bind via lucy-server
console.log("\n=== Step 4: Bind via lucy-server ===");
const bindResp = await fetch(LS + "/v1/channels/lucy/devices/device-bindings", {
  method: "PUT",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + userToken },
  body: JSON.stringify({ otp: preBind.otp }),
});
const bindBody = await bindResp.json();
check("bind HTTP 200", bindResp.ok, `status=${bindResp.status}`);
check("bind status=bound", bindBody.status === "bound", JSON.stringify(bindBody));
check("bind cdi matches", bindBody.cdi === cdi, `expected ${cdi}, got ${bindBody.cdi}`);

// Step 5: SDK pollBinding
console.log("\n=== Step 5: SDK pollBinding ===");
const poll = await client.pollBinding();
check("poll returned result", Boolean(poll), "undefined");
check("poll status=bound", poll?.status === "bound", poll?.status);
check("poll has cuk", Boolean(poll?.cuk), "no cuk");
check("poll has user_id", Boolean(poll?.user_id), "no user_id");

// Step 6: SDK connect
console.log("\n=== Step 6: SDK connect ===");
const connectResult = await client.connect();
check("connect kind=Connected", connectResult.kind === "Connected", connectResult.kind);
if (connectResult.kind === "Connected") {
  const session = connectResult.client;
  check("has accessToken", Boolean(session.accessToken()), "no token");

  const identity = await client.deviceIdentity();
  check("identity has cdi", identity.cdi === cdi, identity.cdi);
  check("identity has user_id", Boolean(identity.user_id), "no user_id");

  await session.shutdown();
  check("shutdown clean", true);
}

// Summary
console.log(`\n========== SUMMARY ==========`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`==============================`);
process.exit(failed > 0 ? 1 : 0);
