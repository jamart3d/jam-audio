import { createBaseWorkerDiagnostics } from './playback_worker_controller_core.js';

// Pure diagnostics helpers for the playback worker controller. They take the
// diagnostics object and explicit inputs so the controller keeps ownership of
// its closure state. Shared-state slot indices are injected by the caller.

// underrunCount and silentFrameCount are read authoritatively from the shared
// state buffer (written by the worklet); assignments are intentionally ignored.
function createWorkerDiagnostics(overrides = {}, { getSharedState, slots } = {}) {
  const diag = createBaseWorkerDiagnostics({
    lowWaterMarkCount: 0,
    recoveryModeActive: false,
    activeBoundedWindowSize: 0,
    retainedBytes: 0,
    pendingSeekDistanceMs: 0,
    fetchToDecodeLagMs: 0,
    resumeAfterStallLatencyMs: 0,
    ...overrides,
  });
  if (getSharedState && slots) {
    Object.defineProperties(diag, {
      underrunCount: {
        get: () => {
          const state = getSharedState();
          return state ? Atomics.load(state, slots.UNDERRUN_EPISODES_INDEX) : 0;
        },
        set: () => {},
      },
      silentFrameCount: {
        get: () => {
          const state = getSharedState();
          return state ? Atomics.load(state, slots.SILENT_FRAMES_INDEX) : 0;
        },
        set: () => {},
      },
    });
  }
  return diag;
}

function applyDecodeMetric(diagnostics, decodeDurationMs) {
  diagnostics.lastDecodeMs = decodeDurationMs;
  diagnostics.maxDecodeMs = Math.max(diagnostics.maxDecodeMs, decodeDurationMs);
  diagnostics.refillCount += 1;
  diagnostics.movingAverageDecodeMs = Number(
    (
      ((diagnostics.movingAverageDecodeMs * (diagnostics.refillCount - 1)) +
        decodeDurationMs) /
      diagnostics.refillCount
    ).toFixed(2),
  );
}

function computeBufferFill(framesAvailable, frameCapacity) {
  return frameCapacity > 0
    ? Number(((framesAvailable / frameCapacity) * 100).toFixed(1))
    : 0;
}

// Returns the new "below low-water-mark" latch value.
function updateLowWaterMark(diagnostics, bufferFillPercent, isBelowLowWaterMark) {
  if (bufferFillPercent < 10 && !isBelowLowWaterMark) {
    diagnostics.lowWaterMarkCount += 1;
    return true;
  }
  if (bufferFillPercent >= 15) {
    return false;
  }
  return isBelowLowWaterMark;
}

function buildExtraSyncPayload({ diagnostics, activePolicy, diagnosticsMode, sharedState, slots }) {
  const payload = {
    lowWaterMarkCount: diagnostics.lowWaterMarkCount,
    recoveryModeActive: diagnostics.recoveryModeActive,
    activeBoundedWindowSize: diagnostics.activeBoundedWindowSize,
    retainedBytes: diagnostics.retainedBytes,
    pendingSeekDistanceMs: diagnostics.pendingSeekDistanceMs,
    fetchToDecodeLagMs: diagnostics.fetchToDecodeLagMs,
    resumeAfterStallLatencyMs: diagnostics.resumeAfterStallLatencyMs,
  };
  if (activePolicy) {
    payload.latencyPolicy = {
      profile: activePolicy.profile,
      playbackStartFrames: activePolicy.playbackStartFrames,
      steadyStateTargetFrames: activePolicy.steadyStateTargetFrames,
      criticalThresholdFrames: activePolicy.criticalThresholdFrames,
      startupDurationSec: activePolicy.startupDurationSec,
      steadyDurationSec: activePolicy.steadyDurationSec,
    };
  }
  if (diagnosticsMode === 'extended') {
    if (sharedState) {
      payload.readIndex = Atomics.load(sharedState, slots.READ_INDEX);
      payload.writeIndex = Atomics.load(sharedState, slots.WRITE_INDEX);
      payload.framesRendered = sharedState.length > slots.TOTAL_FRAMES_RENDERED_INDEX
        ? Atomics.load(sharedState, slots.TOTAL_FRAMES_RENDERED_INDEX)
        : null;
      payload.workletHeartbeatCount = sharedState.length > slots.HEARTBEAT_COUNT_INDEX
        ? Atomics.load(sharedState, slots.HEARTBEAT_COUNT_INDEX)
        : null;
    } else {
      payload.readIndex = null;
      payload.writeIndex = null;
      payload.framesRendered = null;
      payload.workletHeartbeatCount = null;
    }
  }
  return payload;
}

export {
  applyDecodeMetric,
  buildExtraSyncPayload,
  computeBufferFill,
  createWorkerDiagnostics,
  updateLowWaterMark,
};
