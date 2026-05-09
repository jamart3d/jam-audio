# PWA Media Session Contract

## Objective
Ensure the PWA Media Session notification remains persistent on Android by implementing a heartbeat/anchor diagnostic mechanism.

## Context
Android often drops Media Session notifications if it deems the app inactive. A "heartbeat" (periodic small audio playback or state update) can help maintain the session's "active" status in the eyes of the OS.

## Canonical Source of Truth
- `packages/jam-audio-worklet/src/audio_bridge.js`

## Implementation Plan

### Task 1: Patch Canonical Audio Bridge
**File:** `packages/jam-audio-worklet/src/audio_bridge.js`
**Action:** Implement `media-session-heartbeat` logic. This should involve a periodic timer or state update that signals to the main thread (or handles internally if possible) that playback is still active, even if silent or between tracks.
**Review Gate:** Ensure the logic is robust and doesn't introduce noise or performance regressions.

### Task 2: Sync to Jamdisc Web and update contract tests
**Files:**
- `apps/jamdisc_web/web/js/worklet/audio_bridge.js` (Update from canonical)
- `apps/jamdisc_web/web/js/audio_bridge_media_session.test.js` (Update/Add contract test)
**Action:** Copy the patched `audio_bridge.js` to the web app and update the JS contract test to verify the heartbeat existence and behavior.
**Review Gate:** Verify file alignment and test coverage.

### Task 3: Local Verification
**Action:** Run verification commands.
- `node apps/jamdisc_web/web/js/audio_bridge_media_session.test.js`
- `node --check apps/jamdisc_web/web/js/worklet/audio_bridge.js`
**Review Gate:** Confirm tests pass and syntax is valid.

### Task 4: Staging Deployment & Final Review
**Action:** Rebuild and deploy to staging. Verify `build/web/js/worklet/audio_bridge.js` contains the heartbeat logic.
**Review Gate:** Final artifact check before Android testing.

## Platform Behavior Note
**Conclusion:** We have verified that the heartbeat is functioning and emitting the correct state changes. However, if Android still drops the notification despite healthy heartbeat and anchor diagnostics, the remainder is platform surfacing behavior and runtime changes should stop there.
