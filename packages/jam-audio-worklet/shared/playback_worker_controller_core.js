function createSharedPlaybackWorkerControllerCore({
  emitMessage,
  clearIntervalFn,
  getDiagnostics,
  getFrameCapacity,
  getExtraSyncPayload = () => ({}),
  getRefillTimerId,
  setRefillTimerId,
}) {
  function emitDiagnosticsEvent(event) {
    emitMessage({ type: 'diagnostics-event', event });
  }

  function emitDiagnosticsSync({ historyPoint, startupTimingsMs } = {}) {
    const diagnostics = getDiagnostics();
    emitMessage({
      type: 'diagnostics-sync',
      payload: {
        workerState: diagnostics.workerState,
        decoderOwner: diagnostics.decoderOwner,
        framesAvailable: diagnostics.framesAvailable,
        frameCapacity: getFrameCapacity(),
        bufferFillPercent: diagnostics.bufferFillPercent,
        lastDecodeMs: diagnostics.lastDecodeMs,
        lastRefillGapMs: diagnostics.lastRefillGapMs,
        maxRefillGapMs: diagnostics.maxRefillGapMs,
        refillCount: diagnostics.refillCount,
        lastRefillDurationMs: diagnostics.lastRefillDurationMs,
        maxDecodeMs: diagnostics.maxDecodeMs,
        movingAverageDecodeMs: diagnostics.movingAverageDecodeMs,
        transitionGapMs: diagnostics.transitionGapMs,
        lastTransitionFloorPercent: diagnostics.lastTransitionFloorPercent,
        historyPoint,
        startupTimingsMs,
        ...getExtraSyncPayload(),
      },
    });
  }

  function stopRefillLoop() {
    const refillTimerId = getRefillTimerId();
    if (refillTimerId != null) {
      clearIntervalFn(refillTimerId);
      setRefillTimerId(null);
    }
  }

  return {
    emitDiagnosticsEvent,
    emitDiagnosticsSync,
    stopRefillLoop,
  };
}

function createBaseWorkerDiagnostics(overrides = {}) {
  return {
    workerState: 'idle',
    decoderOwner: 'main',
    bufferFillPercent: 0,
    framesAvailable: 0,
    lastDecodeMs: 0,
    lastRefillGapMs: 0,
    maxRefillGapMs: 0,
    refillCount: 0,
    lastRefillDurationMs: 0,
    maxDecodeMs: 0,
    movingAverageDecodeMs: 0,
    transitionGapMs: null,
    lastTransitionFloorPercent: null,
    underrunCount: 0,
    ...overrides,
  };
}

export { createBaseWorkerDiagnostics, createSharedPlaybackWorkerControllerCore };
