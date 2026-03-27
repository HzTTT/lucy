// Local helpers for exec approval display and metadata extraction.
// Copied from openclaw core for compatibility with older openclaw versions.

import type { ReplyPayload } from "openclaw/plugin-sdk";

export type ExecApprovalReplyDecision = "allow-once" | "allow-always" | "deny";

export type ExecApprovalReplyMetadata = {
  approvalId: string;
  approvalSlug: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
};

export type ExecApprovalPendingReplyParams = {
  warningText?: string;
  approvalId: string;
  approvalSlug: string;
  approvalCommandId?: string;
  command: string;
  cwd?: string;
  host: string;
  nodeId?: string;
  expiresAtMs?: number;
  nowMs?: number;
};

export type ExecApprovalRequestPayload = {
  command?: string;
  commandPreview?: string | null;
  host?: string | null;
  systemRunPlan?: {
    commandText?: string;
    commandPreview?: string | null;
  } | null;
};

// Escape invisible characters that can spoof approval prompts in common UIs.
const EXEC_APPROVAL_INVISIBLE_CHAR_REGEX = /[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu;

function formatCodePointEscape(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}

function sanitizeExecApprovalDisplayText(commandText: string): string {
  return commandText.replace(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX, formatCodePointEscape);
}

function normalizePreview(commandText: string, commandPreview?: string | null): string | null {
  const previewRaw = commandPreview?.trim() ?? "";
  if (!previewRaw) {
    return null;
  }
  const preview = sanitizeExecApprovalDisplayText(previewRaw);
  if (preview === commandText) {
    return null;
  }
  return preview;
}

export function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
  commandText: string;
  commandPreview: string | null;
} {
  const commandTextSource =
    request.command ||
    (request.host === "node" && request.systemRunPlan ? request.systemRunPlan.commandText : "");
  const commandText = sanitizeExecApprovalDisplayText(commandTextSource || "");
  const previewSource =
    request.commandPreview ??
    (request.host === "node" ? (request.systemRunPlan?.commandPreview ?? null) : null);
  return {
    commandText,
    commandPreview: normalizePreview(commandText, previewSource),
  };
}

export function getExecApprovalReplyMetadata(
  payload: ReplyPayload,
): ExecApprovalReplyMetadata | null {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return null;
  }
  const execApproval = channelData.execApproval;
  if (!execApproval || typeof execApproval !== "object" || Array.isArray(execApproval)) {
    return null;
  }
  const record = execApproval as Record<string, unknown>;
  const approvalId = typeof record.approvalId === "string" ? record.approvalId.trim() : "";
  const approvalSlug = typeof record.approvalSlug === "string" ? record.approvalSlug.trim() : "";
  if (!approvalId || !approvalSlug) {
    return null;
  }
  const allowedDecisions = Array.isArray(record.allowedDecisions)
    ? record.allowedDecisions.filter(
        (value): value is ExecApprovalReplyDecision =>
          value === "allow-once" || value === "allow-always" || value === "deny",
      )
    : undefined;
  return {
    approvalId,
    approvalSlug,
    allowedDecisions,
  };
}

function buildFence(text: string, language?: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  const languagePrefix = language ? language : "";
  return `${fence}${languagePrefix}\n${text}\n${fence}`;
}

export function buildExecApprovalPendingReplyPayload(
  params: ExecApprovalPendingReplyParams,
): ReplyPayload {
  const approvalCommandId = params.approvalCommandId?.trim() || params.approvalSlug;
  const lines: string[] = [];
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText);
  }
  lines.push("Approval required.");
  lines.push("Run:");
  lines.push(buildFence(`/approve ${approvalCommandId} allow-once`, "txt"));
  lines.push("Pending command:");
  lines.push(buildFence(params.command, "sh"));
  lines.push("Other options:");
  lines.push(
    buildFence(
      `/approve ${approvalCommandId} allow-always\n/approve ${approvalCommandId} deny`,
      "txt",
    ),
  );
  const info: string[] = [];
  info.push(`Host: ${params.host}`);
  if (params.nodeId) {
    info.push(`Node: ${params.nodeId}`);
  }
  if (params.cwd) {
    info.push(`CWD: ${params.cwd}`);
  }
  if (typeof params.expiresAtMs === "number" && Number.isFinite(params.expiresAtMs)) {
    const expiresInSec = Math.max(
      0,
      Math.round((params.expiresAtMs - (params.nowMs ?? Date.now())) / 1000),
    );
    info.push(`Expires in: ${expiresInSec}s`);
  }
  info.push(`Full id: \`${params.approvalId}\``);
  lines.push(info.join("\n"));

  return {
    text: lines.join("\n\n"),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    },
  };
}
