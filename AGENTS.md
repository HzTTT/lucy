# Repository Guidelines

## Project Structure & Module Organization

Lucy is a TypeScript ESM OpenClaw channel plugin. `index.ts` registers the plugin. Core code lives in `src/`: `channel.ts` defines adapters, `gateway.ts` handles inbound traffic, `send.ts` and `nats.ts` handle transport, and `config.ts`, `config-schema.ts`, `state.ts`, and `types.ts` cover configuration and persisted device state. Tests are colocated as `src/*.test.ts`. Keep metadata in `package.json` and `openclaw.plugin.json`.

## Build, Test, and Development Commands

This package has no standalone build script; OpenClaw loads `index.ts` directly at runtime.

- `npm install` in this directory installs Lucy's dependencies when working outside the workspace.
- From the parent OpenClaw root: `docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml up -d` starts OpenClaw plus the local NATS broker.
- From the parent root: `docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli channels status --probe` verifies Lucy's human-readable health status.
- From the parent root: `docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli gateway call channels.status --params '{"probe":true,"timeoutMs":10000}' --json` prints the stable machine-readable `deviceId` / subjects / media probe fields.
- From the parent root: `bun extensions/lucy/scripts/demo-chat.ts --api-key demo_user --device-id <deviceId>` opens the demo client.
- From the parent root: `pnpm test:extensions` or `vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"` runs extension tests.

## Debug Workflow

Use a boundary-first workflow. Prove the cheapest layer first, then move outward. Do not patch Docker, transport, and provider config in one pass.

1. Prove Lucy itself before deployment.
- Run focused tests for `extensions/lucy/src/*.test.ts`.
- Run targeted TypeScript checks on Lucy files with `--skipLibCheck`.
- If these fail, fix code first and do not start Docker debugging yet.

2. Bring up the smallest useful stack.
- Build from the OpenClaw root with `docker build --build-arg OPENCLAW_EXTENSIONS=lucy -t openclaw:local -f Dockerfile .`.
- Start only the pieces needed to debug the channel: NATS and the gateway.
- If using temp config or workspace dirs, keep them stable for the whole session so `deviceId` and channel state do not move underneath you.

3. Separate framework/config failure from plugin failure.
- Read gateway logs before changing code.
- Use `channels status --probe` after each meaningful change for human health checks.
- Use `gateway call channels.status --params '{"probe":true,"timeoutMs":10000}' --json` when you need stable machine-readable `deviceId` / subjects / media probe fields.
- If status says `configured, works, stopped`, inspect Lucy lifecycle code before transport wiring.
- If the gateway is crash-looping, do not depend on `openclaw-cli` containers that share `network_mode: service:openclaw-gateway`; inspect or edit the mounted config directly.

4. Verify runtime dependency visibility inside the container.
- A successful image build does not prove runtime resolution works.
- If logs show `Cannot find module 'nats'` or similar, inspect both `/app/extensions/lucy/node_modules` and `/app/node_modules`.
- For local deploys, keep the compose mount that exposes `./extensions/lucy/node_modules:/app/extensions/lucy/node_modules`.

5. Verify transport before model auth.
- Treat bus events as hard boundaries:
  - `inbound.accepted`: NATS subjects, channel routing, and inbound dispatch are working.
  - `assistant.start` or `assistant.partial`: model execution started.
  - `assistant.final` with upstream auth text or HTTP 401: channel transport is healthy; provider config is the blocker.
- Do not keep changing Lucy when the failure is already above the channel layer.

6. Use a long-wait probe for final verification.
- Short demo clients only catch immediate failures.
- For real verification, publish one message and wait 10-15 seconds for `assistant.final`.
- Prefer a raw NATS subscriber/publisher when you need exact event order.

## Debug Commands

Run these from the OpenClaw root unless noted otherwise.

- Focused tests: `vitest run --config vitest.extensions.config.ts "extensions/lucy/src/*.test.ts"`
- Targeted typecheck: `pnpm exec tsc --noEmit --skipLibCheck extensions/lucy/index.ts extensions/lucy/src/*.ts`
- Build image with Lucy included: `docker build --build-arg OPENCLAW_EXTENSIONS=lucy -t openclaw:local -f Dockerfile .`
- Start local stack with stable temp dirs: `env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml up -d nats openclaw-gateway`
- Inspect gateway logs: `env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml logs openclaw-gateway --tail=200`
- Probe channel runtime: `env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli channels status --probe`
- Stable JSON probe fields: `env OPENCLAW_CONFIG_DIR=/tmp/openclaw-lucy-config OPENCLAW_WORKSPACE_DIR=/tmp/openclaw-lucy-workspace docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml run --rm openclaw-cli gateway call channels.status --params '{"probe":true,"timeoutMs":10000}' --json`
- Inspect runtime deps in container: `docker compose -f docker-compose.yml -f extensions/lucy/docker-compose.nats.yml exec openclaw-gateway ls -la /app/extensions/lucy/node_modules`
- Demo client: `node_modules/.bin/tsx extensions/lucy/scripts/demo-chat.ts --api-key demo_user --device-id <deviceId>`

## Failure Signals

- `auto-restart attempt N/10`:
  Lucy startup is returning too early or throwing during account start.
- `configured, works, stopped`:
  the framework accepted the config, but the listener is not staying alive.
- `Cannot find module 'nats'`:
  runtime packaging problem, not a TypeScript problem.
- No `inbound.accepted`:
  subject mapping, NATS reachability, or channel startup is broken.
- `inbound.accepted` appears but no assistant events:
  transport is alive; inspect model execution or upstream runtime state.
- `assistant.final` returns auth or provider errors:
  Lucy is working; fix provider credentials or model configuration.
- Repeated accepted/final events for one inbound message:
  suspect gateway auto-restart and duplicate listener registration before blaming NATS.

## Coding Style & Naming Conventions

Use TypeScript ESM with 2-space indentation, semicolons, and explicit `.js` suffixes in relative imports. Keep Lucy-specific exports clear, for example `resolveLucyAccount` and `LucyProbe`. Prefer small pure helpers for config parsing and NATS subject logic instead of duplicating validation. When available in the parent workspace, use `oxfmt` and `oxlint` through `pnpm format` and `pnpm check`.

## Testing Guidelines

Vitest is the test framework, and test files should stay as `*.test.ts` beside the code they cover. Favor unit tests for config resolution, state persistence, subject generation, and gateway event emission before Docker-only verification. Lucy does not define a repo-local coverage threshold, so new branches and protocol rules should come with adjacent tests.

## Commit & Pull Request Guidelines

This git root currently has no commit history, so there is no Lucy-specific convention to copy. Follow the surrounding OpenClaw style: short, imperative subjects such as `fix(lucy): reject invalid apiKey tokens` or `Lucy: tighten subject validation`. Keep PRs narrow, explain config or transport impact, link related issues, and include manual verification steps or probe output for Docker or channel-status changes.

## Security & Configuration Tips

Never commit real `apiKey`, NATS credentials, or generated `deviceId` values. Use placeholder tokens that still satisfy `^[A-Za-z0-9_-]+$`, because Lucy uses them as NATS subject segments. Keep runtime packages in `dependencies`; keep `openclaw` in `devDependencies` only so plugin installs remain compatible with OpenClaw's loader.

## Notes And Pitfalls

- `docker build` must receive `--build-arg OPENCLAW_EXTENSIONS=lucy`; setting only a shell env var is not enough for the Dockerfile path that installs extension deps.
- For bus-backed adapters such as Lucy, account startup should stay blocked until `abortSignal`. Spawning a background loop and returning early can trigger OpenClaw auto-restart and duplicate inbound handling.
- A green build is not enough. Always check the running container filesystem and `channels status --probe`; when scripting against Lucy probe fields, prefer `gateway call channels.status ... --json`.
- When the gateway container is already restarting, prefer fixing the mounted config file directly over trying to use dependent CLI containers.
