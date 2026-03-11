import { z } from "zod";

export const LUCY_CHANNEL_ID = "lucy";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_SUBJECT_PREFIX = "cephalon.im.npc";
export const DEFAULT_NATS_SERVER = "nats://127.0.0.1:4222";
export const DEVICE_STATE_VERSION = 1;
export const SUBJECT_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export const LucyDmPolicySchema = z.enum(["allowlist", "open", "disabled"]);

export const LucyConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  servers: z.array(z.string().min(1)).optional(),
  apiKey: z.string().min(1).optional(),
  subjectPrefix: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  dmPolicy: LucyDmPolicySchema.optional(),
  allowFrom: z.array(z.string().min(1)).optional(),
});

export type LucyConfig = z.infer<typeof LucyConfigSchema>;
export type LucyDmPolicy = z.infer<typeof LucyDmPolicySchema>;

export const LucyInboundMessageSchema = z.object({
  version: z.literal(1),
  messageId: z
    .string()
    .regex(/^\d{19}$/)
    .optional(),
  text: z.string(),
  timestamp: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  apiKey: z.string().optional(),
  deviceId: z
    .string()
    .regex(/^\d{19}$/)
    .optional(),
});

export type LucyInboundMessage = z.infer<typeof LucyInboundMessageSchema>;

export const LucyMachineEventTypeSchema = z.enum([
  "inbound.accepted",
  "assistant.start",
  "assistant.partial",
  "assistant.final",
  "reasoning.partial",
  "reasoning.final",
  "tool.start",
  "tool.end",
  "error",
]);

export type LucyMachineEventType = z.infer<typeof LucyMachineEventTypeSchema>;

export const LucyMachineEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().regex(/^\d{19}$/),
  type: LucyMachineEventTypeSchema,
  timestamp: z.number().int(),
  apiKey: z.string(),
  deviceId: z.string().regex(/^\d{19}$/),
  sourceMessageId: z
    .string()
    .regex(/^\d{19}$/)
    .optional(),
  runId: z.string().optional(),
  sessionKey: z.string().optional(),
  text: z.string().optional(),
  toolName: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type LucyMachineEvent = z.infer<typeof LucyMachineEventSchema>;

export type LucyDeviceState = {
  version: 1;
  deviceId: string;
  createdAtMs: number;
};

export type ResolvedLucyAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  servers: string[];
  apiKey?: string;
  subjectPrefix: string;
  token?: string;
  username?: string;
  password?: string;
  dmPolicy: LucyDmPolicy;
  allowFrom: string[];
};

export type LucySubjects = {
  clientSubject: string;
  machineSubject: string;
};

export type LucyProbe = {
  ok: true;
  connectedUrl: string | null;
  clientSubject: string;
  machineSubject: string;
  deviceId: string;
};
