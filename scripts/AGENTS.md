<!-- Parent: ../AGENTS.md -->

# scripts — Lucy debugging and testing tools

## Purpose

This directory contains debugging, testing, and diagnostic scripts for the Lucy channel plugin. See `doc/debugging.md` for full usage documentation, examples, and the debugging decision tree.

## Key files

| File | Description |
|------|-------------|
| `e2e-probe.mjs` | End-to-end probe: login via user-center, connect NATS, publish 4 test cases (plain reply, reasoning, tool use, greeting), verify full event chain. The primary "is Lucy alive?" script. |
| `correlation-probe.mjs` | Sends a message with a unique tag and waits for the tag to appear in `assistant.final`. Verifies message correlation and rules out cross-talk. |
| `consumer-info.mjs` | Dumps JetStream `IM_NPC` stream and `npc-<cdi>` consumer state (pending, ack, sequence numbers). Diagnoses message backlog or stalled consumers. |
| `demo-chat.ts` | Interactive/one-shot NATS chat client with media upload/download support. Connects directly to NATS (user/pass auth). Used for manual testing and CI smoke tests. |
| `raw-event-probe.mjs` | Docker-oriented event probe: reads config and device state from container paths, runs 6 test cases, outputs JSON report. |
| `print-probe-fields.mjs` | Parses config and device state to output runtime probe fields (`channelDeviceId`, `clientSubject`, `machineSubject`, `mediaBucket`) as JSON. |
| `auth-qrcode.ts` | Generates Lucy device binding QR code and URI. Reads local device state, outputs `channel_device_id`, binding URI, and terminal QR code. |

## Agent guidance

### Running scripts

- Probe scripts (`e2e-probe.mjs`, `correlation-probe.mjs`, `consumer-info.mjs`): run with `node` from the `extensions/lucy/` directory. They authenticate via user-center and do not require direct NATS access.
- TypeScript scripts (`demo-chat.ts`, `auth-qrcode.ts`): run with `pnpm exec tsx scripts/<name>.ts`.
- Diagnostic scripts (`print-probe-fields.mjs`, `raw-event-probe.mjs`): run with `node`. Respect env vars `OPENCLAW_CONFIG_PATH`, `LUCY_DEVICE_STATE_PATH`, `OPENCLAW_STATE_DIR`.

### When to use which script

1. **Quick health check** → `e2e-probe.mjs` (always start here)
2. **Message routing correctness** → `correlation-probe.mjs`
3. **Consumer backlog / stuck messages** → `consumer-info.mjs`
4. **Manual interactive testing** → `demo-chat.ts`
5. **Docker/container validation** → `raw-event-probe.mjs`
6. **Config verification** → `print-probe-fields.mjs`
7. **Device binding** → `auth-qrcode.ts`

### Modification rules

- All probe scripts read credentials from `/tmp/lucy-client-home/data/lucy_im/channel_ids/`. Do not hardcode `cdi`, `user_id`, or `cuk` values.
- `demo-chat.ts` and `raw-event-probe.mjs` use direct NATS user/pass authentication. The probe scripts (`e2e-probe.mjs`, `correlation-probe.mjs`, `consumer-info.mjs`) use user-center login + lucy-server token exchange. Keep these two auth paths consistent when modifying.
- NATS subject format: `cephalon.im.npc.<user_id>.<cdi>` (inbound to NPC), `cephalon.im.user.<user_id>` (outbound from NPC). Do not change without updating both probe scripts and `src/gateway.ts`.
