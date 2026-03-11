#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_SUBJECT_PREFIX = "cephalon.im.npc";
const DEFAULT_MEDIA_BUCKET = "lucy_media_v2";
const DEFAULT_MEDIA_RETENTION_HOURS = 168;
const DEFAULT_STATE_DIRNAME = ".openclaw";
const LEGACY_STATE_DIRNAMES = [".clawdbot", ".moldbot", ".moltbot"];
const CONFIG_FILENAMES = ["openclaw.json", "clawdbot.json", "moldbot.json", "moltbot.json"];

function printHelp() {
  console.log(`Lucy probe field helper

Usage:
  node scripts/print-probe-fields.mjs [--config <path>] [--state <path>] [--show-paths]

Output fields:
  deviceId
  clientSubject
  machineSubject
  mediaBucket
  mediaRetentionHours

Environment:
  OPENCLAW_CONFIG_PATH
  OPENCLAW_STATE_DIR
  OPENCLAW_HOME
  LUCY_DEVICE_STATE_PATH
`);
}

function parseArgs(argv) {
  const args = {
    showPaths: false,
    help: false,
    configPath: undefined,
    deviceStatePath: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--show-paths") {
      args.showPaths = true;
      continue;
    }
    if (token === "--config") {
      if (!value) {
        throw new Error("--config requires a path");
      }
      args.configPath = value;
      i += 1;
      continue;
    }
    if (token === "--state") {
      if (!value) {
        throw new Error("--state requires a path");
      }
      args.deviceStatePath = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function resolveHomeDir(env = process.env) {
  const raw = env.OPENCLAW_HOME?.trim() || os.homedir();
  if (!raw) {
    throw new Error("Unable to resolve HOME/OPENCLAW_HOME");
  }
  return path.resolve(raw);
}

function resolveUserPath(input, env = process.env) {
  const trimmed = input?.trim();
  if (!trimmed) {
    throw new Error("Path must not be empty");
  }
  if (trimmed === "~") {
    return resolveHomeDir(env);
  }
  if (trimmed.startsWith("~/")) {
    return path.join(resolveHomeDir(env), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function pathExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveStateDir(env = process.env) {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }

  const homeDir = resolveHomeDir(env);
  const candidates = [
    path.join(homeDir, DEFAULT_STATE_DIRNAME),
    ...LEGACY_STATE_DIRNAMES.map((name) => path.join(homeDir, name)),
  ];

  return candidates.find((candidate) => pathExists(candidate)) ?? candidates[0];
}

function resolveConfigPath(args, env = process.env) {
  if (args.configPath) {
    return resolveUserPath(args.configPath, env);
  }

  const override = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }

  const stateDir = resolveStateDir(env);
  const candidates = CONFIG_FILENAMES.map((name) => path.join(stateDir, name));
  return candidates.find((candidate) => pathExists(candidate)) ?? candidates[0];
}

function resolveDeviceStatePath(args, env = process.env) {
  if (args.deviceStatePath) {
    return resolveUserPath(args.deviceStatePath, env);
  }

  const override = env.LUCY_DEVICE_STATE_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }

  return path.join(resolveStateDir(env), "lucy", "device-state.json");
}

let json5ModulePromise;

async function loadJson5Module() {
  json5ModulePromise ??= import("json5")
    .then((module) => module.default ?? module)
    .catch(() => null);
  return await json5ModulePromise;
}

async function parseJsonLike(raw, label) {
  const json5 = await loadJson5Module();
  if (json5?.parse) {
    return json5.parse(raw);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${String(err)}`);
  }
}

async function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(`Unable to read ${label} at ${filePath}: ${String(err)}`);
  }
  try {
    return await parseJsonLike(raw, label);
  } catch (err) {
    throw new Error(`Unable to parse ${label} at ${filePath}: ${String(err)}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing or empty`);
  }
  return value.trim();
}

function readPositiveInteger(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const configPath = resolveConfigPath(args);
  const deviceStatePath = resolveDeviceStatePath(args);
  const config = await readJsonFile(configPath, "Lucy config");
  const deviceState = await readJsonFile(deviceStatePath, "Lucy device state");
  const lucy = config?.channels?.lucy ?? {};

  const apiKey = requireNonEmptyString(lucy.apiKey, "channels.lucy.apiKey");
  const deviceId = requireNonEmptyString(deviceState?.deviceId, "lucy.deviceId");
  const subjectPrefix =
    typeof lucy.subjectPrefix === "string" && lucy.subjectPrefix.trim()
      ? lucy.subjectPrefix.trim()
      : DEFAULT_SUBJECT_PREFIX;
  const mediaBucket =
    typeof lucy.mediaBucket === "string" && lucy.mediaBucket.trim()
      ? lucy.mediaBucket.trim()
      : DEFAULT_MEDIA_BUCKET;
  const mediaRetentionHours = readPositiveInteger(
    lucy.mediaRetentionHours,
    DEFAULT_MEDIA_RETENTION_HOURS,
  );

  const result = {
    deviceId,
    clientSubject: `${subjectPrefix}.${apiKey}.${deviceId}.client`,
    machineSubject: `${subjectPrefix}.${apiKey}.${deviceId}.machine`,
    mediaBucket,
    mediaRetentionHours,
    ...(args.showPaths
      ? {
          _paths: {
            configPath,
            deviceStatePath,
          },
        }
      : {}),
  };

  console.log(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
});
