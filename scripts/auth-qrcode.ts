import os from "node:os";
import path from "node:path";
import process from "node:process";
import qrcodeTerminal from "qrcode-terminal";
import { buildLucyAuthQrJson, buildLucyAuthQrPayload, buildLucyAuthQrUri } from "../src/auth-qrcode.js";
import { getLucyRuntime, setLucyRuntime } from "../src/runtime.js";
import { loadOrCreateLucyDeviceState } from "../src/state.js";

type Args = {
  json: boolean;
  noQr: boolean;
  stateDir?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    json: false,
    noQr: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--json") {
      args.json = true;
    } else if (token === "--no-qr") {
      args.noQr = true;
    } else if (token === "--state-dir") {
      args.stateDir = value?.trim() || undefined;
      i += 1;
    }
  }
  return args;
}

function resolveStateDir(env: NodeJS.ProcessEnv, override?: string): string {
  const explicit = override?.trim() || env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit.startsWith("~") ? path.join(os.homedir(), explicit.slice(1)) : explicit);
  }
  return path.join(os.homedir(), ".openclaw");
}

function ensureLucyRuntime(stateDir: string) {
  try {
    getLucyRuntime();
    return;
  } catch {
    setLucyRuntime({
      state: {
        resolveStateDir: () => stateDir,
      },
    } as never);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = resolveStateDir(process.env, args.stateDir);
  ensureLucyRuntime(stateDir);

  const state = await loadOrCreateLucyDeviceState();
  const payload = buildLucyAuthQrPayload(state.channelDeviceId);
  const uri = buildLucyAuthQrUri(state.channelDeviceId);
  const json = buildLucyAuthQrJson(state.channelDeviceId);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          stateDir,
          channel_device_id: payload.channel_device_id,
          bind_uri: uri,
          bind_payload: payload,
          bind_payload_json: JSON.parse(json),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`Lucy bind URI: ${uri}\n`);
  process.stdout.write(`channel_device_id: ${payload.channel_device_id}\n`);
  process.stdout.write(`bind payload JSON: ${json}\n`);
  process.stdout.write(`state dir: ${stateDir}\n`);

  if (!args.noQr) {
    process.stdout.write("\n");
    qrcodeTerminal.generate(uri, { small: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[lucy auth-qrcode] ${message}\n`);
  process.exitCode = 1;
});
