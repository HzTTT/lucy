import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MEDIA_BUCKET,
  DEFAULT_MEDIA_MAX_MB,
  DEFAULT_MEDIA_RETENTION_HOURS,
  DEFAULT_NATS_SERVER,
  DEFAULT_SUBJECT_PREFIX,
  OBJECT_STORE_BUCKET_RE,
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

export function isValidObjectStoreBucket(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  return OBJECT_STORE_BUCKET_RE.test(trimmed);
}

export function listLucyAccountIds(_cfg: OpenClawConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveLucyAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedLucyAccount {
  const raw = resolveLucyConfig(cfg);
  const channelUserKey = raw.channelUserKey?.trim() || raw.apiKey?.trim() || undefined;
  const channelDeviceId = raw.channelDeviceId?.trim() || undefined;
  const bootstrapToken = raw.bootstrapToken?.trim() || undefined;
  const servers = raw.servers?.map((server) => server.trim()).filter(Boolean) ?? [
    DEFAULT_NATS_SERVER,
  ];
  const subjectPrefix = raw.subjectPrefix?.trim() || DEFAULT_SUBJECT_PREFIX;
  const mediaBucket = raw.mediaBucket?.trim() || DEFAULT_MEDIA_BUCKET;
  const mediaRetentionHours = raw.mediaRetentionHours ?? DEFAULT_MEDIA_RETENTION_HOURS;
  const mediaMaxMb = raw.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaLocalRoots = raw.mediaLocalRoots?.map((entry) => entry.trim()).filter(Boolean);
  const restartHelperCommand = raw.restartHelperCommand?.trim() || undefined;
  const restartHelperArgs = raw.restartHelperArgs?.map((entry) => entry.trim()).filter(Boolean);
  const restartOnlineTimeoutMs = raw.restartOnlineTimeoutMs;
  const allowFrom =
    raw.allowFrom?.map((entry) => entry.trim()).filter(Boolean) ??
    (channelUserKey ? [channelUserKey] : []);
  const configured =
    (!channelUserKey || isValidSubjectToken(channelUserKey)) &&
    (!channelDeviceId || /^\d{19}$/.test(channelDeviceId)) &&
    isValidObjectStoreBucket(mediaBucket) &&
    Boolean(subjectPrefix.trim()) &&
    servers.length > 0 &&
    Number.isFinite(mediaRetentionHours) &&
    mediaRetentionHours > 0 &&
    Number.isFinite(mediaMaxMb) &&
    mediaMaxMb > 0;

  return {
    accountId: accountId?.trim() || DEFAULT_ACCOUNT_ID,
    enabled: raw.enabled !== false,
    configured,
    name: raw.name?.trim() || undefined,
    servers,
    channelUserKey,
    channelDeviceId,
    bootstrapToken,
    subjectPrefix,
    token: raw.token?.trim() || undefined,
    username: raw.username?.trim() || undefined,
    password: raw.password?.trim() || undefined,
    dmPolicy: raw.dmPolicy ?? "allowlist",
    allowFrom,
    mediaBucket,
    mediaRetentionHours,
    mediaMaxBytes: Math.floor(mediaMaxMb * 1024 * 1024),
    mediaLocalRoots,
    restartHelperCommand,
    restartHelperArgs,
    restartOnlineTimeoutMs,
  };
}

export function unconfiguredLucyReason(account: ResolvedLucyAccount): string {
  if (account.channelUserKey && !isValidSubjectToken(account.channelUserKey)) {
    return "channelUserKey must match /^[A-Za-z0-9_-]+$/ for NATS subject tokens";
  }
  if (account.channelDeviceId && !/^\d{19}$/.test(account.channelDeviceId)) {
    return "channelDeviceId must be a 19-digit snowflake";
  }
  if (!account.subjectPrefix.trim()) {
    return "subjectPrefix is required";
  }
  if (!isValidObjectStoreBucket(account.mediaBucket)) {
    return "mediaBucket must match /^[-\\w]+$/ for JetStream Object Store";
  }
  if (!Number.isFinite(account.mediaRetentionHours) || account.mediaRetentionHours <= 0) {
    return "mediaRetentionHours must be a positive integer";
  }
  if (!Number.isFinite(account.mediaMaxBytes) || account.mediaMaxBytes <= 0) {
    return "mediaMaxMb must be greater than 0";
  }
  if (account.servers.length === 0) {
    return "at least one NATS server is required";
  }
  return "not configured";
}
