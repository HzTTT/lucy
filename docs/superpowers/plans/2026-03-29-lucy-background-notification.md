# Lucy Background Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-phase local background notifications to `LucyIOSDemo` so the selected Lucy device can notify the user when an `assistant.final` event arrives while the app is not active.

**Architecture:** Keep Lucy transport and machine events unchanged. Add a dedicated `LucyNotificationService` in the iOS feature package, wire it into `LucyAppModel` after conversation resolution, and keep the UI changes minimal: one settings section plus one pending-notification scroll path in the root scene.

**Tech Stack:** SwiftUI, Foundation, UserNotifications, XCTest, Swift Package Manager, NATS-backed Lucy machine events

---

## File Map

- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyNotificationService.swift`
  Responsibility: notification policy, dedupe, local delivery wrapper, permission state, pending-open route buffering.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
  Responsibility: inject notification service into `LucyAppModel`, sync scene phase, forward resolved `assistant.final` completions into the service.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRedesignedRootScene.swift`
  Responsibility: consume pending notification-open requests and scroll to the target conversation; keep the active conversation identity synced using the existing single-threaded transcript view.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucySettingsSheetView.swift`
  Responsibility: expose the single `回复完成通知` toggle plus permission status / request / open-settings actions.
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyNotificationServiceTests.swift`
  Responsibility: real behavior tests for policy, dedupe, and notification payload construction using fakes.
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`
  Responsibility: narrow source assertions for wiring points in `LucyRootView.swift`, `LucyRedesignedRootScene.swift`, and `LucySettingsSheetView.swift`.
- Optional Modify: `outside/LucyIOSDemo/LucyIOSDemo/LucyIOSDemoApp.swift`
  Responsibility: only if package-level `UNUserNotificationCenterDelegate` lifecycle proves insufficient during verification.

### Task 1: Add a Testable Notification Policy Seam

**Files:**
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyNotificationServiceTests.swift`
- Create: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyNotificationService.swift`

- [ ] **Step 1: Write failing behavior tests for phase-one notification policy**

Add real XCTest coverage for a pure policy/helper layer with cases for:
- `assistant.final` + app background + notifications enabled -> notify
- app `.active` -> suppress
- permission denied -> suppress
- duplicate completion key -> suppress second delivery

- [ ] **Step 2: Run the focused notification policy tests and verify failure**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyNotificationServiceTests`
Expected: FAIL because `LucyNotificationService.swift` and its test seam do not exist yet.

- [ ] **Step 3: Create the minimal pure helper layer**

Inside `LucyNotificationService.swift`, add small, testable units first:
- a decision/policy helper that evaluates whether a completion should notify
- an in-memory dedupe helper with a bounded recent-key window
- a completion payload type carrying `conversationId`, dedupe key, title, and body

Do not touch `LucyRootView.swift` yet.

- [ ] **Step 4: Re-run the focused notification policy tests**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyNotificationServiceTests`
Expected: PASS for the new policy and dedupe cases.

- [ ] **Step 5: Commit the isolated policy seam**

Commit only the new service file and its tests using a Lore-protocol commit message focused on why the seam exists.

### Task 2: Wrap `UNUserNotificationCenter` Behind `LucyNotificationService`

**Files:**
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyNotificationService.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyNotificationServiceTests.swift`

- [ ] **Step 1: Add failing tests for delivery and tap payload behavior**

Extend `LucyNotificationServiceTests.swift` with fake-center tests that assert:
- scheduled notifications use title `Lucy`
- scheduled notifications use body `回复已完成`
- `threadIdentifier == conversationId`
- `userInfo["conversationId"]` is present
- notification tap stores one pending open target for later consumption

- [ ] **Step 2: Run the focused delivery tests and verify failure**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyNotificationServiceTests`
Expected: FAIL because the service does not yet talk to a notification-center abstraction.

- [ ] **Step 3: Implement the concrete service wrapper**

In `LucyNotificationService.swift`:
- add a tiny protocol or adapter around `UNUserNotificationCenter`
- implement `setup()`, `requestPermission()`, `updateScenePhase(_:)`, `setActiveConversationId(_:)`, `notifyAssistantFinalIfNeeded(...)`, and `consumePendingOpenConversationId()`
- keep the service `@MainActor`
- keep pending-open state inside the service so root-scene routing can be deferred safely until the UI is ready

- [ ] **Step 4: Re-run the focused delivery tests**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyNotificationServiceTests`
Expected: PASS

- [ ] **Step 5: Commit the delivery wrapper**

Commit only the service/test changes using a Lore-protocol commit message focused on isolating local notification delivery from chat state.

### Task 3: Wire `LucyAppModel` Into the Notification Service

**Files:**
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Add failing source assertions for model wiring**

Add focused source assertions proving that:
- `LucyAppModel` owns a notification service seam
- `handleScenePhaseChange(_:)` forwards scene state into the notification service
- `consume(event:)` forwards resolved `assistant.final` completions only after `conversationIdentifier(for:)` has produced a `conversationID`

- [ ] **Step 2: Run the focused source assertions and verify failure**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyIOSDemoFeatureTests/testRootView`
Expected: FAIL because the notification wiring is not present in `LucyRootView.swift`.

- [ ] **Step 3: Implement minimal model integration**

Update `LucyRootView.swift` to:
- inject a `LucyNotificationService` into `LucyAppModel` with a default initializer for production
- call `notificationService.updateScenePhase(newPhase)` from `handleScenePhaseChange(_:)`
- after `assistant.final` conversation resolution in `consume(event:)`, forward a normalized completion payload into the service
- avoid notifying for non-final events

- [ ] **Step 4: Re-run the focused root-view tests**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyIOSDemoFeatureTests/testRootView`
Expected: PASS

- [ ] **Step 5: Commit the model wiring**

Commit only the model-wiring changes using a Lore-protocol commit message focused on keeping notification trigger logic after conversation resolution.

### Task 4: Make the Root Scene Consume Pending Notification Routes

**Files:**
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRedesignedRootScene.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Add failing source assertions for pending-open handling**

Add source assertions proving that:
- conversation rows have stable `.id(conversation.id)` anchors usable by `ScrollViewReader`
- the root scene asks the notification service (or app model seam) for one pending conversation target
- the root scene scrolls to the target after the UI is mounted

- [ ] **Step 2: Run the focused root-scene assertions and verify failure**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyIOSDemoFeatureTests/testChatScene`
Expected: FAIL because pending notification routing is not implemented.

- [ ] **Step 3: Implement the smallest route-consumption path**

Update `LucyRedesignedRootScene.swift` to:
- keep using the existing `ScrollViewReader`
- consume one pending notification conversation id after appear / on re-activation
- scroll to that conversation id instead of inventing a new navigation stack

Update `LucyRootView.swift` only as needed to expose a safe read/consume seam to the scene.

For `activeConversationId`, keep phase one minimal:
- while this root transcript is visible, set `activeConversationId` to `model.conversations.last?.id`
- clear it on disappear

Do not add row-level visibility tracking or a new selected-conversation abstraction.

- [ ] **Step 4: Re-run the focused root-scene tests**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyIOSDemoFeatureTests/testChatScene`
Expected: PASS

- [ ] **Step 5: Commit the route-consumption path**

Commit only the root-scene routing changes using a Lore-protocol commit message focused on deferred notification-open handling.

### Task 5: Add the Minimal Notification Settings Surface

**Files:**
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucySettingsSheetView.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyNotificationService.swift`
- Modify: `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/LucyIOSDemoFeatureTests.swift`

- [ ] **Step 1: Add failing source assertions for settings UI**

Add source assertions proving that `LucySettingsSheetView.swift` includes:
- one `回复完成通知` toggle backed by app storage
- a permission status label
- a request-permission action
- an open-iOS-settings action when permission is not granted

- [ ] **Step 2: Run the focused settings assertions and verify failure**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyIOSDemoFeatureTests/testLucySettings`
Expected: FAIL because the notification section does not exist yet.

- [ ] **Step 3: Implement the minimal settings section**

Add one notification section to `LucySettingsSheetView.swift`:
- store the app-level toggle in a dedicated key such as `LucyCompletionNotificationsEnabled`
- show current permission state from the notification service
- request permission on demand
- provide an "Open iOS Settings" button when the system permission is denied or not granted

Keep the UI narrow. Do not add notification previews, badge settings, or per-type notification matrices.

- [ ] **Step 4: Re-run the focused settings assertions**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage --filter LucyIOSDemoFeatureTests/testLucySettings`
Expected: PASS

- [ ] **Step 5: Commit the settings UI**

Commit only the settings/UI changes using a Lore-protocol commit message focused on making permission state inspectable without widening scope.

### Task 6: Verify Whether Host-App Glue Is Actually Needed

**Files:**
- Optional Modify: `outside/LucyIOSDemo/LucyIOSDemo/LucyIOSDemoApp.swift`

- [ ] **Step 1: Try package-owned notification delegate wiring first**

Do not modify the host app before verification. Keep delegate ownership inside `LucyNotificationService` unless a concrete lifecycle failure appears.

- [ ] **Step 2: Run a simulator build after package changes land**

Run: `xcodebuild -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj -scheme LucyIOSDemo -destination 'generic/platform=iOS Simulator' build`
Expected: BUILD SUCCEEDED

- [ ] **Step 3: Only if the build or runtime proves package-owned delegate setup is insufficient, add the thinnest host-app bridge**

If needed, modify `LucyIOSDemoApp.swift` only to initialize the package-owned notification service correctly. Do not move policy into the app target.

- [ ] **Step 4: Re-run the simulator build**

Run: `xcodebuild -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj -scheme LucyIOSDemo -destination 'generic/platform=iOS Simulator' build`
Expected: BUILD SUCCEEDED

### Task 7: Final Verification

**Files:**
- No new files beyond the tasks above

- [ ] **Step 1: Run the full Swift package test suite**

Run: `swift test --package-path outside/LucyIOSDemo/LucyIOSDemoPackage`
Expected: PASS

- [ ] **Step 2: Run the app build**

Run: `xcodebuild -project outside/LucyIOSDemo/LucyIOSDemo.xcodeproj -scheme LucyIOSDemo -destination 'generic/platform=iOS Simulator' build`
Expected: BUILD SUCCEEDED

- [ ] **Step 3: Manually verify the phase-one behavior**

Manual checklist:
- keep the app alive
- send a message and background the app
- confirm a local notification arrives only on `assistant.final`
- confirm foreground active app does not show the notification
- tap the notification and confirm the transcript scrolls to the target conversation
- confirm the settings screen can request permission and open iOS Settings

- [ ] **Step 4: Document residual risks in the final handoff**

Explicitly note anything intentionally deferred:
- no APNs / remote push
- no delivery after the app is suspended or killed
- no unread badges
- no multi-device notification routing
