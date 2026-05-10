const READ_INDEX = 0;
const WRITE_INDEX = 1;
const FRAMES_AVAILABLE_INDEX = 2;
const END_OF_STREAM_INDEX = 3;
const STOP_INDEX = 4;
const CHANNELS = 2;
const REFILL_CHUNK_FRAMES = 1024;
const REFILL_CHUNK_FRAMES_RECOVERY = 4096;
const REFILL_INTERVAL_MS = 15;
const PLAYBACK_START_FRAMES_DEFAULT = 88200;
const PLAYBACK_START_FRAMES_MIN = 44100;
const STEADY_STATE_TARGET_MIN_FRAMES = 264600; // ~6s at 44.1kHz
const STEADY_STATE_TARGET_MAX_FRAMES = 485100; // ~11s at 44.1kHz
const TRANSITION_HEADROOM_FRAMES = 132300; // ~3s extra during transitions
const CRITICAL_THRESHOLD_FRAMES = 44100; // ~1s at 44.1kHz
const REFILL_MAX_TICK_DURATION_MS = 20;
const READ_AHEAD_MS = 30000; // 30s
const RESUME_THRESHOLD_MS = 10000; // 10s

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
  let streamingFetchError = null;
  let streamingPlaybackStarted = false;
  let streamingFinalized = false;
  let streamingBufferedDurationMs = 0;
  let startupCompleted = false;
  let refillTimerId = null;
  let refillPending = false;
  let lastRefillTickMs = 0;
  let trackStartPositionMs = 0;
  let transitionMonitorUntilMs = 0;
  let transitionFloorCandidate = Infinity;
  let endedEmitted = false;
  let lastChunkReceivedAt = 0;
  let isStalled = false;

  // Adaptive policy state
  let adaptiveSteadyStateTarget = STEADY_STATE_TARGET_MIN_FRAMES;
  let adaptiveStartupThreshold = PLAYBACK_START_FRAMES_DEFAULT;
  let consecutiveStableRefills = 0;

  let diagnostics = createWorkerDiagnostics();

  function emitDiagnosticsEvent(event) {
    emitMessage({ type: 'diagnostics-event', event });
  }

  function emitDiagnosticsSync({ historyPoint, startupTimingsMs } = {}) {
    emitMessage({
      type: 'diagnostics-sync',
      payload: {
        workerState: diagnostics.workerState,
        decoderOwner: diagnostics.decoderOwner,
        framesAvailable: diagnostics.framesAvailable,
        frameCapacity,
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
        lowWaterMarkCount: diagnostics.lowWaterMarkCount,
        recoveryModeActive: diagnostics.recoveryModeActive,
        activeBoundedWindowSize: diagnostics.activeBoundedWindowSize,
        adaptiveSteadyStateTarget,
        retainedBytes: diagnostics.retainedBytes,
        pendingSeekDistanceMs: diagnostics.pendingSeekDistanceMs,
        fetchToDecodeLagMs: diagnostics.fetchToDecodeLagMs,
        resumeAfterStallLatencyMs: diagnostics.resumeAfterStallLatencyMs,
        historyPoint,
        startupTimingsMs,
      },
    });
  }

  function currentPlayer() {
    return windowedPlayer ?? streamingPlayer ?? player;
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
      if (isCritical) {
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
    transitionMonitorUntilMs = 0;
    transitionFloorCandidate = Infinity;
    endedEmitted = false;

    // Reset adaptive state
    adaptiveSteadyStateTarget = STEADY_STATE_TARGET_MIN_FRAMES;
    adaptiveStartupThreshold = PLAYBACK_START_FRAMES_DEFAULT;
    consecutiveStableRefills = 0;
  }

  function stopRefillLoop() {
    if (refillTimerId != null) {
      clearIntervalFn(refillTimerId);
      refillTimerId = null;
    }
  }

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
  }

  function maybeStartPlaybackIfBuffered(optionalFrames) {
    const activePlayer = currentPlayer();
    const framesAvailable = optionalFrames ?? diagnostics.framesAvailable;
    const bufferReady =
      framesAvailable >= adaptiveStartupThreshold ||
      (((streamingFinalized || (player && player.hasEnded())) && framesAvailable > 0));

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
    endedEmitted = true;
    emitMessage({ type: 'ended' });
  }

  function handleEndOfStream() {
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

    // 1. Adaptive Steady-State Policy
    // If scheduling jitter is detected (refill gap > 35ms), increase target headroom.
    // If scheduling is stable, gradually return to minimum target.
    if (diagnostics.lastRefillGapMs > 35) {
      const increase = 44100; // Increase by ~1s
      const nextTarget = Math.min(STEADY_STATE_TARGET_MAX_FRAMES, adaptiveSteadyStateTarget + increase);
      if (nextTarget > adaptiveSteadyStateTarget) {
        adaptiveSteadyStateTarget = nextTarget;
        emitDiagnosticsEvent({
          type: 'adaptive-target-increased',
          label: 'Increasing buffer target due to jitter',
          newTarget: adaptiveSteadyStateTarget,
          gapMs: diagnostics.lastRefillGapMs,
          severity: 'info',
          timestampMs: nowMs(),
        });
      }
      consecutiveStableRefills = 0;
    } else if (diagnostics.lastRefillGapMs > 0 && diagnostics.lastRefillGapMs < 20) {
      consecutiveStableRefills++;
      if (consecutiveStableRefills > 30 && adaptiveSteadyStateTarget > STEADY_STATE_TARGET_MIN_FRAMES) {
        adaptiveSteadyStateTarget = Math.max(STEADY_STATE_TARGET_MIN_FRAMES, adaptiveSteadyStateTarget - 4410); // Decrease by ~100ms
        consecutiveStableRefills = 25; // Reset but stay near threshold
      }
    }

    let wroteFrames = false;

    while (true) {
      const framesAvailable = Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX);

      // 2. Transition Headroom Protection
      // If we are within 10s of a track handoff, increase target headroom to protect against transition dips.
      let transitionHeadroom = 0;
      if (!isStreaming && player) {
        const currentDuration = player.durationMs();
        const currentPos = player.positionMs() - trackStartPositionMs;
        const timeRemainingMs = currentDuration - currentPos;
        if (currentDuration > 0 && timeRemainingMs > 0 && timeRemainingMs < 10000) {
          transitionHeadroom = TRANSITION_HEADROOM_FRAMES;
        }
      }

      const baseTarget = startupCompleted ? adaptiveSteadyStateTarget : frameCapacity;
      const currentTargetFrames = Math.min(frameCapacity - 4096, baseTarget + transitionHeadroom);

      const isCritical = framesAvailable < CRITICAL_THRESHOLD_FRAMES;
      const currentChunkSize = isCritical ? REFILL_CHUNK_FRAMES_RECOVERY : REFILL_CHUNK_FRAMES;

      const writableFrames = Math.min(
        currentTargetFrames - framesAvailable,
        currentChunkSize,
      );

      if (writableFrames <= 0) {
        break;
      }

      const decodeStartedAt = performanceNow();
      const previousDuration = isStreaming
        ? activePlayer.durationMs()
        : player.durationMs();
      let result;
      let decodeError;
      try {
        result = activePlayer.decodeFrames(writableFrames);
      } catch (error) {
        decodeError = error;
      }

      const decodeDurationMs = performanceNow() - decodeStartedAt;
      updateDecodeMetrics(Number(decodeDurationMs.toFixed(2)));

      // 3. Adaptive Startup Threshold
      // If we see very fast decodes initially, we can safely start playback earlier.
      if (!startupCompleted && diagnostics.refillCount > 1 && diagnostics.refillCount < 5) {
        if (diagnostics.movingAverageDecodeMs < 8) {
          adaptiveStartupThreshold = PLAYBACK_START_FRAMES_MIN;
        }
      }

      if (result instanceof Float32Array && result.length > 0) {
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
      }

      if (activePlayer === windowedPlayer) {
        if (activePlayer.hasPendingSeek()) {
          const offset = activePlayer.pendingSeekOffset();
          activePlayer.clearPendingSeek();
          if (fetchController) {
            streamingFetchError = null;
            fetchController.fetchFrom(offset);
          }
          return; // Skip this refill tick, data will arrive next tick
        } else if (fetchController && !fetchController.isPaused && activePlayer.bufferedAheadMs() > READ_AHEAD_MS) {
          fetchController.pause();
        } else if (fetchController && fetchController.isPaused && activePlayer.bufferedAheadMs() < RESUME_THRESHOLD_MS) {
          fetchController.resume();
        }
      }

      if (decodeError) {
        const message =
          decodeError instanceof Error ? decodeError.message : String(decodeError);
        if (message.includes('end-of-stream')) {
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
            handleEndOfStream();
          }
          return;
        }
        if (player.hasEnded()) {
          handleEndOfStream();
        }
        return;
      }

      if (!(result instanceof Float32Array)) {
        if (isStreaming && streamingFinalized) {
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
          handleEndOfStream();
        }
        return;
      }

      if (!isStreaming) {
        const newDuration = player.durationMs();
        if (newDuration !== previousDuration) {
          const actualTransitionMs = player.positionMs() - trackStartPositionMs;
          diagnostics.transitionGapMs = actualTransitionMs - previousDuration;
          trackStartPositionMs = player.positionMs();
          emitDiagnosticsEvent({
            type: 'track-handoff',
            label: 'Track handoff',
            timestampMs: nowMs(),
            severity: 'info',
          });
          emitMessage({ type: 'track-changed' });
          emitMessage({ type: 'duration', durationMs: Math.floor(newDuration) });
          transitionMonitorUntilMs = nowMs() + 500;
          transitionFloorCandidate = Infinity;
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
        (isStreaming ? activePlayer.positionMs() : player.positionMs()) -
          trackStartPositionMs,
      );
      emitMessage({ type: 'position', positionMs: currentPositionMs });

      if (!startupCompleted && Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX) >= adaptiveStartupThreshold) {
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
      player = createGaplessPlayer(audioBytes, buffers.sampleRate ?? 48000);
      emitMessage({ type: 'duration', durationMs: Math.floor(player.durationMs()) });
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
      
      const wasmPlayer = createWindowedStreamingPlayer(totalSize != null ? BigInt(totalSize) : undefined, maxWindowMb);
      let framesDecoded = 0;
      let lastWindowStart = 0;
      
      windowedPlayer = {
        free: () => wasmPlayer.free(),
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
          if (!fetchController) return 0;
          const fetched = fetchController.bytesFetched;
          if (framesDecoded === 0) return fetched;
          const bytesPerFrame = fetched / framesDecoded;
          const estimatedConsumed = framesDecoded * bytesPerFrame;
          return Math.max(0, fetched - estimatedConsumed);
        },
        bufferedAheadMs: () => {
          if (!fetchController || framesDecoded === 0) return 0;
          const fetched = fetchController.bytesFetched;
          const bytesPerFrame = fetched / framesDecoded;
          const bufferedFrames = windowedPlayer.bufferedAhead() / bytesPerFrame;
          return (bufferedFrames / sampleRate) * 1000;
        }
      };

      emitDiagnosticsSync({
        startupTimingsMs: {
          decoderCreate: Number((performanceNow() - startedAt).toFixed(2)),
        },
      });

      fetchController = createRangeFetchController(url, {
        onChunk: (chunk) => {
          lastChunkReceivedAt = performanceNow();
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
          if (windowedPlayer) {
            windowedPlayer.finalizeStream();
            streamingFinalized = true;
            kickRefillLoopIfNeeded();
          }
        },
        onError: (err) => {
          diagnostics.transitionGapMs = null;
          emitMessage({ type: 'playback-error', message: err.message || 'fetch error' });
        }
      });

      fetchController.fetchFrom(0);
    },

    playTrackStreaming(buffers) {
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
      streamingPlayer = createStreamingPlayer(buffers.sampleRate ?? 48000);
      emitDiagnosticsSync({
        startupTimingsMs: {
          decoderCreate: Number((performanceNow() - startedAt).toFixed(2)),
        },
      });
    },

    appendChunk(chunk) {
      if (!streamingPlayer) {
        throw new Error('Streaming player is not active.');
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

    preloadNext(audioBytes) {
      if (!player) {
        return;
      }
      const result = player.loadNext(audioBytes);
      if (result && result.error === 'next_failed') {
        emitMessage({
          type: 'preload-error',
          message: result.message ?? 'preload failed',
        });
      }
    },

    preloadNextBounded(url, totalSize) {
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

      return {
        framesAvailable,
        decoderReady: !!(windowedPlayer || streamingPlayer || player),
        endOfStream,
        pendingSeek,
      };
    },
  };
}

function createWorkerDiagnostics(overrides = {}) {
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
    lowWaterMarkCount: 0,
    recoveryModeActive: false,
    activeBoundedWindowSize: 0,
    retainedBytes: 0,
    pendingSeekDistanceMs: 0,
    fetchToDecodeLagMs: 0,
    resumeAfterStallLatencyMs: 0,
    ...overrides,
  };
}

export { createPlaybackWorkerController };
