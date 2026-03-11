import fs from "node:fs/promises";
import { connect, JSONCodec } from "nats";

const DEFAULT_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ?? "/home/node/.openclaw/openclaw.json";
const DEFAULT_DEVICE_STATE_PATH =
  process.env.LUCY_DEVICE_STATE_PATH ?? "/home/node/.openclaw/lucy/device-state.json";
const DEFAULT_OUTPUT_PATH =
  process.env.LUCY_PROBE_OUTPUT_PATH ?? "/tmp/lucy-raw-probe-results.json";

const jc = JSONCodec();
let idCounter = 0;

function nextId() {
  const ms = String(Date.now());
  const suffix = String(idCounter++ % 1_000_000).padStart(6, "0");
  return `${ms}${suffix}`;
}

function countByType(events) {
  return events.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] ?? 0) + 1;
    return acc;
  }, {});
}

async function loadRuntime() {
  const [configRaw, deviceRaw] = await Promise.all([
    fs.readFile(DEFAULT_CONFIG_PATH, "utf8"),
    fs.readFile(DEFAULT_DEVICE_STATE_PATH, "utf8"),
  ]);
  const config = JSON.parse(configRaw);
  const deviceState = JSON.parse(deviceRaw);
  const lucy = config.channels?.lucy ?? {};
  const apiKey = lucy.apiKey;
  const deviceId = deviceState.deviceId;
  const subjectPrefix = lucy.subjectPrefix ?? "cephalon.im.npc";

  if (!apiKey || !deviceId) {
    throw new Error("lucy apiKey/deviceId missing from runtime config");
  }

  const clientSubject = `${subjectPrefix}.${apiKey}.${deviceId}.client`;
  const machineSubject = `${subjectPrefix}.${apiKey}.${deviceId}.machine`;
  const connectOptions = {
    servers: lucy.servers ?? ["nats://127.0.0.1:4222"],
  };
  if (lucy.token) {
    connectOptions.token = lucy.token;
  } else {
    if (lucy.username) connectOptions.user = lucy.username;
    if (lucy.password) connectOptions.pass = lucy.password;
  }

  return {
    apiKey,
    deviceId,
    subjectPrefix,
    clientSubject,
    machineSubject,
    connectOptions,
  };
}

async function runCase(nc, runtime, testCase) {
  const sourceMessageId = nextId();
  const payload = {
    version: 1,
    messageId: sourceMessageId,
    text: testCase.prompt,
    timestamp: Date.now(),
    ...testCase.payloadOverride,
  };

  const events = [];
  const startedAt = Date.now();
  const idleMs = testCase.idleMs ?? 1500;
  const timeoutMs = testCase.timeoutMs ?? 25000;

  return await new Promise((resolve) => {
    let done = false;
    let idleTimer;
    let timeoutTimer;

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(timeoutTimer);
      sub.unsubscribe();
      resolve({
        id: testCase.id,
        label: testCase.label,
        prompt: testCase.prompt,
        payload,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        stopReason: reason,
        events,
        counts: countByType(events),
      });
    };

    const sub = nc.subscribe(runtime.machineSubject, {
      callback: (_err, msg) => {
        let event;
        try {
          event = jc.decode(msg.data);
        } catch {
          return;
        }
        if (event?.sourceMessageId !== sourceMessageId) {
          return;
        }

        events.push(event);
        const terminal = event.type === "assistant.final" || event.type === "error";
        if (terminal) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finish("idle_after_terminal"), idleMs);
        }
      },
    });

    timeoutTimer = setTimeout(() => finish("timeout"), timeoutMs);

    nc.publish(runtime.clientSubject, jc.encode(payload));
    void nc.flush();
  });
}

async function main() {
  const runtime = await loadRuntime();
  const toolReadPath =
    process.env.LUCY_TOOL_READ_PATH ?? "/home/node/.openclaw/workspace/lucy-tool-read.txt";
  const toolExecPath =
    process.env.LUCY_TOOL_EXEC_PATH ?? "/home/node/.openclaw/workspace/lucy-tool-exec.txt";

  const cases = [
    {
      id: "plain_short_no_tools",
      label: "Plain short reply, no tools",
      prompt: "Reply with exactly PLAIN_OK. Do not use any tool. Do not add anything else.",
      timeoutMs: 15000,
    },
    {
      id: "reasoning_no_tools",
      label: "Reasoning-leaning prompt, no tools",
      prompt:
        "Think carefully first, then reply with exactly REASONING_OK. Do not use any tool. Do not add anything else.",
      timeoutMs: 20000,
    },
    {
      id: "read_tool",
      label: "Read tool exact output",
      prompt: `Use the read tool on ${toolReadPath} and reply with exactly the two nonce values separated by one space. Do not add anything else.`,
      timeoutMs: 25000,
    },
    {
      id: "exec_then_read",
      label: "Exec then read chain",
      prompt: `Use the exec tool to run: printf docker-exec-probe > ${toolExecPath}. Then use the read tool on ${toolExecPath} and reply with exactly docker-exec-probe.`,
      timeoutMs: 25000,
    },
    {
      id: "long_streaming",
      label: "Long streaming answer",
      prompt:
        "Do not use tools. Explain the JavaScript event loop in 12 numbered bullets, in English, with at least 1200 total characters so streaming and block flushing are visible.",
      timeoutMs: 30000,
      idleMs: 2000,
    },
    {
      id: "api_key_mismatch_error",
      label: "Payload apiKey mismatch error",
      prompt: "This should fail because payload apiKey mismatches the subject namespace.",
      payloadOverride: {
        apiKey: "wrong_namespace",
      },
      timeoutMs: 8000,
      idleMs: 1000,
    },
  ];

  const nc = await connect(runtime.connectOptions);
  try {
    const results = [];
    for (const testCase of cases) {
      const result = await runCase(nc, runtime, testCase);
      results.push(result);
    }

    const output = {
      generatedAt: new Date().toISOString(),
      runtime,
      cases: results,
    };

    await fs.writeFile(DEFAULT_OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

    for (const result of results) {
      console.log(
        `${result.id}: events=${result.events.length} stop=${result.stopReason} counts=${JSON.stringify(result.counts)}`,
      );
    }
    console.log(`wrote ${DEFAULT_OUTPUT_PATH}`);
  } finally {
    await nc.close();
  }
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exitCode = 1;
});
