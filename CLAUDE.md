# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Scope

This directory is the `lucy` OpenClaw channel plugin: a DM-only transport that bridges OpenClaw to Lucy clients over NATS. It owns transport, binding, presence, and media transfer; it does **not** own model/provider availability.

## Read first

- `extensions/lucy/README.md` — current operational flow, recommended config, validation commands, and transport-vs-model troubleshooting boundaries.
- `extensions/lucy/doc/auth-binding/integrated-flow.md` — authoritative binding/auth flow with `user-center` and `auth-callout`.
- `extensions/lucy/doc/app-nats-integration.md` — app/client protocol contract.
- `extensions/lucy/LucyIOSDemo/README.md` — companion iOS demo behavior; this app is a real protocol-validation client, not a mock.

## Common commands

Run these from the OpenClaw repo root unless noted otherwise.

- Install dependencies: `pnpm install`
- Full repo build/typecheck: `pnpm build`
- Full repo lint/check: `pnpm check`
- Lucy TypeScript check only: `pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts`
- Lucy tests: `vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"`
- Single Lucy test file: `vitest run --config vitest.extensions.config.ts extensions/lucy/src/gateway.test.ts`
- Single Lucy test by name: `vitest run --config vitest.extensions.config.ts extensions/lucy/src/gateway.test.ts -t "payload channelDeviceId does not match subject namespace"`
- Print bind QR from the standalone script: `pnpm exec tsx extensions/lucy/scripts/auth-qrcode.ts --json`
- Transport-layer smoke test against NATS: `pnpm exec tsx extensions/lucy/scripts/demo-chat.ts --server nats://chat.lucy.run:4222 --channel-user-key <channel_user_key> --channel-device-id <channel_device_id> --text "Reply with exactly LUCY_E2E_OK." --wait-ms 25000`
- Plugin helper commands through OpenClaw:
  - `openclaw lucy auth-qrcode`
  - `openclaw lucy reset-state`
- Optional local NATS for transport work: `docker compose -f extensions/lucy/docker-compose.nats.yml up -d nats`
- iOS demo regression test: `xcodebuildmcp swift-package test --package-path ./extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage --filter LucyIOSDemoFeatureTests.testMachineEventDecodesCamelCaseChannelDeviceId`

## Architecture overview

### Plugin entry and registration

- `extensions/lucy/index.ts` is the plugin entrypoint.
- It stores the OpenClaw runtime via `setLucyRuntime`, registers the `lucy` channel plugin, and registers both CLI and slash-style Lucy helper commands.

### Main channel adapter

- `extensions/lucy/src/channel.ts` is the top-level `ChannelPlugin` definition.
- It wires together:
  - config/account resolution
  - DM security policy
  - outbound text/media sending
  - status probing/snapshots
  - gateway startup
- Lucy advertises DM-only chat and `blockStreaming: true`, but the gateway still emits `assistant.partial`, `reasoning.*`, and `tool.*` events over NATS for the client UI.

### Startup and binding flow

Gateway startup is centered in `extensions/lucy/src/gateway.ts` and always goes through binding state first:

1. `startLucyGateway()` calls `syncLucyBindingState()` from `extensions/lucy/src/auth-binding.ts`.
2. `syncLucyBindingState()` ensures local device state exists, registers the device with `user-center`, polls binding state, and persists the resulting `channel_user_key` when available.
3. The resolved account is then hydrated from local state before NATS connect.
4. Gateway subscribes to `{subjectPrefix}.{channelUserKey}.{channelDeviceId}.client` and publishes replies/events to the sibling `.machine` subject.

Important: the normal production path is **binding-first**. `channelDeviceId`, `bootstrapToken`, and eventually `channelUserKey` are usually learned dynamically from local state + `user-center`, not hardcoded in config.

### Inbound message pipeline

`handleLucyInboundMessage()` in `extensions/lucy/src/gateway.ts` is the core runtime path:

1. Validate and normalize inbound payloads with the zod schemas in `extensions/lucy/src/types.ts`.
2. Reject mismatches between payload namespace and NATS subject namespace.
3. Resolve the OpenClaw route through `channelRuntime.routing.resolveAgentRoute()`.
4. Download inbound media from JetStream Object Store when present.
5. Build and persist OpenClaw session context.
6. Emit `inbound.accepted`.
7. Dispatch the agent reply through `dispatchReplyWithBufferedBlockDispatcher()`.
8. Mirror agent lifecycle back to NATS as `assistant.start`, `assistant.partial`, `assistant.final`, `reasoning.partial`, `reasoning.final`, `tool.start`, `tool.end`, and `error`.

### Outbound path

- Channel outbound senders in `extensions/lucy/src/channel.ts` publish `assistant.final` messages directly to a Lucy device/user target.
- `normalizeLucyOutboundTarget()` strips an optional `lucy:` prefix.
- Outbound media goes through the same JetStream Object Store path as inbound media.

## State, config, and protocol boundaries

### Persistent state

- `extensions/lucy/src/state.ts` stores device state at `<openclaw state dir>/lucy/device-state.json`.
- The file contains the generated `channelDeviceId`, `bootstrapToken`, binding status, and eventually `channelUserKey`.
- The state layer migrates legacy v1 state and preserves binding progression (`pending -> registered -> bound`).

### Pairing export

- `extensions/lucy/src/pairing-export.ts` writes `<openclaw state dir>/lucy/pairing-info.json`.
- This is a sanitized local readiness file used by nearby onboarding/BLE flows; changes to device state should preserve this export behavior.

### Config model

- `extensions/lucy/src/types.ts` defines the zod schemas and protocol types.
- `extensions/lucy/src/config.ts` resolves the live account.
- Recommended config is minimal (`servers` plus enablement); legacy fields (`apiKey`, `token`, `username`, `password`) still exist for compatibility, but current behavior is built around `channel_user_key + channel_device_id`.

### user-center integration

- `extensions/lucy/src/user-center.ts` owns HTTP registration and binding checks.
- The base URL is currently encoded in `LUCY_USER_CENTER_BASE_URL`.
- If binding looks broken, inspect this path before touching NATS code.

## NATS, presence, and media

### NATS transport

- `extensions/lucy/src/nats.ts` builds canonical client/machine subjects and connection options.
- Native `nats://` and custom `ws://` / `wss://` transport are both supported; websocket transport lives in `extensions/lucy/src/nats-websocket.ts`.

### Presence contract

Presence is part of the runtime contract, not an optional extra:

- Gateway startup publishes `client.status.report` once so external presence infrastructure can map `client_id` to the Lucy device.
- Gateway also broadcasts online/offline heartbeats on `{subjectPrefix}.{channelUserKey}._discover`.
- Each device also listens on `{subjectPrefix}.{channelUserKey}.{channelDeviceId}.ping` to answer immediate presence checks.

If chat works but app online-state is wrong, inspect `extensions/lucy/src/gateway.ts` startup/shutdown logic before changing client code.

### Media transport

- `extensions/lucy/src/media.ts` stores bytes in JetStream Object Store and keeps only descriptors in NATS events.
- Lucy supports image/audio media only.
- `assistant.final` currently attaches at most one uploaded media object even if upstream produced multiple media candidates.
- Local-path outbound media is allowed only when the path is within approved media roots.

## Commands and local tooling

- `extensions/lucy/src/command.ts` implements `openclaw lucy auth-qrcode` and `openclaw lucy reset-state`, plus the `/lucy ...` command equivalents.
- `extensions/lucy/src/auth-qrcode.ts` defines the `lucy://bind?...` QR payload/URI format.
- `extensions/lucy/scripts/auth-qrcode.ts` is useful when you need QR payload generation without a full plugin runtime.
- `extensions/lucy/scripts/demo-chat.ts` is the fastest way to verify raw `client` / `machine` subject behavior, including media upload/download.

## Test focus

Tests are protocol- and integration-seam heavy, not just unit tests:

- `extensions/lucy/src/gateway.test.ts` covers inbound validation, routing, event sequencing, media hydration, and namespace mismatch handling.
- `extensions/lucy/src/channel.test.ts` covers outbound target normalization and media-root merging.
- `extensions/lucy/src/state.test.ts`, `user-center.test.ts`, `auth-qrcode.test.ts`, `pairing-export.test.ts`, `nats.test.ts`, and related tests cover the protocol edges.

When changing protocol fields or event names, also check the iOS demo and its tests under `extensions/lucy/LucyIOSDemo/LucyIOSDemoPackage`.
