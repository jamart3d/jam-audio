import { nudgeWaitAsyncState, startPortLoop } from './playback_worker_controller_refill.js';

// Refill driver loops for the playback worker controller (waitasync, port, degraded
// interval). The controller keeps refillRingBuffer and refillPending; everything that
// can be reassigned by the controller (shared state, diagnostics, worklet port) is read
// through a getter on every use, never captured.
//
// State is split so that nothing but a real interval id ever reaches clearIntervalFn:
//   - sessionEpoch: the controller-wide playback epoch (also compared by fetch callbacks).
//     Bumped by start() and invalidate(), never by stop().
//   - loopGeneration: retires waitasync/port loops. Bumped by start(), invalidate() and
//     stop(), so stopping really stops a running loop.
//   - token: marks a loop active for waitasync/port; intervalId: the setInterval id.
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
  let token = null;
  let intervalId = null;
  let driver = null; // 'waitasync' | 'port' | 'degraded-interval'; set once per worker lifetime
  let lastRefillTickMs = 0;
  let sessionEpoch = 0;
  let loopGeneration = 0;

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
  async function runWaitAsyncLoop(generation) {
    while (loopGeneration === generation) {
      if (!getSharedState()) break;
      // Capture expected BEFORE refill so a worklet notify during refill is
      // not lost: waitAsync will see not-equal and loop immediately.
      const expected = Atomics.load(getSharedState(), refillRequestIndex);
      refillRingBuffer();
      if (loopGeneration !== generation) break; // loop retired during refill
      const result = Atomics.waitAsync(getSharedState(), refillRequestIndex, expected, waitTimeoutMs);
      if (result.async) {
        await result.value; // 'ok' | 'timed-out' | 'not-equal' — all wake reasons are fine
      }
      // Any wake reason → loop, re-read, refill. Spurious wakes are harmless.
    }
    if (token === generation) token = null;
  }

  // Fallback #1: MessagePort from worklet
  function runPortLoop(generation) {
    const success = startPortLoop({
      getWorkletPort,
      refillRingBuffer,
      shouldKeepRunning: () => generation === loopGeneration,
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
    token = generation;
  }

  // Fallback #2: degraded setInterval (throttle-prone, logs warning on each delayed tick)
  function runDegradedIntervalLoop() {
    lastRefillTickMs = performanceNow();
    intervalId = setIntervalFn(() => {
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
    // New playback session: retires every loop and invalidates captured session ids.
    invalidate() { sessionEpoch += 1; loopGeneration += 1; },
    // Retires a running waitasync/port loop and marks the loop inactive. Does not touch
    // the session epoch, so in-flight fetch callbacks stay valid. The interval timer is
    // cleared by the shared core through the hooks below.
    stop() { loopGeneration += 1; token = null; },
    sessionId: () => sessionEpoch,
    isActive: () => token !== null || intervalId !== null,
    driver: () => driver,
    // Shared-core hooks: only a real setInterval id is ever exposed to clearIntervalFn.
    getIntervalId: () => intervalId,
    setIntervalId: (value) => { intervalId = value; },
    nudgeIfWaitAsync() {
      const sharedState = getSharedState();
      if (driver === 'waitasync' && sharedState) {
        nudgeWaitAsyncState(sharedState, refillRequestIndex);
      }
    },
  };

  function start() {
    sessionEpoch += 1;
    // Clears any interval timer and retires loops from a previous start (Finding 2).
    stopRefillLoop();
    loopGeneration += 1;
    const generation = loopGeneration;
    token = generation; // loop is active
    const selected = selectDriver();

    if (selected === 'waitasync') {
      runWaitAsyncLoop(generation);
    } else if (selected === 'port') {
      runPortLoop(generation);
    } else {
      runDegradedIntervalLoop();
    }
  }
}

export { createRefillLoop };
