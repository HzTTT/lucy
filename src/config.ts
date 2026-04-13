import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { LucyImConfig } from "lucy-im-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_HOME_DIR,
  DEFAULT_LOCAL_NOTIFY_BIND,
  DEFAULT_LOCAL_NOTIFY_PATH,
  DEFAULT_LOCAL_NOTIFY_PORT,
  DEFAULT_MEDIA_MAX_MB,
  DEFAULT_SUBJECT_PREFIX,
  SUBJECT_TOKEN_RE,
  type LucyConfig,
  type ResolvedLucyAccount,
} from "./types.js";

function resolveLucyConfig(cfg: OpenClawConfig): LucyConfig {
  const section = cfg.channels?.lucy;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return {};
  }
  return section as LucyConfig;
}

function normalizeLocalNotifyPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "/") {
    return trimmed;
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

export function isValidLocalNotifyPort(value: number | undefined): boolean {
  return Number.isInteger(value) && value! > 0 && value! <= 65_535;
}

export function isValidLocalNotifyPath(value: string | undefined): boolean {
  const normalized = normalizeLocalNotifyPath(value);
  return Boolean(normalized && normalized.startsWith("/"));
}

function resolveLucyLocalNotify(raw: LucyConfig): ResolvedLucyAccount["localNotify"] {
  const section = raw.localNotify;
  if (!section || typeof section !== "object" || Array.isArray(section) || section.enabled === false) {
    return undefined;
  }

  return {
    enabled: true,
    bind: section.bind?.trim() || DEFAULT_LOCAL_NOTIFY_BIND,
    port: section.port ?? DEFAULT_LOCAL_NOTIFY_PORT,
    path: normalizeLocalNotifyPath(section.path) ?? DEFAULT_LOCAL_NOTIFY_PATH,
  };
}

export function isValidSubjectToken(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  return SUBJECT_TOKEN_RE.test(trimmed);
}

export function listLucyAccountIds(_cfg: OpenClawConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveLucyAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedLucyAccount {
  const raw = resolveLucyConfig(cfg);
  const localNotify = resolveLucyLocalNotify(raw);
  const userCenterDomain = raw.userCenterDomain?.trim() || "";
  const lucyServerDomain = raw.lucyServerDomain?.trim() || "";
  const homeDir = raw.homeDir?.trim() || DEFAULT_HOME_DIR;
  const kind = raw.kind ?? "lucy";
  const subjectPrefix = raw.subjectPrefix?.trim() || DEFAULT_SUBJECT_PREFIX;
  const mediaMaxMb = raw.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaLocalRoots = raw.mediaLocalRoots?.map((entry) => entry.trim()).filter(Boolean);
  const restartHelperCommand = raw.restartHelperCommand?.trim() || undefined;
  const restartHelperArgs = raw.restartHelperArgs?.map((entry) => entry.trim()).filter(Boolean);
  const restartOnlineTimeoutMs = raw.restartOnlineTimeoutMs;
  const allowFrom = raw.allowFrom?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  const pairingSocket = raw.pairingSocket?.trim() || undefined;

  const configured =
    Boolean(userCenterDomain) &&
    Boolean(lucyServerDomain) &&
    (!localNotify ||
      (Boolean(localNotify.bind.trim()) &&
        isValidLocalNotifyPort(localNotify.port) &&
        isValidLocalNotifyPath(localNotify.path)));

  return {
    accountId: accountId?.trim() || DEFAULT_ACCOUNT_ID,
    enabled: raw.enabled !== false,
    configured,
    name: raw.name?.trim() || undefined,
    userCenterDomain,
    lucyServerDomain,
    homeDir,
    kind,
    subjectPrefix,
    dmPolicy: raw.dmPolicy ?? "allowlist",
    allowFrom,
    mediaMaxBytes: Math.floor(mediaMaxMb * 1024 * 1024),
    mediaLocalRoots,
    localNotify,
    restartHelperCommand,
    restartHelperArgs,
    restartOnlineTimeoutMs,
    pairingSocket,
  };
}

export function unconfiguredLucyReason(account: ResolvedLucyAccount): string {
  if (!account.userCenterDomain) {
    return "userCenterDomain is required";
  }
  if (!account.lucyServerDomain) {
    return "lucyServerDomain is required";
  }
  if (account.localNotify && !account.localNotify.bind.trim()) {
    return "localNotify.bind is required when localNotify is enabled";
  }
  if (account.localNotify && !isValidLocalNotifyPort(account.localNotify.port)) {
    return "localNotify.port must be an integer between 1 and 65535";
  }
  if (account.localNotify && !isValidLocalNotifyPath(account.localNotify.path)) {
    return "localNotify.path must start with /";
  }
  return "not configured";
}

export function buildLucyImConfig(account: ResolvedLucyAccount): LucyImConfig {
  return new LucyImConfig({
    homeDir: account.homeDir,
    userCenterDomain: account.userCenterDomain,
    lucyServerDomain: account.lucyServerDomain,
    kind: account.kind,
  });
}
