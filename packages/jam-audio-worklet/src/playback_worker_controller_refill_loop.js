import { nudgeWaitAsyncState, startPortLoop } from './playback_worker_controller_refill.js';

// Refill driver loops for the playback worker controller (waitasync, port, degraded
// interval). The controller keeps refillRingBuffer and refillPending; everything that
// can be reassigned by the controller (shared state, diagnostics, worklet port) is read
// through a getter on every use, never captured.
//
// Behavior is intentionally identical to the inline code it replaced, including two
// known defects pinned by audio_playback_worker_controller_refill_characterization.test.js:
// the loop token doubles as the value passed to clearIntervalFn, and stopping the timer
// does not retire a running waitasync loop (only invalidate() does).
function createRefillLoop({
  getSharedState,
  getDiagnostics,
  getWorkletPort,
  refillRingBuffer,
  stopRefillLoop,
  isRefillPending,
  emitDiagnosticsEvent,
  nowMs,
  performanceNow,
  setIntervalFn,
  waitTimeoutMs,
  refillRequestIndex,
  refillIntervalMs,
}) {
  let timerId = null;
  let driver = null; // 'waitasync' | 'port' | 'degraded-interval'; set once per worker lifetime
  let lastRefillTickMs = 0;
  let currentSessionId = 0;

  function selectDriver() {
    if (driver !== null) return driver; // already selected
    // BOUNDS GUARD (Finding 1): if the SAB is small (legacy 5-slot fixture), slot 7 is
    // out of range. waitAsync on an out-of-bounds index would throw RangeError. Fall back
    // to legacy interval so existing tests continue to pass without change.
    const sharedState = getSharedState();
    const sabHasSlot7 = sharedState && sharedState.length > refillRequestIndex;
    if (typeof Atomics.waitAsync === 'function' && sabHasSlot7) {
      driver = 'waitasync';
    } else if (getWorkletPort() !== null) {
      driver = 'port';
    } else {
      driver = 'degraded-interval';
    }
    emitDiagnosticsEvent({
      type: 'refill-driver-selected',
      label: `Refill driver selected: ${driver}`,
      timestampMs: nowMs(),
      severity: driver === 'degraded-interval' ? 'warning' : 'info',
      driver,
    });
    return driver;
  }

  // Primary driver: Atomics.waitAsync
  // waitTimeoutMs is injected via controller options (default 1000ms production; 10ms in tests).
  async function runWaitAsyncLoop(sessionId) {
    while (currentSessionId === sessionId) {
      if (!getSharedState()) break;
      // Capture expected BEFORE refill so a worklet notify during refill is
      // not lost: waitAsync will see not-equal and loop immediately.
      const expected = Atomics.load(getSharedState(), refillRequestIndex);
      refillRingBuffer();
      if (currentSessionId !== sessionId) break; // session changed during refill
      const result = Atomics.waitAsync(getSharedState(), refillRequestIndex, expected, waitTimeoutMs);
      if (result.async) {
        await result.value; // 'ok' | 'timed-out' | 'not-equal' — all wake reasons are fine
      }
      // Any wake reason → loop, re-read, refill. Spurious wakes are harmless.
    }
    if (timerId === sessionId) timerId = null;
  }

  // Fallback #1: MessagePort from worklet
  function runPortLoop(sessionId) {
    const success = startPortLoop({
      getWorkletPort,
      refillRingBuffer,
      shouldKeepRunning: () => sessionId === currentSessionId,
    });
    if (!success) {
      emitDiagnosticsEvent({
        type: 'refill-driver-port-missing',
        label: 'Port driver selected but workletPort is null — falling back to interval',
        timestampMs: nowMs(),
        severity: 'warning',
      });
      runDegradedIntervalLoop();
      return;
    }
    // Initial refill on loop start (covers startup case before worklet fires)
    refillRingBuffer();
    timerId = sessionId;
  }

  // Fallback #2: degraded setInterval (throttle-prone, logs warning on each delayed tick)
  function runDegradedIntervalLoop() {
    lastRefillTickMs = performanceNow();
    timerId = setIntervalFn(() => {
      if (isRefillPending()) return;
      const currentTime = performanceNow();
      const gap = currentTime - lastRefillTickMs;
      lastRefillTickMs = currentTime;
      const diagnostics = getDiagnostics();
      diagnostics.lastRefillGapMs = Number(gap.toFixed(2));
      diagnostics.maxRefillGapMs = Math.max(
        diagnostics.maxRefillGapMs,
        diagnostics.lastRefillGapMs,
      );
      if (gap > 25) {
        emitDiagnosticsEvent({
          type: 'refill-timer-delayed',
          label: `refill delayed ${Math.round(gap)}ms`,
          severity: 'warning',
          timestampMs: nowMs(),
          gapMs: Math.round(gap),
        });
        if (diagnostics.bufferFillPercent < 15) {
          emitDiagnosticsEvent({
            type: 'refill-delayed-headroom-low',
            label: 'Refill delayed while headroom low',
            severity: 'critical',
            timestampMs: nowMs(),
            bufferFillPercent: diagnostics.bufferFillPercent,
          });
        }
      }
      refillRingBuffer();
    }, refillIntervalMs);
  }

  return {
    selectDriver,
    start,
    // Retires every running loop: they compare their captured session id on each wake.
    invalidate() { currentSessionId += 1; },
    sessionId: () => currentSessionId,
    isActive: () => timerId !== null,
    driver: () => driver,
    // Shared-core hooks (stopRefillLoop clears whatever timerId holds).
    getTimerId: () => timerId,
    setTimerId: (value) => { timerId = value; },
    nudgeIfWaitAsync() {
      const sharedState = getSharedState();
      if (driver === 'waitasync' && sharedState) {
        nudgeWaitAsyncState(sharedState, refillRequestIndex);
      }
    },
  };

  function start() {
    // ALWAYS bump first (Finding 2): prior loops see stale sessionId on next wake and exit.
    currentSessionId += 1;
    const sessionId = currentSessionId;
    stopRefillLoop(); // clear any interval timer / sentinel from previous loop
    timerId = sessionId; // truthy sentinel — loop is active
    const selected = selectDriver();

    if (selected === 'waitasync') {
      runWaitAsyncLoop(sessionId);
    } else if (selected === 'port') {
      runPortLoop(sessionId);
    } else {
      runDegradedIntervalLoop();
    }
  }
}

export { createRefillLoop };
