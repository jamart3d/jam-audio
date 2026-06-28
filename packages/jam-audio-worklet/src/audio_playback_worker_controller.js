// S1 spike findings (2026-06-11):
// Atomics.waitAsync verified working on:
//   Chrome Node v20.20.2 (V8 11.3.244.8-node.38) — PASS
//   Firefox DEFERRED — DEFERRED
//   Safari iOS DEFERRED — DEFERRED — iOS on-device validation deferred per spec §6
// Minimum floor per spec §3.1: Chrome 87+, Safari 16.4+, Firefox recent releases.
// Runtime detection at worker init selects: waitasync | port | degraded-interval.
//
// S2 spike findings (2026-06-11):
// MessagePort wiring path: bridge creates MessageChannel, transfers port2 to
// the worker via worker.postMessage({type:'set-worklet-port'}, [port2]),
// and transfers port1 to the worklet via processorNode.port.postMessage(
//   {type:'set-refill-port'}, [port1]).
// The worker receives port2 via onmessage, calls controller.setWorkletPort(port2).
// The worklet sets this.refillPort = port1 in handleMessage.
// Manual verification: wiring confirmed functional — worklet posts {type:'refill-wake'}
// on port1; worker receives on port2.onmessage and calls refillRingBuffer() directly.
// NOTE: wiring requires workaround for worklet/worker not being parent/child:
//   all port transfers MUST go through the main thread (bridge).
// Wiring confirmed functional via node mock environment (S2 PASS).

import {
  createBaseWorkerDiagnostics,
  createSharedPlaybackWorkerControllerCore,
} from '../shared/playback_worker_controller_core.js';
import {
  createWorkletPortState,
  currentPlayerFrom,
  playerHasEnded,
  playerPositionMs,
} from './playback_worker_controller_runtime.js';
import {
  startPortLoop,
  nudgeWaitAsyncState,
} from './playback_worker_controller_refill.js';


const READ_INDEX = 0;
const WRITE_INDEX = 1;
const FRAMES_AVAILABLE_INDEX = 2;
const END_OF_STREAM_INDEX = 3;
const STOP_INDEX = 4;
const REFILL_REQUEST_INDEX = 7; // futex: worklet add+notify when hungry; worker waitAsync target
const TARGET_FRAMES_INDEX = 8;  // adaptive fill target (Phase 1: STEADY_STATE_TARGET_FRAMES)
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
const ARITHMETIC_FALLBACK_WATCHDOG_MS = 2000;
const HANDOFF_RETRY_WINDOW_MS = 200;
const HANDOFF_FILL_THRESHOLD_PERCENT = 25;

const PRELOAD_HOLD_MS = 500;
const GAPLESS_ENDED_FALLBACK_MS = 750;
const RECOVERY_REMAINING_THRESHOLD_MS = 1500;

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
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  workletPort = null,          // S2: MessageChannel port1, transferred from bridge → worker → here
  onWorkletPortReady = null,   // S2: callback so tests can verify the port was received
  waitTimeoutMs = 1000,        // Finding 5: injected so tests use 10ms and never hang
}) {
  const workletPortState = createWorkletPortState({
    initialPort: workletPort,
    onWorkletPortReady,
  });

  const getWorkletPort = workletPortState.getWorkletPort;
  const setWorkletPort = workletPortState.setWorkletPort;

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
  let refillDriver = null; // 'waitasync' | 'port' | 'degraded-interval'; set once per worker lifetime
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
  let pendingHandoffDurationBaseMs = -1;
  let pendingHandoffPreviousDurationMs = 0;
  let pendingHandoffProvisionalDurationMs = 0;
  let pendingGaplessHintDurationMs = 0;
  let loadedNextGaplessHintDurationMs = 0;
  let pendingHandoffHintDurationMs = 0;
  let preloadHoldUntilMs = 0;
  let preloadHoldActive = false;
  let lastChunkReceivedAt = 0;
  let isStalled = false;
  let consecutiveZeroRefills = 0;
  let currentSessionId = 0;
  let diagnostics = createWorkerDiagnostics();

  let lastSeamGeneration = 0;
  let arithmeticBoundaryArmedAtMs = 0;
  let pendingGaplessBytes = null;
  let gaplessPlayerNextLoaded = false;
  let gaplessEndedFallbackTimer = null;
  let pendingGaplessFallbackRecoveryConfirmation = false;
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

  function emitEndedEmissionState(action) {
    emitDiagnosticsEvent({
      type: 'ended-emission-state',
      label: 'Ended emission state',
      timestampMs: nowMs(),
      severity: 'info',
      action,
      endedEmitted,
      pendingGaplessBytes: pendingGaplessBytes === null ? 'none' : 'present',
      gaplessPlayerNextLoaded,
      preloadHoldActive,
      preloadHoldRemainingMs: preloadHoldActive
        ? Math.max(0, preloadHoldUntilMs - nowMs())
        : 0,
    });
  }

  function currentPlayer() {
    return currentPlayerFrom({ windowedPlayer, streamingPlayer, player });
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
    pendingHandoffDurationBaseMs = -1;
    pendingHandoffPreviousDurationMs = 0;
    pendingHandoffProvisionalDurationMs = 0;
    pendingGaplessHintDurationMs = 0;
    loadedNextGaplessHintDurationMs = 0;
    pendingHandoffHintDurationMs = 0;
    _streamingHintDurationMs = 0;
    transitionMonitorUntilMs = 0;
    transitionFloorCandidate = Infinity;
    handoffUnderrunBaseline = 0;
    handoffStartedAtMs = 0;
    handoffPendingUntilMs = 0;
    lastCompletedHandoffUnderrunDelta = 0;
    endedEmitted = false;
    clearPreloadHoldTimer();
    preloadHoldUntilMs = 0;
    preloadHoldActive = false;
    lastChunkReceivedAt = 0;
    isStalled = false;
    consecutiveZeroRefills = 0;
    clearTimeoutFn(gaplessEndedFallbackTimer);
    gaplessEndedFallbackTimer = null;
    pendingGaplessBytes = null;
    pendingGaplessSampleRate = 0;
    gaplessPlayerNextLoaded = false;
    pendingGaplessFallbackRecoveryConfirmation = false;
    lastSeamGeneration = 0;
    arithmeticBoundaryArmedAtMs = 0;
    currentSessionId++;
  }

  function setCurrentTrackEndPosition(durationMs, isKnown = durationMs > 0) {
    currentTrackEndPositionMs = durationMs > 0 ? durationMs : 0;
    currentTrackEndPositionKnown = isKnown;
    currentTrackEndPositionHandled = false;
  }

  function checkSeamSignal(activePlayer) {
    if (!activePlayer || activePlayer === streamingPlayer || activePlayer === windowedPlayer || typeof activePlayer.seamGeneration !== 'function') {
      return false;
    }
    const gen = activePlayer.seamGeneration();
    if (gen < lastSeamGeneration) {
      lastSeamGeneration = gen;
    }
    if (gen <= lastSeamGeneration) return false;

    // P1.10: Double-fire guard. If the EOS path already handled this boundary,
    // consume the generation (so it won't re-trigger on the next tick before reset)
    // but return false to suppress the second track-changed emission.
    if (currentTrackEndPositionHandled) {
      lastSeamGeneration = gen;
      return false;
    }

    // New seam detected. Seam position is always authoritative — decoded frames
    // are the boundary authority; container duration is a hint. Update the end
    // position and emit the full diagnostic trail unconditionally so sub-500ms
    // drifts are recorded and signedGapMs is always accurate.
    lastSeamGeneration = gen;
    const seamPositionMs = activePlayer.lastSeamPositionMs();
    const prevEndPositionMs = currentTrackEndPositionMs;

    currentTrackEndPositionMs = seamPositionMs;
    emitDiagnosticsEvent({
      type: 'seam-boundary-handoff',
      label: 'Seam signal superseded metadata boundary',
      timestampMs: nowMs(),
      severity: 'info',
      seamPositionMs,
      metadataBoundaryMs: prevEndPositionMs,
      headerDriftMs: prevEndPositionMs - seamPositionMs,
    });
    return true;
  }

  function currentBoundaryDurationMs() {
    if (!currentTrackEndPositionKnown) return 0;
    const base = trackStartPositionMs > 0 ? trackStartPositionMs : 0;
    return Math.max(0, currentTrackEndPositionMs - base);
  }

  function isStaleHandoffDuration(candidateDurationMs, previousDurationMs) {
    if (!candidateDurationMs || candidateDurationMs <= 0) return false;
    if (!previousDurationMs || previousDurationMs <= 0) return false;
    return Math.abs(candidateDurationMs - previousDurationMs) <= TRACK_HANDOFF_TOLERANCE_MS;
  }

  function emitGaplessDurationCorrection(durationMs, basePositionMs) {
    setCurrentTrackEndPosition(basePositionMs + durationMs, true);
    pendingHandoffDurationBaseMs = -1;
    pendingHandoffPreviousDurationMs = 0;
    pendingHandoffProvisionalDurationMs = 0;
    pendingGaplessHintDurationMs = 0;
    loadedNextGaplessHintDurationMs = 0;
    pendingHandoffHintDurationMs = 0;
    emitMessage({ type: 'duration', durationMs: Math.floor(durationMs) });
    emitDiagnosticsEvent({
      type: 'gapless-duration-corrected',
      label: 'Gapless duration corrected after handoff',
      timestampMs: nowMs(),
      severity: 'info',
      durationMs: Math.floor(durationMs),
      basePositionMs: Math.floor(basePositionMs),
      nextBoundaryMs: Math.floor(basePositionMs + durationMs),
      trackStartPositionMs: Math.floor(trackStartPositionMs),
      currentTrackEndPositionMs: Math.floor(currentTrackEndPositionMs),
      currentTrackEndPositionKnown,
    });
  }

  function probePendingHandoffDuration(activePlayer) {
    if (pendingHandoffDurationBaseMs < 0 || !activePlayer) return;
    const candidateDurationMs = activePlayer.durationMs();
    if (!candidateDurationMs || candidateDurationMs <= 0) return;
    if (pendingHandoffHintDurationMs > 0 && Math.abs(candidateDurationMs - pendingHandoffHintDurationMs) <= TRACK_HANDOFF_TOLERANCE_MS) {
      pendingHandoffDurationBaseMs = -1;
      pendingHandoffPreviousDurationMs = 0;
      pendingHandoffProvisionalDurationMs = 0;
      pendingHandoffHintDurationMs = 0;
      return;
    }
    if (isStaleHandoffDuration(candidateDurationMs, pendingHandoffPreviousDurationMs)) {
      return;
    }
    emitGaplessDurationCorrection(candidateDurationMs, pendingHandoffDurationBaseMs);
  }

  const _coreStopRefillLoop = core.stopRefillLoop;
  function stopRefillLoop() {
    _coreStopRefillLoop();
    if (sharedState && sharedState.length > REFILL_REQUEST_INDEX) {
      Atomics.notify(sharedState, REFILL_REQUEST_INDEX, 1);
    }
  }

  // Shared gapless boundary / handoff logic called from two sites:
  //   1. The writableFrames<=0 (full-buffer) early break — isFullBufferTick=true.
  //   2. The normal in-loop decode path — isFullBufferTick=false.
  //
  // Pre-condition: caller has already verified !isStreaming && activePlayer === player.
  // The function handles the currentTrackEndPositionKnown guard internally.
  //
  // Returns:
  //   'retry'  — boundary crossed but fill% too low; caller must defer (break/return)
  //   'unsafe' — fill% retry window expired; stopRefillLoop has been called, caller must return
  //   'fired'  — handoff was executed and track-changed emitted
  //   null     — end-position unknown or boundary not yet crossed; no action needed
  function runGaplessBoundaryHandoff(activePlayer, framesAvailable, isFullBufferTick) {
    probePendingHandoffDuration(activePlayer);
    const newDuration = activePlayer.durationMs();
    // Resolve end position if it was unknown at the previous handoff boundary
    // (e.g. stale duration at transition; duration became known this tick).
    const canUseStreamingHintForUnknownEnd =
      _pendingHandoffBasePositionMs < 0 && _streamingHintDurationMs > 0;

    if (!currentTrackEndPositionKnown &&
        (newDuration > 0 || canUseStreamingHintForUnknownEnd)) {
      const resolvedDuration = newDuration || _streamingHintDurationMs;
      const endPositionMs =
        _pendingHandoffBasePositionMs >= 0
          ? _pendingHandoffBasePositionMs + resolvedDuration
          : resolvedDuration;
      setCurrentTrackEndPosition(endPositionMs, true);
      if (_pendingHandoffBasePositionMs >= 0) {
        emitMessage({
          type: 'duration',
          durationMs: Math.floor(resolvedDuration),
        });
        _pendingHandoffBasePositionMs = -1;
      }
    }
    let crossedTrackBoundary = false;
    let positionMs = activePlayer.positionMs();

    const hasSeamAPI = typeof activePlayer.seamGeneration === 'function' &&
                       typeof activePlayer.lastSeamPositionMs === 'function';

    if (hasSeamAPI) {
      const isSeam = checkSeamSignal(activePlayer);
      if (isSeam) {
        crossedTrackBoundary = true;
        positionMs = activePlayer.lastSeamPositionMs();
        arithmeticBoundaryArmedAtMs = 0; // seam took authority; clear watchdog
      } else if (currentTrackEndPositionKnown && !currentTrackEndPositionHandled) {
        const arithmeticCrossed =
          positionMs >= currentTrackEndPositionMs - TRACK_HANDOFF_TOLERANCE_MS;
        if (arithmeticCrossed) {
          if (playerHasEnded(activePlayer)) {
            crossedTrackBoundary = true;
          } else {
            // Seam API present but seam has not arrived yet — arm watchdog, suppress emission.
            if (arithmeticBoundaryArmedAtMs === 0) {
              arithmeticBoundaryArmedAtMs = nowMs();
            }
            const watchdogExpired =
              nowMs() - arithmeticBoundaryArmedAtMs >= ARITHMETIC_FALLBACK_WATCHDOG_MS;
            if (watchdogExpired) {
              // Seam absent too long — fire arithmetic fallback and log diagnostic.
              crossedTrackBoundary = true;
              arithmeticBoundaryArmedAtMs = 0;
              emitDiagnosticsEvent({
                type: 'arithmetic-fallback-handoff',
                label: 'Arithmetic fallback handoff: seam absent past watchdog window',
                timestampMs: nowMs(),
                severity: 'warning',
                positionMs: Math.floor(positionMs),
                boundaryMs: Math.floor(currentTrackEndPositionMs),
                watchdogMs: ARITHMETIC_FALLBACK_WATCHDOG_MS,
              });
            }
            // If watchdog not expired: suppress (seam is expected, not yet arrived).
          }
        }
      }
    } else {
      if (currentTrackEndPositionKnown && !currentTrackEndPositionHandled) {
        crossedTrackBoundary =
          positionMs >=
          currentTrackEndPositionMs - TRACK_HANDOFF_TOLERANCE_MS;
      }
    }

    if (!crossedTrackBoundary) {
      return null;
    }
    const fillPercent = frameCapacity > 0 ? (framesAvailable / frameCapacity) * 100 : 0;
    const activePlayerEnded = playerHasEnded(activePlayer);
    if (fillPercent < HANDOFF_FILL_THRESHOLD_PERCENT && !activePlayerEnded) {
      if (handoffPendingUntilMs === 0) {
        handoffPendingUntilMs = nowMs() + HANDOFF_RETRY_WINDOW_MS;
      }
      if (nowMs() < handoffPendingUntilMs) {
        return 'retry';
      }
      handoffPendingUntilMs = 0;
      stopRefillLoop();
      diagnostics.transitionGapMs = null;
      emitMessage({ type: 'playback-error', message: 'handoff_unsafe' });
      return 'unsafe';
    }
    handoffPendingUntilMs = 0;
    diagnostics.transitionGapMs = positionMs - currentTrackEndPositionMs;
    handoffUnderrunBaseline = diagnostics.underrunCount;
    handoffStartedAtMs = nowMs();
    const signedGapMs = diagnostics.transitionGapMs;
    const audibleLateGapMs = Math.max(0, signedGapMs);
    const underrunDelta = lastCompletedHandoffUnderrunDelta;
    const previousDurationMs = currentBoundaryDurationMs();
    trackStartPositionMs = positionMs;
    _streamingHintDurationMs = 0;
    currentTrackEndPositionHandled = true;
    emitDiagnosticsEvent({
      type: 'track-handoff',
      label: 'Track handoff',
      timestampMs: handoffStartedAtMs,
      severity: audibleLateGapMs > 0 || underrunDelta > 0 ? 'warning' : 'info',
      signedGapMs,
      audibleLateGapMs,
      targetSignedGapMs: 0,
      targetLeadMs: 0,
      transitionFloorPercent: diagnostics.lastTransitionFloorPercent,
      underrunDelta,
    });
    const handoffDurationIsStale = isStaleHandoffDuration(newDuration, previousDurationMs);
    const hintedDurationMs = loadedNextGaplessHintDurationMs > 0
      ? loadedNextGaplessHintDurationMs
      : pendingGaplessHintDurationMs;
    // When the previous boundary window was very short (< 1000ms), the player was
    // seeked close to the end of the current track — typical of streaming→gapless
    // transitions. In this case durationMs() still reflects the OLD track's full
    // file duration and is unreliable as the new-track duration. If a preloaded
    // hint (pendingGaplessHintDurationMs / loadedNextGaplessHintDurationMs) is
    // available, prefer it over the player's stale value.
    const tinyPreviousDuration = previousDurationMs > 0 && previousDurationMs < 1000;
    const useHint = (handoffDurationIsStale || tinyPreviousDuration) && hintedDurationMs > 0 &&
      Math.abs(hintedDurationMs - previousDurationMs) > TRACK_HANDOFF_TOLERANCE_MS;
    const nextDurationMs = useHint
      ? hintedDurationMs
      : handoffDurationIsStale
        ? 0
        : Math.floor(newDuration || 0);
    if (tinyPreviousDuration) {
      emitDiagnosticsEvent({
        type: 'handoff-tiny-previous-duration',
        label: 'Gapless handoff fired on tiny boundary window',
        timestampMs: handoffStartedAtMs,
        severity: 'warning',
        previousDurationMs: Math.floor(previousDurationMs),
        playerDurationMs: Math.floor(newDuration),
        hintDurationMs: Math.floor(hintedDurationMs),
        chosen: Math.floor(useHint ? hintedDurationMs : (newDuration || 0)),
        positionMs: Math.floor(positionMs),
      });
    }
    if (handoffDurationIsStale) {
      if (useHint) {
        // Hint is authoritative. Set up a pending probe so that if the player
        // eventually returns the confirmed next-track duration we can validate;
        // the stale check in probePendingHandoffDuration will suppress overwrites
        // while durationMs() still returns the old-track value.
        pendingHandoffDurationBaseMs = positionMs;
        pendingHandoffPreviousDurationMs = previousDurationMs;
        pendingHandoffProvisionalDurationMs = newDuration;
        pendingHandoffHintDurationMs = hintedDurationMs;
        emitDiagnosticsEvent({
          type: 'gapless-duration-hint-used',
          label: 'Gapless handoff duration hint used',
          timestampMs: handoffStartedAtMs,
          severity: 'info',
          hintDurationMs: hintedDurationMs,
          staleDurationMs: newDuration,
          previousDurationMs: previousDurationMs,
          nextBoundaryMs: positionMs + hintedDurationMs,
        });
      } else {
        pendingHandoffDurationBaseMs = positionMs;
        pendingHandoffPreviousDurationMs = previousDurationMs;
        pendingHandoffProvisionalDurationMs = newDuration;
        emitDiagnosticsEvent({
          type: 'gapless-duration-provisional',
          label: 'Gapless handoff duration is provisional',
          timestampMs: handoffStartedAtMs,
          severity: 'warning',
          transitionPositionMs: Math.floor(positionMs),
          staleDurationMs: Math.floor(newDuration),
          previousDurationMs: Math.floor(previousDurationMs),
          trackStartPositionMs: Math.floor(trackStartPositionMs),
          currentTrackEndPositionMs: Math.floor(currentTrackEndPositionMs),
          currentTrackEndPositionKnown,
          gaplessHandoffMissingHint: true,
        });
      }
    } else if (tinyPreviousDuration && useHint) {
      // Tiny-window fire: the hint is authoritative and no pending probe is
      // needed — the player's durationMs() is still the old track's value and
      // would cause probePendingHandoffDuration to overwrite the correct boundary
      // if we opened a probe here. Just record the diagnostic.
      emitDiagnosticsEvent({
        type: 'gapless-duration-hint-used',
        label: 'Gapless handoff duration hint used (tiny window)',
        timestampMs: handoffStartedAtMs,
        severity: 'info',
        hintDurationMs: hintedDurationMs,
        staleDurationMs: newDuration,
        previousDurationMs: previousDurationMs,
        nextBoundaryMs: positionMs + hintedDurationMs,
      });
    } else if (tinyPreviousDuration) {
      // Tiny-window fire with no hint: the player's durationMs() still reflects the
      // OLD track's full file duration (newDuration). We accepted it as nextDurationMs
      // and armed the boundary with it above, but it will be wrong once the player
      // advances to the new track. Open a probe so probePendingHandoffDuration can
      // correct the boundary when durationMs() changes.
      //
      // pendingHandoffPreviousDurationMs is set to newDuration (the current stale value)
      // so the stale guard in probePendingHandoffDuration suppresses re-correction while
      // the player still reports the old file duration, and fires as soon as the player
      // returns the new track's real duration.
      pendingHandoffDurationBaseMs = positionMs;
      pendingHandoffPreviousDurationMs = newDuration;
      pendingHandoffProvisionalDurationMs = newDuration;
      emitDiagnosticsEvent({
        type: 'gapless-duration-provisional',
        label: 'Gapless handoff duration is provisional (tiny window, no hint)',
        timestampMs: handoffStartedAtMs,
        severity: 'warning',
        transitionPositionMs: Math.floor(positionMs),
        staleDurationMs: Math.floor(newDuration),
        previousDurationMs: Math.floor(previousDurationMs),
        trackStartPositionMs: Math.floor(trackStartPositionMs),
        currentTrackEndPositionMs: Math.floor(currentTrackEndPositionMs),
        currentTrackEndPositionKnown,
        gaplessHandoffMissingHint: true,
        tinyWindowNoHint: true,
      });
    }
    emitMessage({
      type: 'track-changed',
      transitionPositionMs: Math.floor(positionMs),
      durationMs: nextDurationMs,
      trackDelta: 1,
    });
    if (nextDurationMs > 0) {
      emitMessage({ type: 'duration', durationMs: nextDurationMs });
    }
    transitionMonitorUntilMs = handoffStartedAtMs + 500;
    transitionFloorCandidate = Infinity;
    gaplessPlayerNextLoaded = false;
    if (useHint) {
      setCurrentTrackEndPosition(positionMs + hintedDurationMs, true);
      _pendingHandoffBasePositionMs = -1;
    } else if (nextDurationMs > 0) {
      setCurrentTrackEndPosition(positionMs + nextDurationMs, true);
      _pendingHandoffBasePositionMs = -1;
    } else {
      _pendingHandoffBasePositionMs = positionMs;
      setCurrentTrackEndPosition(0, false);
    }
    pendingGaplessHintDurationMs = 0;
    loadedNextGaplessHintDurationMs = 0;
    if (isFullBufferTick) {
      emitDiagnosticsEvent({
        type: 'boundary-checked-on-full-buffer',
        label: 'Gapless boundary check fired on full-buffer tick',
        timestampMs: handoffStartedAtMs,
        severity: 'info',
        positionMs: Math.floor(positionMs),
        framesAvailable,
        fillPercent: Number(fillPercent.toFixed(1)),
      });
    }
    return 'fired';
  }

  function startRefillWaitLoop() {
    // ALWAYS bump first (Finding 2): prior loops see stale sessionId on next wake and exit.
    currentSessionId++;
    const sessionId = currentSessionId;
    stopRefillLoop(); // clear any interval timer / sentinel from previous loop
    refillTimerId = sessionId; // truthy sentinel — loop is active
    const driver = selectRefillDriver();

    if (driver === 'waitasync') {
      _runWaitAsyncLoop(sessionId);
    } else if (driver === 'port') {
      _runPortLoop(sessionId);
    } else {
      _runDegradedIntervalLoop();
    }
  }

  // Primary driver: Atomics.waitAsync
  // waitTimeoutMs is injected via controller options (default 1000ms production; 10ms in tests).
  async function _runWaitAsyncLoop(sessionId) {
    while (currentSessionId === sessionId) {
      if (!sharedState) break;
      // Capture expected BEFORE refill so a worklet notify during refill is
      // not lost: waitAsync will see not-equal and loop immediately.
      const expected = Atomics.load(sharedState, REFILL_REQUEST_INDEX);
      refillRingBuffer();
      if (currentSessionId !== sessionId) break; // session changed during refill
      const result = Atomics.waitAsync(sharedState, REFILL_REQUEST_INDEX, expected, waitTimeoutMs);
      if (result.async) {
        await result.value; // 'ok' | 'timed-out' | 'not-equal' — all wake reasons are fine
      }
      // Any wake reason → loop, re-read, refill. Spurious wakes are harmless.
    }
    if (refillTimerId === sessionId) refillTimerId = null;
  }

  // Fallback #1: MessagePort from worklet
  function _runPortLoop(sessionId) {
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
      _runDegradedIntervalLoop();
      return;
    }
    // Initial refill on loop start (covers startup case before worklet fires)
    refillRingBuffer();
    refillTimerId = sessionId;
  }

  // Fallback #2: degraded setInterval (throttle-prone, logs warning on each delayed tick)
  function _runDegradedIntervalLoop() {
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

  function selectRefillDriver() {
    if (refillDriver !== null) return refillDriver; // already selected
    // BOUNDS GUARD (Finding 1): if the SAB is small (legacy 5-slot fixture), slot 7 is
    // out of range. waitAsync on an out-of-bounds index would throw RangeError. Fall back
    // to legacy interval so existing tests continue to pass without change.
    const sabHasSlot7 = sharedState && sharedState.length > REFILL_REQUEST_INDEX;
    if (typeof Atomics.waitAsync === 'function' && sabHasSlot7) {
      refillDriver = 'waitasync';
    } else if (getWorkletPort() !== null) {
      refillDriver = 'port';
    } else {
      refillDriver = 'degraded-interval';
    }
    emitDiagnosticsEvent({
      type: 'refill-driver-selected',
      label: `Refill driver selected: ${refillDriver}`,
      timestampMs: nowMs(),
      severity: refillDriver === 'degraded-interval' ? 'warning' : 'info',
      driver: refillDriver,
    });
    return refillDriver;
  }

  function bindSharedBuffers({ pcmBuffer, stateBuffer, frameCapacity: nextCapacity }) {
    frameCapacity = nextCapacity;
    sharedSamples = new Float32Array(pcmBuffer);
    sharedState = new Int32Array(stateBuffer);
    sharedState.fill(0);
    if (sharedState.length > TARGET_FRAMES_INDEX) {
      Atomics.store(sharedState, TARGET_FRAMES_INDEX, STEADY_STATE_TARGET_FRAMES);
    }
    if (sharedState.length > REFILL_REQUEST_INDEX) {
      Atomics.store(sharedState, REFILL_REQUEST_INDEX, 0); // reset generation counter
    }
    updateBufferMetrics();
    selectRefillDriver();
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
        targetSignedGapMs: 0,
        targetLeadMs: 0,
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

  let preloadHoldTimerId = null;

  function clearPreloadHoldTimer() {
    if (preloadHoldTimerId !== null) {
      clearTimeoutFn(preloadHoldTimerId);
      preloadHoldTimerId = null;
    }
  }

  function schedulePreloadHoldExpiry() {
    if (preloadHoldTimerId !== null) return; // already scheduled
    const remainingMs = Math.max(0, preloadHoldUntilMs - nowMs());
    preloadHoldTimerId = setTimeoutFn(() => {
      preloadHoldTimerId = null;
      // Mark the hold as expired before calling emitEnded so that the
      // nowMs() < preloadHoldUntilMs guard in emitEnded always evaluates
      // to false here.  Without this, a frozen/constant injected nowMs()
      // (common in tests) would make emitEnded re-enter the hold-active
      // branch and call schedulePreloadHoldExpiry again — an infinite
      // timer chain that keeps the event loop alive forever.
      preloadHoldUntilMs = 0;
      emitEnded();
    }, remainingMs);
  }

  function emitEnded() {
    if (endedEmitted) {
      clearPreloadHoldTimer();
      emitEndedEmissionState('duplicate-ignored');
      return;
    }
    // Combine both "next track is ready" signals into one flag so all three
    // branches below share the same predicate.
    const nextTrackPending = pendingGaplessBytes !== null || gaplessPlayerNextLoaded;

    // Layer A hold window: if no next-track signal is present yet, wait up to 500ms
    // for it to arrive before falling through to streaming reinit.
    if (!nextTrackPending && !preloadHoldActive) {
      preloadHoldActive = true;
      preloadHoldUntilMs = nowMs() + PRELOAD_HOLD_MS;
      emitEndedEmissionState('hold-started');
      schedulePreloadHoldExpiry();
      return;
    }
    if (!nextTrackPending && preloadHoldActive) {
      if (nowMs() < preloadHoldUntilMs) {
        emitEndedEmissionState('hold-active');
        schedulePreloadHoldExpiry();
        return;
      }
      // Hold window expired — fall through to streaming reinit
      preloadHoldActive = false;
    }
    // nextTrackPending: the gapless player (or streaming→gapless bridge) will
    // handle the handoff on the next refill tick. Do not emit ended.
    if (nextTrackPending) {
      preloadHoldActive = false;
      clearPreloadHoldTimer();
      emitEndedEmissionState('suppressed-pending-gapless');
      return;
    }
    endedEmitted = true;
    clearPreloadHoldTimer();
    emitEndedEmissionState('emitted');
    emitMessage({ type: 'ended' });
  }

  function recoverFromStaleGaplessSuppression() {
    const activePlayer = currentPlayer();
    const hadSharedState = sharedState !== null;
    const hadActivePlayer = activePlayer !== null;
    const refillLoopActiveBefore = refillTimerId !== null;
    const endOfStreamBefore = sharedState
      ? Atomics.load(sharedState, END_OF_STREAM_INDEX)
      : null;
    const framesAvailableBefore = sharedState
      ? Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX)
      : null;
    const activePositionMs = playerPositionMs(activePlayer);
    const remainingMs = currentTrackEndPositionKnown
      ? currentTrackEndPositionMs - activePositionMs
      : null;
    const activePlayerEnded = playerHasEnded(activePlayer);
    const hasKnownRemainingAudio =
      currentTrackEndPositionKnown &&
      remainingMs !== null &&
      remainingMs > RECOVERY_REMAINING_THRESHOLD_MS;
    const canRecover =
      hadActivePlayer &&
      hasKnownRemainingAudio;

    // P1.8: Check if the loaded gapless next can be handed off directly BEFORE
    // clearing gaplessPlayerNextLoaded. The original code cleared it first (bug:
    // destroyed the loaded player reference before any handoff could be attempted).
    if (gaplessPlayerNextLoaded && !currentTrackEndPositionHandled && sharedState) {
      const framesAvailable = Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX);
      // Treat recovery position as EOS boundary: set end position to current position
      // so crossedTrackBoundary fires, then let runGaplessBoundaryHandoff do the rest.
      const savedEndMs = currentTrackEndPositionMs;
      currentTrackEndPositionMs = activePositionMs;
      const handoffResult = runGaplessBoundaryHandoff(activePlayer, framesAvailable, false);
      if (handoffResult !== null && handoffResult !== 'retry' && handoffResult !== 'unsafe') {
        // Handoff succeeded — restart refill loop for the new track.
        preloadHoldActive = false;
        preloadHoldUntilMs = 0;
        if (sharedState) Atomics.store(sharedState, END_OF_STREAM_INDEX, 0);
        startRefillWaitLoop();
        emitDiagnosticsEvent({
          type: 'gapless-fallback-recovery',
          reason: 'premature-eos-unlock',
          action: 'handoff-succeeded',
          hadSharedState,
          hadActivePlayer,
          refillLoopActiveBefore,
          endOfStreamBefore,
          framesAvailableBefore,
          endOfStreamAfter: 0,
          framesAvailableAfter: Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX),
          currentTrackEndPositionKnown,
          currentTrackEndPositionMs: activePositionMs,
          activePositionMs,
          remainingMs,
          activePlayerEnded,
          hasKnownRemainingAudio,
        });
        return;
      }
      // Handoff was not applicable — restore state and fall through to old recovery logic.
      currentTrackEndPositionMs = savedEndMs;
      currentTrackEndPositionHandled = false;
    }

    // Old recovery logic (unchanged) — only reached when gapless handoff was not available
    // or not applicable. Now safe to clear gaplessPlayerNextLoaded.
    gaplessPlayerNextLoaded = false;
    preloadHoldActive = false;
    preloadHoldUntilMs = 0;

    let action = 'flag-cleared-only';
    if (canRecover && sharedState) {
      Atomics.store(sharedState, END_OF_STREAM_INDEX, 0);
      if (refillTimerId === null) {
        startRefillWaitLoop();
        action = 'refill-restarted';
        pendingGaplessFallbackRecoveryConfirmation = true;
      } else {
        action = 'eos-cleared-refill-active';
        pendingGaplessFallbackRecoveryConfirmation = true;
      }
    }

    emitDiagnosticsEvent({
      type: 'gapless-fallback-recovery',
      reason: 'premature-eos-unlock',
      action,
      hadSharedState,
      hadActivePlayer,
      refillLoopActiveBefore,
      endOfStreamBefore,
      framesAvailableBefore,
      endOfStreamAfter: sharedState
        ? Atomics.load(sharedState, END_OF_STREAM_INDEX)
        : null,
      framesAvailableAfter: sharedState
        ? Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX)
        : null,
      currentTrackEndPositionKnown,
      currentTrackEndPositionMs,
      activePositionMs,
      remainingMs,
      activePlayerEnded,
      hasKnownRemainingAudio,
    });

    if (action === 'flag-cleared-only' && hadActivePlayer && !hasKnownRemainingAudio) {
      endedEmitted = true;
      emitMessage({ type: 'ended' });
    }
  }

  function scheduleGaplessFallback() {
    clearTimeoutFn(gaplessEndedFallbackTimer);
    gaplessEndedFallbackTimer = setTimeoutFn(() => {
      gaplessEndedFallbackTimer = null;
      if (!endedEmitted && gaplessPlayerNextLoaded && pendingGaplessBytes === null) {
        recoverFromStaleGaplessSuppression();
      }
    }, GAPLESS_ENDED_FALLBACK_MS);
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
        // P1.8: When a gapless next track is loaded, decoder-confirmed EOS is the
        // boundary — the file has no more bytes regardless of position arithmetic.
        // Trigger the handoff directly rather than stopping the loop and waiting
        // for recoverFromStaleGaplessSuppression to (mis-)handle it.
        if (!currentTrackEndPositionHandled &&
            (gaplessPlayerNextLoaded || pendingGaplessBytes !== null)) {
          const activePlayer = currentPlayer();
          const positionMs = playerPositionMs(activePlayer);
          emitDiagnosticsEvent({
            type: 'eos-boundary-handoff',
            label: 'EOS triggered direct gapless handoff (decoder confirmed end)',
            timestampMs: nowMs(),
            severity: 'info',
            positionMs: Math.floor(positionMs),
            expectedEndMs: Math.floor(currentTrackEndPositionMs),
            shortfallMs: Math.floor(currentTrackEndPositionMs - positionMs),
          });
          // Reuse runGaplessBoundaryHandoff: force positionMs past boundary by
          // temporarily setting currentTrackEndPositionMs to positionMs so the
          // crossedTrackBoundary check passes.
          const savedEndMs = currentTrackEndPositionMs;
          currentTrackEndPositionMs = positionMs; // EOS position IS the boundary
          const framesAvailable = Atomics.load(sharedState, FRAMES_AVAILABLE_INDEX);
          const handoffResult = runGaplessBoundaryHandoff(activePlayer, framesAvailable, false);
          if (handoffResult === null || handoffResult === 'retry' || handoffResult === 'unsafe') {
            // Handoff was not performed (e.g. unsafe fill level) — restore end position
            // and fall through to scheduleGaplessFallback for a second chance.
            currentTrackEndPositionMs = savedEndMs;
            currentTrackEndPositionHandled = false; // allow fallback recovery to retry
            stopRefillLoop();
            emitEnded();
            if (!endedEmitted && (gaplessPlayerNextLoaded || pendingGaplessBytes !== null)) {
              scheduleGaplessFallback();
            }
          } else {
            // Handoff succeeded — restart refill loop for the new track.
            stopRefillLoop();
            startRefillWaitLoop();
          }
          return;
        }
        stopRefillLoop();
        emitEnded();
        // Fix B (log77): schedule a fallback window whenever ended has not yet
        // been emitted, regardless of whether a gapless signal has arrived yet.
        // Previously the guard required gaplessPlayerNextLoaded===true, so a
        // truncated stream with no signal present never scheduled the fallback —
        // the 500 ms emitEnded hold fired late and health_recovery restarted the
        // track. The interior check inside scheduleGaplessFallback still guards
        // what actually happens when the timer fires.
        if (!endedEmitted) {
          scheduleGaplessFallback();
        }
      }
    }
  }

  function streamingGaplessHandoffLabel(reason) {
    if (reason === 'end-of-stream-error') {
      return 'Track handoff (streaming→gapless, end-of-stream path)';
    }
    if (reason === 'non-array-result') {
      return 'Track handoff (streaming→gapless, non-array path)';
    }
    if (reason === 'zero-length-result') {
      return 'Track handoff (streaming→gapless, zero-length path)';
    }
    return 'Track handoff (streaming→gapless)';
  }

  function transitionStreamingToGapless(reason, transitionPositionMs, hintDurationMs = 0) {
    const previousStreamingDurationMs =
      typeof streamingPlayer?.durationMs === 'function'
        ? streamingPlayer.durationMs()
        : 0;
    const bytes = pendingGaplessBytes;
    const sampleRate = pendingGaplessSampleRate;
    let newPlayer;

    try {
      newPlayer = createGaplessPlayer(bytes, sampleRate);
    } catch (bridgeError) {
      stopRefillLoop();
      diagnostics.transitionGapMs = null;
      emitMessage({
        type: 'playback-error',
        message: bridgeError instanceof Error ? bridgeError.message : String(bridgeError),
      });
      return false;
    }

    pendingGaplessBytes = null;
    pendingGaplessSampleRate = 0;
    pendingGaplessHintDurationMs = Number.isFinite(hintDurationMs) && hintDurationMs > 0 ? Math.floor(hintDurationMs) : 0;
    pendingHandoffHintDurationMs = 0;
    trackStartPositionMs = transitionPositionMs;

    const rawBridgeDurationMs = newPlayer.durationMs();
    const normalizedHintDurationMs =
      Number.isFinite(hintDurationMs) && hintDurationMs > 0
        ? Math.floor(hintDurationMs)
        : 0;
    const bridgeDurationIsStale =
      normalizedHintDurationMs > 0 &&
      rawBridgeDurationMs > 0 &&
      previousStreamingDurationMs > 0 &&
      Math.abs(rawBridgeDurationMs - previousStreamingDurationMs) <= TRACK_HANDOFF_TOLERANCE_MS &&
      Math.abs(normalizedHintDurationMs - previousStreamingDurationMs) > TRACK_HANDOFF_TOLERANCE_MS;
    const bridgeDurationMs = bridgeDurationIsStale
      ? normalizedHintDurationMs
      : rawBridgeDurationMs;

    if (bridgeDurationIsStale) {
      pendingHandoffDurationBaseMs = transitionPositionMs;
      pendingHandoffPreviousDurationMs = previousStreamingDurationMs;
      pendingHandoffProvisionalDurationMs = rawBridgeDurationMs;
      pendingHandoffHintDurationMs = normalizedHintDurationMs;
      emitDiagnosticsEvent({
        type: 'streaming-gapless-duration-hint-used',
        label: 'Streaming gapless duration hint used',
        timestampMs: nowMs(),
        severity: 'info',
        hintDurationMs: normalizedHintDurationMs,
        staleDurationMs: rawBridgeDurationMs,
        previousDurationMs: previousStreamingDurationMs,
        transitionPositionMs: Math.floor(transitionPositionMs),
        nextBoundaryMs: Math.floor(transitionPositionMs + normalizedHintDurationMs),
      });
    }

    if (bridgeDurationMs > 0) {
      setCurrentTrackEndPosition(transitionPositionMs + bridgeDurationMs, true);
      _pendingHandoffBasePositionMs = -1;
    } else {
      setCurrentTrackEndPosition(0, false);
      _pendingHandoffBasePositionMs = transitionPositionMs;
    }

    handoffUnderrunBaseline = diagnostics.underrunCount;
    handoffStartedAtMs = nowMs();
    diagnostics.transitionGapMs = 0;

    streamingPlayer.free();
    streamingPlayer = null;
    streamingFinalized = false;
    player = newPlayer;
    _streamingHintDurationMs = 0;

    const nextDurationMs = Math.floor(bridgeDurationMs);
    emitMessage({
      type: 'track-changed',
      transitionPositionMs: Math.floor(transitionPositionMs),
      durationMs: nextDurationMs,
      trackDelta: 1,
    });
    emitMessage({ type: 'duration', durationMs: nextDurationMs });
    emitDiagnosticsEvent({
      type: 'track-handoff',
      label: streamingGaplessHandoffLabel(reason),
      timestampMs: handoffStartedAtMs,
      severity: 'info',
      signedGapMs: 0,
      audibleLateGapMs: 0,
      targetSignedGapMs: 0,
      targetLeadMs: 0,
      transitionFloorPercent: diagnostics.lastTransitionFloorPercent,
      underrunDelta: 0,
    });
    return true;
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
        // Fix-A: even when the ring buffer is full, the gapless boundary check
        // must execute so that track-changed is emitted at the track boundary.
        // Previously this break was unconditional, so a full buffer at the exact
        // tick where positionMs pins at the end would suppress track-changed on
        // every subsequent tick until a decode slot opened.  We call
        // runGaplessBoundaryHandoff with isFullBufferTick=true, which emits the
        // 'boundary-checked-on-full-buffer' diagnostic when the handoff fires.
        if (!isStreaming && activePlayer === player) {
          const fullBufferResult = runGaplessBoundaryHandoff(activePlayer, framesAvailable, true);
          if (fullBufferResult === 'unsafe') return;
          // 'retry', 'fired', or null — all fall through to break below
        }
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
        if (pendingGaplessFallbackRecoveryConfirmation) {
          pendingGaplessFallbackRecoveryConfirmation = false;
          emitDiagnosticsEvent({
            type: 'gapless-fallback-recovery-confirmed',
            label: 'Gapless fallback recovery confirmed',
            timestampMs: nowMs(),
            severity: 'info',
            framesWritten: result.length / CHANNELS,
            positionMs: playerPositionMs(activePlayer),
          });
        }
        diagnostics.pendingSeekDistanceMs = 0;
        if (lastChunkReceivedAt > 0) {
          const lag = performanceNow() - lastChunkReceivedAt;
          diagnostics.fetchToDecodeLagMs = Number(lag.toFixed(2));
          if (isStalled) {
            diagnostics.resumeAfterStallLatencyMs = Number(lag.toFixed(2));
            isStalled = false;
            emitMessage({ type: 'buffering-ended' });
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
            const transitionPositionMs = streamingPlayer?.positionMs() ?? 0;
            transitionStreamingToGapless('end-of-stream-error', transitionPositionMs, pendingGaplessHintDurationMs);
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
            if (!isStalled) {
              emitMessage({ type: 'buffering-started' });
            }
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
              const transitionPositionMs = streamingPlayer.positionMs();
              transitionStreamingToGapless('null-result', transitionPositionMs, pendingGaplessHintDurationMs);
              return;
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
            const transitionPositionMs = streamingPlayer?.positionMs() ?? 0;
            transitionStreamingToGapless('non-array-result', transitionPositionMs, pendingGaplessHintDurationMs);
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
            const transitionPositionMs = streamingPlayer?.positionMs() ?? 0;
            transitionStreamingToGapless('zero-length-result', transitionPositionMs, pendingGaplessHintDurationMs);
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
        const loopResult = runGaplessBoundaryHandoff(activePlayer, framesAvailable, false);
        if (loopResult === 'retry' || loopResult === 'unsafe') {
          return;
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
        setTimeoutFn(() => refillRingBuffer(), 0);
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
      startRefillWaitLoop();
    } else if (refillDriver === 'waitasync' && sharedState) {
      nudgeWaitAsyncState(sharedState, REFILL_REQUEST_INDEX);
    }
    refillRingBuffer();
  }

  return {
    setDiagnosticsMode,
    playTrack(audioBytes, buffers) {
      stopRefillLoop();
      resetPlaybackState();
      pendingGaplessHintDurationMs = 0;
      loadedNextGaplessHintDurationMs = 0;
      pendingHandoffHintDurationMs = 0;
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
      startRefillWaitLoop();
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

      lastChunkReceivedAt = performanceNow();

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
          gaplessPlayerNextLoaded = true;
        } catch { /* ignore */ }
        if (gaplessPlayerNextLoaded) {
          loadedNextGaplessHintDurationMs = pendingGaplessHintDurationMs;
          pendingGaplessHintDurationMs = 0;
        } else {
          pendingGaplessHintDurationMs = 0;
          loadedNextGaplessHintDurationMs = 0;
        }
        pendingGaplessBytes = null;
      } else {
        pendingGaplessHintDurationMs = 0;
        loadedNextGaplessHintDurationMs = 0;
      }
      pendingHandoffHintDurationMs = 0;
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

    preloadNext(audioBytes, hintDurationMs = 0) {
      const isFinitePositive = Number.isFinite(hintDurationMs) && hintDurationMs > 0;
      pendingGaplessHintDurationMs = isFinitePositive ? Math.floor(hintDurationMs) : 0;

      if (!player) {
        if (streamingPlayer || windowedPlayer) {
          // Store bytes; the streaming→gapless bridge will consume them when streaming ends.
          pendingGaplessBytes = audioBytes;
          pendingGaplessSampleRate = activeSampleRate;
          emitMessage({ type: 'preload-pending' });
        } else {
          pendingGaplessHintDurationMs = 0;
          emitMessage({ type: 'preload-error', message: 'no_active_player' });
        }
        return;
      }
      let result;
      try {
        result = player.loadNext(audioBytes);
      } catch (error) {
        pendingGaplessHintDurationMs = 0;
        loadedNextGaplessHintDurationMs = 0;
        emitMessage({
          type: 'preload-error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (result && result.error === 'next_failed') {
        pendingGaplessHintDurationMs = 0;
        loadedNextGaplessHintDurationMs = 0;
        emitMessage({
          type: 'preload-error',
          message: result.message ?? 'preload failed',
        });
      } else {
        gaplessPlayerNextLoaded = true;
        loadedNextGaplessHintDurationMs = isFinitePositive ? Math.floor(hintDurationMs) : 0;
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
          // Zero FRAMES_AVAILABLE_INDEX first so the worklet thread sees zero
          // frames and outputs silence before any other index moves.
          // Residual race (accepted, pre-existing, sub-millisecond): a worklet
          // callback that already loaded a positive FRAMES_AVAILABLE before this
          // zero-store can still Atomics.sub the zeroed counter, briefly driving it
          // negative; the next refill tick then over-computes writableFrames until
          // Atomics.add corrects it. Benign, pre-existing, sub-millisecond.
          Atomics.store(sharedState, FRAMES_AVAILABLE_INDEX, 0);
          Atomics.store(sharedState, END_OF_STREAM_INDEX, 0);
          Atomics.store(sharedState, READ_INDEX, 0);
          Atomics.store(sharedState, WRITE_INDEX, 0);

          // Notify slot 7 so any still-running loop iteration wakes immediately
          // to see the new FRAMES_AVAILABLE=0. stopRefillLoop() above bumps
          // currentSessionId, so the old loop will exit; this notify is a
          // belt-and-suspenders wake in case the loop is mid-waitAsync.
          if (sharedState && sharedState.length > REFILL_REQUEST_INDEX) {
            Atomics.add(sharedState, REFILL_REQUEST_INDEX, 1);
            Atomics.notify(sharedState, REFILL_REQUEST_INDEX, 1);
          }
        }
        trackStartPositionMs = 0;
        pendingGaplessHintDurationMs = 0;
        pendingHandoffHintDurationMs = 0;
        const durationMs = activePlayer.durationMs();
        setCurrentTrackEndPosition(durationMs, durationMs > 0);
        clearPreloadHoldTimer();
        endedEmitted = false;
        emitDiagnosticsEvent({
          type: 'seek',
          label: 'Seek',
          timestampMs: nowMs(),
          severity: 'info',
        });
      }
      startRefillWaitLoop();
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

    setWorkletPort,
    getWorkletPort,
    getSabConstants() {
      return { REFILL_REQUEST_INDEX, TARGET_FRAMES_INDEX };
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
