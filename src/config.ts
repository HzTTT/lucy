import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_NATS_SERVER,
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
  const apiKey = raw.apiKey?.trim() || undefined;
  const servers = raw.servers?.map((server) => server.trim()).filter(Boolean) ?? [
    DEFAULT_NATS_SERVER,
  ];
  const subjectPrefix = raw.subjectPrefix?.trim() || DEFAULT_SUBJECT_PREFIX;
  const allowFrom =
    raw.allowFrom?.map((entry) => entry.trim()).filter(Boolean) ?? (apiKey ? [apiKey] : []);
  const configured =
    Boolean(apiKey) &&
    isValidSubjectToken(apiKey) &&
    Boolean(subjectPrefix.trim()) &&
    servers.length > 0;

  return {
    accountId: accountId?.trim() || DEFAULT_ACCOUNT_ID,
    enabled: raw.enabled !== false,
    configured,
    name: raw.name?.trim() || undefined,
    servers,
    apiKey,
    subjectPrefix,
    token: raw.token?.trim() || undefined,
    username: raw.username?.trim() || undefined,
    password: raw.password?.trim() || undefined,
    dmPolicy: raw.dmPolicy ?? "allowlist",
    allowFrom,
  };
}

export function unconfiguredLucyReason(account: ResolvedLucyAccount): string {
  if (!account.apiKey) {
    return "apiKey is required";
  }
  if (!isValidSubjectToken(account.apiKey)) {
    return "apiKey must match /^[A-Za-z0-9_-]+$/ for NATS subject tokens";
  }
  if (!account.subjectPrefix.trim()) {
    return "subjectPrefix is required";
  }
  if (account.servers.length === 0) {
    return "at least one NATS server is required";
  }
  return "not configured";
}
