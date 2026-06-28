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
    positionMs: 0,
    decodedPositionMs: 0,
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
    recoveryModeActive: false,
    activeBoundedWindowSize: 0,
    retainedBytes: 0,
    pendingSeekDistanceMs: 0,
    fetchToDecodeLagMs: 0,
    resumeAfterStallLatencyMs: 0,
    readIndex: null,
    writeIndex: null,
    framesRendered: null,
    workletHeartbeatCount: null,
    workerCommandRoundTripMs: null,
    bridgePositionEventAgeMs: null,
    hiddenMediaPlaying: null,
    audioContextState: null,
    history: [],
    historyStartIndex: 0,
    events: [],
  };
}

function pushHistoryPoint(state, point) {
  state.history.push(point);
  const cutoff = point.timeMs - HISTORY_WINDOW_MS;

  while (state.historyStartIndex < state.history.length && state.history[state.historyStartIndex].timeMs < cutoff) {
    state.historyStartIndex++;
  }

  if (state.historyStartIndex >= 1000) {
    state.history = state.history.slice(state.historyStartIndex);
    state.historyStartIndex = 0;
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
    positionMs: state.positionMs,
    decodedPositionMs: state.decodedPositionMs,
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
    recoveryModeActive: state.recoveryModeActive,
    activeBoundedWindowSize: state.activeBoundedWindowSize,
    retainedBytes: state.retainedBytes,
    pendingSeekDistanceMs: state.pendingSeekDistanceMs,
    fetchToDecodeLagMs: state.fetchToDecodeLagMs,
    resumeAfterStallLatencyMs: state.resumeAfterStallLatencyMs,
    readIndex: state.readIndex,
    writeIndex: state.writeIndex,
    framesRendered: state.framesRendered,
    workletHeartbeatCount: state.workletHeartbeatCount,
    workerCommandRoundTripMs: state.workerCommandRoundTripMs,
    bridgePositionEventAgeMs: state.bridgePositionEventAgeMs,
    hiddenMediaPlaying: state.hiddenMediaPlaying,
    audioContextState: state.audioContextState,
    history: state.historyStartIndex > 0 ? state.history.slice(state.historyStartIndex) : [...state.history],
  };
}

export { buildSnapshot, createDiagnosticsState, pushEvent, pushHistoryPoint };
