/**
 * Lucy E2E Test 03: 媒体传输
 *
 * 测试:
 *   1. Iroh Blob 往返 (blobPut → blobFetch)
 *   2. App 发图片给 NPC (inbound media)
 *   3. NPC 发图片给 App (outbound media via gateway message tool)
 *
 * 前置: 已完成绑定, gateway 正在运行, mediaLocalRoots 包含 /tmp
 * 运行: node test/e2e/03-media.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { blobPut, blobFetch } from "lucy-im-sdk";

// ── 配置 ──
const UC = "https://test.unicorn.org.cn/cephalon/user-center";
const LS = "https://test.unicorn.org.cn/aiden/lucy-server";
const PHONE = "18888888888";
const PWD = "cephalon.boss";
const TEST_IMAGE = "/tmp/test-image.png";

const home = (process.env.HOME || "/home/cephalon") + "/data/lucy_im";
const cdi = (await fs.readFile(path.join(home, "channel_ids/cdi"), "utf8")).trim();
const userId = (await fs.readFile(path.join(home, "channel_ids/user_id"), "utf8")).trim();

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.error(`  ❌ ${label}: ${detail || ""}`); }
}

// ── 确保测试图片存在 ──
let testImageData;
try {
  testImageData = await fs.readFile(TEST_IMAGE);
} catch {
  // 创建一个 1x1 红色 PNG 作为测试图片
  testImageData = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  );
  await fs.writeFile(TEST_IMAGE, testImageData);
  console.log("Created test image:", TEST_IMAGE, testImageData.length, "bytes");
}

// ═══════════════════════════════════════
// Test 1: Iroh Blob 往返
// ═══════════════════════════════════════
console.log("\n=== Test 1: Iroh Blob 往返 ===");
const blobSession = blobPut(new Uint8Array(testImageData), "test.png");
check("blobPut returns blobRef", Boolean(blobSession.blobRef), "no blobRef");
check("blobPut returns fileHash", Boolean(blobSession.fileHash), "no fileHash");

try {
  const fetched = await blobFetch(blobSession.blobRef);
  check("blobFetch returns data", fetched.length > 0, `${fetched.length} bytes`);
  check("data matches original", Buffer.from(fetched).equals(testImageData), `${fetched.length} vs ${testImageData.length}`);
} catch (e) {
  check("blobFetch succeeds", false, e.message);
}
blobSession.close();

// ═══════════════════════════════════════
// 连接 NATS
// ═══════════════════════════════════════
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
console.log("NATS connected\n");

// 发消息 + 按 sourceMessageId 收集事件。每次调用生成唯一 messageId 避免历史响
// 应被误认为当前消息的回复。
let msgIdCounter = 0;
function freshMessageId() {
  return `23${Date.now()}${String(msgIdCounter++ % 10000).padStart(4, "0")}`;
}

async function sendAndCollect(buildPayload, timeoutMs = 180000) {
  const messageId = freshMessageId();
  const events = [];
  const sub = nc.subscribe(userSub);
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const timer = setTimeout(() => { sub.unsubscribe(); resolve(); }, timeoutMs);
  (async () => {
    for await (const msg of sub) {
      try {
        const evt = JSON.parse(Buffer.from(msg.data).toString("utf8"));
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
  // Let the SUB protocol flush before publishing to avoid a race between
  // subscription registration and fast gateway machine events.
  await nc.flush();
  await new Promise(r => setTimeout(r, 200));

  const payload = { version: 2, messageId, timestamp: Date.now(), ...buildPayload(messageId) };
  await js.publish(npcSub, enc.encode(JSON.stringify(payload)));
  await done;
  return events;
}

// ═══════════════════════════════════════
// Test 2: App 发图片给 NPC (inbound)
// ═══════════════════════════════════════
console.log("=== Test 2: App 发图片给 NPC ===");
const inboundBlob = blobPut(new Uint8Array(testImageData), "photo.png");
console.log("  Sending image message, waiting...");
const t2Events = await sendAndCollect(() => ({
  text: "Describe this image briefly in one sentence.",
  media: {
    transport: "iroh-blob",
    blob_ref: inboundBlob.blobRef,
    kind: "image",
    contentType: "image/png",
    size: testImageData.length,
    fileName: "photo.png",
  },
}));
inboundBlob.close();

const t2Final = t2Events.find(e => e.type === "assistant.final");
const t2Error = t2Events.find(e => e.type === "error");
check("got inbound.accepted", t2Events.some(e => e.type === "inbound.accepted"));
check("no error", !t2Error, t2Error?.text?.slice(0, 80));
check("got assistant.final", Boolean(t2Final));
check("response has text", t2Final?.text?.length > 5, t2Final?.text?.slice(0, 80));

// ═══════════════════════════════════════
// Test 3: NPC 发图片给 App (outbound)
// ═══════════════════════════════════════
console.log("\n=== Test 3: NPC 发图片给 App ===");
console.log("  Asking agent to send image, waiting...");
const t3Events = await sendAndCollect(() => ({
  text: `Use the message tool to send me the file at ${TEST_IMAGE} as a media attachment. The target is lucy:${userId}`,
}));

const t3Final = t3Events.find(e => e.type === "assistant.final" && e.media);
const t3AnyFinal = t3Events.find(e => e.type === "assistant.final");
const t3Error = t3Events.find(e => e.type === "error");
check("no error", !t3Error, t3Error?.text?.slice(0, 80));
check("got assistant.final with media", Boolean(t3Final), t3AnyFinal?.text?.slice(0, 50));

if (t3Final?.media) {
  const media = t3Final.media;
  check("media transport is iroh-blob", media.transport === "iroh-blob", media.transport);
  check("media has blob_ref", Boolean(media.blob_ref));
  check("media kind is image", media.kind === "image", media.kind);
  check("media size > 0", media.size > 0, String(media.size));

  // Fetch the blob
  console.log("  Fetching blob from NPC...");
  try {
    const fetched = await blobFetch(media.blob_ref);
    check("blobFetch succeeds", fetched.length > 0, `${fetched.length} bytes`);
    check("size matches descriptor", fetched.length === media.size, `${fetched.length} vs ${media.size}`);
    const originalImage = await fs.readFile(TEST_IMAGE);
    check("content matches original", Buffer.from(fetched).equals(originalImage));
  } catch (e) {
    check("blobFetch succeeds", false, e.message);
  }
}

// ── Summary ──
await nc.close();
console.log(`\n========== SUMMARY ==========`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`==============================`);
process.exit(failed > 0 ? 1 : 0);
