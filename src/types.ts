import { z } from "zod";

export const LUCY_CHANNEL_ID = "lucy";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_SUBJECT_PREFIX = "cephalon.im.npc";
export const DEFAULT_NATS_SERVER = "nats://127.0.0.1:4222";
export const DEFAULT_MEDIA_BUCKET = "lucy_media_v2";
export const DEFAULT_MEDIA_RETENTION_HOURS = 168;
export const DEFAULT_MEDIA_MAX_MB = 20;
export const DEVICE_STATE_VERSION = 2;
export const LUCY_USER_CENTER_BASE_URL = "https://prod.unicorn.org.cn/cephalon/user-center";
export const SUBJECT_TOKEN_RE = /^[A-Za-z0-9_-]+$/;
export const OBJECT_STORE_BUCKET_RE = /^[-\w]+$/;
export const OBJECT_STORE_KEY_RE = /^[-/=.\w]+$/;
export const LUCY_MEDIA_TRANSPORT = "jetstream-object-store";
export const LucyBindingStatusSchema = z.enum(["pending", "registered", "bound"]);

export const LucyMessageIdSchema = z.string().regex(/^\d{19}$/);
export const LucyMetadataSchema = z.record(z.string(), z.unknown());
export const LucyMediaKindSchema = z.enum(["image", "audio"]);

export const LucyMediaDescriptorSchema = z.object({
  transport: z.literal(LUCY_MEDIA_TRANSPORT),
  bucket: z.string().regex(OBJECT_STORE_BUCKET_RE),
  key: z.string().regex(OBJECT_STORE_KEY_RE),
  kind: LucyMediaKindSchema,
  contentType: z.string().min(1).optional(),
  size: z.number().int().nonnegative(),
  fileName: z.string().min(1).optional(),
  sha256: z.string().min(1).optional(),
});

export const LucyDmPolicySchema = z.enum(["allowlist", "open", "disabled"]);

export const LucyConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  servers: z.array(z.string().min(1)).optional(),
  channelUserKey: z.string().min(1).optional(),
  channelDeviceId: LucyMessageIdSchema.optional(),
  bootstrapToken: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  subjectPrefix: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  dmPolicy: LucyDmPolicySchema.optional(),
  allowFrom: z.array(z.string().min(1)).optional(),
  mediaBucket: z.string().regex(OBJECT_STORE_BUCKET_RE).optional(),
  mediaRetentionHours: z.number().int().positive().optional(),
  mediaMaxMb: z.number().positive().optional(),
  mediaLocalRoots: z.array(z.string().min(1)).optional(),
});

export type LucyConfig = z.infer<typeof LucyConfigSchema>;
export type LucyBindingStatus = z.infer<typeof LucyBindingStatusSchema>;
export type LucyDmPolicy = z.infer<typeof LucyDmPolicySchema>;
export type LucyMediaKind = z.infer<typeof LucyMediaKindSchema>;
export type LucyMediaDescriptor = z.infer<typeof LucyMediaDescriptorSchema>;

export const LucyInboundMessageV1Schema = z.object({
  version: z.literal(1),
  messageId: LucyMessageIdSchema.optional(),
  text: z.string(),
  timestamp: z.number().int().optional(),
  metadata: LucyMetadataSchema.optional(),
  channelUserKey: z.string().optional(),
  channelDeviceId: LucyMessageIdSchema.optional(),
  apiKey: z.string().optional(),
  deviceId: LucyMessageIdSchema.optional(),
});

export const LucyInboundMessageV2Schema = z
  .object({
    version: z.literal(2),
    messageId: LucyMessageIdSchema.optional(),
    text: z.string().optional(),
    media: LucyMediaDescriptorSchema.optional(),
    timestamp: z.number().int().optional(),
    metadata: LucyMetadataSchema.optional(),
    channelUserKey: z.string().optional(),
    channelDeviceId: LucyMessageIdSchema.optional(),
    apiKey: z.string().optional(),
    deviceId: LucyMessageIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasText = Boolean(value.text?.trim());
    if (!hasText && !value.media) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text or media is required",
        path: ["text"],
      });
    }
  });

export const LucyInboundMessageSchema = z.union([LucyInboundMessageV2Schema, LucyInboundMessageV1Schema]);

export type LucyInboundMessageV1 = z.infer<typeof LucyInboundMessageV1Schema>;
export type LucyInboundMessageV2 = z.infer<typeof LucyInboundMessageV2Schema>;
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
  "approval.pending",
  "approval.resolved",
]);

export type LucyMachineEventType = z.infer<typeof LucyMachineEventTypeSchema>;

export const LucyMachineEventSchema = z.object({
  version: z.literal(2),
  eventId: LucyMessageIdSchema,
  type: LucyMachineEventTypeSchema,
  timestamp: z.number().int(),
  channelUserKey: z.string(),
  channelDeviceId: LucyMessageIdSchema,
  sourceMessageId: LucyMessageIdSchema.optional(),
  runId: z.string().optional(),
  sessionKey: z.string().optional(),
  text: z.string().optional(),
  toolName: z.string().optional(),
  metadata: LucyMetadataSchema.optional(),
  media: LucyMediaDescriptorSchema.optional(),
  approvalId: z.string().optional(),
  approvalSlug: z.string().optional(),
  approvalCommand: z.string().optional(),
  approvalCwd: z.string().optional(),
  approvalHost: z.string().optional(),
  approvalExpiresAtMs: z.number().optional(),
  approvalAllowedDecisions: z.array(z.string()).optional(),
  approvalDecision: z.string().optional(),
  approvalResolvedBy: z.string().optional(),
});

export type LucyMachineEvent = z.infer<typeof LucyMachineEventSchema>;

export type LucyDeviceState = {
  version: 2;
  channelDeviceId: string;
  bootstrapToken: string;
  bindingStatus: LucyBindingStatus;
  channelUserKey?: string;
  createdAtMs: number;
};

export type ResolvedLucyAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  servers: string[];
  channelUserKey?: string;
  channelDeviceId?: string;
  bootstrapToken?: string;
  subjectPrefix: string;
  token?: string;
  username?: string;
  password?: string;
  dmPolicy: LucyDmPolicy;
  allowFrom: string[];
  mediaBucket: string;
  mediaRetentionHours: number;
  mediaMaxBytes: number;
  mediaLocalRoots?: string[];
};

export type LucySubjects = {
  clientSubject: string;
  machineSubject: string;
};

export type LucyProbe = {
  ok: true;
  bindingStatus: LucyBindingStatus;
  connectedUrl: string | null;
  clientSubject: string | null;
  machineSubject: string | null;
  channelDeviceId: string;
  channelUserKey?: string;
  bindingCheckUrl: string;
  userCenterBaseUrl: string;
  mediaBucket: string;
  mediaRetentionHours: number;
};
