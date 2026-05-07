const HISTORY_WINDOW_MS = 30000;
const MAX_EVENTS = 120;

function createDiagnosticsState() {
  return {
    playbackState: 'idle',
    startupPhase: 'idle',
    workerState: 'idle',
    decoderOwner: 'main',
    bufferFillPercent: 0,
    framesAvailable: 0,
    frameCapacity: 0,
    underrunCount: 0,
    lastDecodeMs: 0,
    lastRefillGapMs: 0,
    maxRefillGapMs: 0,
    refillCount: 0,
    lastRefillDurationMs: 0,
    maxDecodeMs: 0,
    movingAverageDecodeMs: 0,
    startupTimingsMs: {},
    transitionGapMs: null,
    // Lowest buffer fill % seen in the 500 ms after a gapless handoff.
    lastTransitionFloorPercent: null,
    lowWaterMarkCount: 0,
    activeBoundedWindowSize: 0,
    retainedBytes: 0,
    pendingSeekDistanceMs: 0,
    fetchToDecodeLagMs: 0,
    resumeAfterStallLatencyMs: 0,
    history: [],
    events: [],
  };
}

function pushHistoryPoint(state, point) {
  state.history.push(point);
  const cutoff = point.timeMs - HISTORY_WINDOW_MS;
  while (state.history.length > 0 && state.history[0].timeMs < cutoff) {
    state.history.shift();
  }
}

function pushEvent(state, event) {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
}

function buildSnapshot(state, capturedAtMs) {
  return {
    capturedAtMs,
    playbackState: state.playbackState,
    startupPhase: state.startupPhase,
    workerState: state.workerState,
    decoderOwner: state.decoderOwner,
    bufferFillPercent: state.bufferFillPercent,
    framesAvailable: state.framesAvailable,
    frameCapacity: state.frameCapacity,
    underrunCount: state.underrunCount,
    lastDecodeMs: state.lastDecodeMs,
    lastRefillGapMs: state.lastRefillGapMs,
    maxRefillGapMs: state.maxRefillGapMs,
    refillCount: state.refillCount,
    lastRefillDurationMs: state.lastRefillDurationMs,
    maxDecodeMs: state.maxDecodeMs,
    movingAverageDecodeMs: state.movingAverageDecodeMs,
    startupTimingsMs: { ...state.startupTimingsMs },
    transitionGapMs: state.transitionGapMs,
    lastTransitionFloorPercent: state.lastTransitionFloorPercent,
    lowWaterMarkCount: state.lowWaterMarkCount,
    activeBoundedWindowSize: state.activeBoundedWindowSize,
    retainedBytes: state.retainedBytes,
    pendingSeekDistanceMs: state.pendingSeekDistanceMs,
    fetchToDecodeLagMs: state.fetchToDecodeLagMs,
    resumeAfterStallLatencyMs: state.resumeAfterStallLatencyMs,
    history: [...state.history],
  };
}

export { buildSnapshot, createDiagnosticsState, pushEvent, pushHistoryPoint };
