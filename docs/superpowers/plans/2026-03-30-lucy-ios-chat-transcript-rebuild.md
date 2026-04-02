# Lucy iOS Chat Transcript Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `LucyIOSDemo` chat around an iOS 18 UIKit transcript core so sending, streaming, keyboard motion, and rich media stay smooth while the current user turn anchors near the top of the screen.

**Architecture:** Keep Lucy transport, machine events, onboarding, settings, and device flows intact. Replace the current `ScrollView` transcript with a `UICollectionView`-driven transcript core backed by a new turn/session store, a dedicated streaming turn store, a projection engine, and a media pipeline that only refreshes the affected items. The migration is branch-local: old and new chat code may coexist in source during the rewrite, but the shipped app ends with one iOS-only chat path aligned to `iOS 18.0`.

**Tech Stack:** Swift 6.1, SwiftUI shell, UIKit collection view, diffable data source, XCTest, Xcode project + Swift Package, NATS / JetStream-backed Lucy machine events, AVFoundation, QuickLookThumbnailing

---

## Verification Prerequisite

Use an installed simulator destination from `xcodebuild -showdestinations`. In the current workspace, the stable default is:

```bash
export SIM_DEST='platform=iOS Simulator,name=iPhone 17'
```

If `iPhone 17` is not available on the executor machine, replace `SIM_DEST` with one of the installed destinations shown by `xcodebuild -showdestinations`.

All `xcodebuild ... -project outside/LucyIOSDemo/...` commands below assume the shell is running from:

```bash
/Users/hongzaitou/Project/openclaw/extensions/lucy
```

## Repo Boundary

Implementation files under `outside/LucyIOSDemo/...` live in the separate git repo at:

```bash
/Users/hongzaitou/Project/LucyIOSDemo
```

Run all implementation `git add` / `git commit` steps with:

```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo ...
```

Do not stage or commit `outside/LucyIOSDemo/...` paths from the `extensions/lucy` git root.

## File Map

- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Package.swift`
  Responsibility: align the package to `iOS 18.0`, drop package-level macOS support, register any new source groups implicitly, and keep the package scheme buildable for iOS simulator tests.
- Modify: `outside/LucyIOSDemo/Config/Shared.xcconfig`
  Responsibility: make `IPHONEOS_DEPLOYMENT_TARGET = 18.0` the shared source of truth instead of leaving the current `16.0` / `18.4` split.
- Modify: `outside/LucyIOSDemo/LucyIOSDemo.xcodeproj/project.pbxproj`
  Responsibility: remove ad hoc `18.4` overrides and ensure the app and test targets inherit the aligned deployment target/config.
- Modify: `outside/LucyIOSDemo/LucyIOSDemo/LucyIOSDemoApp.swift`
  Responsibility: only if the app entry needs a lightweight root wiring change after the transcript replacement; avoid business logic here.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ContentView.swift`
  Responsibility: keep the package entry simple while pointing at the rebuilt root path.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
  Responsibility: keep onboarding / ready-state routing, but replace transcript ownership with the new session store + chat container.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyServices.swift`
  Responsibility: keep transport/service clients, remove old transcript persistence from this file, and expose only the reusable network/service seams needed by the new store.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyModels.swift`
  Responsibility: retain wire/config/domain types still needed by transport, but stop growing the old transcript-specific model path.
- Modify then eventually shrink: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRedesignedRootScene.swift`
  Responsibility: preserve the old transcript only as a migration fallback until the new UIKit transcript is live; remove chat responsibilities by the end.

- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyChatSessionStore.swift`
  Responsibility: stable turn list, send lifecycle, machine-event merge, final persistence, notification hooks, and conversation recovery. This becomes the only chat-runtime source of truth.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyStreamingTurnStore.swift`
  Responsibility: isolate the active assistant turn’s temporary reasoning/tool/live-text/media state from the stable session store.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyTranscriptModels.swift`
  Responsibility: define `LucyTurn`, `LucyTurnInput`, `LucyTurnOutput`, `LucyTranscriptSection`, `LucyTranscriptItem`, and item identity rules.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyTranscriptProjectionEngine.swift`
  Responsibility: map session + streaming state into diffable section/item snapshots with item-level refresh boundaries.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyTranscriptPersistenceStore.swift`
  Responsibility: replace `LucyConversationStore` with the new on-disk format; explicit one-time reset is acceptable and old data is not migrated.

- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyChatContainerView.swift`
  Responsibility: SwiftUI shell for header, sheets, ready-state composition, and embedding the UIKit transcript/composer stack.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyChatViewControllerRepresentable.swift`
  Responsibility: bridge SwiftUI state into the UIKit transcript controller.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewController.swift`
  Responsibility: own the collection view, diffable data source, snapshot application, keyboard layout guide, and turn-anchor restoration.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewportController.swift`
  Responsibility: implement `anchoredTurn`, `followingTail`, `manualBrowse`, and `restoringAnchor` state transitions.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyComposerHostView.swift`
  Responsibility: replace the old overlay composer with a dedicated bottom host that shares layout with the transcript.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyComposerState.swift`
  Responsibility: draft text, attachment chip state, focus routing, and send enablement separate from transcript rendering.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyChatSessionStoreProtocol.swift`
  Responsibility: define the mockable session-store contract consumed by the UIKit transcript path and UI tests.

- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyUserMessageCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyReasoningCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyToolGroupCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyApprovalCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyAssistantMarkdownCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyImageGalleryCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyAudioCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyFileCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyTurnStatusCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyTurnFooterCell.swift`
  Responsibility: one cell per transcript item type, each consuming precomputed view models only.

- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/Media/LucyMediaPipeline.swift`
  Responsibility: orchestrate image downsampling, document/video thumbnail generation, cache lookup, and media view model assembly.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/Media/LucyImageDownsampler.swift`
  Responsibility: generate list/preview/fullscreen image variants safely off the main thread.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/Media/LucyFileThumbnailPipeline.swift`
  Responsibility: generate and cache document/video thumbnails with QuickLookThumbnailing.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/Media/LucyMarkdownRenderCache.swift`
  Responsibility: cache completed markdown/table/render artifacts separately from streaming text.

- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyChatSessionStoreTests.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyStreamingTurnStoreTests.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyTranscriptProjectionEngineTests.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyTranscriptPersistenceStoreTests.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyMediaPipelineTests.swift`
  Responsibility: pure logic/store/media coverage for the new core.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`
  Responsibility: keep source-level guard rails for root wiring, package/platform declarations, and transcript entry-point changes.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoUITests/LucyIOSDemoUITests.swift`
  Responsibility: host app launch smoke tests for the rebuilt transcript path.
- Create: `outside/LucyIOSDemo/LucyIOSDemoUITests/LucyTranscriptFlowUITests.swift`
  Responsibility: deterministic iOS-level checks for top anchoring, manual-browse pause/resume, keyboard recovery, and mixed-media refresh behavior.

## Task 0: Capture the Pre-Rewrite Performance Baseline

**Files:**
- Modify: `outside/LucyIOSDemo/LucyIOSDemoUITests/LucyIOSDemoUITests.swift` (only if launch arguments or fixtures are needed)
- Create: `outside/LucyIOSDemo/crash/reports/lucy-chat-baseline-2026-03-30.md`

- [ ] **Step 1: Prepare a repeatable baseline fixture**

Pick one stable test account/device setup and record:
- one text-only conversation used for send-to-first-token timing
- one long-session conversation fixture containing at least `220` turns
- one mixed-media conversation containing image, audio, and document messages
- one keyboard stress path (focus, dismiss, refocus while streaming)
- one continuous streaming path that stays active for at least `30` seconds

If `outside/LucyIOSDemo/crash/reports/` does not exist, create it before recording the baseline report.

- [ ] **Step 2: Measure the old transcript behavior before any rewrite work**

Run the app in simulator and capture:
- `20` repeated send-to-first-token samples so a rough P95 can be computed
- keyboard open/close feel and any visible jump distance
- long-session (`220+` turns) scroll smoothness
- mixed-media scroll smoothness
- the continuous streaming path for at least `30` seconds
- any 1 second+ hangs

Record the measurements in:
`outside/LucyIOSDemo/crash/reports/lucy-chat-baseline-2026-03-30.md`

- [ ] **Step 3: Build the baseline app before changing code**

Run:
```bash
xcodebuild build \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemo \
  -destination 'generic/platform=iOS Simulator'
```
Expected: BUILD SUCCEEDED

- [ ] **Step 4: Commit the baseline notes if they contain repo-tracked artifacts**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add crash/reports/lucy-chat-baseline-2026-03-30.md
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```
Only if the baseline report is intentionally kept in git; otherwise skip the commit and keep the measurements available for later comparison.

## Task 1: Align Platform Targets and Lock the Rewrite Surface

**Files:**
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Package.swift`
- Modify: `outside/LucyIOSDemo/Config/Shared.xcconfig`
- Modify: `outside/LucyIOSDemo/LucyIOSDemo.xcodeproj/project.pbxproj`
- Test: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Add failing source assertions for the deployment-target cleanup**

Add or extend `LucyIOSDemoFeatureTests.swift` with assertions that require:
- `Package.swift` to declare `.iOS(.v18)` only
- `Package.swift` to no longer declare `.macOS(.v13)`
- `Config/Shared.xcconfig` to set `IPHONEOS_DEPLOYMENT_TARGET = 18.0`
- `project.pbxproj` to stop hardcoding `18.4`

- [ ] **Step 2: Run the source assertions and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests
```
Expected: FAIL on the new target-alignment assertions because the project still declares mixed deployment settings.

- [ ] **Step 3: Make `iOS 18.0` the only supported deployment target**

Apply the minimal config changes:
- set `Package.swift` platforms to `.iOS(.v18)` only
- remove the package-level macOS platform declaration
- set `Config/Shared.xcconfig` to `IPHONEOS_DEPLOYMENT_TARGET = 18.0`
- remove `18.4` project overrides so the Xcode targets inherit the shared config cleanly

- [ ] **Step 4: Re-run the target-alignment tests**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests
```
Expected: PASS for the target-alignment assertions.

- [ ] **Step 5: Commit the platform cleanup**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Package.swift \
  Config/Shared.xcconfig \
  LucyIOSDemo.xcodeproj/project.pbxproj \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```
Use a Lore-protocol message focused on why deployment-target alignment must happen before the transcript rewrite.

## Task 2: Introduce the New Turn and Persistence Core

**Files:**
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyTranscriptModels.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyTranscriptPersistenceStore.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyServices.swift`
- Test: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyTranscriptPersistenceStoreTests.swift`

- [ ] **Step 1: Write failing tests for the new turn model and non-migrating persistence**

Add tests covering:
- saving/loading a stable `[LucyTurn]`
- request attachments and downloaded media persist in the new format
- a missing or invalid old `LucyConversationStore` file results in a clean reset instead of a migration attempt
- identity values remain stable across save/load

- [ ] **Step 2: Run the focused persistence tests and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyTranscriptPersistenceStoreTests
```
Expected: FAIL because the new transcript model and persistence store do not exist yet.

- [ ] **Step 3: Create the minimal turn model and persistence store**

Implement:
```swift
struct LucyTurn: Identifiable, Equatable, Codable { ... }
struct LucyTurnInput: Equatable, Codable { ... }
struct LucyTurnOutput: Equatable, Codable { ... }
final class LucyTranscriptPersistenceStore { ... }
```
Keep the first cut Foundation-first. Do not wire UI or streaming yet.

- [ ] **Step 4: Remove transcript persistence responsibility from `LucyServices.swift`**

Do not delete `LucyConversationStore` yet. Instead:
- move real new-model persistence ownership into `LucyTranscriptPersistenceStore`
- keep `LucyConversationStore` behavior unchanged for the old `LucyConversation` / `LucyReplyState` path until final cutover
- do not invent an intermediate two-way adapter between `LucyConversation` and `[LucyTurn]`
- stop adding new behavior to `LucyConversationStore`; it survives only to keep the legacy path building during migration

- [ ] **Step 5: Re-run the persistence tests**

Run the Task 2 command again.  
Expected: PASS

- [ ] **Step 6: Commit the new persistence baseline**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyTranscriptModels.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyTranscriptPersistenceStore.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyServices.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyTranscriptPersistenceStoreTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 3: Lock Store Ownership Boundaries Before UI Migration

**Files:**
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyChatSessionStoreProtocol.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
- Test: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Add failing source assertions for ownership boundaries**

Require source assertions that prove:
- `LucyAppModel` keeps onboarding / ready-state / device / settings shell responsibilities only
- send flow, NATS event consumption, streaming merge, persistence, and notification hooks are planned to move into `LucyChatSessionStore`
- the UI layer depends on a mockable `LucyChatSessionStoreProtocol`, not on a concrete `LucyAppModel` transcript API

- [ ] **Step 2: Run the ownership assertions and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests
```
Expected: FAIL because the ownership boundary and protocol do not exist yet.

- [ ] **Step 3: Create the protocol and document the split in code**

Create:
```swift
@MainActor
protocol LucyChatSessionStoreProtocol: AnyObject {
    var turns: [LucyTurn] { get }
    var activeStreamingTurnID: String? { get }
    func sendDraft(...)
    func connectIfNeeded()
}
```
Update `LucyRootView.swift` comments / seams so the shell-vs-chat-runtime split is explicit before the UI rewrite starts.

- [ ] **Step 4: Re-run the ownership assertions**

Run the Task 3 command again.  
Expected: PASS

- [ ] **Step 5: Commit the ownership boundary**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyChatSessionStoreProtocol.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 4: Isolate Streaming State and Build the Projection Engine

**Files:**
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyStreamingTurnStore.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyTranscriptProjectionEngine.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyStreamingTurnStoreTests.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyTranscriptProjectionEngineTests.swift`

- [ ] **Step 1: Write failing tests for streaming isolation**

Add tests covering:
- streaming text updates do not mutate stable `LucyTurnOutput` until finalize
- reasoning/tool/approval/media states merge into one active turn
- finalize flushes the streaming turn into stable output once
- duplicate finalization does not create duplicate transcript items

- [ ] **Step 2: Write failing tests for transcript projection**

Add tests covering:
- one turn maps to one section
- `userMessage`, `reasoning`, `toolGroup`, `assistantText`, `imageGallery`, `audioCard`, `fileCard`, `error`, and `turnFooter` items project in the correct order
- item identities stay stable when only text/media payload changes
- image gallery and tool group updates only affect the corresponding item identities

- [ ] **Step 3: Run the focused core tests and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyStreamingTurnStoreTests \
  -only-testing:LucyIOSDemoFeatureTests/LucyTranscriptProjectionEngineTests
```
Expected: FAIL because the new streaming store and projection engine do not exist yet.

- [ ] **Step 4: Implement the minimal streaming store**

Implement a focused API such as:
```swift
@MainActor
final class LucyStreamingTurnStore {
    func begin(turnID: String, ...)
    func apply(event: LucyMachineEvent)
    func finalize() -> LucyTurnOutput?
    func reset()
}
```

- [ ] **Step 5: Implement the projection engine**

Implement:
```swift
// in LucyTranscriptModels.swift
enum LucyTranscriptItem: Hashable { ... }
struct LucyTranscriptSection: Hashable { ... }

// in LucyTranscriptProjectionEngine.swift
enum LucyTranscriptProjectionEngine {
    static func makeSnapshot(turns: [LucyTurn], streaming: LucyStreamingTurnStore?) -> [LucyTranscriptSection]
}
```
Do not touch UIKit or SwiftUI yet.

- [ ] **Step 6: Re-run the core tests**

Run the Task 4 command again.  
Expected: PASS

- [ ] **Step 7: Commit the isolated transcript core**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyStreamingTurnStore.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyTranscriptProjectionEngine.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyStreamingTurnStoreTests.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyTranscriptProjectionEngineTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 5: Build `LucyChatSessionStore` Around the Existing Transport

**Files:**
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyChatSessionStore.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyChatSessionStoreProtocol.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
- Test: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyChatSessionStoreTests.swift`

- [ ] **Step 1: Write failing session-store tests**

Add tests covering:
- `sendDraft()` creates a new turn with a stable input id
- machine events route into the active streaming turn
- `assistant.final` commits exactly once into the stable turn list
- old local history reset is tolerated on first launch
- notification hooks still trigger only after final conversation resolution

- [ ] **Step 2: Run the focused session tests and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyChatSessionStoreTests
```
Expected: FAIL because `LucyChatSessionStore` does not exist yet.

- [ ] **Step 3: Implement the first `LucyChatSessionStore`**

Wrap the existing `LucyNatsSession`, notification service, and persistence store behind one store API:
```swift
@MainActor
final class LucyChatSessionStore: ObservableObject, LucyChatSessionStoreProtocol {
    @Published private(set) var turns: [LucyTurn] = []
    let streamingStore: LucyStreamingTurnStore
    func connectIfNeeded()
    func sendDraft(...)
    func consume(event: LucyMachineEvent)
}
```

`LucyChatSessionStore` owns:
- send flow
- NATS event consumption
- streaming merge/finalize
- new-model persistence
- notification hooks

`LucyAppModel` keeps only:
- onboarding state
- ready/onboarding routing
- device/presence shell state
- settings / sheet shell state until later extraction

- [ ] **Step 4: Rewire `LucyRootView` to own the new session store**

Keep onboarding and device-state logic in `LucyRootView.swift`, but stop letting it own transcript rendering concerns. The old `conversations` array should stop being the primary transcript source once the new store exists.

During this task, keep the old `conversations` / `LucyRedesignedRootScene` path rendering the visible transcript until Task 6 mounts `LucyChatContainerView`. The new session store should exist in parallel first, without breaking the currently shipped ready-state UI.

- [ ] **Step 5: Re-run the session-store tests**

Run the Task 5 command again.  
Expected: PASS

- [ ] **Step 6: Commit the session-store migration**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyChatSessionStoreProtocol.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatCore/LucyChatSessionStore.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyChatSessionStoreTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 6: Scaffold the UIKit Transcript Container and Temporary Migration Entry

**Files:**
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyChatContainerView.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyChatViewControllerRepresentable.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewController.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ContentView.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Add failing source assertions for the new transcript entry path**

Require source assertions that prove:
- `LucyRootView` can mount `LucyChatContainerView`
- `LucyChatContainerView` embeds a representable/UIViewController path
- the temporary migration access path is branch-only and not a long-lived runtime feature flag

- [ ] **Step 2: Run the root wiring assertions and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests
```
Expected: FAIL on the new transcript-entry assertions.

- [ ] **Step 3: Implement the container skeleton**

Create the minimal UIKit bridge:
```swift
struct LucyChatContainerView: View { ... }
struct LucyChatViewControllerRepresentable: UIViewControllerRepresentable { ... }
final class LucyTranscriptViewController: UIViewController { ... }
```
At this stage:
- render a placeholder collection view fed by the projection engine
- consume `LucyChatSessionStoreProtocol` instead of a concrete runtime type
- add the `DEBUG`-only initializer/factory seam in `ContentView` / `LucyRootView` so UI tests can inject a mock session store before final cutover

- [ ] **Step 4: Build the app and package shell**

Run:
```bash
xcodebuild build \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemo \
  -destination 'generic/platform=iOS Simulator'
```
Expected: BUILD SUCCEEDED with the new container mounted.

- [ ] **Step 5: Commit the transcript shell**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyChatContainerView.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyChatViewControllerRepresentable.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewController.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ContentView.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 7: Implement Top-Anchored Viewport Behavior and Diffable Snapshot Updates

**Files:**
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewportController.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewController.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Add failing source assertions for viewport state transitions**

Require source assertions for:
- `anchoredTurn`
- `followingTail`
- `manualBrowse`
- `restoringAnchor`
- a code path that scrolls the just-sent user turn near the top instead of always snapping to bottom

- [ ] **Step 2: Run the viewport assertions and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests
```
Expected: FAIL because the viewport controller does not exist yet.

- [ ] **Step 3: Implement the viewport controller**

Create:
```swift
enum LucyViewportMode { case anchoredTurn, followingTail, manualBrowse, restoringAnchor }
final class LucyTranscriptViewportController { ... }
```
It should accept scroll metrics and return precise snapshot/scroll commands for the transcript view controller.

- [ ] **Step 4: Wire diffable snapshots and top-anchor behavior into the view controller**

Update `LucyTranscriptViewController` to:
- build section snapshots from the projection engine
- apply item-level refreshes only
- scroll the new user turn near the top on send
- suspend auto-follow when the user manually browses

- [ ] **Step 5: Run a simulator build and a manual smoke check**

Run:
```bash
xcodebuild build \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemo \
  -destination 'generic/platform=iOS Simulator'
```
Expected: BUILD SUCCEEDED  
Manual check: the placeholder transcript can scroll without bottom-snapping logic.

- [ ] **Step 6: Commit viewport control**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewportController.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewController.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 8: Replace the Overlay Composer With a Shared Keyboard Layout Host

**Files:**
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyComposerState.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyComposerHostView.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyChatContainerView.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewController.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Write failing source assertions for composer/keyboard ownership**

Require proof that:
- the new composer is not an overlay on the transcript scroll view
- transcript and composer share one layout stack
- keyboard behavior flows through `keyboardLayoutGuide` or equivalent container constraints, not the old hand-computed inset path

- [ ] **Step 2: Run the composer assertions and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests
```
Expected: FAIL because the old overlay composer still owns keyboard motion.

- [ ] **Step 3: Create the new composer host and state**

Create:
```swift
@MainActor final class LucyComposerState: ObservableObject { ... }
struct LucyComposerHostView: View { ... }
```
Move draft text, attachment chip state, and send enablement here, not inside the old transcript scene.

- [ ] **Step 4: Wire transcript + composer into one shared host layout**

Update the UIKit transcript controller/container so keyboard movement adjusts the whole transcript/composer stack while preserving the current top-anchored turn.

- [ ] **Step 5: Build and manually verify keyboard motion**

Run:
```bash
xcodebuild build \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemo \
  -destination 'generic/platform=iOS Simulator'
```
Expected: BUILD SUCCEEDED  
Manual check: keyboard open/close does not create white gaps or reverse jumps.

- [ ] **Step 6: Commit the composer migration**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyComposerState.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyComposerHostView.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyChatContainerView.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewController.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 9: Port Transcript Item Rendering Into Focused Cells

**Files:**
- Create: all files under `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewController.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRichMarkdownRendering.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Add failing source assertions for dedicated cell ownership**

Require source assertions proving that:
- user / reasoning / tool / approval / assistant markdown / image / audio / file rendering no longer all live inside `LucyRedesignedRootScene.swift`
- transcript cells are registered from dedicated files
- markdown rendering for streaming vs final output uses separate paths

- [ ] **Step 2: Run the source assertions and verify failure**

Run the same `xcodebuild test ... LucyIOSDemoFeatureTests` command as above.  
Expected: FAIL because the old giant scene file still owns rendering.

- [ ] **Step 3: Retire legacy scene assertions that no longer fit the new ownership**

Update `LucyIOSDemoFeatureTests.swift` in the same task so that:
- source assertions still protecting real markdown/media behavior remain
- assertions that require transcript ownership to stay in `LucyRedesignedRootScene.swift` are deleted or rewritten against the new cell/controller files

- [ ] **Step 4: Implement the first-pass cells**

Create each cell with one responsibility only:
- `LucyUserMessageCell`
- `LucyReasoningCell`
- `LucyToolGroupCell`
- `LucyApprovalCell`
- `LucyAssistantMarkdownCell`
- `LucyTurnStatusCell`
- `LucyTurnFooterCell`

Keep media cells stubbed until Task 9 if needed, but register the item types now.

- [ ] **Step 5: Move markdown rendering behind `LucyAssistantMarkdownCell`**

Update `LucyRichMarkdownRendering.swift` so:
- streaming text uses the lightweight path
- final text uses cached rich rendering
- the transcript controller/cell consumes prebuilt view models, not raw event state

- [ ] **Step 6: Re-run build and focused source tests**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests
```
Expected: PASS for the transcript ownership assertions.

- [ ] **Step 7: Commit transcript cells**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyTranscriptViewController.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRichMarkdownRendering.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 10: Add the Media Pipeline and Media Cells

**Files:**
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/Media/LucyMediaPipeline.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/Media/LucyImageDownsampler.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/Media/LucyFileThumbnailPipeline.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/Media/LucyMarkdownRenderCache.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyImageGalleryCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyAudioCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyFileCell.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyMediaPipelineTests.swift`

- [ ] **Step 1: Write failing media-pipeline tests**

Cover:
- image downsampling returns list-sized variants instead of raw originals
- document/video thumbnails cache by stable key
- media completion refresh only touches the affected item view model
- markdown cache keys change when content hash changes

- [ ] **Step 2: Run the focused media tests and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyMediaPipelineTests
```
Expected: FAIL because the pipeline and media cells do not exist yet.

- [ ] **Step 3: Implement the media pipeline**

Create:
```swift
enum LucyMediaPipeline { ... }
enum LucyImageDownsampler { ... }
final class LucyFileThumbnailPipeline { ... }
final class LucyMarkdownRenderCache { ... }
```
Keep heavy work off the main actor.

- [ ] **Step 4: Implement the media cells**

Create:
- `LucyImageGalleryCell`
- `LucyAudioCell`
- `LucyFileCell`

Requirements:
- image list uses downsampled variants only
- document/video cards use generated thumbnails
- audio playback state stays local to the cell/controller and does not mutate transcript state on every tick

- [ ] **Step 5: Re-run the media tests and build**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyMediaPipelineTests

xcodebuild build \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemo \
  -destination 'generic/platform=iOS Simulator'
```
Expected: TEST SUCCEEDED and BUILD SUCCEEDED

- [ ] **Step 6: Commit the media pipeline**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/Media \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyImageGalleryCell.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyAudioCell.swift \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/Cells/LucyFileCell.swift \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyMediaPipelineTests.swift
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 11: Swap the App to the New Transcript Path and Remove the Old Chat Core

**Files:**
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ContentView.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRedesignedRootScene.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyModels.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyServices.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoUITests/LucyIOSDemoUITests.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoUITests/LucyTranscriptFlowUITests.swift`

- [ ] **Step 1: Add failing source assertions for old-path removal**

Require source assertions that:
- `LucyRootView` routes ready-state chat through the new container
- `LucyRedesignedRootScene.swift` no longer owns transcript rendering and auto-scroll logic
- old conversation/transcript persistence calls are gone

- [ ] **Step 2: Run the root-removal assertions and verify failure**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}" \
  -only-testing:LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests
```
Expected: FAIL because the old path is still present.

- [ ] **Step 3: Make the new transcript the only chat path**

Update the ready-state flow so `LucyChatContainerView` is the one shipped chat transcript. Remove the migration-only branch entry and delete old transcript logic from `LucyRedesignedRootScene.swift` / related model code.

At the same time, migrate the legacy tests that still assume the old transcript path:
- delete or rewrite old `LucyConversationStore()` behavioral tests
- delete or rewrite old `LucyRedesignedRootScene` source assertions
- keep only assertions that still protect real post-rebuild behavior

- [ ] **Step 4: Add deterministic UI tests for anchored-turn behavior**

Create `LucyTranscriptFlowUITests.swift` with at least these checks:
- send one message and assert the newest user turn is visible near the top working area
- start manual browsing and assert auto-follow does not immediately snap back
- refocus / dismiss keyboard during an active assistant stream and assert the transcript stays usable

Add a deterministic fixture seam while doing this:
- add a `DEBUG`-only app bootstrap path where `ContentView` / `LucyRootView` reads launch arguments or environment values from `XCUIApplication`
- use those values to construct an internal mock `LucyChatSessionStoreProtocol` implementation with canned transcript fixtures
- keep the seam `DEBUG`-only and branch-local
- avoid introducing a long-lived product feature flag just for transcript testing

- [ ] **Step 5: Re-run full package + app verification**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}"

xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemo \
  -destination "${SIM_DEST}"

xcodebuild build \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemo \
  -destination 'generic/platform=iOS Simulator'
```
Expected: TEST SUCCEEDED and BUILD SUCCEEDED

- [ ] **Step 6: Perform manual simulator validation**

Manual checklist:
- send a text-only message and confirm the user turn anchors near the top
- confirm assistant streaming grows downward without bottom snapping
- open/close keyboard while streaming
- send an image, an audio file, and a document
- manually browse away from the current turn and confirm auto-follow pauses
- return to the active turn and confirm follow resumes

- [ ] **Step 7: Compare against the baseline metrics**

Re-run the Task 0 baseline paths and compare against
`outside/LucyIOSDemo/crash/reports/lucy-chat-baseline-2026-03-30.md`.
Do not declare the rewrite done until:
- `20` repeated send-to-first-token samples show latency no worse than baseline at P95
- the `220+` turn long-session fixture still scrolls without new 1 second+ hangs
- no 1 second+ hangs appear in the mixed-media path
- the `30` second continuous streaming path remains usable throughout
- the sent user bubble remains in the upper third of the visible transcript after send
- keyboard refocus / dismiss does not create a white gap or shift the anchored turn by more than one bubble height

- [ ] **Step 8: Commit the final transcript cutover**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add \
  LucyIOSDemoPackage/Sources/LucyIOSDemoFeature \
  LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift \
  LucyIOSDemoUITests
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```

## Task 12: Final QA, Cleanup, and Documentation Notes

**Files:**
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift` (only if QA exposes cleanup fixes)
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/ChatUI/LucyChatContainerView.swift` (only if QA exposes cleanup fixes)
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/*` as needed
- Modify: `outside/LucyIOSDemo/LucyIOSDemoUITests/*` as needed

- [ ] **Step 1: Run the full verification suite one more time**

Run:
```bash
xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemoFeature \
  -destination "${SIM_DEST}"

xcodebuild test \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemo \
  -destination "${SIM_DEST}"

xcodebuild build \
  -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj \
  -scheme LucyIOSDemo \
  -destination 'generic/platform=iOS Simulator'
```
Expected: TEST SUCCEEDED and BUILD SUCCEEDED

- [ ] **Step 2: Capture any last-mile fixes as separate tiny commits**

If verification exposes issues, fix one issue at a time:
- write/extend the failing test
- implement the smallest fix
- re-run only the affected verification
- commit

- [ ] **Step 3: Summarize migration results**

Document in the final execution handoff:
- which files were deleted/split from the old transcript
- that the old local transcript store was intentionally reset, not migrated
- what verification was run

- [ ] **Step 4: Final commit if needed**

Run:
```bash
git -C /Users/hongzaitou/Project/LucyIOSDemo add -A
git -C /Users/hongzaitou/Project/LucyIOSDemo commit
```
Only if Task 11 introduced real cleanup changes beyond prior commits.
