import { z } from "zod";

// Max size of a single NDJSON frame on the pairing IPC socket. Includes the
// trailing newline. Anything larger is rejected both on encode and decode so
// neither side can be forced to buffer unbounded input.
export const PAIRING_IPC_MAX_FRAME_BYTES = 4096;

const RequestIdSchema = z.string().min(1).max(128);
const OtpSchema = z.string().min(1).max(16);
const ErrorMessageSchema = z.string().min(1).max(512);

export const PairingIpcBindRequestSchema = z.object({
  type: z.literal("bind.request"),
  request_id: RequestIdSchema,
  requested_at_ms: z.number().int().nonnegative(),
});

export const PairingIpcOtpIssuedSchema = z.object({
  type: z.literal("otp.issued"),
  request_id: RequestIdSchema,
  otp: OtpSchema,
  expires_at_ms: z.number().int().positive(),
});

export const PairingIpcOtpErrorSchema = z.object({
  type: z.literal("otp.error"),
  request_id: RequestIdSchema,
  error: ErrorMessageSchema,
});

export const PairingIpcBindCompletedSchema = z.object({
  type: z.literal("bind.completed"),
  cuk: z.string().min(1).max(256),
  user_id: z.string().min(1).max(256),
});

export const PairingIpcBindClearedSchema = z.object({
  type: z.literal("bind.cleared"),
});

export const PairingIpcPingSchema = z.object({
  type: z.literal("ping"),
});

export const PairingIpcPongSchema = z.object({
  type: z.literal("pong"),
});

export const PairingIpcMessageSchema = z.discriminatedUnion("type", [
  PairingIpcBindRequestSchema,
  PairingIpcOtpIssuedSchema,
  PairingIpcOtpErrorSchema,
  PairingIpcBindCompletedSchema,
  PairingIpcBindClearedSchema,
  PairingIpcPingSchema,
  PairingIpcPongSchema,
]);

export type PairingIpcBindRequest = z.infer<typeof PairingIpcBindRequestSchema>;
export type PairingIpcOtpIssued = z.infer<typeof PairingIpcOtpIssuedSchema>;
export type PairingIpcOtpError = z.infer<typeof PairingIpcOtpErrorSchema>;
export type PairingIpcBindCompleted = z.infer<typeof PairingIpcBindCompletedSchema>;
export type PairingIpcBindCleared = z.infer<typeof PairingIpcBindClearedSchema>;
export type PairingIpcPing = z.infer<typeof PairingIpcPingSchema>;
export type PairingIpcPong = z.infer<typeof PairingIpcPongSchema>;
export type PairingIpcMessage = z.infer<typeof PairingIpcMessageSchema>;

export type PairingIpcFrameErrorCode =
  | "frame_too_large"
  | "invalid_json"
  | "invalid_schema";

export class PairingIpcFrameError extends Error {
  readonly code: PairingIpcFrameErrorCode;
  constructor(code: PairingIpcFrameErrorCode, message: string) {
    super(message);
    this.name = "PairingIpcFrameError";
    this.code = code;
  }
}

export function encodePairingIpcMessage(msg: PairingIpcMessage): string {
  const json = JSON.stringify(msg);
  // +1 for the trailing newline that delimits the frame on the wire.
  const bytes = Buffer.byteLength(json, "utf8") + 1;
  if (bytes > PAIRING_IPC_MAX_FRAME_BYTES) {
    throw new PairingIpcFrameError(
      "frame_too_large",
      `encoded frame ${bytes} bytes exceeds max ${PAIRING_IPC_MAX_FRAME_BYTES} bytes`,
    );
  }
  return `${json}\n`;
}

export function decodePairingIpcLine(line: string): PairingIpcMessage {
  if (Buffer.byteLength(line, "utf8") > PAIRING_IPC_MAX_FRAME_BYTES) {
    throw new PairingIpcFrameError(
      "frame_too_large",
      `incoming frame exceeds max ${PAIRING_IPC_MAX_FRAME_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new PairingIpcFrameError(
      "invalid_json",
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = PairingIpcMessageSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join(".")}` : "";
    throw new PairingIpcFrameError(
      "invalid_schema",
      `schema validation failed${where}: ${first?.message ?? "unknown error"}`,
    );
  }
  return result.data;
}
