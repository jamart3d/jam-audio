# Mode B Phase 2: Refill Scheduling & Handoff - Implementation Notes

## Summary of Changes

Implemented a more adaptive and resilient refill strategy for the playback worker. The changes focus on reducing startup latency, improving recovery from starvation, and preventing the worker from blocking the event loop for too long.

### Key Enhancements

1.  **Adaptive Chunk Sizing**:
    *   Introduced `REFILL_CHUNK_FRAMES_RECOVERY` (4096 frames) for when the buffer is below a critical threshold (1 second).
    *   Standard refill uses `REFILL_CHUNK_FRAMES` (1024 frames) for steady-state efficiency.
    *   This reduces Wasm boundary overhead when catching up.

2.  **Early Playback Start**:
    *   Moved the `maybeStartPlaybackIfBuffered` check INSIDE the `refillRingBuffer` loop.
    *   Playback can now start as soon as the threshold (1.83s) is met, even if the worker is still filling the rest of the target (up to 11s).
    *   Reduces "Time to First Sound" significantly.

3.  **Non-Blocking Refill Loop**:
    *   Introduced `REFILL_MAX_TICK_DURATION_MS` (20ms).
    *   If a refill tick takes too long, it yields back to the event loop using `setTimeout(..., 0)` and continues in the next tick.
    *   This prevents the "Greedy Loop" from blocking other worker commands (like `stop` or `seek`).
    *   Added `refillPending` flag to prevent overlapping refills from the 15ms interval timer.

4.  **Recovery Mode Diagnostics**:
    *   Added `recoveryModeActive` flag to diagnostics.
    *   Emits a `recovery-mode-entered` event when headroom drops below 1 second.
    *   This allows for better observability of near-starvation events.

## Files Changed

*   `packages/jam-audio-worklet/src/audio_playback_worker_controller.js`: Core refill logic, constants, and state management.
*   `packages/jam-audio-worklet/src/audio_diagnostics_state.js`: Diagnostics state definition.
*   `packages/jam-audio-worklet/src/audio_bridge.js`: Bridge-side diagnostics synchronization.

## Validation Results

*   **Syntax Check**: Passed (`node --check`).
*   **Logic Review**: 
    *   Startup: Handled correctly by early signal.
    *   Steady State: 15ms timer remains the primary driver.
    *   Starvation: Adaptive chunk size and non-blocking yields improve recovery.
    *   Transition/Seek: Logic preserved, improved responsiveness due to non-blocking.

## Residual Risks

*   **Browser Timer Jitter**: While the non-blocking loop helps, extreme browser timer throttling (e.g., background tabs) may still affect the 15ms interval. Phase 3 (Adaptive Buffer Policy) should address this by increasing buffer depth in such conditions.
*   **Wasm Performance**: If `decodeFrames` is exceptionally slow (e.g., on very low-end devices), even a single 4096-frame chunk might take more than 20ms. The loop check happens *after* each chunk, so it can't interrupt a single decode call.
