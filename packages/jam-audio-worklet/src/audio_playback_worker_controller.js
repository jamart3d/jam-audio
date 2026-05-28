import {
  createBaseWorkerDiagnostics,
  createSharedPlaybackWorkerControllerCore,
} from '../shared/playback_worker_controller_core.js';

const READ_INDEX = 0;
const WRITE_INDEX = 1;
const FRAMES_AVAILABLE_INDEX = 2;
const END_OF_STREAM_INDEX = 3;
const STOP_INDEX = 4;
const CHANNELS = 2;
const REFILL_CHUNK_FRAMES = 1024;
const REFILL_CHUNK_FRAMES_RECOVERY = 4096;
const REFILL_INTERVAL_MS = 15;
const PLAYBACK_START_FRAMES = 88200;
const STEADY_STATE_TARGET_FRAMES = 264600; // ~5.5s at 48kHz
const CRITICAL_THRESHOLD_FRAMES = 44100; // ~1s at 44.1kHz
const REFILL_MAX_TICK_DURATION_MS = 20;
const READ_AHEAD_BYTES = 8 * 1024 * 1024;
const RESUME_THRESHOLD_BYTES = 2 * 1024 * 1024;
const TRACK_HANDOFF_TOLERANCE_MS = 50;
const HANDOFF_RETRY_WINDOW_MS = 200;
const HANDOFF_FILL_THRESHOLD_PERCENT = 25;

function createPlaybackWorkerController({
  createGaplessPlayer,
  createStreamingPlayer,
  createWindowedStreamingPlayer,
  createRangeFetchController,
  emitMessage,
  setIntervalFn,
  clearIntervalFn,
  performanceNow,
  nowMs,
}) {
  let sharedSamples = null;
  let sharedState = null;
  let frameCapacity = 0;
  let player = null;
  let streamingPlayer = null;
  let windowedPlayer = null;
  let fetchController = null;
  let streamingPlaybackStarted = false;
  let streamingFinalized = false;
  let streamingBufferedDurationMs = 0;
  let startupCompleted = false;
  let refillTimerId = null;
  let refillPending = false;
  let lastRefillTickMs = 0;
  let trackStartPositionMs = 0;
  let currentTrackEndPositionMs = 0;
  let currentTrackEndPositionKnown = false;
  let currentTrackEndPositionHandled = false;
  let _streamingHintDurationMs = 0;
  let transitionMonitorUntilMs = 0;
  let transitionFloorCandidate = Infinity;
  let handoffUnderrunBaseline = 0;
  let handoffStartedAtMs = 0;
  let handoffPendingUntilMs = 0;
  let lastCompletedHandoffUnderrunDelta = 0;
  let endedEmitted = false;
  let _pendingHandoffBasePositionMs = -1;
  let preloadHoldUntilMs = 0;
  let preloadHoldActive = false;
  let lastChunkReceivedAt = 0;
  let isStalled = false;
  let consecutiveZeroRefills = 0;
  let currentSessionId = 0;
  let diagnostics = createWorkerDiagnostics();

  let pendingGaplessBytes = null;
  let pendingGaplessSampleRate = 0;
  let activeSampleRate = 48000;
  const core = createSharedPlaybackWorkerControllerCore({
    emitMessage,
    clearIntervalFn,
    getDiagnostics: () => diagnostics,
    getFrameCapacity: () => frameCapacity,
    getExtraSyncPayload: () => {
      const payload = {
        lowWaterMarkCount: diagnostics.lowWaterMarkCount,
        recoveryModeActive: diagnostics.recoveryModeActive,
        activeBoundedWindowSize: diagnostics.activeBoundedWindowSize,
        retainedBytes: diagnostics.retainedBytes,
        pendingSeekDistanceMs: diagnostics.pendingSeekDistanceMs,
        fetchToDecodeLagMs: diagnostics.fetchToDecodeLagMs,
        resumeAfterStallLatencyMs: diagnostics.resumeAfterStallLatencyMs,
      };
      if (diagnosticsMode === 'extended') {
        if (sharedState) {
          payload.readIndex = Atomics.load(sharedState, READ_INDEX);
          payload.writeIndex = Atomics.load(sharedState, WRITE_INDEX);
          payload.framesRendered = sharedState.length > 5 ? Atomics.load(sharedState, 5) : null;
          payload.workletHeartbeatCount = sharedState.length > 6 ? Atomics.load(sharedState, 6) : null;
        } else {
          payload.readIndex = null;
          payload.writeIndex = null;
          payload.framesRendered = null;
          payload.workletHeartbeatCount = null;
        }
      }
      return payload;
    },
    getRefillTimerId: () => refillTimerId,
    setRefillTimerId: (value) => {
      refillTimerId = value;
    },
  });

  const coreEmitDiagnosticsEvent = core.emitDiagnosticsEvent;
  const emitDiagnosticsSync = core.emitDiagnosticsSync;

  let diagnosticsMode = 'minimal';

  function setDiagnosticsMode(mode) {
    diagnosticsMode = ['off', 'minimal', 'normal', 'extended'].includes(mode)
      ? mode
      : 'minimal';
  }

  const noisyEventTypes = new Set(['refill-complete', 'media-session-heartbeat', 'readahead-status', 'decode-waiting', 'refill-starvation-diagnostic']);

  function emitDiagnosticsEvent(event) {
    if (diagnosticsMode === 'extended' || !noisyEventTypes.has(event.type)) {
      coreEmitDiagnosticsEvent(event);
    }
  }

  function currentPlayer() {
    return windowedPlayer ?? streamingPlayer ?? player;
  }

  function playerHasEnded(candidatePlayer) {
    return typeof candidatePlayer?.hasEnded === 'function' && candidatePlayer.hasEnded();
  }

  let isBelowLowWaterMark = false;

  function updateBufferMetrics() {
    const framesAvailable = sharedState
      ? Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX)
      : 0;
    diagnostics.framesAvailable = framesAvailable;
    diagnostics.bufferFillPercent =
      frameCapacity > 0
        ? Number(((framesAvailable / frameCapacity) * 100).toFixed(1))
        : 0;

    if (diagnostics.bufferFillPercent < 10 && !isBelowLowWaterMark) {
      isBelowLowWaterMark = true;
      diagnostics.lowWaterMarkCount += 1;
    } else if (diagnostics.bufferFillPercent >= 15) {
      isBelowLowWaterMark = false;
    }

    const isCritical = framesAvailable < CRITICAL_THRESHOLD_FRAMES && frameCapacity > 0;
    if (isCritical !== diagnostics.recoveryModeActive) {
      diagnostics.recoveryModeActive = isCritical;
      if (isCritical && startupCompleted) {
        emitDiagnosticsEvent({
          type: 'recovery-mode-entered',
          label: 'Entering recovery mode (low headroom)',
          severity: 'warning',
          timestampMs: nowMs(),
          framesAvailable,
        });
      }
    }

    if (windowedPlayer) {
      diagnostics.retainedBytes = windowedPlayer.bufferedBytes();
    }

    const currentTime = nowMs();
    if (currentTime <= transitionMonitorUntilMs) {
      if (diagnostics.bufferFillPercent < transitionFloorCandidate) {
        transitionFloorCandidate = diagnostics.bufferFillPercent;
      }
    } else if (
      transitionFloorCandidate !== Infinity &&
      currentTime > transitionMonitorUntilMs
    ) {
      diagnostics.lastTransitionFloorPercent = transitionFloorCandidate;
      lastCompletedHandoffUnderrunDelta =
        diagnostics.underrunCount - handoffUnderrunBaseline;
      emitDiagnosticsEvent({
        type: 'transition-buffer-floor',
        label: 'Transition buffer floor',
        floorPercent: transitionFloorCandidate,
        timestampMs: currentTime,
        severity: transitionFloorCandidate < 25 ? 'warning' : 'info',
      });
      transitionFloorCandidate = Infinity;
    }
  }

  function resetPlaybackState() {
    if (player) {
      player.free();
      player = null;
    }
    if (streamingPlayer) {
      streamingPlayer.free();
      streamingPlayer = null;
    }
    if (windowedPlayer) {
      windowedPlayer.free();
      windowedPlayer = null;
    }
    if (fetchController) {
      fetchController.abort();
      fetchController = null;
    }
    sharedSamples = null;
    sharedState = null;
    frameCapacity = 0;
    streamingPlaybackStarted = false;
    streamingFinalized = false;
    streamingBufferedDurationMs = 0;
    startupCompleted = false;
    trackStartPositionMs = 0;
    currentTrackEndPositionMs = 0;
    currentTrackEndPositionKnown = false;
    currentTrackEndPositionHandled = false;
    _pendingHandoffBasePositionMs = -1;
    _streamingHintDurationMs = 0;
    transitionMonitorUntilMs = 0;
    transitionFloorCandidate = Infinity;
    handoffUnderrunBaseline = 0;
    handoffStartedAtMs = 0;
    handoffPendingUntilMs = 0;
    lastCompletedHandoffUnderrunDelta = 0;
    endedEmitted = false;
    preloadHoldUntilMs = 0;
    preloadHoldActive = false;
    lastChunkReceivedAt = 0;
    isStalled = false;
    consecutiveZeroRefills = 0;
    pendingGaplessBytes = null;
    pendingGaplessSampleRate = 0;
    currentSessionId++;
  }

  function setCurrentTrackEndPosition(durationMs, isKnown = durationMs > 0) {
    currentTrackEndPositionMs = durationMs > 0 ? durationMs : 0;
    currentTrackEndPositionKnown = isKnown;
    currentTrackEndPositionHandled = false;
  }

  const stopRefillLoop = core.stopRefillLoop;

  function startRefillLoop() {
    stopRefillLoop();
    lastRefillTickMs = performanceNow();
    refillTimerId = setIntervalFn(() => {
      if (refillPending) return;
      const currentTime = performanceNow();
      const gap = currentTime - lastRefillTickMs;
      lastRefillTickMs = currentTime;
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
    }, REFILL_INTERVAL_MS);
  }

  function bindSharedBuffers({ pcmBuffer, stateBuffer, frameCapacity: nextCapacity }) {
    frameCapacity = nextCapacity;
    sharedSamples = new Float32Array(pcmBuffer);
    sharedState = new Int32Array(stateBuffer);
    sharedState.fill(0);
    updateBufferMetrics();
  }

  function noteRefillComplete() {
    updateBufferMetrics();
    const historyPoint = {
      timeMs: nowMs(),
      bufferFillPercent: diagnostics.bufferFillPercent,
      decodeMs: diagnostics.lastDecodeMs,
      framesAvailable: diagnostics.framesAvailable,
    };
    emitDiagnosticsEvent({
      type: 'refill-complete',
      label: 'Refill complete',
      timestampMs: nowMs(),
      severity: 'info',
      durationMs: diagnostics.lastRefillDurationMs,
      framesAvailable: diagnostics.framesAvailable,
      bufferFillPercent: diagnostics.bufferFillPercent,
      decodeMs: diagnostics.lastDecodeMs,
    });
    emitDiagnosticsSync({ historyPoint });
    maybeStartPlaybackIfBuffered();
  }

  function updateDecodeMetrics(decodeDurationMs) {
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

  function emitPlaybackStarted() {
    emitMessage({ type: 'playback-started' });
    emitDiagnosticsEvent({
      type: 'startup-buffer-ready',
      label: 'Startup buffer ready',
      timestampMs: nowMs(),
      severity: 'info',
      framesAvailable: diagnostics.framesAvailable,
      bufferFillPercent: diagnostics.bufferFillPercent,
    });
    if (diagnostics._isStreamingReinit && diagnostics._reInitStartMs > 0) {
      const reInitReadyMs = performanceNow();
      const audibleLateGapMs = Math.max(0, reInitReadyMs - diagnostics._reInitStartMs);
      emitDiagnosticsEvent({
        type: 'track-handoff',
        label: 'Track handoff (streaming reinit)',
        timestampMs: nowMs(),
        severity: audibleLateGapMs > 100 ? 'warning' : 'info',
        signedGapMs: audibleLateGapMs,
        audibleLateGapMs,
        isStreamingReinit: true,
        transitionFloorPercent: diagnostics.lastTransitionFloorPercent,
        underrunDelta: 0,
      });
      diagnostics._isStreamingReinit = false;
      diagnostics._reInitStartMs = 0;
    }
  }

  function maybeStartPlaybackIfBuffered(optionalFrames) {
    const activePlayer = currentPlayer();
    const framesAvailable = optionalFrames ?? diagnostics.framesAvailable;
    const bufferReady =
      framesAvailable >= PLAYBACK_START_FRAMES ||
      (((streamingFinalized || playerHasEnded(player)) && framesAvailable > 0));

    if (!activePlayer || startupCompleted || !bufferReady) {
      return;
    }

    startupCompleted = true;
    if ((streamingPlayer || windowedPlayer) && !streamingPlaybackStarted) {
      streamingPlaybackStarted = true;
    }
    emitPlaybackStarted();
  }

  function emitEnded() {
    if (endedEmitted) {
      return;
    }
    // Layer A hold window: if no gapless bytes are pending, wait up to 500ms
    // for them to arrive before falling through to streaming reinit.
    if (pendingGaplessBytes === null && !preloadHoldActive) {
      preloadHoldActive = true;
      preloadHoldUntilMs = nowMs() + 500;
      return; // hold — do not emit yet
    }
    if (pendingGaplessBytes === null && preloadHoldActive) {
      if (nowMs() < preloadHoldUntilMs) {
        return; // still within hold window — do not emit yet
      }
      // Hold window expired — fall through to streaming reinit
      preloadHoldActive = false;
    }
    // pendingGaplessBytes is not null: the streaming→gapless bridge will
    // handle the handoff on the next refill tick. Do not emit ended.
    if (pendingGaplessBytes !== null) {
      preloadHoldActive = false;
      return;
    }
    endedEmitted = true;
    emitMessage({ type: 'ended' });
  }

  function handleEndOfStream() {
    // For streaming formats like Opus, durationMs() stays 0 (OGG total-sample-count is in
    // the last page, not the headers). positionMs() after all frames are decoded equals the
    // true total duration, so emit it now if we haven't sent a real duration yet.
    if (streamingPlayer) {
      const finalDurationMs = Math.floor(streamingPlayer.positionMs());
      if (finalDurationMs > 0) {
        emitMessage({ type: 'duration', durationMs: finalDurationMs });
      }
    }
    if (sharedState) {
      Atomics.store(sharedState, END_OF_STREAM_INDEX, 1);
      if (Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX) === 0) {
        stopRefillLoop();
        emitEnded();
      }
    }
  }

  function refillRingBuffer() {
    refillPending = false;
    const activePlayer = currentPlayer();
    if (!activePlayer || !sharedSamples || !sharedState) {
      return;
    }
    const isStreaming = activePlayer === streamingPlayer || activePlayer === windowedPlayer;
    const refillStartedAt = performanceNow();
    let wroteFrames = false;

    while (true) {
      const framesAvailable = Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX);
      const currentTargetFrames = startupCompleted ? STEADY_STATE_TARGET_FRAMES : frameCapacity;

      const isCritical = framesAvailable < CRITICAL_THRESHOLD_FRAMES;
      const currentChunkSize = isCritical ? REFILL_CHUNK_FRAMES_RECOVERY : REFILL_CHUNK_FRAMES;

      const writableFrames = Math.min(
        currentTargetFrames - framesAvailable,
        currentChunkSize,
      );

      if (writableFrames <= 0) {
        break;
      }

      if (activePlayer === windowedPlayer && activePlayer.hasPendingSeek()) {
        const offset = activePlayer.pendingSeekOffset();
        activePlayer.clearPendingSeek();
        if (fetchController) {
          fetchController.fetchFrom(offset);
        }
        return; // Skip this refill tick, data will arrive next tick
      }

      const decodeStartedAt = performanceNow();
      let result;
      let decodeError;
      try {
        result = activePlayer.decodeFrames(writableFrames);
      } catch (error) {
        decodeError = error;
      }

      updateDecodeMetrics(Number((performanceNow() - decodeStartedAt).toFixed(2)));

      if (activePlayer !== currentPlayer()) {
        return;
      }

      if (result instanceof Float32Array && result.length > 0) {
        consecutiveZeroRefills = 0;
        diagnostics.pendingSeekDistanceMs = 0;
        if (lastChunkReceivedAt > 0) {
          const lag = performanceNow() - lastChunkReceivedAt;
          diagnostics.fetchToDecodeLagMs = Number(lag.toFixed(2));
          if (isStalled) {
            diagnostics.resumeAfterStallLatencyMs = Number(lag.toFixed(2));
            isStalled = false;
          }
          lastChunkReceivedAt = 0;
        }
      } else {
        const isEOFOrFinalizedDrain = isStreaming
          ? streamingFinalized
          : playerHasEnded(activePlayer);
        if (isCritical && !isEOFOrFinalizedDrain) {
          consecutiveZeroRefills++;
          if (consecutiveZeroRefills === 10 || (consecutiveZeroRefills > 10 && consecutiveZeroRefills % 50 === 0)) {
            if (diagnosticsMode === 'extended') {
              const bufferFillPercent = frameCapacity > 0
                ? Number(((framesAvailable / frameCapacity) * 100).toFixed(1))
                : 0;

              emitDiagnosticsEvent({
                type: 'refill-starvation-diagnostic',
                label: 'Refill starvation detected',
                timestampMs: nowMs(),
                severity: 'warning',
                framesAvailable,
                bufferFillPercent,
                refillGapMs: diagnostics.lastRefillGapMs,
                zeroFillRun: consecutiveZeroRefills,
              });
            }
          }
        } else {
          consecutiveZeroRefills = 0;
        }
      }

      if (activePlayer === windowedPlayer) {
        if (fetchController) {
          const bufferedAhead = activePlayer.bufferedAhead();
          const framesDecodedCount = windowedPlayer.framesDecoded();
          const isPaused = fetchController.isPaused;
          const sampleRate = activePlayer.sampleRate();
          const minFrames = sampleRate * 5;

          // Diagnostics logging
          if (framesDecodedCount < minFrames * 2) { // Log more frequently early on
            emitDiagnosticsEvent({
              type: 'readahead-status',
              label: 'Read-ahead status',
              timestampMs: nowMs(),
              severity: 'info',
              bufferedAhead,
              bytesFetched: fetchController.bytesFetched,
              framesDecoded: framesDecodedCount,
              isPaused,
            });
          }

          if (framesDecodedCount > minFrames) {
            if (!isPaused && bufferedAhead > READ_AHEAD_BYTES) {
              fetchController.pause();
            } else if (isPaused && bufferedAhead < RESUME_THRESHOLD_BYTES) {
              fetchController.resume();
            }
          }
        }
      }

      if (decodeError) {
        const message =
          decodeError instanceof Error ? decodeError.message : String(decodeError);
        if (message.includes('end-of-stream')) {
          if (isStreaming && streamingFinalized && pendingGaplessBytes !== null) {
            // end-of-stream error on a finalized stream — route through the bridge.
            const transitionPositionMs = streamingPlayer?.positionMs() ?? 0;
            console.log('[worker] streaming→gapless bridge (end-of-stream error): transitioning at', transitionPositionMs.toFixed(0), 'ms');
            const bytes = pendingGaplessBytes;
            pendingGaplessBytes = null;
            let newPlayer;
            try {
              newPlayer = createGaplessPlayer(bytes, pendingGaplessSampleRate);
            } catch (bridgeError) {
              stopRefillLoop();
              diagnostics.transitionGapMs = null;
              emitMessage({ type: 'playback-error', message: bridgeError instanceof Error ? bridgeError.message : String(bridgeError) });
              return;
            }
            trackStartPositionMs = transitionPositionMs;
            setCurrentTrackEndPosition(
              newPlayer.durationMs() || _streamingHintDurationMs,
              newPlayer.durationMs() > 0 || _streamingHintDurationMs > 0,
            );
            handoffUnderrunBaseline = diagnostics.underrunCount;
            handoffStartedAtMs = nowMs();
            diagnostics.transitionGapMs = 0;
            streamingPlayer.free();
            streamingPlayer = null;
            streamingFinalized = false;
            player = newPlayer;
            const nextDurationMs = Math.floor(newPlayer.durationMs() || _streamingHintDurationMs || 0);
            emitMessage({
              type: 'track-changed',
              transitionPositionMs: Math.floor(transitionPositionMs),
              durationMs: nextDurationMs,
            });
            emitMessage({ type: 'duration', durationMs: nextDurationMs });
            emitDiagnosticsEvent({ type: 'track-handoff', label: 'Track handoff (streaming→gapless, end-of-stream path)', timestampMs: handoffStartedAtMs, severity: 'info', signedGapMs: 0, audibleLateGapMs: 0, transitionFloorPercent: diagnostics.lastTransitionFloorPercent, underrunDelta: 0 });
            return;
          }
          handleEndOfStream();
          return;
        }
        stopRefillLoop();
        diagnostics.transitionGapMs = null;
        emitMessage({ type: 'playback-error', message: message || 'decode error' });
        return;
      }

      if (result === null) {
        if (isStreaming) {
          if (!streamingFinalized) {
            isStalled = true;
            emitDiagnosticsEvent({
              type: 'decode-waiting',
              label: 'Waiting for stream data',
              severity: 'info',
              timestampMs: nowMs(),
            });
          }
          if (streamingFinalized) {
            if (pendingGaplessBytes !== null) {
              // Streaming has finished and we have a preloaded next track.
              // Transition to WasmGaplessPlayer without letting the ring buffer drain.
              console.log('[worker] streaming→gapless bridge: transitioning at', streamingPlayer.positionMs().toFixed(0), 'ms');
              const transitionPositionMs = streamingPlayer.positionMs();
              const bytes = pendingGaplessBytes;
              pendingGaplessBytes = null;

              let newPlayer;
              try {
                newPlayer = createGaplessPlayer(bytes, pendingGaplessSampleRate);
              } catch (error) {
                stopRefillLoop();
                diagnostics.transitionGapMs = null;
                emitMessage({
                  type: 'playback-error',
                  message: error instanceof Error ? error.message : String(error),
                });
                return;
              }

              trackStartPositionMs = transitionPositionMs;
              setCurrentTrackEndPosition(
                newPlayer.durationMs() || _streamingHintDurationMs,
                newPlayer.durationMs() > 0 || _streamingHintDurationMs > 0,
              );
              handoffUnderrunBaseline = diagnostics.underrunCount;
              handoffStartedAtMs = nowMs();
              diagnostics.transitionGapMs = 0;

              streamingPlayer.free();
              streamingPlayer = null;
              streamingFinalized = false;
              player = newPlayer;

              const nextDurationMs = Math.floor(newPlayer.durationMs() || _streamingHintDurationMs || 0);
              emitMessage({
                type: 'track-changed',
                transitionPositionMs: Math.floor(transitionPositionMs),
                durationMs: nextDurationMs,
              });
              emitMessage({ type: 'duration', durationMs: nextDurationMs });
              emitDiagnosticsEvent({
                type: 'track-handoff',
                label: 'Track handoff (streaming→gapless)',
                timestampMs: handoffStartedAtMs,
                severity: 'info',
                signedGapMs: 0,
                audibleLateGapMs: 0,
                transitionFloorPercent: diagnostics.lastTransitionFloorPercent,
                underrunDelta: 0,
              });
            } else {
              handleEndOfStream();
            }
            return;
          }
        }
        if (activePlayer !== player) {
          return;
        }
        if (playerHasEnded(activePlayer)) {
          handleEndOfStream();
        }
        return;
      }

      if (!(result instanceof Float32Array)) {
        if (isStreaming && streamingFinalized) {
          if (pendingGaplessBytes !== null) {
            // Non-Float32Array result on a finalized stream — route through the bridge.
            const transitionPositionMs = streamingPlayer?.positionMs() ?? 0;
            console.log('[worker] streaming→gapless bridge (non-array result): transitioning at', transitionPositionMs.toFixed(0), 'ms');
            const bytes = pendingGaplessBytes;
            pendingGaplessBytes = null;
            let newPlayer;
            try {
              newPlayer = createGaplessPlayer(bytes, pendingGaplessSampleRate);
            } catch (bridgeError) {
              stopRefillLoop();
              diagnostics.transitionGapMs = null;
              emitMessage({ type: 'playback-error', message: bridgeError instanceof Error ? bridgeError.message : String(bridgeError) });
              return;
            }
            trackStartPositionMs = transitionPositionMs;
            setCurrentTrackEndPosition(
              newPlayer.durationMs() || _streamingHintDurationMs,
              newPlayer.durationMs() > 0 || _streamingHintDurationMs > 0,
            );
            handoffUnderrunBaseline = diagnostics.underrunCount;
            handoffStartedAtMs = nowMs();
            diagnostics.transitionGapMs = 0;
            streamingPlayer.free();
            streamingPlayer = null;
            streamingFinalized = false;
            player = newPlayer;
            const nextDurationMs = Math.floor(newPlayer.durationMs() || _streamingHintDurationMs || 0);
            emitMessage({
              type: 'track-changed',
              transitionPositionMs: Math.floor(transitionPositionMs),
              durationMs: nextDurationMs,
            });
            emitMessage({ type: 'duration', durationMs: nextDurationMs });
            emitDiagnosticsEvent({ type: 'track-handoff', label: 'Track handoff (streaming→gapless, non-array path)', timestampMs: handoffStartedAtMs, severity: 'info', signedGapMs: 0, audibleLateGapMs: 0, transitionFloorPercent: diagnostics.lastTransitionFloorPercent, underrunDelta: 0 });
            return;
          }
          handleEndOfStream();
          return;
        }
        stopRefillLoop();
        diagnostics.transitionGapMs = null;
        emitMessage({
          type: 'playback-error',
          message: result.message ?? 'decode error',
        });
        return;
      }

      if (isStreaming && result.length === 0) {
        if (streamingFinalized) {
          if (pendingGaplessBytes !== null) {
            // Zero-length result on a finalized stream — route through the bridge.
            const transitionPositionMs = streamingPlayer?.positionMs() ?? 0;
            console.log('[worker] streaming→gapless bridge (zero-length result): transitioning at', transitionPositionMs.toFixed(0), 'ms');
            const bytes = pendingGaplessBytes;
            pendingGaplessBytes = null;
            let newPlayer;
            try {
              newPlayer = createGaplessPlayer(bytes, pendingGaplessSampleRate);
            } catch (bridgeError) {
              stopRefillLoop();
              diagnostics.transitionGapMs = null;
              emitMessage({ type: 'playback-error', message: bridgeError instanceof Error ? bridgeError.message : String(bridgeError) });
              return;
            }
            trackStartPositionMs = transitionPositionMs;
            setCurrentTrackEndPosition(
              newPlayer.durationMs() || _streamingHintDurationMs,
              newPlayer.durationMs() > 0 || _streamingHintDurationMs > 0,
            );
            handoffUnderrunBaseline = diagnostics.underrunCount;
            handoffStartedAtMs = nowMs();
            diagnostics.transitionGapMs = 0;
            streamingPlayer.free();
            streamingPlayer = null;
            streamingFinalized = false;
            player = newPlayer;
            const nextDurationMs = Math.floor(newPlayer.durationMs() || _streamingHintDurationMs || 0);
            emitMessage({
              type: 'track-changed',
              transitionPositionMs: Math.floor(transitionPositionMs),
              durationMs: nextDurationMs,
            });
            emitMessage({ type: 'duration', durationMs: nextDurationMs });
            emitDiagnosticsEvent({ type: 'track-handoff', label: 'Track handoff (streaming→gapless, zero-length path)', timestampMs: handoffStartedAtMs, severity: 'info', signedGapMs: 0, audibleLateGapMs: 0, transitionFloorPercent: diagnostics.lastTransitionFloorPercent, underrunDelta: 0 });
            return;
          }
          handleEndOfStream();
        }
        return;
      }

      if (!isStreaming) {
        if (activePlayer !== player) {
          return;
        }
        const newDuration = activePlayer.durationMs();
        if (
          !currentTrackEndPositionKnown &&
          (newDuration > 0 || _streamingHintDurationMs > 0)
        ) {
          const resolvedDuration = newDuration || _streamingHintDurationMs;
          const endPositionMs =
            _pendingHandoffBasePositionMs >= 0
              ? _pendingHandoffBasePositionMs + resolvedDuration
              : resolvedDuration;
          setCurrentTrackEndPosition(endPositionMs, true);
          if (_pendingHandoffBasePositionMs >= 0) {
            // Emit a corrected duration for the track whose duration was unknown
            // at handoff time. Dart uses this to schedule the next preload.
            emitMessage({
              type: 'duration',
              durationMs: Math.floor(resolvedDuration),
            });
            _pendingHandoffBasePositionMs = -1;
          }
        }
        const transitionPositionMs = activePlayer.positionMs();
        if (currentTrackEndPositionKnown && !currentTrackEndPositionHandled) {
          const crossedTrackBoundary =
            transitionPositionMs >=
            currentTrackEndPositionMs - TRACK_HANDOFF_TOLERANCE_MS;
          if (crossedTrackBoundary) {
            const currentFillPercent = frameCapacity > 0 ? (framesAvailable / frameCapacity) * 100 : 0;
            if (currentFillPercent < HANDOFF_FILL_THRESHOLD_PERCENT) {
              if (handoffPendingUntilMs === 0) {
                handoffPendingUntilMs = nowMs() + HANDOFF_RETRY_WINDOW_MS;
              }
              if (nowMs() < handoffPendingUntilMs) {
                return; // retry next tick
              }
              handoffPendingUntilMs = 0;
              stopRefillLoop();
              diagnostics.transitionGapMs = null;
              emitMessage({ type: 'playback-error', message: 'handoff_unsafe' });
              return;
            }
            handoffPendingUntilMs = 0;
            diagnostics.transitionGapMs =
              transitionPositionMs - currentTrackEndPositionMs;
            handoffUnderrunBaseline = diagnostics.underrunCount;
            handoffStartedAtMs = nowMs();
            const signedGapMs = diagnostics.transitionGapMs;
            const audibleLateGapMs = Math.max(0, signedGapMs);
            const underrunDelta = lastCompletedHandoffUnderrunDelta;
            trackStartPositionMs = transitionPositionMs;
            currentTrackEndPositionHandled = true;
            emitDiagnosticsEvent({
              type: 'track-handoff',
              label: 'Track handoff',
              timestampMs: handoffStartedAtMs,
              severity:
                audibleLateGapMs > 0 || underrunDelta > 0 ? 'warning' : 'info',
              signedGapMs,
              audibleLateGapMs,
              transitionFloorPercent: diagnostics.lastTransitionFloorPercent,
              underrunDelta,
            });
            const nextDurationMs = Math.floor(newDuration || 0);
            emitMessage({
              type: 'track-changed',
              transitionPositionMs: Math.floor(transitionPositionMs),
              durationMs: nextDurationMs,
            });
            emitMessage({ type: 'duration', durationMs: nextDurationMs });
            transitionMonitorUntilMs = handoffStartedAtMs + 500;
            transitionFloorCandidate = Infinity;
            // Reset the boundary detector for the next gapless handoff.
            // After the Rust-internal track swap, activePlayer.durationMs() returns
            // the new track's duration (not the old track's). The new absolute
            // end position is transitionPositionMs (= old end) + newDuration.
            // setCurrentTrackEndPosition resets currentTrackEndPositionHandled = false
            // so the next boundary crossing will fire a second track-changed.
            if (newDuration > 0) {
              // Duration known at handoff time: set absolute boundary directly.
              setCurrentTrackEndPosition(transitionPositionMs + newDuration, true);
              _pendingHandoffBasePositionMs = -1;
            } else {
              // Duration unknown at handoff time (VBR MP3, Ogg without headers).
              // Save the base so the per-tick discovery block can resolve the
              // absolute boundary once durationMs() returns a positive value.
              // setCurrentTrackEndPosition(0, false) resets:
              //   currentTrackEndPositionHandled = false  (via setCurrentTrackEndPosition)
              //   currentTrackEndPositionKnown   = false  (isKnown arg)
              // so the discovery block will fire on the next tick with a real duration.
              _pendingHandoffBasePositionMs = transitionPositionMs;
              setCurrentTrackEndPosition(0, false);
            }
          }
        }
      }

      const samples = result;
      const framesToCopy = Math.min(writableFrames, samples.length / CHANNELS);
      if (framesToCopy <= 0) {
        break;
      }

      const writeFrame = Atomics.load(sharedState, WRITE_INDEX);
      const samplesToCopy = framesToCopy * CHANNELS;
      const writeIndex = writeFrame * CHANNELS;
      const capacitySamples = frameCapacity * CHANNELS;

      if (writeIndex + samplesToCopy <= capacitySamples) {
        sharedSamples.set(samples.subarray(0, samplesToCopy), writeIndex);
      } else {
        const firstPartSamples = capacitySamples - writeIndex;
        sharedSamples.set(samples.subarray(0, firstPartSamples), writeIndex);
        sharedSamples.set(
          samples.subarray(firstPartSamples, samplesToCopy),
          0,
        );
      }

      Atomics.store(
        sharedState,
        WRITE_INDEX,
        (writeFrame + framesToCopy) % frameCapacity,
      );
      Atomics.add(sharedState, FRAMES_AVAILABLE_INDEX, framesToCopy);
      wroteFrames = true;

      const currentPositionMs = Math.floor(
        activePlayer.positionMs() - trackStartPositionMs,
      );
      emitMessage({ type: 'position', positionMs: currentPositionMs });

      if (!startupCompleted && Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX) >= PLAYBACK_START_FRAMES) {
        maybeStartPlaybackIfBuffered(Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX));
      }

      if (performanceNow() - refillStartedAt > REFILL_MAX_TICK_DURATION_MS) {
        refillPending = true;
        setTimeout(() => refillRingBuffer(), 0);
        break;
      }
    }

    diagnostics.lastRefillDurationMs = Number(
      (performanceNow() - refillStartedAt).toFixed(2),
    );

    if (wroteFrames) {
      noteRefillComplete();
    } else {
      updateBufferMetrics();
      emitDiagnosticsSync();
      maybeStartPlaybackIfBuffered();
    }
  }

  function kickRefillLoopIfNeeded() {
    const activePlayer = currentPlayer();
    if (!activePlayer || !sharedSamples || !sharedState) {
      return;
    }
    if (refillTimerId == null) {
      startRefillLoop();
    }
    refillRingBuffer();
  }

  return {
    setDiagnosticsMode,
    playTrack(audioBytes, buffers) {
      stopRefillLoop();
      resetPlaybackState();
      diagnostics = createWorkerDiagnostics({
        workerState: 'running',
        decoderOwner: 'worker',
      });
      emitDiagnosticsEvent({
        type: 'decoder-reinitialized',
        label: 'Decoder reinitialized (gapless)',
        timestampMs: nowMs(),
        severity: 'info',
      });
      bindSharedBuffers(buffers);
      const startedAt = performanceNow();
      activeSampleRate = buffers.sampleRate ?? 48000;
      try {
        player = createGaplessPlayer(audioBytes, activeSampleRate);
      } catch (error) {
        stopRefillLoop();
        emitMessage({
          type: 'playback-error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const durationMs = player.durationMs();
      setCurrentTrackEndPosition(durationMs, durationMs > 0);
      emitMessage({ type: 'duration', durationMs: Math.floor(durationMs) });
      emitDiagnosticsSync({
        startupTimingsMs: {
          decoderCreate: Number((performanceNow() - startedAt).toFixed(2)),
        },
      });
      startRefillLoop();
      refillRingBuffer();
    },

    playTrackBounded(url, totalSize, sampleRate, buffers) {
      stopRefillLoop();
      resetPlaybackState();
      const sessionId = currentSessionId;
      const maxWindowMb = 64;
      diagnostics = createWorkerDiagnostics({
        workerState: 'running',
        decoderOwner: 'worker',
        activeBoundedWindowSize: maxWindowMb,
      });
      emitDiagnosticsEvent({
        type: 'decoder-reinitialized',
        label: 'Decoder reinitialized (bounded)',
        timestampMs: nowMs(),
        severity: 'info',
      });
      bindSharedBuffers(buffers);
      const startedAt = performanceNow();
      
      let wasmPlayer;
      try {
        wasmPlayer = createWindowedStreamingPlayer(totalSize != null ? BigInt(totalSize) : undefined, maxWindowMb);
      } catch (error) {
        emitMessage({
          type: 'playback-error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      let framesDecoded = 0;
      let lastWindowStart = 0;
      
      windowedPlayer = {
        free: () => wasmPlayer.free(),
        framesDecoded: () => framesDecoded,
        decodeFrames: (n) => {
          const result = wasmPlayer.decodeFrames(n);
          if (result instanceof Float32Array) {
            framesDecoded += result.length / 2;
          }
          return result;
        },
        durationMs: () => {
          if (framesDecoded === 0 || !fetchController || fetchController.bytesFetched === 0 || !totalSize) return 0;
          const bytesPerFrame = fetchController.bytesFetched / framesDecoded;
          return ((totalSize / bytesPerFrame) / sampleRate) * 1000;
        },
        positionMs: () => (framesDecoded / sampleRate) * 1000,
        sampleRate: () => sampleRate,
        channels: () => 2,
        isReady: () => true,
        isFinalized: () => false,
        seekToMs: (ms) => {
          wasmPlayer.seekToMs(ms);
          framesDecoded = Math.floor((ms * sampleRate) / 1000);
        },
        hasPendingSeek: () => wasmPlayer.hasPendingSeek(),
        pendingSeekOffset: () => wasmPlayer.pendingSeekOffset(),
        clearPendingSeek: () => wasmPlayer.clearPendingSeek(),
        windowStart: () => wasmPlayer.windowStart(),
        bufferedBytes: () => wasmPlayer.bufferedBytes(),
        finalizeStream: () => wasmPlayer.finalizeStream(),
        appendChunk: (chunk) => wasmPlayer.appendChunk(chunk),
        bufferedAhead: () => {
          return wasmPlayer.bufferedBytes();
        }
      };

      emitDiagnosticsSync({
        startupTimingsMs: {
          decoderCreate: Number((performanceNow() - startedAt).toFixed(2)),
        },
      });

      // Fix 3: track fetch start time to diagnose proxy cold-start latency.
      let fetchStartAt = 0;

      fetchController = createRangeFetchController(url, {
        onChunk: (chunk) => {
          if (sessionId !== currentSessionId) return;
          const isFirstChunk = lastChunkReceivedAt === 0;
          lastChunkReceivedAt = performanceNow();
          if (isFirstChunk && fetchStartAt > 0) {
            const firstByteMs = Math.round(lastChunkReceivedAt - fetchStartAt);
            emitDiagnosticsEvent({
              type: 'bounded-first-byte',
              label: `First byte received after ${firstByteMs}ms`,
              timestampMs: nowMs(),
              severity: firstByteMs > 5000 ? 'warning' : 'info',
              firstByteMs,
            });
          }
          if (windowedPlayer) {
            windowedPlayer.appendChunk(chunk);
            const currentWindowStart = windowedPlayer.windowStart();
            if (currentWindowStart > lastWindowStart) {
              emitDiagnosticsEvent({
                type: 'bounded-window-slide',
                label: 'Bounded window slide',
                timestampMs: nowMs(),
                severity: 'info',
                oldStart: lastWindowStart,
                newStart: currentWindowStart,
              });
              lastWindowStart = currentWindowStart;
            }
            kickRefillLoopIfNeeded();
          }
        },
        onComplete: () => {
          if (sessionId !== currentSessionId) return;
          if (windowedPlayer) {
            windowedPlayer.finalizeStream();
            streamingFinalized = true;
            kickRefillLoopIfNeeded();
          }
        },
        onError: (err) => {
          if (sessionId !== currentSessionId) return;
          diagnostics.transitionGapMs = null;
          emitMessage({ type: 'playback-error', message: err.message || 'fetch error' });
        }
      });

      fetchStartAt = performanceNow();
      fetchController.fetchFrom(0);
    },

    playTrackStreaming(buffers) {
      const isReinit = !!(player || streamingPlayer || windowedPlayer);
      const reInitStartMs = isReinit ? performanceNow() : 0;

      stopRefillLoop();
      resetPlaybackState();
      diagnostics = createWorkerDiagnostics({
        workerState: 'running',
        decoderOwner: 'worker',
      });
      emitDiagnosticsEvent({
        type: 'decoder-reinitialized',
        label: 'Decoder reinitialized (streaming)',
        timestampMs: nowMs(),
        severity: 'info',
      });
      bindSharedBuffers(buffers);
      const startedAt = performanceNow();
      activeSampleRate = buffers.sampleRate ?? 48000;
      try {
        streamingPlayer = createStreamingPlayer(activeSampleRate);
      } catch (error) {
        stopRefillLoop();
        emitMessage({
          type: 'playback-error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      emitDiagnosticsSync({
        startupTimingsMs: {
          decoderCreate: Number((performanceNow() - startedAt).toFixed(2)),
        },
      });
      if (isReinit) {
        diagnostics._reInitStartMs = reInitStartMs;
        diagnostics._isStreamingReinit = true;
      }
    },

    appendChunk(chunk) {
      if (!streamingPlayer) {
        return {
          ready: false,
          playbackStarted: false,
          sessionEnded: true,
        };
      }

      const wasReady = streamingPlayer.isReady();
      const ready = streamingPlayer.appendChunk(chunk);
      if (!wasReady && ready) {
        const durationMs = Math.floor(streamingPlayer.durationMs());
        if (durationMs > 0) {
          emitMessage({ type: 'duration', durationMs });
        }
      }

      if (ready) {
        kickRefillLoopIfNeeded();
      }

      return {
        ready: streamingPlayer.isReady(),
        playbackStarted: streamingPlaybackStarted,
        sessionEnded: false,
      };
    },

    finalizeStream() {
      if (!streamingPlayer) {
        return;
      }
      streamingPlayer.finalize();
      streamingFinalized = true;
      kickRefillLoopIfNeeded();
    },

    transitionStreamToGapless(audioBytes, hintDurationMs = 0) {
      if (!streamingPlayer) {
        return;
      }
      const currentDecodePositionMs = streamingPlayer.positionMs();
      let newPlayer;
      try {
        newPlayer = createGaplessPlayer(audioBytes, activeSampleRate);
      } catch (error) {
        console.error('[worker] transitionStreamToGapless: failed to create GaplessPlayer:', error instanceof Error ? error.message : String(error));
        return;
      }
      try {
        newPlayer.seekToMs(currentDecodePositionMs);
      } catch {
        // Seek failed — player stays at 0, future user seeks will still work.
      }
      if (pendingGaplessBytes !== null) {
        try {
          newPlayer.loadNext(pendingGaplessBytes);
        } catch { /* ignore */ }
        pendingGaplessBytes = null;
      }
      streamingPlayer.free();
      streamingPlayer = null;
      streamingFinalized = false;
      player = newPlayer;
      trackStartPositionMs = currentDecodePositionMs;
      _streamingHintDurationMs = hintDurationMs;
      setCurrentTrackEndPosition(
        newPlayer.durationMs() || hintDurationMs,
        newPlayer.durationMs() > 0 || hintDurationMs > 0,
      );
      endedEmitted = false;
      kickRefillLoopIfNeeded();
    },

    preloadNext(audioBytes) {
      if (!player) {
        if (streamingPlayer || windowedPlayer) {
          // Store bytes; the streaming→gapless bridge will consume them when streaming ends.
          pendingGaplessBytes = audioBytes;
          pendingGaplessSampleRate = activeSampleRate;
          console.log('[worker] preloadNext: stored as pendingGaplessBytes for streaming→gapless bridge');
          emitMessage({ type: 'preload-pending' });
        } else {
          emitMessage({ type: 'preload-error', message: 'no_active_player' });
        }
        return;
      }
      console.log('[worker] preloadNext: calling player.loadNext, bytes=' + audioBytes.byteLength);
      let result;
      try {
        result = player.loadNext(audioBytes);
      } catch (error) {
        emitMessage({
          type: 'preload-error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (result && result.error === 'next_failed') {
        emitMessage({
          type: 'preload-error',
          message: result.message ?? 'preload failed',
        });
      } else {
        emitMessage({ type: 'preload-pending' });
      }
    },

    preloadNextBounded(_url, _totalSize) {
      // In v1, bounded streaming preloading doesn't fetch bytes into RAM.
      // The gapless transition will fall back to a standard gapped load when playQueue is called.
    },

    seek(positionMs) {
      const activePlayer = currentPlayer();
      if (!activePlayer) {
        return;
      }
      if (streamingPlayer && !streamingFinalized) {
        const maxBufferedMs = this.bufferedDurationMs();
        if (positionMs > maxBufferedMs) {
          throw new RangeError(
            `Seek target ${positionMs}ms exceeds buffered range ${maxBufferedMs}ms.`,
          );
        }
      }

      stopRefillLoop();
      diagnostics.transitionGapMs = null;
      
      const currentPos = (activePlayer.positionMs() - trackStartPositionMs);
      diagnostics.pendingSeekDistanceMs = Math.abs(positionMs - currentPos);

      let seekError = null;
      try {
        activePlayer.seekToMs(positionMs);
      } catch (err) {
        seekError = err;
      }

      if (seekError) {
        emitDiagnosticsEvent({
          type: 'seek-failed',
          label: 'Seek failed',
          timestampMs: nowMs(),
          severity: 'warning',
          message: seekError instanceof Error ? seekError.message : String(seekError),
        });
      } else {
        if (sharedState) {
          Atomics.store(sharedState, READ_INDEX, 0);
          Atomics.store(sharedState, WRITE_INDEX, 0);
          Atomics.store(sharedState, FRAMES_AVAILABLE_INDEX, 0);
          Atomics.store(sharedState, END_OF_STREAM_INDEX, 0);
        }
        trackStartPositionMs = 0;
        const durationMs = activePlayer.durationMs();
        setCurrentTrackEndPosition(durationMs, durationMs > 0);
        endedEmitted = false;
        emitDiagnosticsEvent({
          type: 'seek',
          label: 'Seek',
          timestampMs: nowMs(),
          severity: 'info',
        });
      }
      startRefillLoop();
    },

    setBufferedDurationMs(value) {
      streamingBufferedDurationMs = Number.isFinite(value)
        ? Math.max(0, value)
        : 0;
    },

    bufferedDurationMs() {
      if (streamingPlayer) {
        const durationMs = streamingPlayer.durationMs();
        if (streamingFinalized || streamingPlayer.isFinalized()) {
          return durationMs;
        }
        return Math.min(durationMs || streamingBufferedDurationMs, streamingBufferedDurationMs);
      }
      if (player) {
        return player.durationMs();
      }
      return 0;
    },

    pauseRefill() {
      stopRefillLoop();
    },

    transportMute() {
      stopRefillLoop();
      if (sharedState) {
        Atomics.store(sharedState, STOP_INDEX, 1);
      }
      emitDiagnosticsSync();
      return this.getHealthStatus();
    },

    transportUnmute() {
      if (sharedState) {
        Atomics.store(sharedState, STOP_INDEX, 0);
      }
      kickRefillLoopIfNeeded();
      emitDiagnosticsSync();
      return this.getHealthStatus();
    },

    stop() {
      stopRefillLoop();
      if (sharedState) {
        Atomics.store(sharedState, STOP_INDEX, 1);
      }
      resetPlaybackState();
      diagnostics = createWorkerDiagnostics();
      emitDiagnosticsSync();
    },

    nudge() {
      emitDiagnosticsEvent({
        type: 'worker-nudge',
        label: 'Worker nudged',
        timestampMs: nowMs(),
        severity: 'info',
      });
      kickRefillLoopIfNeeded();
      return this.getHealthStatus();
    },

    getHealthStatus() {
      const framesAvailable = sharedState
        ? Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX)
        : 0;
      const endOfStream = sharedState
        ? Atomics.load(sharedState, END_OF_STREAM_INDEX) === 1
        : false;
      const pendingSeek = (windowedPlayer?.hasPendingSeek()) ?? false;

      const health = {
        framesAvailable,
        decoderReady: !!(windowedPlayer || streamingPlayer || player),
        endOfStream,
        pendingSeek,
      };

      if (sharedState) {
        health.readIndex = Atomics.load(sharedState, READ_INDEX);
        health.writeIndex = Atomics.load(sharedState, WRITE_INDEX);
        health.framesRendered = sharedState.length > 5 ? Atomics.load(sharedState, 5) : null;
        health.workletHeartbeatCount = sharedState.length > 6 ? Atomics.load(sharedState, 6) : null;
      } else {
        health.readIndex = null;
        health.writeIndex = null;
        health.framesRendered = null;
        health.workletHeartbeatCount = null;
      }

      return health;
    },
  };
}

function createWorkerDiagnostics(overrides = {}) {
  return createBaseWorkerDiagnostics({
    lowWaterMarkCount: 0,
    recoveryModeActive: false,
    activeBoundedWindowSize: 0,
    retainedBytes: 0,
    pendingSeekDistanceMs: 0,
    fetchToDecodeLagMs: 0,
    resumeAfterStallLatencyMs: 0,
    ...overrides,
  });
}

export { createPlaybackWorkerController };
