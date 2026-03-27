# Lucy Media Kinds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize Lucy's isolated worktree baseline, then extend Lucy and `LucyIOSDemo` to support OpenClaw's four media kinds: `image`, `audio`, `video`, and `document`.

**Architecture:** First fix only the real baseline regressions and add minimal local tooling so tests and typechecks are trustworthy inside the standalone Lucy worktree. Then extend the Lucy media descriptor and MIME inference path end-to-end, while keeping iOS rendering simple by using dedicated image/audio UI and generic file cards for video/document.

**Tech Stack:** TypeScript ESM, Vitest, Zod, NATS JetStream Object Store, SwiftUI, UniformTypeIdentifiers

---

### Task 1: Fix the Two Real Vitest Baseline Failures

**Files:**
- Modify: `src/sdk-compat.test.ts`
- Modify: `src/channel.test.ts`

- [ ] **Step 1: Add a failing test for the SDK import detector false positive**

Add a focused assertion in `src/sdk-compat.test.ts` proving that a leading comment before `import type ... from "openclaw/plugin-sdk"` must not be treated as a runtime import.

- [ ] **Step 2: Run the focused SDK compatibility test and verify the new assertion fails**

Run: `./node_modules/.bin/vitest run src/sdk-compat.test.ts`
Expected: FAIL because the helper still flags the comment-prefixed `import type` statement.

- [ ] **Step 3: Fix the import detector with the smallest parser change**

Update the helper so it strips leading comments or otherwise recognizes `import type` statements correctly without weakening the runtime-import guard.

- [ ] **Step 4: Re-run the focused SDK compatibility test**

Run: `./node_modules/.bin/vitest run src/sdk-compat.test.ts`
Expected: PASS

- [ ] **Step 5: Correct the exec approval "unconfigured" test fixture**

Change `src/channel.test.ts` so the "disabled" case uses actually invalid Lucy config, for example an invalid `channelUserKey`, instead of an empty `channels` section that Lucy currently treats as structurally configured.

- [ ] **Step 6: Run the focused exec approval test**

Run: `./node_modules/.bin/vitest run src/channel.test.ts -t "lucyPlugin.execApprovals"`
Expected: PASS

- [ ] **Step 7: Run the targeted baseline suite**

Run: `./node_modules/.bin/vitest run src/*.test.ts`
Expected: PASS for all `*.test.ts` files.

### Task 2: Add Minimal Repo-Local Standalone Tooling

**Files:**
- Modify: `package.json`
- Create or Modify: `tsconfig.json`
- Optionally modify: `.gitignore` only if generated artifacts need ignoring

- [ ] **Step 1: Write the failing repo-local typecheck command expectation**

Capture the exact desired command in the plan and run it before adding config:

Run: `./node_modules/.bin/tsc --noEmit`
Expected: FAIL because the repo currently has no local TypeScript configuration suitable for ESM plugin development.

- [ ] **Step 2: Add the minimum local dev tooling**

Add repo-local `typescript` and `vitest` dev dependencies if needed, plus a `tsconfig.json` with Node ESM-friendly settings sufficient for Lucy source and tests.

- [ ] **Step 3: Add package scripts for repeatable standalone verification**

Add scripts such as:
- `test:unit`
- `typecheck`

- [ ] **Step 4: Run the repo-local typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Re-run the repo-local test suite**

Run: `npm run test:unit`
Expected: PASS

### Task 3: Extend Lucy Media Schema and Inference

**Files:**
- Modify: `src/types.ts`
- Modify: `src/media.ts`
- Modify: `src/outbound-media.ts`
- Test: add or extend media-related tests near the touched files

- [ ] **Step 1: Add a failing test for new media kinds**

Add tests proving Lucy media schema and MIME inference accept:
- `video/mp4 -> video`
- `application/pdf -> document`
- `text/plain -> document`

- [ ] **Step 2: Run the focused media tests and verify failure**

Run the new focused vitest command for the edited media test file.
Expected: FAIL because Lucy currently only supports `image` and `audio`.

- [ ] **Step 3: Extend Lucy media kinds in `src/types.ts`**

Update Zod schemas and exported runtime types to include `video` and `document`.

- [ ] **Step 4: Extend MIME and filename inference in transport helpers**

Update `src/media.ts` and `src/outbound-media.ts` to classify video and document media correctly while preserving current image/audio behavior.

- [ ] **Step 5: Re-run the focused media tests**

Expected: PASS

### Task 4: Update Lucy Message Handling and Demo Script

**Files:**
- Modify: `src/gateway.ts`
- Modify: `src/send.ts` if needed for placeholders or typing
- Modify: `scripts/demo-chat.ts`
- Modify: related tests such as `src/gateway.test.ts`

- [ ] **Step 1: Add a failing test for non-image/audio inbound or outbound media**

Add a test showing Lucy can accept or emit a `document` or `video` descriptor without throwing unsupported-media errors.

- [ ] **Step 2: Run the focused gateway or demo-related test**

Expected: FAIL with current `image | audio` assumptions.

- [ ] **Step 3: Implement the minimal message-handling changes**

Allow the new media kinds through inbound placeholder generation, outbound upload selection, and the demo script descriptor builder.

- [ ] **Step 4: Re-run the focused tests**

Expected: PASS

### Task 5: Extend `LucyIOSDemo` Attachment Picking and Rendering

**Files:**
- Modify: `LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyModels.swift`
- Modify: `LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyServices.swift`
- Modify: `LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRedesignedRootScene.swift`
- Modify or add: iOS tests if practical in the current repo setup

- [ ] **Step 1: Add a failing unit-level test or narrow reproduction for kind inference**

Cover at least:
- PDF as `document`
- MP4 as `video`

- [ ] **Step 2: Run the focused iOS test or reproduction**

Expected: FAIL because iOS models currently only define `image` and `audio`.

- [ ] **Step 3: Extend iOS media kinds and attachment loading**

Update `LucyMediaKind`, `LucyMediaLoader`, and picker flows so Files-based selection can load document/video attachments while preserving current image picking.

- [ ] **Step 4: Keep rendering intentionally simple**

Preserve image/audio specialized cards, and route video/document to the generic file-card path with filename and content-type display.

- [ ] **Step 5: Re-run the focused iOS verification**

Expected: PASS

### Task 6: Final Verification

**Files:**
- No new files required beyond earlier tasks

- [ ] **Step 1: Run repo-local unit tests**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 2: Run repo-local typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run targeted media regression tests**

Run the focused vitest commands for schema, gateway, and channel media behavior.
Expected: PASS

- [ ] **Step 4: Summarize any residual risks**

Document anything intentionally deferred, especially large-file limits and rich video playback UX.
