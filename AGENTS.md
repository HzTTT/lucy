# Repository Guidelines

## Scope

This directory is the `lucy` OpenClaw channel plugin: a DM-only transport that bridges OpenClaw to Lucy clients over NATS via `lucy-im-sdk-nodejs`. The SDK owns auth (Ed25519), binding, NATS token exchange, JetStream messaging, and presence. The plugin owns OpenClaw integration, media transfer, and model provisioning; it does **not** own model/provider availability.

When docs and code disagree, treat the current code as the source of truth and update guidance to match the code.

## Read first

- `extensions/lucy/README.md` — operational flow, recommended config, validation commands, and transport-vs-model troubleshooting boundaries.
- `extensions/lucy/doc/auth-binding/integrated-flow.md` — binding/auth flow across Lucy, `user-center`, iOS, and `auth-callout`.
- `extensions/lucy/doc/app-nats-integration.md` — app/client protocol contract for NATS subjects, machine events, presence, and media.
- `extensions/lucy/outside/user-center/docs/lucy-model-config.md` — Lucy `current-user/model-config` contract, lazy API-key creation, and environment-derived `base_url`.
- `extensions/lucy/doc/debugging.md` — debugging scripts catalog, usage examples, and decision tree for diagnosing Lucy issues.

## Related external components (`outside/` symlinks)

For Lucy work, also inspect `extensions/lucy/outside/`. These linked repos are part of the real integration surface.

- `outside/LucyIOSDemo`
  - iOS client and protocol-validation app.
  - Check when changing app-facing protocol, BLE pairing UX, machine events, or subject usage.
  - Key area: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/**`
- `outside/user-center`
  - Server-side source of truth for registration, binding, current-user credential lookup, and connection verification.
  - Check when changing `channel_user_key`, `channel_device_id`, `bootstrap_token`, bind flow, or `/v1/channels/lucy/*` contracts.
  - Key area: `outside/user-center/internal/routers/channel_binding.go`
- `outside/npc-im-server`
  - NATS auth and presence infrastructure.
  - `auth-callout` verifies Lucy NATS credentials via `user-center` and issues scoped permissions.
  - `presence-bridge` turns `client.status.report` plus `$SYS.ACCOUNT.>` disconnects into `_discover` online/offline events.
  - Key areas: `outside/npc-im-server/auth-callout/main.go`, `outside/npc-im-server/presence-bridge/main.py`
- `outside/blue-wifi`
  - BLE Wi-Fi provisioning agent.
  - Reads Lucy's sanitized `pairing-info.json` and exposes it over BLE as `lucy_pairing_info`.
  - Check when changing BLE pairing handoff or the format/semantics of `pairing-info.json`.
  - Key area: `outside/blue-wifi/internal/bluewifi/lucy.go`

## Architecture role

Treat this repository as the **OpenClaw-side Lucy channel integration**, not as the source of truth for user identity or binding state.

- Lucy plugin responsibilities (via `lucy-im-sdk-nodejs`):
  - generate Ed25519 keypair and register device with `user-center` to obtain `cdi`
  - execute pre-bind OTP flow and poll binding to obtain `cuk` + `user_id`
  - exchange Ed25519-signed params for NATS token and connect
  - subscribe/publish via JetStream Pull Consumer (stream `IM_NPC`, durable `npc-<cdi>`)
  - SDK handles presence internally (`_discover` online/offline, heartbeat, ping reply)
  - export sanitized pairing state for nearby BLE/onboarding flows
  - embed-register the `cephalon` provider inside the Lucy plugin package itself
  - accept `version = 3 / kind = provision_model` control messages
  - write `models.providers.cephalon.*` and switch `agents.defaults.model.primary`
  - trigger automatic `openclaw gateway restart` (or configured restart helper override) after provisioning
- `user-center` responsibilities:
  - accept Ed25519 public key registration, return `cdi`
  - own user-device binding, `cuk`, and credential lookup
  - expose `GET /v1/channels/lucy/current-user/model-config`
  - lazily create and then reuse the Lucy-specific model API key
- `lucy-server` responsibilities:
  - pre-bind OTP signing (Ed25519 signature verification)
  - device binding status query (Ed25519 signature verification)
  - NATS token exchange (Ed25519 signature verification)
- `outside/npc-im-server/auth-callout` responsibilities:
  - validate NATS token
  - mint minimal NATS permissions for the validated device
- `outside/blue-wifi` responsibilities:
  - read Lucy's local pairing export and expose it over BLE
- iOS / external clients responsibilities (via `lucy-im-sdk-kotlin`):
  - scan QR or fetch BLE pairing info to obtain `cdi`
  - call `user-center` bind/current-user APIs
  - connect NATS via their own SDK

Keep terminology aligned with the integration docs: `cdi`, `cuk`, `user_id`, and Ed25519 keypair.

## Project structure and key code

Lucy is a TypeScript ESM OpenClaw channel plugin. Auth, binding, NATS connection, JetStream messaging, and presence are delegated to `lucy-im-sdk-nodejs` (git submodule at `lucy-im-sdk/`).

- `extensions/lucy/index.ts` — plugin entrypoint
- `extensions/lucy/lucy-im-sdk/` — git submodule: `lucy-im-sdk-nodejs` (Ed25519 auth, binding, NATS, JetStream, presence)
- `extensions/lucy/src/channel.ts` — top-level `ChannelPlugin` definition
- `extensions/lucy/src/gateway.ts` — inbound message pipeline and runtime event mirroring (JetStream consumer)
- `extensions/lucy/src/send.ts` — machine-event publication (JetStream publish)
- `extensions/lucy/src/media.ts` — JetStream Object Store upload/download
- `extensions/lucy/src/pairing-export.ts` — sanitized BLE pairing export (`pairing-info.json`)
- `extensions/lucy/src/types.ts` — zod schemas and protocol types

## Startup and binding flow

Gateway startup is binding-first, using `lucy-im-sdk-nodejs`:

1. `startLucyGateway()` creates `LucyImClient` with config (`homeDir`, `userCenterDomain`, `lucyServerDomain`, `kind`).
2. Calls `client.init()` — SDK generates Ed25519 keypair, registers device (public key → `cdi`), checks local `cuk`/`user_id`.
3. If `PendingBind`: calls `client.preBind()` for OTP, then `client.pollBinding()` until bound (persists `cuk` + `user_id`).
4. Calls `client.connect()` — SDK exchanges Ed25519-signed params for NATS token, connects, initializes JetStream, starts presence.
5. Plugin subscribes via `session.subscribeChannel("cephalon.im.npc.<user_id>.<cdi>", handler)`.
6. Plugin publishes via `session.publishChannel("cephalon.im.user.<user_id>", payload)`.

SDK stores state in `~/data/lucy_im/` (Ed25519 keys in `bootstrap_token/`, identifiers in `channel_ids/`).

## Cross-repo change checklist

- Protocol fields or machine events changed:
  - update `extensions/lucy/src/**`
  - verify `outside/LucyIOSDemo/**`
- Binding semantics or `user-center` / `lucy-server` API changed:
  - SDK handles auth/binding internally; check `lucy-im-sdk/src/http.ts`, `lucy-im-sdk/src/client.ts`
  - verify `outside/user-center/**`
- Model provisioning / auto-restart / embedded `cephalon` provider changed:
  - update `extensions/lucy/src/cephalon-provider.ts`, `extensions/lucy/src/provider-provisioning.ts`, `extensions/lucy/src/restart-ticket.ts`, `extensions/lucy/src/gateway.ts`, `extensions/lucy/src/types.ts`
  - verify `outside/user-center/internal/{routers,controllers,handlers,types}/channel_binding.go`
  - verify `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/{LucyModels,LucyServices,LucyRootView,LucySettingsSheetView,LucyRedesignedRootScene}.swift`
  - update docs in all three repos together so provider id, model id, event names, restart behavior, and `base_url` semantics stay aligned
- Presence / `_discover` / heartbeat / NATS auth changed:
  - Presence is handled by SDK internally (`lucy-im-sdk/src/natsConn.ts`)
  - NATS auth is token-based via SDK (`lucy-im-sdk/src/http.ts` `fetchNatsTokenNpc`)
  - verify `outside/npc-im-server/**`
- Pairing export changed:
  - update `extensions/lucy/src/pairing-export.ts`
  - verify `outside/blue-wifi/**` and `outside/LucyIOSDemo/**`

## Build, test, and development commands

Run these from the OpenClaw repo root unless noted otherwise.

- Install dependencies if needed: `pnpm install`
- Focused tests: `vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"`
- Targeted typecheck: `pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts`
- Optional local NATS: `docker compose -f extensions/lucy/docker-compose.nats.yml up -d nats`
- Print bind QR: `pnpm exec tsx extensions/lucy/scripts/auth-qrcode.ts --json`
- Transport smoke test: `pnpm exec tsx extensions/lucy/scripts/demo-chat.ts --channel-user-key <channel_user_key> --channel-device-id <channel_device_id> --text "Reply with exactly LUCY_E2E_OK." --wait-ms 25000` (NATS address is obtained from the token endpoint; pass `--server` only to override)
- Plugin helper commands:
  - `openclaw lucy auth-qrcode`
  - `openclaw lucy reset-state`
- Local stack (stable temp dirs): `env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml up -d nats openclaw-gateway`
- Gateway logs: `env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml logs openclaw-gateway --tail=200`
- Probe channel runtime: `env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli channels status --probe`
- Stable JSON probe fields: `env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli gateway call channels.status --params '{"probe":true,"timeoutMs":10000}' --json`
- Inspect runtime deps in container: `docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml exec openclaw-gateway ls -la /app/extensions/lucy/node_modules`
- iOS demo regression test: `xcodebuildmcp swift-package test --package-path ./extensions/lucy/outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyIOSDemoFeatureTests/testMachineEventDecodesCamelCaseChannelDeviceId`

## iPhone verification loop

For app-facing changes under `outside/LucyIOSDemo/**`, the default completion loop is:

1. Run the relevant `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage ...` verification first.
2. Automatically build and run on a connected physical iPhone with `xcodebuildmcp`; do not stop at simulator-only verification when a device is available.
3. Prefer the connected device named `宏仔头的iPhone (2)`; the current known UDID is `C6EE7005-94ED-5C16-87D7-875DD6ACB13F`. Re-check availability with `xcodebuildmcp device list` each session instead of assuming the device state is unchanged.
4. Use `xcodebuildmcp device build-and-run --project-path ./outside/LucyIOSDemo/LucyIOSDemo.xcodeproj --scheme LucyIOSDemo --device-id <UDID> --platform iOS` as the default real-device run command.
5. After a successful device launch, derive the app path and bundle id with:
   - `xcodebuildmcp device get-app-path --project-path ./outside/LucyIOSDemo/LucyIOSDemo.xcodeproj --scheme LucyIOSDemo --platform iOS`
   - `xcodebuildmcp device get-app-bundle-id --app-path <APP_PATH>`
6. Start device log capture before handing the build to the user with `xcodebuildmcp device start-device-log-capture --device-id <UDID> --bundle-id <BUNDLE_ID>`, keep the returned `log-session-id`, then explicitly wait for the user to finish manual testing.
7. After the user says testing is done, stop capture with `xcodebuildmcp device stop-device-log-capture --log-session-id <LOG_SESSION_ID>`, inspect the logs, and include any relevant runtime findings in the close-out.
8. Do not claim the Lucy iOS app change is fully verified until the real-device build, the user's manual check, and the post-test log review have all happened, unless the user explicitly waives that loop.
9. If no physical iPhone is connected or device launch/log capture fails, report the blocker clearly, include the exact failing step, and fall back to simulator verification only as a degraded path.

## Debug workflow

See `extensions/lucy/doc/debugging.md` for the full debugging scripts catalog, usage examples, and decision tree.

Use a boundary-first workflow. Prove the cheapest layer first, then move outward.

1. Prove Lucy locally first.
- Run focused tests and targeted typechecks.
- If these fail, fix code before Docker or infra debugging.

2. Bring up the smallest useful stack.
- Start NATS and the gateway first.
- Keep SDK homeDir (`~/data/lucy_im/`) stable so `cdi` and bind state do not drift.

3. Separate plugin failure from framework/config failure.
- Read gateway logs before changing code.
- Use `channels status --probe` for human checks.
- Use `gateway call channels.status ... --json` for stable machine-readable fields.
- If status says `configured, works, stopped`, inspect Lucy lifecycle/startup logic.

4. Verify runtime dependency visibility inside containers.
- A successful image build does not prove runtime resolution works.
- If logs show `Cannot find module 'nats'`, inspect both `/app/extensions/lucy/node_modules` and `/app/node_modules`.

5. Verify transport before model auth.
- `inbound.accepted` means JetStream consumer, channel routing, and inbound dispatch are working.
- `assistant.start` / `assistant.partial` means model execution started.
- `assistant.final` with upstream auth text or HTTP 401 means Lucy transport is healthy and provider config is the blocker.

6. Use a longer wait for final verification.
- Publish one message and wait long enough for `assistant.final`.
- Prefer raw NATS subscriber/publisher when you need exact event order.

## Failure signals

- `auto-restart attempt N/10`:
  Lucy startup is returning too early or throwing during account start.
- `configured, works, stopped`:
  the framework accepted the config, but the listener is not staying alive.
- `Cannot find module 'nats'`:
  runtime packaging problem, not a TypeScript problem.
- No `inbound.accepted`:
  JetStream consumer setup, NATS token exchange, or channel startup is broken.
- `inbound.accepted` appears but no assistant events:
  transport is alive; inspect model execution or upstream runtime state.
- `assistant.final` returns auth or provider errors:
  Lucy is working; fix provider credentials or model configuration.
- Repeated accepted/final events for one inbound message:
  suspect gateway auto-restart and duplicate listener registration before blaming NATS.

## Coding style and naming

Use TypeScript ESM with 2-space indentation, semicolons, and explicit `.js` suffixes in relative imports. Prefer small pure helpers for config parsing, subject logic, and protocol normalization instead of duplicating validation.

## Testing guidelines

Vitest is the test framework. Keep tests as `*.test.ts` beside the code they cover. Favor protocol-seam and integration-seam tests for config resolution, state persistence, subject generation, pairing export, and gateway event emission before Docker-only verification.

## Security and configuration tips

Never commit real `cuk`, `cdi`, NATS tokens, Ed25519 private keys, or `user_id` values. Use placeholders that still satisfy the runtime format rules because these values are used in subjects, auth, and protocol payloads.

Keep runtime packages in `dependencies`; keep `openclaw` in `devDependencies` or `peerDependencies` only so plugin installs remain compatible with the host loader.

## OpenClaw SDK compatibility

Treat the host `openclaw` package as the effective plugin SDK version.

- Prefer `openclaw/plugin-sdk` for generic plugin APIs.
- Do not depend on `openclaw/plugin-sdk/compat` from Lucy.
- Use narrower subpaths only when Lucy intentionally requires a host version known to export them.
- When making SDK-facing changes, verify Lucy against the oldest and newest host versions you claim to support.

## Notes and pitfalls

- `docker build` must receive `--build-arg OPENCLAW_EXTENSIONS=lucy`; setting only a shell env var is not enough for the Dockerfile path that installs extension deps.
- For bus-backed adapters such as Lucy, account startup should stay blocked until `abortSignal`; spawning a background loop and returning early can trigger OpenClaw auto-restart and duplicate inbound handling.
- A green build is not enough. Always check the running container filesystem and `channels status --probe`; when scripting against probe fields, prefer `gateway call channels.status ... --json`.
- When the gateway container is already restarting, prefer fixing the mounted config file directly over trying to use dependent CLI containers.
- Current model-provisioning design is **not** a separate `cephalon` plugin package. The `cephalon` provider is registered from inside Lucy itself.
- Do not hardcode `prod` / `test` model gateway URLs in Lucy, LucyIOSDemo, or `user-center`. `base_url` must follow the active environment and come from configuration or the `current-user/model-config` response.
