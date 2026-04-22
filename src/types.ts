import { z } from "zod";

export const LUCY_CHANNEL_ID = "lucy";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_SUBJECT_PREFIX = "cephalon.im.npc";
export const DEFAULT_HOME_DIR = "~/.lucy/identity/";
export const DEFAULT_DEVICE_TYPE = "cloud";
export const DEFAULT_LOCAL_NOTIFY_BIND = "127.0.0.1";
export const DEFAULT_LOCAL_NOTIFY_PORT = 8000;
export const DEFAULT_LOCAL_NOTIFY_PATH = "/usb-events";
export const DEFAULT_MEDIA_MAX_MB = 20;
export const DEFAULT_MAX_ATTACHMENTS = 10;
export const DEFAULT_USER_CENTER_DOMAIN = "https://prod.unicorn.org.cn/cephalon/user-center";
export const DEFAULT_LUCY_SERVER_DOMAIN = "https://prod.unicorn.org.cn/aiden/lucy-server";
export const DEFAULT_PAIRING_SOCKET = "/run/lucy/pairing.sock";
export const DEFAULT_MEDIA_LOCAL_ROOTS: readonly string[] = ["/home/lucy"];
export const SUBJECT_TOKEN_RE = /^[A-Za-z0-9_-]+$/;
export const LUCY_MEDIA_TRANSPORT = "iroh-blob";
export const LucyBindingStatusSchema = z.enum(["pending", "registered", "bound"]);

export const LucyMessageIdSchema = z.string().regex(/^\d{19}$/);
export const LucyMetadataSchema = z.record(z.string(), z.unknown());
export const LucyMediaKindSchema = z.enum(["image", "audio", "video", "document"]);

export const LucyMediaDescriptorSchema = z.object({
  transport: z.literal(LUCY_MEDIA_TRANSPORT),
  blob_ref: z.string().min(1),
  kind: LucyMediaKindSchema,
  contentType: z.string().min(1).optional(),
  size: z.number().int().nonnegative(),
  fileName: z.string().min(1).optional(),
});

export const LucyDmPolicySchema = z.enum(["allowlist", "open", "disabled"]);
export const LucyLocalNotifyConfigSchema = z.object({
  enabled: z.boolean().optional(),
  bind: z.string().min(1).optional(),
  port: z.number().int().positive().max(65535).optional(),
  path: z.string().min(1).optional(),
});

export const LucyLocalNotifyCodeSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const LucyLocalNotifyPayloadSchema = z.object({
  code: LucyLocalNotifyCodeSchema,
  device: z.string().min(1),
  timestamp: z.string().min(1),
  message: z.string(),
});

export const LucyConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  userCenterDomain: z.string().min(1).optional(),
  lucyServerDomain: z.string().min(1).optional(),
  homeDir: z.string().min(1).optional(),
  deviceType: z.string().min(1).optional(),
  subjectPrefix: z.string().min(1).optional(),
  dmPolicy: LucyDmPolicySchema.optional(),
  allowFrom: z.array(z.string().min(1)).optional(),
  mediaMaxMb: z.number().positive().optional(),
  maxAttachments: z.number().int().positive().max(20).optional(),
  mediaLocalRoots: z.array(z.string().min(1)).optional(),
  localNotify: LucyLocalNotifyConfigSchema.optional(),
  restartHelperCommand: z.string().min(1).optional(),
  restartHelperArgs: z.array(z.string().min(1)).optional(),
  restartOnlineTimeoutMs: z.number().int().positive().optional(),
  pairingSocket: z.string().min(1).optional(),
});

export type LucyConfig = z.infer<typeof LucyConfigSchema>;
export type LucyBindingStatus = z.infer<typeof LucyBindingStatusSchema>;
export type LucyDmPolicy = z.infer<typeof LucyDmPolicySchema>;
export type LucyMediaKind = z.infer<typeof LucyMediaKindSchema>;
export type LucyMediaDescriptor = z.infer<typeof LucyMediaDescriptorSchema>;
export type LucyLocalNotifyConfig = z.infer<typeof LucyLocalNotifyConfigSchema>;
export type LucyLocalNotifyCode = z.infer<typeof LucyLocalNotifyCodeSchema>;
export type LucyLocalNotifyPayload = z.infer<typeof LucyLocalNotifyPayloadSchema>;

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

export const LucyProvisioningPayloadSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  switchDefaultModel: z.boolean().optional(),
  restartRequested: z.boolean().optional(),
});

export const LucyInboundMessageV3Schema = z
  .object({
    version: z.literal(3),
    kind: z.enum(["chat", "provision_model"]),
    messageId: LucyMessageIdSchema.optional(),
    text: z.string().optional(),
    media: LucyMediaDescriptorSchema.optional(),
    provision: LucyProvisioningPayloadSchema.optional(),
    timestamp: z.number().int().optional(),
    metadata: LucyMetadataSchema.optional(),
    channelUserKey: z.string().optional(),
    channelDeviceId: LucyMessageIdSchema.optional(),
    apiKey: z.string().optional(),
    deviceId: LucyMessageIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "chat") {
      const hasText = Boolean(value.text?.trim());
      if (!hasText && !value.media) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "text or media is required",
          path: ["text"],
        });
      }
      return;
    }

    if (!value.provision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provision is required",
        path: ["provision"],
      });
    }
  });

export const LucyInboundMessageV4Schema = z
  .object({
    version: z.literal(4),
    kind: z.enum(["chat", "provision_model"]),
    messageId: LucyMessageIdSchema.optional(),
    text: z.string().optional(),
    media: LucyMediaDescriptorSchema.optional(),
    attachments: z.array(LucyMediaDescriptorSchema).optional(),
    provision: LucyProvisioningPayloadSchema.optional(),
    timestamp: z.number().int().optional(),
    metadata: LucyMetadataSchema.optional(),
    channelUserKey: z.string().optional(),
    channelDeviceId: LucyMessageIdSchema.optional(),
    apiKey: z.string().optional(),
    deviceId: LucyMessageIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "chat") {
      const hasText = Boolean(value.text?.trim());
      const hasMedia = Boolean(value.media) || Boolean(value.attachments?.length);
      if (!hasText && !hasMedia) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "text, media, or attachments is required",
          path: ["text"],
        });
      }
      return;
    }

    if (!value.provision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provision is required",
        path: ["provision"],
      });
    }
  });

export const LucyInboundMessageSchema = z.union([
  LucyInboundMessageV4Schema,
  LucyInboundMessageV3Schema,
  LucyInboundMessageV2Schema,
  LucyInboundMessageV1Schema,
]);

export type LucyInboundMessageV1 = z.infer<typeof LucyInboundMessageV1Schema>;
export type LucyInboundMessageV2 = z.infer<typeof LucyInboundMessageV2Schema>;
export type LucyInboundMessageV3 = z.infer<typeof LucyInboundMessageV3Schema>;
export type LucyInboundMessageV4 = z.infer<typeof LucyInboundMessageV4Schema>;
export type LucyInboundMessage = z.infer<typeof LucyInboundMessageSchema>;
export type LucyProvisioningPayload = z.infer<typeof LucyProvisioningPayloadSchema>;

export const LucyMachineEventTypeSchema = z.enum([
  "inbound.accepted",
  "assistant.start",
  "assistant.partial",
  "assistant.final",
  // Run-level terminator: emitted exactly once per inbound message after the
  // reply dispatcher resolves (success or error). Clients use this to know
  // the agent turn is fully done.
  "assistant.complete",
  "reasoning.partial",
  "reasoning.final",
  "tool.start",
  "tool.end",
  "error",
  "approval.pending",
  "approval.resolved",
  "config.updated",
  "config.error",
  "restart.scheduled",
  "restart.completed",
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
  attachments: z.array(LucyMediaDescriptorSchema).optional(),
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

export type ResolvedLucyAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  userCenterDomain: string;
  lucyServerDomain: string;
  homeDir: string;
  deviceType: string;
  subjectPrefix: string;
  dmPolicy: LucyDmPolicy;
  allowFrom: string[];
  mediaMaxBytes: number;
  maxAttachments: number;
  mediaLocalRoots?: string[];
  localNotify?: {
    enabled: true;
    bind: string;
    port: number;
    path: string;
  };
  restartHelperCommand?: string;
  restartHelperArgs?: string[];
  restartOnlineTimeoutMs?: number;
  /**
   * Absolute path to the blue-wifi pairing IPC Unix domain socket. When set,
   * the Lucy gateway connects to this socket during PendingBind so the
   * attached BLE agent can trigger on-demand preBind() calls and receive the
   * resulting OTP. Leave empty to disable the IPC integration entirely.
   */
  pairingSocket?: string;
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
