# Lucy Media Kinds Design

**Date:** 2026-03-27

**Goal**

Make Lucy align with OpenClaw's media model so the plugin and `LucyIOSDemo` can carry more than image uploads. Lucy should support the same four media kinds the host already recognizes: `image`, `audio`, `video`, and `document`.

**Current State**

- OpenClaw host media utilities already recognize `image`, `audio`, `video`, and `document`.
- Lucy protocol and transport currently allow only `image` and `audio`.
- `LucyIOSDemo` currently limits picking and local loading to images and audio-like attachments, with image-first UI affordances.
- The Lucy repository also has a small amount of local baseline friction in an isolated worktree:
  - two real failing vitest tests
  - no repo-local test/typecheck tooling configuration for standalone worktree use

**Design**

1. Align Lucy protocol kinds with OpenClaw host kinds.

- Extend Lucy media descriptor schemas and runtime types from `image | audio` to `image | audio | video | document`.
- Keep JetStream Object Store transport unchanged.
- Preserve descriptor shape so old code paths continue to work for image/audio.

2. Align Lucy media inference with MIME-first classification.

- `image/* -> image`
- `audio/* -> audio`
- `video/* -> video`
- `text/* -> document`
- `application/* -> document`

Filename-based fallback remains only for local convenience when MIME is missing.

3. Keep Lucy UI handling simple.

- `LucyIOSDemo` keeps dedicated renderers for `image` and `audio`.
- `video` and `document` first ship as generic file cards with name, content type, local/open affordances, and download support.
- This avoids coupling protocol support to a full video playback feature.

4. Stabilize the local baseline before the feature work.

- Fix the two real failing vitest tests by correcting the false-positive SDK import detector and the incorrect exec-approval "unconfigured" test setup.
- Add minimal repo-local tooling so this isolated Lucy worktree can run targeted tests and typechecks without depending on the parent OpenClaw workspace.

**Files in Scope**

- Plugin protocol and transport:
  - `src/types.ts`
  - `src/media.ts`
  - `src/outbound-media.ts`
  - `src/gateway.ts`
  - `src/send.ts`
  - `scripts/demo-chat.ts`
- Plugin tests:
  - `src/channel.test.ts`
  - `src/gateway.test.ts`
  - `src/sdk-compat.test.ts`
  - new or updated media inference tests as needed
- Local tooling baseline:
  - `package.json`
  - `tsconfig.json` if needed
- iOS Demo:
  - `LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyModels.swift`
  - `LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyServices.swift`
  - `LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRedesignedRootScene.swift`
  - iOS tests if present or added

**Non-Goals**

- Changing Lucy transport away from JetStream Object Store
- Adding rich video playback UX in the first pass
- Raising Lucy's 20 MB limit in the same change
- Redesigning OpenClaw host media APIs

**Verification**

- Local baseline:
  - targeted vitest for `src/*.test.ts` passes
  - repo-local typecheck command passes in the isolated worktree
- Plugin media behavior:
  - document/video media descriptors parse and round-trip
  - inbound media save path accepts document/video content types
  - outbound assistant media upload accepts document/video sources
- Demo behavior:
  - `LucyIOSDemo` can pick at least one document type and one video type
  - picked attachments serialize, publish, receive, and render as generic file cards when not image/audio
