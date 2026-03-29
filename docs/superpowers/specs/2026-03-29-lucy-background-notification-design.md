# Lucy Background Notification Design

**Date:** 2026-03-29

**Goal**

Add first-phase background notifications to the Lucy iOS app so that when the currently selected Lucy device finishes a reply, the user can receive a local notification while the app is backgrounded but still alive.

This phase is intentionally narrow:

- single-device behavior only
- notify only on `assistant.final`
- local notifications only
- no unread badges or conversation-list state work
- no APNs / remote push yet

**Current State**

- Lucy plugin already emits `assistant.final` machine events over the existing NATS channel.
- `LucyIOSDemo` already tracks device online status through `_discover` plus `ping`.
- `LucyIOSDemo` reconnects and resumes presence when the app returns to foreground, but it has no notification service, no notification permission flow, and no background completion notification path.
- `outside/Open-Relay` uses a dedicated notification service instead of embedding notification policy directly inside chat or transport code. It also suppresses notifications when the user is already viewing the active conversation.

**Decision Summary**

Use a dedicated `LucyNotificationService` in the iOS client. Chat/runtime code continues to consume Lucy machine events, but notification policy moves into a separate service that owns:

- notification permission state
- foreground/background awareness
- active conversation suppression
- lightweight duplicate suppression
- local notification delivery
- notification tap routing

This keeps first-phase work small while preserving a clean upgrade path to future APNs-based delivery.

**Design**

1. Add a dedicated notification service.

- Introduce `LucyNotificationService` in `LucyIOSDemo`.
- The service wraps `UNUserNotificationCenter`.
- It exposes setup, permission request, scene-phase sync, active-conversation sync, and `notifyAssistantFinalIfNeeded(...)`.
- Chat state does not decide presentation directly. It emits a semantic "reply finished" signal to the service.

2. Trigger notifications only from `assistant.final`.

- The only notification source in this phase is a Lucy machine event of type `assistant.final`.
- `assistant.start`, `assistant.partial`, `reasoning.*`, provisioning events, and errors do not notify.
- The service receives enough context to identify the conversation and the final event instance.

3. Restrict scope to the current selected device.

- Notification delivery only applies to the device currently selected in `LucyIOSDemo`.
- No cross-device aggregation or device-switching behavior is added in this phase.
- Notification tap routing assumes the current app state is already scoped to one active device.

4. Keep notification delivery background-only in phase one.

- If the app scene phase is `.active`, do not present a Lucy completion notification in this phase.
- The app still records `activeConversationId` for the currently visible conversation.
- That conversation identity is kept because it remains useful for later foreground-notification or unread work, and for defensive routing checks.
- If the app is `.inactive` or `.background`, notifications are allowed for eligible `assistant.final` events.

5. Add lightweight duplicate suppression.

- Prefer `event.eventId` as the dedupe key.
- If needed, fall back to a compound key based on conversation identity plus `sourceMessageId` and event type.
- Keep dedupe state in memory only for this phase.
- Store only a small recent window, for example the last 200 completion events, to avoid repeated local notifications after reconnect or replay.

6. Keep notification content intentionally minimal.

- Title: `Lucy`
- Body: `回复已完成`
- `threadIdentifier`: `conversationId`
- `userInfo`: include `conversationId`

Do not include the full reply text in the notification body in phase one. This avoids overly long previews, markdown artifacts, and unnecessary lock-screen leakage.

7. Add a minimal settings surface.

- Add a single toggle: `回复完成通知`
- Show current system permission state: granted or not granted
- If permission is not granted, allow:
  - request permission
  - open iOS Settings

The app-level toggle controls whether Lucy completion notifications are attempted. The system permission state remains separate.

8. Request permission contextually, not aggressively.

- The app should register categories and load cached permission state during startup.
- If the system authorization status is `notDetermined`, request permission at the first moment a real completion notification would be useful, or from the settings screen when the user explicitly asks.
- Do not force a permission prompt on cold app launch.

9. Route notification taps directly to the conversation.

- When the user taps the notification, the app reads `conversationId` from notification payload.
- The router navigates directly into that conversation.
- No multi-device selection, fallback home landing, or intermediary prompt is introduced in this phase.

**Architecture and Data Flow**

1. Lucy machine event arrives in `LucyRootViewModel.consume(event:)`.
2. Existing reply-state handling updates the conversation.
3. When the event type is `assistant.final`, `LucyRootViewModel` forwards a normalized completion payload to `LucyNotificationService`.
4. `LucyNotificationService` evaluates:
   - app-level toggle enabled
   - system permission granted or requestable
   - app not in `.active`
   - event not already deduped
5. If allowed, the service schedules a local notification immediately.
6. On notification tap, the app resolves `conversationId` and routes to the matching conversation view.

**Files in Scope**

- iOS app notification and routing layer:
  - `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRootView.swift`
  - `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyRedesignedRootScene.swift`
  - `outside/LucyIOSDemo/LucyIOSDemoPackage/Sources/LucyIOSDemoFeature/LucyServices.swift`
  - one new notification service file, likely beside the other feature services
- Optional app-shell integration if needed:
  - `outside/LucyIOSDemo/LucyIOSDemo/App/...` or package entry wiring, depending on where `UNUserNotificationCenterDelegate` is best hosted
- iOS tests:
  - `outside/LucyIOSDemo/LucyIOSDemoPackage/Tests/LucyIOSDemoFeatureTests/...`

The Lucy plugin under `src/` is out of scope unless a missing field blocks notification routing. Current design assumes existing `assistant.final` payloads are sufficient.

**Non-Goals**

- APNs or any remote push path
- Notifications after the app has been suspended or killed by iOS
- Unread counts, badges, or conversation list indicators
- Multi-device notification aggregation
- New NATS subjects or new Lucy machine event types
- Notification previews that include full assistant reply text

**Error Handling**

- If notification permission is denied, do not retry aggressively. Surface the state in settings and provide an "Open iOS Settings" path.
- If a completion event cannot be mapped to a conversation, skip notification rather than guessing.
- If notification scheduling fails, log it but do not alter the conversation state.
- If a duplicate completion event arrives, drop it silently after dedupe.
- If notification tap routing happens before the destination UI mounts, buffer the route and replay it once the root scene is ready.

**Verification**

- Unit coverage:
  - `assistant.final` in background triggers one local notification
  - non-final events do not notify
  - foreground active app suppresses notification
  - duplicate final events notify only once
  - permission denied prevents scheduling
- Integration coverage:
  - notification payload includes `conversationId`
  - tapping a delivered notification routes to the correct conversation
  - app returns from background and still resolves pending notification navigation
- Manual verification:
  - keep app alive, send a message, background the app, and confirm notification arrives on `assistant.final`
  - confirm no notification appears while actively viewing the same conversation in foreground
  - confirm settings reflect permission state and can request permission

**Phase Two Extension Path**

If later work requires notifications after suspension or process death, keep the same semantic event boundary and extend the delivery layer instead of rewriting chat logic:

- retain `assistant.final` as the notification intent source
- keep app-side local notification service as one delivery adapter
- add a remote push delivery path separately
- preserve tap-routing payload compatibility by continuing to key on `conversationId`

This lets phase one stay useful rather than becoming throwaway code.
