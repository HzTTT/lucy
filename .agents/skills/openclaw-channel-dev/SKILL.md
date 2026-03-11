---
name: openclaw-channel-dev
description: >
  Guide for developing private OpenClaw channel plugins (extensions). Use this skill whenever
  the user wants to build, scaffold, debug, or understand any OpenClaw channel plugin — including
  custom messaging integrations, DM-only channels, webhook listeners, streaming reply support,
  tool execution display, and reasoning/thinking display. Trigger on phrases like "openclaw channel
  plugin", "openclaw extension", "custom channel", "openclaw integration", "private channel dev",
  or any mention of implementing ChannelPlugin, ChannelGatewayAdapter, or dispatchReplyWithBufferedBlockDispatcher.
---

# Developing a Private OpenClaw Channel Plugin

This skill covers the end-to-end process for building a custom private channel plugin for OpenClaw.
The focus is **one-to-one direct message (DM) channels**, streaming replies, tool execution display,
and thinking/reasoning display.

---

## High-Level Architecture

An OpenClaw channel plugin is a TypeScript ESM package under `extensions/<channel-id>/` (or an
external npm package) that exports a plugin object. The runtime loads it via the plugin registry and
calls its adapters.

```
extensions/my-channel/
├── package.json          ← plugin entry (openclaw.extensions field)
├── index.ts              ← plugin registration
└── src/
    ├── channel.ts        ← ChannelPlugin definition (config, gateway, outbound, status…)
    ├── gateway.ts        ← inbound listener (webhook / long-poll)
    ├── send.ts           ← platform send API
    ├── config.ts         ← account config resolution
    └── types.ts          ← local types
```

---

## Step 1 — package.json

```jsonc
{
  "name": "@my-org/openclaw-my-channel",
  "version": "1.0.0",
  "type": "module",
  "main": "./index.ts",       // jiti resolves .ts at runtime
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "my-channel",
      "label": "My Channel",
      "aliases": ["mychannel", "mc"]
    }
  },
  "dependencies": {
    // put your platform SDK here, e.g. "axios": "^1.7"
  },
  "devDependencies": {
    "openclaw": "*"           // type access; resolved at runtime via jiti alias
  }
}
```

**Rules:**
- Runtime deps go in `dependencies` (npm install runs `--omit=dev`).
- Never put `openclaw` in `dependencies` — use `devDependencies` or `peerDependencies`.
- Do not use `workspace:*` in `dependencies`.

---

## Step 2 — index.ts (plugin registration)

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { myChannelPlugin } from "./src/channel.js";

// Store runtime reference for use inside adapters
let _runtime: OpenClawPluginApi["runtime"] | undefined;
export function getRuntime() {
  if (!_runtime) throw new Error("runtime not initialized");
  return _runtime;
}

const plugin = {
  id: "my-channel",
  name: "My Channel",
  register(api: OpenClawPluginApi) {
    _runtime = api.runtime;
    api.registerChannel({ plugin: myChannelPlugin });
  },
};

export default plugin;
```

---

## Step 3 — src/channel.ts (ChannelPlugin)

For a minimal DM-only channel you need these adapters:
- `config` — account resolution (required)
- `capabilities` — declare `chatTypes: ["direct"]`
- `gateway` — inbound listener (start/stop)
- `outbound` — send replies to platform
- `status` (optional) — health checks
- `security` (optional) — DM allowlist

```typescript
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { getRuntime } from "../index.js";
import type { MyAccount } from "./config.js";
import { listMyAccountIds, resolveMyAccount } from "./config.js";
import { startMyGateway } from "./gateway.js";
import { sendMyChannelMessage } from "./send.js";

export const myChannelPlugin: ChannelPlugin<MyAccount> = {
  id: "my-channel",

  meta: {
    id: "my-channel",
    label: "My Channel",
    selectionLabel: "My Channel (plugin)",
    docsPath: "/channels/my-channel",
    docsLabel: "my-channel",
    blurb: "one-on-one DM via My Platform",
    order: 90,
    quickstartAllowFrom: true,
  },

  capabilities: {
    chatTypes: ["direct"],   // DM only
    media: false,
    blockStreaming: true,    // opt-in for partial streaming
  },

  config: {
    listAccountIds: (cfg) => listMyAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMyAccount(cfg, accountId),
    isConfigured: (account) => Boolean(account.apiKey?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.apiKey?.trim()),
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveMyAccount(cfg, accountId);
      return account.allowFrom ?? [];
    },
  },

  // Optional: DM security (allowlist)
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      if (!account.allowFrom?.length) return null;
      return {
        policy: "allow",
        allowFrom: account.allowFrom,
        allowFromPath: `channels.my-channel.allowFrom`,
        approveHint: `Run: openclaw my-channel allow <userId>`,
      };
    },
  },

  outbound: {
    deliveryMode: "direct",
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveMyAccount(cfg, accountId);
      await sendMyChannelMessage(account.apiKey, to, text);
      return { channel: "my-channel", messageId: `sent-${Date.now()}` };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const { channelRuntime } = ctx;
      if (!channelRuntime) {
        ctx.log?.error?.("channelRuntime not available (SDK too old)");
        return;
      }
      return startMyGateway({
        account: ctx.account,
        cfg: ctx.cfg,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
        channelRuntime,
      });
    },
  },
};
```

---

## Step 4 — src/config.ts (account resolution)

```typescript
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export type MyAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  apiKey?: string;
  allowFrom?: string[];
};

export function listMyAccountIds(cfg: OpenClawConfig): string[] {
  const section = (cfg as any).channels?.["my-channel"];
  if (!section) return [];
  return ["default"];
}

export function resolveMyAccount(cfg: OpenClawConfig, accountId?: string | null): MyAccount {
  const section = (cfg as any).channels?.["my-channel"] ?? {};
  return {
    accountId: accountId ?? "default",
    name: section.name,
    enabled: section.enabled !== false,
    apiKey: section.apiKey ?? process.env.MY_CHANNEL_API_KEY,
    allowFrom: section.allowFrom,
  };
}
```

**Config in `~/.openclaw/config.yaml`:**
```yaml
channels:
  my-channel:
    enabled: true
    apiKey: "your-api-key"
    allowFrom:
      - "user-123"
```

---

## Step 5 — src/gateway.ts (CORE: inbound + dispatch with streaming)

This is the most important file. It receives platform messages and dispatches AI replies,
with streaming, tool execution events, and reasoning display.

```typescript
import type { PluginRuntimeChannel } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { MyAccount } from "./config.js";

type GatewayParams = {
  account: MyAccount;
  cfg: OpenClawConfig;
  abortSignal: AbortSignal;
  log?: { info: (msg: string) => void; error?: (msg: string) => void };
  channelRuntime: PluginRuntimeChannel;
};

export async function startMyGateway(params: GatewayParams): Promise<void> {
  const { account, cfg, abortSignal, log, channelRuntime } = params;

  // --- Set up inbound listener (webhook / long-poll / SDK events) ---
  // Example: HTTP long-poll loop
  while (!abortSignal.aborted) {
    try {
      const inboundMessages = await pollMyPlatform(account.apiKey, abortSignal);
      for (const msg of inboundMessages) {
        // Don't await — process messages concurrently
        handleInboundMessage({ msg, account, cfg, log, channelRuntime }).catch((err) =>
          log?.error?.(`[my-channel] dispatch error: ${String(err)}`),
        );
      }
    } catch (err) {
      if (abortSignal.aborted) break;
      log?.error?.(`[my-channel] poll error: ${String(err)}`);
      await sleep(5000, abortSignal);
    }
  }
}

type InboundMsg = {
  fromId: string;   // platform user ID (used for routing + reply target)
  text: string;
};

async function handleInboundMessage(params: {
  msg: InboundMsg;
  account: MyAccount;
  cfg: OpenClawConfig;
  log?: { info: (msg: string) => void; error?: (msg: string) => void };
  channelRuntime: PluginRuntimeChannel;
}): Promise<void> {
  const { msg, account, cfg, log, channelRuntime } = params;

  // 1. Resolve which agent should handle this message
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: "my-channel",
    accountId: account.accountId,
    peer: { id: msg.fromId, chatType: "direct" },
    chatType: "direct",
  });

  if (!route) {
    log?.info(`[my-channel] no route for ${msg.fromId} — ignored`);
    return;
  }

  // 2. Build inbound context (the "envelope" the agent sees)
  const ctx = channelRuntime.reply.finalizeInboundContext({
    cfg,
    channel: "my-channel",
    agentId: route.agentId,
    accountId: account.accountId,
    sessionKey: route.sessionKey,
    chatType: "direct",
    from: msg.fromId,
    text: msg.text,
    // Optional metadata shown to the agent:
    envelope: { From: msg.fromId, Channel: "my-channel" },
  });

  log?.info(`[my-channel] dispatching "${msg.text}" → agent ${route.agentId}`);

  // 3. Dispatch with streaming, tool events, and reasoning display
  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      // Called for each completed reply block (text, tool result, etc.)
      deliver: async (payload) => {
        if (!payload.text?.trim()) return;
        await sendMyChannelMessage(account.apiKey, msg.fromId, payload.text);
      },
    },
    replyOptions: {
      // ── STREAMING: partial text arrives while model is still generating ──
      // Show a live preview (edit existing message, update UI, etc.)
      onPartialReply: async (payload) => {
        if (!payload.text?.trim()) return;
        // e.g. update a "typing preview" in your platform
        await updateTypingPreview(account.apiKey, msg.fromId, payload.text);
      },

      // ── THINKING: reasoning/chain-of-thought blocks ──
      onReasoningStream: async (payload) => {
        if (!payload.text?.trim()) return;
        // payload.isReasoning === true
        // Options:
        // a) Suppress entirely (simplest for most channels)
        // b) Show in a collapsible/secondary UI
        // c) Send as a prefixed message: `[thinking] ${payload.text}`
        // For DM channels: typically suppress or show as small indicator
      },
      onReasoningEnd: async () => {
        // Reasoning block complete — clear the thinking indicator if you showed one
      },

      // ── TOOL EXECUTION: when agent uses a tool (web search, code, etc.) ──
      onToolStart: async ({ name, phase }) => {
        // Called when a tool starts — name = tool name (e.g. "web_search")
        // Show a temporary status: "🔧 Using web_search..."
        if (name) {
          await sendStatusMessage(account.apiKey, msg.fromId, `🔧 ${name}…`);
        }
      },
      onAssistantMessageStart: async () => {
        // New assistant text block starting (e.g. after tool call completes)
        // Clear any "using tool..." status messages
      },
    },
  });
}

// ── Helpers (implement these for your platform) ──────────────────────────────

async function pollMyPlatform(apiKey: string, abort: AbortSignal): Promise<InboundMsg[]> {
  // TODO: call your platform's polling / webhook endpoint
  // Return array of new inbound messages
  return [];
}

async function sendMyChannelMessage(apiKey: string, to: string, text: string): Promise<void> {
  // TODO: call your platform's send API
}

async function updateTypingPreview(apiKey: string, to: string, text: string): Promise<void> {
  // TODO: update an existing "draft" message with partial text, or no-op if not supported
}

async function sendStatusMessage(apiKey: string, to: string, text: string): Promise<void> {
  // TODO: send (or edit) a status message; delete it once real reply comes
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
  });
}
```

---

## Streaming Architecture — How It Works

```
Platform message arrives
        │
        ▼
handleInboundMessage()
        │
        ▼
resolveAgentRoute()          ← find which agent + session
        │
        ▼
finalizeInboundContext()     ← build MsgContext for agent
        │
        ▼
dispatchReplyWithBufferedBlockDispatcher()
        │
        ├─ onReasoningStream()  ← thinking text (stream)
        ├─ onReasoningEnd()     ← thinking block done
        ├─ onToolStart()        ← tool beginning
        ├─ onPartialReply()     ← text streaming (incremental)
        ├─ onAssistantMessageStart() ← new text block after tool
        └─ deliver()            ← final complete block → send to platform
```

**Key insight:** `deliver` is what actually sends the final text. `onPartialReply` is for live
preview/typing indicators — it fires many times per block. Not all platforms support live preview;
it's fine to no-op `onPartialReply` and only implement `deliver`.

---

## Streaming Strategies by Platform Type

| Platform capability | Recommended approach |
|---------------------|---------------------|
| Edit message in place (like Telegram) | `onPartialReply` → edit draft message; `deliver` → finalize |
| SSE / websocket push | `onPartialReply` → push incremental tokens |
| No live update support | No-op `onPartialReply`; implement `deliver` only |

---

## Thinking/Reasoning Display Patterns

The `onReasoningStream` callback receives `payload.isReasoning = true` text. Options:

1. **Suppress** (simplest): no-op the callback. The final answer still comes via `deliver`.
2. **Collapsed block**: send a `<details>` (if HTML) or prefixed message `💭 [thinking] ...`
3. **Typing indicator**: show "Claude is thinking..." while `onReasoningStream` fires; clear on `onReasoningEnd`
4. **Separate message**: send thinking as a separate, deletable message before the final answer

For simple DM channels, option 3 (indicator only) gives the best UX without noise.

---

## Tool Execution Display Patterns

The `onToolStart({ name, phase })` callback fires when a tool begins. `onAssistantMessageStart`
fires when the next text block begins (after tool completion).

Recommended flow:
1. `onToolStart` → send "🔧 Running `web_search`…" (or edit an existing status message)
2. `deliver` (tool result block) → send the tool result summary if `payload.isReasoning` is false
3. `onAssistantMessageStart` → clear the tool status message

Keep tool status messages ephemeral — send then delete, or edit in place.

---

## Key Types Reference

```typescript
// The full plugin interface (all fields optional except id, meta, capabilities, config)
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";

// The runtime surface available inside gateway.startAccount
import type { PluginRuntimeChannel } from "openclaw/plugin-sdk/core";

// Core config passed everywhere
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

// Payload for each reply event
type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  isReasoning?: boolean;  // true for thinking blocks
  isError?: boolean;
  channelData?: Record<string, unknown>;
};

// GetReplyOptions (replyOptions in dispatchReplyWithBufferedBlockDispatcher)
// Key callbacks:
//   onPartialReply(payload)     — streaming text
//   onReasoningStream(payload)  — thinking text
//   onReasoningEnd()            — thinking block done
//   onToolStart({ name, phase }) — tool starting
//   onAssistantMessageStart()   — new text block (after tool)
```

---

## Key Source Files (for deeper reading)

| File | What to read there |
|------|--------------------|
| `src/channels/plugins/types.plugin.ts` | `ChannelPlugin` interface — all adapters |
| `src/channels/plugins/types.adapters.ts` | `ChannelOutboundAdapter`, `ChannelGatewayAdapter`, `ChannelConfigAdapter` |
| `src/channels/plugins/types.core.ts` | `ChannelCapabilities`, `ChannelMeta`, `ChannelAccountSnapshot` |
| `src/auto-reply/types.ts` | `GetReplyOptions`, `ReplyPayload` — streaming callbacks |
| `src/auto-reply/reply/reply-dispatcher.ts` | `ReplyDispatcherWithTypingOptions` |
| `src/auto-reply/reply/provider-dispatcher.ts` | `dispatchReplyWithBufferedBlockDispatcher` |
| `src/plugins/runtime/types-channel.ts` | `PluginRuntimeChannel` — what `ctx.channelRuntime` exposes |
| `extensions/telegram/src/channel.ts` | Full production reference (Telegram plugin) |
| `extensions/matrix/src/channel.ts` | Another real extension plugin example |

---

## Telegram Channel — Key Patterns to Borrow

Reference: `extensions/telegram/src/channel.ts`

1. **Token config**: Telegram stores the bot token in `cfg.channels.telegram.botToken`.
   Mirror this pattern: store your credential in `cfg.channels.my-channel.apiKey`.

2. **Block streaming**: Telegram sets `capabilities.blockStreaming: true` and uses
   `sendMessageDraft` for partial replies. If your platform supports editing a sent
   message, do the same: keep a `currentMsgId` and call edit-message API in `onPartialReply`.

3. **Chunking**: Telegram uses `chunkMarkdownText` with a 4000-char limit. Use the same via
   `outbound.chunker = (text, limit) => channelRuntime.text.chunkMarkdownText(text, limit)`.

4. **allowFrom security**: Telegram's `security.resolveDmPolicy` uses
   `buildAccountScopedDmSecurityPolicy` from `openclaw/plugin-sdk/compat`. Use the same helper.

5. **Status/probe**: Telegram probes the bot API to verify the token is valid. Add a `status.probeAccount`
   that pings your platform's API to confirm credentials work.

---

## Common Pitfalls

- **Don't block `startAccount`**: It should run indefinitely (poll loop / event listener).
  Return a cleanup teardown or run the loop with `abortSignal`.
- **Don't mix static import and dynamic import** for the same module. Use `.runtime.ts` boundary
  files for lazy-loaded platform SDKs.
- **Always check `ctx.channelRuntime`**: It's optional for forward-compatibility. Log an error and
  bail if undefined.
- **Session keys**: Use `channelRuntime.routing.resolveAgentRoute` — don't build session keys
  manually. The route handles DM scope, binding resolution, and session persistence.
- **Tool result payloads**: `deliver` is called for tool result blocks too (not just text blocks).
  Check `payload.text` before sending to avoid empty messages.
- **Streaming noise**: Never send streaming partials to a final non-editable message. Only update
  a preview/draft; use `deliver` for the real send.
