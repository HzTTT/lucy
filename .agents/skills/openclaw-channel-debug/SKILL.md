---
name: openclaw-channel-debug
description: Debug OpenClaw channel plugins when they build but do not run, auto-restart, fail to resolve runtime dependencies in Docker, show up as configured-but-stopped in `channels status --probe`, or pass transport events but fail at provider auth. Use for bundled or private DM channels, especially bus-backed integrations such as NATS with compose-based local deploys.
---

# OpenClaw Channel Debug

## Overview

Use this skill to isolate whether a channel failure lives in plugin code, gateway lifecycle, Docker packaging, transport wiring, or provider auth.

## Debug Flow

1. Prove the plugin before touching deployment.
- Run focused tests for the extension only.
- Run targeted TypeScript checks on the extension files with `--skipLibCheck` so third-party declaration noise does not hide real plugin errors.
- Run formatter/lint only on the extension files.

2. Separate config failure from plugin failure.
- Read gateway logs before changing code.
- Treat fresh-config errors such as missing `gateway.mode=local` as deployment blockers, not plugin bugs.
- If `openclaw-cli` shares `network_mode: service:openclaw-gateway`, do not rely on CLI containers while gateway is crash-looping. Edit the mounted config file directly if needed.
- Prefer a clean `docker compose ... down` and fresh `up -d` when gateway is already in a restart loop.

3. Verify channel runtime lifecycle.
- Use `channels status --probe` after every meaningful change.
- If status says `configured, works, stopped`, inspect `startAccount` first.
- For bus listeners, keep `startAccount` blocked until `abortSignal`; do not spawn a background loop and return early unless the framework explicitly requires it.
- Auto-restart logs like `auto-restart attempt N/10` usually mean the adapter returned too early or threw during startup.

4. Verify runtime dependency visibility inside the container.
- A bundled extension can compile into the image and still fail at runtime with `Cannot find module ...`.
- Inspect both `/app/extensions/<id>/node_modules` and `/app/node_modules/<dep>` inside the running container.
- If the extension depends on workspace symlinks, add an extension-specific compose mount for local deploys, for example `./extensions/<id>/node_modules:/app/extensions/<id>/node_modules`.
- Re-check the container filesystem before re-testing the plugin.

5. Validate transport before model auth.
- Confirm the transport itself first: ports reachable, bus container up, gateway healthy, channel probe says `works`.
- Treat event boundaries as layer markers:
  - `inbound.accepted`: transport and route resolution worked.
  - `assistant.start` or `assistant.partial`: model execution started.
  - `assistant.final` with auth text or upstream 401: the channel is fine; provider auth is the blocker.
- Do not debug the plugin when the real issue is missing or wrong model credentials.

6. Use a long-wait transport probe when short demos hide the truth.
- One-shot demo clients that exit after 1-2 seconds are only good for immediate failures.
- For real verification, publish one inbound message and wait 10-15 seconds for `assistant.final` or timeout.
- Prefer a raw bus subscriber/publisher when you need exact event sequencing.

7. Fix only the layer that is currently failing.
- Startup loop: gateway lifecycle.
- `Cannot find module`: runtime dependency visibility.
- `configured, works, stopped`: listener lifecycle or auto-restart.
- Provider 401 or missing API key: model auth or wrong provider config.
- No `inbound.accepted`: subject mapping, bus reachability, or channel not running.

## Exit Criteria

Consider the debug complete only when all of these are true:
- Focused extension tests pass.
- Targeted TypeScript checks pass.
- `docker compose ... ps` shows the bus and gateway up.
- `channels status --probe` shows the channel `running` and `works`.
- A raw transport probe yields `inbound.accepted` and at least one assistant event.
- Any remaining failure is clearly upstream of the channel, such as provider auth.

## Common Pitfalls

- Passing `OPENCLAW_EXTENSIONS=<id>` as an environment variable to `docker build` is not enough; use `--build-arg OPENCLAW_EXTENSIONS=<id>`.
- A successful Docker build does not prove the extension can resolve its runtime dependencies.
- Shared-network CLI containers are poor debugging tools while the gateway is restarting.
- Repeated accepted/final events for one inbound message often mean the listener is being auto-restarted, not that the bus duplicated the message.
