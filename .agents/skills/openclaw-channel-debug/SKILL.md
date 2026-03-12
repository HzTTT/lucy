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

8. For media bugs, split the path into 4 boundaries and prove each one separately.
- Boundary A, inbound upload: verify the client can upload to Object Store and still get `inbound.accepted`.
- Boundary B, upstream generation: verify whether the model/agent actually emits `assistant.final.media`; do not infer this from a tool result or control-UI transcript.
- Boundary C, outbound channel send: inspect `~/.openclaw/delivery-queue` for failed media sends and read `lastError` before touching plugin code.
- Boundary D, client render/grouping: if a raw `assistant.final` with `media` exists on the wire, the remaining bug is in the client.

9. Treat `delivery-queue` as the source of truth for local-path media failures.
- For local installs, inspect `~/.openclaw/delivery-queue/*.json` and `~/.openclaw/delivery-queue/failed/*.json`.
- If `lastError` says `Local media path is not under an allowed directory`, the bug is neither transport nor provider auth.
- Default safe roots come from OpenClaw state/workspace/tmp roots; a path like `/home/<user>/data/...` will be rejected unless the sender first copies it into an allowed root.

10. Capture raw machine events before claiming a media reply exists.
- Subscribe directly to the channel `machine` subject and log the full JSON.
- Confirm whether the photo reply is a real `assistant.final` with a `media` descriptor, or only a tool result mentioning `mediaUrl`.
- A control-UI or tool transcript that shows `mediaUrl` is not proof the channel client ever received a media event.

11. Watch for direct-send events that do not carry `sourceMessageId`.
- Tool-driven outbound sends such as `message(action=send, filePath=...)` may emit a standalone `assistant.final` with `media` but without `sourceMessageId`.
- If the raw machine event has `media` and no `sourceMessageId`, transport is healthy; clients that key strictly by `sourceMessageId` will silently drop the image.
- Fix the client grouping/rendering path before blaming Lucy.

12. Normalize target ids before building subjects.
- Inspect actual outbound `to` values in tool results and delivery payloads.
- If a tool emits `lucy:demo_user` but the client subscribes to `demo_user`, strip the `lucy:` prefix before computing subjects.
- A subject namespace mismatch can make media appear to "send successfully" while landing on the wrong subject.

13. For non-Docker local installs, prefer local-state inspection over container workflows.
- Check `~/.openclaw/openclaw.json` for the active channel config.
- Check `~/.openclaw/extensions/<id>` for the deployed plugin version and source.
- Use `journalctl --user-unit openclaw-gateway` (or the system unit if applicable) for runtime logs when `~/.openclaw/logs` does not contain gateway output.

## Exit Criteria

Consider the debug complete only when all of these are true:
- Focused extension tests pass.
- Targeted TypeScript checks pass.
- `docker compose ... ps` shows the bus and gateway up.
- `channels status --probe` shows the channel `running` and `works`.
- A raw transport probe yields `inbound.accepted` and at least one assistant event.
- For media incidents, a raw transport probe must also answer whether `assistant.final.media` is present, absent, or rejected before the client sees it.
- Any remaining failure is clearly upstream of the channel, such as provider auth.

## Common Pitfalls

- Passing `OPENCLAW_EXTENSIONS=<id>` as an environment variable to `docker build` is not enough; use `--build-arg OPENCLAW_EXTENSIONS=<id>`.
- A successful Docker build does not prove the extension can resolve its runtime dependencies.
- Shared-network CLI containers are poor debugging tools while the gateway is restarting.
- Repeated accepted/final events for one inbound message often mean the listener is being auto-restarted, not that the bus duplicated the message.
