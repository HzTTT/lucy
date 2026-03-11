import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { connectLucyNatsWithOptions } from "../src/nats.js";

type Args = {
  apiKey?: string;
  deviceId?: string;
  server: string;
  subjectPrefix: string;
  token?: string;
  text?: string;
  waitMs: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    server: "nats://127.0.0.1:4222",
    subjectPrefix: "cephalon.im.npc",
    waitMs: 15_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--api-key") {
      args.apiKey = value;
      i += 1;
    } else if (token === "--device-id") {
      args.deviceId = value;
      i += 1;
    } else if (token === "--server") {
      args.server = value ?? args.server;
      i += 1;
    } else if (token === "--subject-prefix") {
      args.subjectPrefix = value ?? args.subjectPrefix;
      i += 1;
    } else if (token === "--token") {
      args.token = value ?? args.token;
      i += 1;
    } else if (token === "--text") {
      args.text = value;
      i += 1;
    } else if (token === "--wait-ms") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.waitMs = parsed;
      }
      i += 1;
    }
  }
  return args;
}

function requireArg(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function buildSubjects(params: { subjectPrefix: string; apiKey: string; deviceId: string }) {
  const prefix = params.subjectPrefix.trim();
  return {
    clientSubject: `${prefix}.${params.apiKey}.${params.deviceId}.client`,
    machineSubject: `${prefix}.${params.apiKey}.${params.deviceId}.machine`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = requireArg(args.apiKey, "--api-key");
  const deviceId = requireArg(args.deviceId, "--device-id");
  const nc = await connectLucyNatsWithOptions({
    servers: [args.server],
    name: `lucy-demo-${apiKey}`,
    token: args.token,
    timeout: 5_000,
  });
  const subjects = buildSubjects({
    subjectPrefix: args.subjectPrefix,
    apiKey,
    deviceId,
  });
  const sub = nc.subscribe(subjects.machineSubject);
  void (async () => {
    for await (const msg of sub) {
      console.log(`[machine] ${msg.string()}`);
    }
  })();

  const publishOnce = async (text: string) => {
    nc.publish(
      subjects.clientSubject,
      JSON.stringify({
        version: 1,
        text,
      }),
    );
    await nc.flush();
  };

  if (args.text?.trim()) {
    await publishOnce(args.text.trim());
    setTimeout(() => {
      void nc.close();
    }, args.waitMs);
    return;
  }

  const rl = createInterface({ input, output });
  console.log(`Connected. Publishing to ${subjects.clientSubject}`);
  console.log(`Listening on ${subjects.machineSubject}`);
  if (args.token) {
    console.log("Using token authentication");
  }
  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) {
        continue;
      }
      if (line === "/quit" || line === "/exit") {
        break;
      }
      await publishOnce(line);
    }
  } finally {
    rl.close();
    await nc.close();
  }
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
