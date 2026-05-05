const READ_INDEX = 0;
const WRITE_INDEX = 1;
const FRAMES_AVAILABLE_INDEX = 2;
const END_OF_STREAM_INDEX = 3;
const STOP_INDEX = 4;
const CHANNELS = 2;
const REFILL_CHUNK_FRAMES = 1024;
const REFILL_INTERVAL_MS = 15;
const PLAYBACK_START_FRAMES = 88200;
const READ_AHEAD_BYTES = 8 * 1024 * 1024;
const RESUME_THRESHOLD_BYTES = 2 * 1024 * 1024;

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
  let lastRefillTickMs = 0;
  let trackStartPositionMs = 0;
  let transitionMonitorUntilMs = 0;
  let transitionFloorCandidate = Infinity;
  let endedEmitted = false;
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
        historyPoint,
        startupTimingsMs,
      },
    });
  }

  function currentPlayer() {
    return windowedPlayer ?? streamingPlayer ?? player;
  }

  function updateBufferMetrics() {
    const framesAvailable = sharedState
      ? Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX)
      : 0;
    diagnostics.framesAvailable = framesAvailable;
    diagnostics.bufferFillPercent =
      frameCapacity > 0
        ? Number(((framesAvailable / frameCapacity) * 100).toFixed(1))
        : 0;

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

  function maybeStartPlaybackIfBuffered() {
    const activePlayer = currentPlayer();
    const bufferReady =
      diagnostics.framesAvailable >= PLAYBACK_START_FRAMES ||
      (((streamingFinalized || (player && player.hasEnded())) && diagnostics.framesAvailable > 0));

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
    const activePlayer = currentPlayer();
    if (!activePlayer || !sharedSamples || !sharedState) {
      return;
    }
    const isStreaming = activePlayer === streamingPlayer || activePlayer === windowedPlayer;
    const refillStartedAt = performanceNow();
    let wroteFrames = false;

    while (true) {
      const framesAvailable = Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX);
      const writableFrames = Math.min(
        frameCapacity - framesAvailable,
        REFILL_CHUNK_FRAMES,
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

      updateDecodeMetrics(Number((performanceNow() - decodeStartedAt).toFixed(2)));

      if (activePlayer === windowedPlayer) {
        if (activePlayer.hasPendingSeek()) {
          const offset = activePlayer.pendingSeekOffset();
          activePlayer.clearPendingSeek();
          if (fetchController) {
            streamingFetchError = null;
            fetchController.fetchFrom(offset);
          }
          return; // Skip this refill tick, data will arrive next tick
        } else if (fetchController && !fetchController.isPaused && activePlayer.bufferedAhead() > READ_AHEAD_BYTES) {
          fetchController.pause();
        } else if (fetchController && fetchController.isPaused && activePlayer.bufferedAhead() < RESUME_THRESHOLD_BYTES) {
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
      diagnostics = createWorkerDiagnostics({
        workerState: 'running',
        decoderOwner: 'worker',
      });
      bindSharedBuffers(buffers);
      const startedAt = performanceNow();
      
      const wasmPlayer = createWindowedStreamingPlayer(totalSize != null ? BigInt(totalSize) : undefined, 64);
      let framesDecoded = 0;
      
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
        finalizeStream: () => wasmPlayer.finalizeStream(),
        appendChunk: (chunk) => wasmPlayer.appendChunk(chunk),
        bufferedAhead: () => {
          if (!fetchController) return 0;
          const fetched = fetchController.bytesFetched;
          if (framesDecoded === 0) return fetched;
          const bytesPerFrame = fetched / framesDecoded;
          const estimatedConsumed = framesDecoded * bytesPerFrame;
          return Math.max(0, fetched - estimatedConsumed);
        }
      };

      emitDiagnosticsSync({
        startupTimingsMs: {
          decoderCreate: Number((performanceNow() - startedAt).toFixed(2)),
        },
      });

      fetchController = createRangeFetchController(url, {
        onChunk: (chunk) => {
          if (windowedPlayer) {
            windowedPlayer.appendChunk(chunk);
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
    ...overrides,
  };
}

export { createPlaybackWorkerController };
