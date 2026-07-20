import {
  buildSnapshot,
  createDiagnosticsState,
  pushEvent,
  pushHistoryPoint,
} from './audio_diagnostics_state.js';
import { createBridgeSessionState } from './audio_bridge_session.js';
import {
  clampVolume,
  sendPreloadCommand,
} from './audio_bridge_transport.js';
import {
  PRESETS as EQ_PRESETS,
  createEqChain,
  wireEqChain,
  connectProcessorToChain,
  applyBand,
  applyBands,
  clampGain,
} from './audio_bridge_eq.js';

// protocol:begin
const PROTOCOL_VERSION = 2;
const PROTOCOL_SLOTS = 12;
const READ_INDEX = 0;
const WRITE_INDEX = 1;
const FRAMES_AVAILABLE_INDEX = 2;
const END_OF_STREAM_INDEX = 3;
const STOP_INDEX = 4;
const TOTAL_FRAMES_RENDERED_INDEX = 5;
const HEARTBEAT_COUNT_INDEX = 6;
const REFILL_REQUEST_INDEX = 7;
const TARGET_FRAMES_INDEX = 8;
const UNDERRUN_EPISODES_INDEX = 9;
const SILENT_FRAMES_INDEX = 10;
const EPOCH_INDEX = 11;
// protocol:end

export function createJamAudioBridge({
  wasmModuleLoader,
  processorModuleUrl,
  playbackWorkerModuleUrl,
  namespace = 'jamAudioBridge',
  channels = 2,
  silentWavUrl = 'audio/silent.wav',
}) {
  const CHANNELS = channels;
  const DECLICK_DURATION_S = (window._jamdiscDeclickDurationMs ?? 15) / 1000;
  const SNAPSHOT_INTERVAL_MS = 250;
  const enableBoundedUrlAnchorExperiment = window._jamdiscEnableBoundedUrlAnchorExperiment === true;

  let wasmReadyPromise;
  let audioContext;
  let workletReadyPromise;
  let gainNode;
  let eqFilterNodes = null;
  let pendingEqGains = [0, 0, 0, 0, 0];
  let processorNode;
  let currentVolume = 1.0;
  let sharedPcmBuffer;
  let sharedStateBuffer;
  let frameCapacity = 8192;
  let playbackWorker;
  let workletPortWired = false;
  let playbackWorkerRequestId = 0;
  const pendingWorkerRequests = new Map();
  let diagnosticsSnapshotTimerId;
  let diagnosticsSnapshotEnabled = false;
  let diagnosticsMode = 'minimal';
  let heartbeatIntervalId;
  let heartbeatLastKnownPositionSec = 0;
  let heartbeatLastKnownDurationSec = 0;
  let heartbeatPositionCapturedAtMs = 0;

  /** @type {((error: any) => void) | null} */
  let onPlaybackErrorCallback = null;
  /** @type {((error: any) => void) | null} */
  let onPreloadErrorCallback = null;
  /** @type {(() => void) | null} */
  let onPreloadPendingCallback = null;
  /** @type {(() => void) | null} */
  let onPlaybackStartedCallback = null;
  // True when the worker has buffered enough to play but the AudioContext is
  // still suspended (Android non-installed PWA deeplink). The Dart "started"
  // callback is deferred until gesture-resume so the UI shows the play button
  // (paused) rather than the pause button (playing) while no audio comes out.
  let pendingPlaybackStartedOnResume = false;
  let needsPlaybackStartedDeclick = false;
  /** @type {(() => void) | null} */
  let onPlaybackSuspendedCallback = null;
  /** @type {((source: string) => void) | null} */
  let onAudioInterruptedCallback = null;
  let audioInterruptionLatched = false;
  let audioInterruptionStuckTimerId = null;
  let appOwnedPauseInFlight = false;
  let appOwnedStopInFlight = false;
  let appOwnedResetInFlight = false;
  let appOwnedReloadInFlight = false;
  /** @type {(() => void) | null} */
  let onEndedCallback = null;
  let onHandoffFallbackCallback = null;
  /** @type {((position: number) => void) | null} */
  let onPositionCallback = null;
  /** @type {((duration: number) => void) | null} */
  let onDurationCallback = null;
  /** @type {(() => void) | null} */
  let onNextCallback = null;
  /** @type {(() => void) | null} */
  let onPreviousCallback = null;
  /** @type {(() => void) | null} */
  let onPlayCallback = null;
  /** @type {(() => void) | null} */
  let onPauseCallback = null;
  /** @type {((track: any) => void) | null} */
  let onTrackChangedCallback = null;
  /** @type {((snapshot: string) => void) | null} */
  let onDiagnosticsSnapshotCallback = null;
  /** @type {((event: string) => void) | null} */
  let onDiagnosticsEventCallback = null;
  /** @type {((position: number) => void) | null} */
  let onSeekCallback = null;
  /** @type {(() => void) | null} */
  let onStopCallback = null;
  let onBufferingCallback = null;

  let diagnosticsState = createDiagnosticsState();
  Object.defineProperties(diagnosticsState, {
    underrunCount: {
      get: () => sharedStateBuffer ? Atomics.load(new Int32Array(sharedStateBuffer), UNDERRUN_EPISODES_INDEX) : 0,
      set: () => {}
    },
    silentFrameCount: {
      get: () => sharedStateBuffer ? Atomics.load(new Int32Array(sharedStateBuffer), SILENT_FRAMES_INDEX) : 0,
      set: () => {}
    }
  });
  let lastKnownBufferedDurationMs = 0;
  let silentAudioEl = null;
  let currentTrackBlobUrl = null;
  let boundedAnchorEndedHandler = null;
  let silentPlayHandler = null;
  let isAppOwnedResumeInFlight = false;
  let mediaSessionResumeRequested = false;
  let _nextTrackMeta = null;
  let lastPositionEventTs = 0;

  let transportMuted = false;
  let transportMuteReason = null;
  let resumeUnmuteSent = false;

  // NOTIFICATION_KEEP_WHILE_PAUSED: set via localStorage to switch notification behavior while paused.
  // false (Option A, default): silentAudioEl pauses on logical pause → notification disappears, no wrong icon.
  // true (Option B): silentAudioEl stays playing → notification survives but shows wrong ⏸ icon.
  // Toggle from console: localStorage.setItem('jamdisc_notif_keep_paused', 'true') then reload.
  let NOTIFICATION_KEEP_WHILE_PAUSED =
    (typeof localStorage !== 'undefined') && localStorage.getItem('jamdisc_notif_keep_paused') === 'true';

  let queueTrackIds = [];
  let activeTrackIndex = 0;
  let activeTrackId = null;
  let activeTrackTitle = '';

  let playbackSessionGeneration = 0;
  let playbackSessionChain = Promise.resolve();

  function enqueuePlaybackSession(sessionGeneration, action) {
    const run = playbackSessionChain
      .catch(() => {})
      .then(async () => {
        if (sessionGeneration !== playbackSessionGeneration) return;
        await action(sessionGeneration);
      });
    playbackSessionChain = run.catch(() => {});
    return run;
  }

  function enqueueLatestPlaybackSession(action) {
    const sessionGeneration = ++playbackSessionGeneration;
    return enqueuePlaybackSession(sessionGeneration, action);
  }

  function isCurrentPlaybackSession(sessionGeneration) {
    return sessionGeneration === playbackSessionGeneration;
  }

  const sessionState = createBridgeSessionState({
    storage: typeof window !== 'undefined' ? window.localStorage : null,
    resetProcessorPosition: () => {
      diagnosticsState.positionMs = 0;
      diagnosticsState.decodedPositionMs = 0;
      processorNode?.port.postMessage({ type: 'reset_position' });
    },
  });

  const saveSessionMetadataToLocalStorage = () => {
    sessionState.setSessionQueue(queueTrackIds, activeTrackIndex);
    sessionState.setPositionMs(diagnosticsState.positionMs || 0);
    sessionState.setDecodedPositionMs(diagnosticsState.decodedPositionMs || 0);
    sessionState.setActiveTrackTitle(activeTrackTitle);
    sessionState.saveSessionMetadataToLocalStorage();
  };

  const clearSessionMetadataFromLocalStorage = () => {
    sessionState.clearSessionMetadataFromLocalStorage();
  };

  const setSessionQueue = (trackIds, currentIndex) => {
    sessionState.setSessionQueue(trackIds, currentIndex);
    const snap = sessionState.getPlaybackSessionSnapshot();
    activeTrackIndex = snap.activeTrackIndex;
    activeTrackId = snap.activeTrackId;
    queueTrackIds = trackIds || [];
  };

  const getPlaybackSessionSnapshot = () => {
    sessionState.setSessionQueue(queueTrackIds, activeTrackIndex);
    sessionState.setPositionMs(diagnosticsState.positionMs || 0);
    sessionState.setDecodedPositionMs(diagnosticsState.decodedPositionMs || 0);
    sessionState.setActiveTrackTitle(activeTrackTitle);
    return sessionState.getPlaybackSessionSnapshot();
  };


  const isAndroidTransport = /Android/i.test(navigator.userAgent ?? '');

  async function rampGainToValue(targetValue, durationSeconds) {
    if (!audioContext || !gainNode) return;
    if (Math.abs(gainNode.gain.value - targetValue) < 1e-4) return;
    const now = audioContext.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(targetValue, now + durationSeconds);
    // Do NOT await a wall-clock timer here. linearRampToValueAtTime is scheduled
    // on the audio thread and is unthrottled. Awaiting setTimeout(15ms) throttles
    // to 1s+ in hidden tabs, stalling pause/stop from MediaSession actions.
  }

  function forceGainToZero(reason) {
    if (!audioContext || !gainNode || audioContext.state === 'closed') return;
    const now = audioContext.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(0, now);
    emitDiagnosticsEvent({
      type: 'gain-forced-zero',
      label: `Gain forced to zero (${reason})`,
      timestampMs: nowMs(),
      severity: 'info',
      details: {
        reason,
        audioContextState: audioContext.state,
        gainNodeValue: gainNode.gain.value,
      },
    });
  }


  function scheduleDeclickRampToCurrentVolume(reason) {
    if (!audioContext || !gainNode) return;
    const now = audioContext.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(currentVolume, now + DECLICK_DURATION_S);
    emitDiagnosticsEvent({
      type: 'startup-declick-ramp',
      label: `Startup declick ramp scheduled (${reason})`,
      timestampMs: nowMs(),
      severity: 'info',
      gainNodeValue: gainNode?.gain?.value ?? null,
      targetVolume: currentVolume,
      audioContextState: audioContext?.state ?? 'none',
    });
  }

  async function waitForWorkerTransportQuiet() {
    if (playbackWorker) {
      await sendPlaybackWorkerCommand('transportMute').catch(() => {});
    }
    transportMuted = true;
    transportMuteReason = 'pause';
    emitDiagnosticsEvent({
      type: 'transport-worker-muted',
      label: 'Transport worker muted',
      timestampMs: nowMs(),
      severity: 'info',
    });
  }

  async function runMutedAndroidTransportTransition({
    transitionKind,
    preserveMediaSession = true,
    performAction,
    fadeIn = false,
    skipInitialRamp = false,
  }) {
    emitDiagnosticsEvent({
      type: 'transport-transition-start',
      label: `Transport transition start: ${transitionKind}`,
      timestampMs: nowMs(),
      severity: 'info',
    });

    if (!skipInitialRamp) {
      await Promise.all([
        rampGainToValue(0, DECLICK_DURATION_S),
        waitForWorkerTransportQuiet(),
      ]);
      emitDiagnosticsEvent({
        type: 'transport-gain-zero',
        label: `Transport gain reached zero: ${transitionKind}`,
        timestampMs: nowMs(),
        severity: 'info',
      });
    } else {
      await waitForWorkerTransportQuiet();
    }
    try {
      await performAction({ preserveMediaSession });
    } catch (e) {
      console.warn(`[Android transition] performAction failed (${transitionKind}):`, e);
    }

    if (fadeIn) {
      if (playbackWorker) {
        await sendPlaybackWorkerCommand('transportUnmute').catch(() => {});
      }
      transportMuted = false;
      transportMuteReason = null;
      resumeUnmuteSent = true;
      await rampGainToValue(currentVolume, DECLICK_DURATION_S);
    }
  }

  function restoreSilentAnchor() {
    if (!silentAudioEl) return;
    clearBoundedAnchorEndedHandler();
    silentAudioEl.loop = true;
    silentAudioEl.src = silentWavUrl;
    silentAudioEl.load();
    silentAudioEl.play().catch(() => {});
  }

  function clearBoundedAnchorEndedHandler() {
    if (silentAudioEl && boundedAnchorEndedHandler) {
      silentAudioEl.removeEventListener('ended', boundedAnchorEndedHandler);
      boundedAnchorEndedHandler = null;
    }
  }

  function ensureSilentAudio() {
    if (silentAudioEl) return;
    silentAudioEl = new Audio(silentWavUrl);
    silentAudioEl.id = `${namespace}-silent-audio`;
    silentAudioEl.loop = true;
    silentAudioEl.volume = 0.001;
    silentAudioEl.style.display = 'none';

    document.body.appendChild(silentAudioEl);

    silentPlayHandler = () => {
      if (mediaSessionResumeRequested) {
        mediaSessionResumeRequested = false;
        if (audioContext && audioContext.state === 'suspended') {
          audioContext.resume().catch(() => {});
        }
        emitDiagnosticsEvent({
          type: 'media-session-play-triggered',
          label: 'audioContext.resume() via Media Session anchor play event',
          timestampMs: nowMs(),
          severity: 'info',
          audioContextState: audioContext?.state ?? 'none',
        });
        return;
      }
      if (isAppOwnedResumeInFlight) {
        return;
      }
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }
    };
    silentAudioEl.addEventListener('play', silentPlayHandler);
    silentAudioEl.addEventListener('pause', () => {
      if (!isLogicalPlaybackActive()) return;
      if (isAppOwnedAudioTransitionInFlight()) {
        emitDiagnosticsEvent({
          type: 'audio-interruption-suppressed',
          label: 'Hidden anchor pause suppressed',
          timestampMs: nowMs(),
          severity: 'info',
          source: 'hidden_anchor_pause',
          reason: 'app_owned_transition',
        });
        return;
      }
      emitDiagnosticsEvent({
        type: 'hidden-anchor-interruption-detected',
        label: 'Hidden anchor pause interruption detected',
        timestampMs: nowMs(),
        severity: 'warn',
        audioContextState: audioContext?.state ?? 'none',
      });
      notifyAudioInterrupted('hidden_anchor_pause');
    });
  }

  function setTrackAudioOnSilentElement(bytes) {
    ensureSilentAudio();
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    const newBlobUrl = URL.createObjectURL(blob);
    if (currentTrackBlobUrl) {
      URL.revokeObjectURL(currentTrackBlobUrl);
    }
    currentTrackBlobUrl = newBlobUrl;

    emitDiagnosticsEvent({
      type: 'hidden-media-asset-ready',
      label: 'Hidden media asset ready (bytes)',
      timestampMs: nowMs(),
      severity: 'info',
      details: {
        source: 'bytes',
        blobUrl: currentTrackBlobUrl,
      },
    });
  }

  function setStreamingAnchor(bytes) {
    if (!bytes || bytes.length === 0) return;
    ensureSilentAudio();
    // Only set if we don't have a track-specific blob URL yet,
    // or if we want to "upgrade" from silent.wav.
    // In streaming, we start with silent.wav and upgrade to first chunk.
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    const newBlobUrl = URL.createObjectURL(blob);
    if (currentTrackBlobUrl) {
      URL.revokeObjectURL(currentTrackBlobUrl);
    }
    currentTrackBlobUrl = newBlobUrl;

    emitDiagnosticsEvent({
      type: 'hidden-media-asset-ready',
      label: 'Hidden media anchor upgraded (streaming chunk)',
      timestampMs: nowMs(),
      severity: 'info',
      details: {
        source: 'streaming-chunk',
        blobUrl: currentTrackBlobUrl,
      },
    });
  }

  function setBoundedTrackAudioOnSilentElement(url) {
    ensureSilentAudio();
    clearBoundedAnchorEndedHandler();

    // Revoke any prior blob URL after ensuring the function has a clean slate.
    // currentTrackBlobUrl is managed separately from the bounded URL itself.
    if (currentTrackBlobUrl) {
      URL.revokeObjectURL(currentTrackBlobUrl);
      currentTrackBlobUrl = null;
    }

    // If the element is in an unrecoverable state (non-null .error), recreate it
    // so .play() has a clean slate. This guards against recovery storms where
    // a prior blob failure left the element with MEDIA_ERR_SRC_NOT_SUPPORTED.
    if (silentAudioEl && silentAudioEl.error) {
      emitDiagnosticsEvent({
        type: 'hidden-media-anchor-recreated',
        label: 'Silent anchor element recreated due to unrecoverable media error',
        timestampMs: nowMs(),
        severity: 'warn',
        details: {
          errorCode: silentAudioEl.error?.code ?? null,
        },
      });
      if (silentPlayHandler) {
        silentAudioEl.removeEventListener('play', silentPlayHandler);
        silentPlayHandler = null;
      }
      try { silentAudioEl.pause(); } catch {}
      try { document.body.removeChild(silentAudioEl); } catch {}
      silentAudioEl = null;
      ensureSilentAudio();
    }

    if (enableBoundedUrlAnchorExperiment) {
      silentAudioEl.loop = false;
      silentAudioEl.src = url;
      silentAudioEl.load();

      boundedAnchorEndedHandler = () => {
        restoreSilentAnchor();
        emitDiagnosticsEvent({
          type: 'bounded-anchor-ended',
          label: 'Bounded anchor ended, restored silent anchor',
          timestampMs: nowMs(),
          severity: 'info',
        });
      };
      silentAudioEl.addEventListener('ended', boundedAnchorEndedHandler, { once: true });

      silentAudioEl.play().catch((err) => {
        restoreSilentAnchor();
        emitDiagnosticsEvent({
          type: 'hidden-media-bounded-play-failed',
          label: 'Bounded anchor play failed, restored silent anchor',
          timestampMs: nowMs(),
          severity: 'warn',
          error: err?.message,
        });
      });
    }

    emitDiagnosticsEvent({
      type: 'hidden-media-asset-ready',
      label: 'Hidden media asset ready (bounded url)',
      timestampMs: nowMs(),
      severity: 'info',
      details: {
        source: 'bounded-url',
        url: url,
        experimentEnabled: enableBoundedUrlAnchorExperiment,
      },
    });
  }



  function nowMs() {
    return Math.round(performance.now());
  }

  function roundMs(value) {
    return Number(value.toFixed(2));
  }

  function ensureCrossOriginIsolation() {
    if (!window.crossOriginIsolated) {
      throw new Error(
        'Playback requires cross-origin isolation. Serve the app with COOP=same-origin and COEP=credentialless headers.',
      );
    }
  }

  function emitDiagnosticsEvent(event) {
    const emitEvent = { ...event, timestampMs: Date.now() };
    pushEvent(diagnosticsState, emitEvent);
    if (typeof onDiagnosticsEventCallback === 'function') {
      onDiagnosticsEventCallback(JSON.stringify(emitEvent));
    }
  }

  function emitDiagnosticsSnapshot() {
    if (typeof onDiagnosticsSnapshotCallback !== 'function') {
      return;
    }
    if (diagnosticsMode === 'extended') {
      diagnosticsState.bridgePositionEventAgeMs = lastPositionEventTs > 0 ? nowMs() - lastPositionEventTs : null;
      diagnosticsState.hiddenMediaPlaying = silentAudioEl ? !silentAudioEl.paused : false;
      diagnosticsState.audioContextState = audioContext ? audioContext.state : 'none';
    } else {
      diagnosticsState.bridgePositionEventAgeMs = null;
      diagnosticsState.hiddenMediaPlaying = null;
      diagnosticsState.audioContextState = null;
    }
    onDiagnosticsSnapshotCallback(
      JSON.stringify(buildSnapshot(diagnosticsState, nowMs())),
    );
  }

  function runMediaAction(label, action) {
    try {
      const result = action();
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          emitDiagnosticsEvent({
            type: 'media-session-action-error',
            label: `Media action failed: ${label}`,
            timestampMs: nowMs(),
            severity: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      emitDiagnosticsEvent({
        type: 'media-session-action-error',
        label: `Media action failed: ${label}`,
        timestampMs: nowMs(),
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function startDiagnosticsLoop() {
    if (!diagnosticsSnapshotEnabled) {
      stopDiagnosticsLoop();
      return;
    }
    stopDiagnosticsLoop();
    emitDiagnosticsSnapshot();
    diagnosticsSnapshotTimerId = window.setInterval(() => {
      emitDiagnosticsSnapshot();
    }, SNAPSHOT_INTERVAL_MS);
  }

  function stopDiagnosticsLoop() {
    if (diagnosticsSnapshotTimerId) {
      window.clearInterval(diagnosticsSnapshotTimerId);
      diagnosticsSnapshotTimerId = undefined;
    }
  }

  function setDiagnosticsSnapshotEnabled(enabled) {
    diagnosticsSnapshotEnabled = !!enabled;
    if (diagnosticsSnapshotEnabled) {
      startDiagnosticsLoop();
    } else {
      stopDiagnosticsLoop();
    }
  }

  function setDiagnosticsMode(mode) {
    diagnosticsMode = mode || 'minimal';
    void sendPlaybackWorkerCommand('setDiagnosticsMode', { mode: diagnosticsMode }).catch(() => {});
  }

  /**
   * PWA Media Session Heartbeat
   * 
   * Android Chrome often drops Media Session notifications if it deems the app inactive.
   * This heartbeat periodically re-asserts the playback state and position to the OS
   * to maintain the session's "active" status.
   * 
   * NOTE: If Android still drops the notification despite healthy heartbeat diagnostics,
   * the remainder is likely platform-specific surfacing behavior (e.g. battery optimization)
   * and further runtime logic changes in the bridge may not be effective.
   */
  function startHeartbeat() {
    if (heartbeatIntervalId) return;
    heartbeatIntervalId = window.setInterval(() => {
      if ('mediaSession' in navigator && heartbeatLastKnownDurationSec > 0) {
        try {
          const elapsedSec = (performance.now() - heartbeatPositionCapturedAtMs) / 1000;
          const position = Math.min(
            heartbeatLastKnownPositionSec + elapsedSec,
            heartbeatLastKnownDurationSec,
          );
          navigator.mediaSession.setPositionState({
            duration: heartbeatLastKnownDurationSec,
            playbackRate: 1.0,
            position,
          });
        } catch {}
      }
      emitDiagnosticsEvent({
        type: 'media-session-heartbeat',
        label: 'Media session heartbeat',
        timestampMs: nowMs(),
        severity: 'info',
      });
    }, 5000);
  }

  function stopHeartbeat() {
    if (heartbeatIntervalId) {
      window.clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = undefined;
    }
  }

  function setStartupPhase(phase) {
    diagnosticsState.startupPhase = phase;
  }

  function recordStartupTiming(key, durationMs) {
    diagnosticsState.startupTimingsMs[key] = durationMs;
  }

  function markPlaybackState(state, options = {}) {
    const { preserveMediaSession = false } = options;
    diagnosticsState.playbackState = state;
    updatePlaybackState(state, { preserveMediaSession });
  }

  function setWorkerState(state) {
    diagnosticsState.workerState = state;
  }

  async function ensureWasm() {
    if (!wasmReadyPromise) {
      setStartupPhase('initializing wasm');
      const startedAt = performance.now();
      emitDiagnosticsEvent({
        type: 'wasm-init-started',
        label: 'Wasm init started',
        timestampMs: nowMs(),
        severity: 'info',
      });
      wasmReadyPromise = wasmModuleLoader().then((value) => {
        window.wasm_bindgen = value;
        const durationMs = roundMs(performance.now() - startedAt);
        recordStartupTiming('wasmInit', durationMs);
        emitDiagnosticsEvent({
          type: 'wasm-ready',
          label: 'Wasm ready',
          timestampMs: nowMs(),
          severity: 'info',
          durationMs,
        });
        return value;
      });
    }
    return wasmReadyPromise;
  }

  function isLogicalPlaybackActive() {
    return diagnosticsState.playbackState === 'playing' ||
      navigator?.mediaSession?.playbackState === 'playing';
  }

  function isAppOwnedAudioTransitionInFlight() {
    return appOwnedPauseInFlight ||
      appOwnedStopInFlight ||
      appOwnedResetInFlight ||
      appOwnedReloadInFlight ||
      isAppOwnedResumeInFlight;
  }

  function clearAudioInterruptionLatch(reason) {
    const wasLatched = audioInterruptionLatched;
    audioInterruptionLatched = false;
    if (audioInterruptionStuckTimerId != null) {
      clearTimeout(audioInterruptionStuckTimerId);
      audioInterruptionStuckTimerId = null;
    }
    if (wasLatched) {
      emitDiagnosticsEvent({
        type: 'audio-interruption-latch-cleared',
        label: 'Audio interruption latch cleared',
        timestampMs: nowMs(),
        severity: 'info',
        reason,
        audioContextState: audioContext?.state ?? 'none',
      });
    }
  }

  function armAudioInterruptionStuckTimer(source) {
    if (audioInterruptionStuckTimerId != null) clearTimeout(audioInterruptionStuckTimerId);
    audioInterruptionStuckTimerId = setTimeout(() => {
      audioInterruptionStuckTimerId = null;
      if (!audioInterruptionLatched || audioContext?.state !== 'interrupted') return;
      emitDiagnosticsEvent({
        type: 'audio-interruption-stuck',
        label: 'Audio interruption remained stuck',
        timestampMs: nowMs(),
        severity: 'warn',
        source,
        audioContextState: audioContext?.state ?? 'none',
      });
    }, 10000);
  }

  function notifyAudioInterrupted(source, details = {}) {
    if (!isLogicalPlaybackActive()) {
      emitDiagnosticsEvent({
        type: 'audio-interruption-suppressed',
        label: 'Audio interruption suppressed',
        timestampMs: nowMs(),
        severity: 'info',
        source,
        reason: 'inactive_playback',
        ...details,
      });
      return;
    }
    if (isAppOwnedAudioTransitionInFlight()) {
      emitDiagnosticsEvent({
        type: 'audio-interruption-suppressed',
        label: 'Audio interruption suppressed',
        timestampMs: nowMs(),
        severity: 'info',
        source,
        reason: 'app_owned_transition',
        ...details,
      });
      return;
    }
    if (audioInterruptionLatched) {
      emitDiagnosticsEvent({
        type: 'audio-interruption-suppressed',
        label: 'Audio interruption suppressed',
        timestampMs: nowMs(),
        severity: 'info',
        source,
        reason: 'already_latched',
        ...details,
      });
      return;
    }

    audioInterruptionLatched = true;
    emitDiagnosticsEvent({
      type: 'audio-interruption-detected',
      label: 'Audio interruption detected',
      timestampMs: nowMs(),
      severity: 'warn',
      source,
      audioContextState: audioContext?.state ?? 'none',
      hiddenMediaPlaying: silentAudioEl ? !silentAudioEl.paused : false,
      ...details,
    });
    if (source === 'audio_context_interrupted') {
      armAudioInterruptionStuckTimer(source);
    }
    if (typeof onAudioInterruptedCallback === 'function') {
      onAudioInterruptedCallback(source);
    }
  }

  async function ensureAudioGraph() {
    if (!audioContext) {
      setStartupPhase('initializing audio graph');
      audioContext = new AudioContext();
      if (typeof audioContext.addEventListener === 'function') {
        audioContext.addEventListener('statechange', () => {
          const state = audioContext.state;
          emitDiagnosticsEvent({
            type: 'audiocontext-state-changed',
            label: `AudioContext state: ${state}`,
            timestampMs: nowMs(),
            severity: 'info',
            state,
            currentTime: audioContext.currentTime,
            gainNodeValue: gainNode?.gain?.value ?? null,
          });

          if (state === 'running') {
            clearAudioInterruptionLatch('audio_context_running');
            return;
          }
          if (state === 'interrupted') {
            notifyAudioInterrupted('audio_context_interrupted', { state });
            return;
          }
          if (state === 'suspended') {
            if (pendingPlaybackStartedOnResume) {
              if (typeof onPlaybackSuspendedCallback === 'function') {
                onPlaybackSuspendedCallback();
              }
              return;
            }
            notifyAudioInterrupted('audio_context_suspended', { state });
          }
        });
      }
      emitDiagnosticsEvent({
        type: 'audio-context-created',
        label: 'Audio context created',
        timestampMs: nowMs(),
        severity: 'info',
        sampleRate: audioContext.sampleRate,
      });
    }


    if (!workletReadyPromise) {
      const startedAt = performance.now();
      emitDiagnosticsEvent({
        type: 'worklet-load-started',
        label: 'Worklet load started',
        timestampMs: nowMs(),
        severity: 'info',
      });
      workletReadyPromise = audioContext.audioWorklet
        .addModule(processorModuleUrl)
        .then((value) => {
          const durationMs = roundMs(performance.now() - startedAt);
          recordStartupTiming('workletLoad', durationMs);
          emitDiagnosticsEvent({
            type: 'worklet-ready',
            label: 'Worklet ready',
            timestampMs: nowMs(),
            severity: 'info',
            durationMs,
          });
          return value;
        });
    }
    await workletReadyPromise;

    if (!gainNode) {
      gainNode = audioContext.createGain();
      gainNode.gain.value = 0; // Initialize to silent to avoid startup pops/clicks during eager context creation
      gainNode.connect(audioContext.destination);
      eqFilterNodes = createEqChain(audioContext);
      wireEqChain(eqFilterNodes, gainNode);
      applyBands(eqFilterNodes, pendingEqGains);
      emitDiagnosticsEvent({
        type: 'gain-node-connected',
        label: 'gainNode connected to AudioContext destination',
        timestampMs: nowMs(),
        severity: 'info',
        gainNodeValue: gainNode.gain.value,
        audioContextState: audioContext.state,
      });
    }

    if (!processorNode) {
      processorNode = new AudioWorkletNode(audioContext, 'jam-audio-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [CHANNELS],
      });
      connectProcessorToChain(processorNode, eqFilterNodes, gainNode);
      processorNode.port.onmessage = (event) => {
        if (event.data.type === 'position') {
          lastPositionEventTs = nowMs();
          const positionMs = (event.data.framesRendered / audioContext.sampleRate) * 1000;
          diagnosticsState.positionMs = Math.round(positionMs);
          if (typeof onPositionCallback === 'function') {
            onPositionCallback(diagnosticsState.positionMs);
          }
        }
      };
    }
  }

  function applyDiagnosticsSync(payload) {
    if (!payload) return;
    if (payload.workerState !== undefined) diagnosticsState.workerState = payload.workerState;
    if (payload.decoderOwner !== undefined) diagnosticsState.decoderOwner = payload.decoderOwner;
    if (payload.framesAvailable !== undefined) diagnosticsState.framesAvailable = payload.framesAvailable;
    if (payload.frameCapacity !== undefined) diagnosticsState.frameCapacity = payload.frameCapacity;
    if (payload.bufferFillPercent !== undefined) diagnosticsState.bufferFillPercent = payload.bufferFillPercent;
    if (payload.lastDecodeMs !== undefined) diagnosticsState.lastDecodeMs = payload.lastDecodeMs;
    if (payload.lastRefillGapMs !== undefined) diagnosticsState.lastRefillGapMs = payload.lastRefillGapMs;
    if (payload.maxRefillGapMs !== undefined) diagnosticsState.maxRefillGapMs = payload.maxRefillGapMs;
    if (payload.refillCount !== undefined) diagnosticsState.refillCount = payload.refillCount;
    if (payload.lastRefillDurationMs !== undefined) diagnosticsState.lastRefillDurationMs = payload.lastRefillDurationMs;
    if (payload.maxDecodeMs !== undefined) diagnosticsState.maxDecodeMs = payload.maxDecodeMs;
    if (payload.movingAverageDecodeMs !== undefined) diagnosticsState.movingAverageDecodeMs = payload.movingAverageDecodeMs;
    if (payload.transitionGapMs !== undefined) diagnosticsState.transitionGapMs = payload.transitionGapMs;
    if (payload.lastTransitionFloorPercent !== undefined) {
      diagnosticsState.lastTransitionFloorPercent = payload.lastTransitionFloorPercent;
    }
    if (payload.lowWaterMarkCount !== undefined) diagnosticsState.lowWaterMarkCount = payload.lowWaterMarkCount;
    if (payload.recoveryModeActive !== undefined) diagnosticsState.recoveryModeActive = payload.recoveryModeActive;
    if (payload.activeBoundedWindowSize !== undefined) diagnosticsState.activeBoundedWindowSize = payload.activeBoundedWindowSize;
    if (payload.retainedBytes !== undefined) diagnosticsState.retainedBytes = payload.retainedBytes;
    if (payload.pendingSeekDistanceMs !== undefined) diagnosticsState.pendingSeekDistanceMs = payload.pendingSeekDistanceMs;
    if (payload.fetchToDecodeLagMs !== undefined) diagnosticsState.fetchToDecodeLagMs = payload.fetchToDecodeLagMs;
    if (payload.resumeAfterStallLatencyMs !== undefined) diagnosticsState.resumeAfterStallLatencyMs = payload.resumeAfterStallLatencyMs;
    if (payload.startupTimingsMs) {
      diagnosticsState.startupTimingsMs = {
        ...diagnosticsState.startupTimingsMs,
        ...payload.startupTimingsMs,
      };
    }
    if (payload.historyPoint) {
      pushHistoryPoint(diagnosticsState, payload.historyPoint);
    }
    if (diagnosticsMode === 'extended') {
      diagnosticsState.readIndex = payload.readIndex !== undefined ? payload.readIndex : null;
      diagnosticsState.writeIndex = payload.writeIndex !== undefined ? payload.writeIndex : null;
      diagnosticsState.framesRendered = payload.framesRendered !== undefined ? payload.framesRendered : null;
      diagnosticsState.workletHeartbeatCount = payload.workletHeartbeatCount !== undefined ? payload.workletHeartbeatCount : null;
    } else {
      diagnosticsState.readIndex = null;
      diagnosticsState.writeIndex = null;
      diagnosticsState.framesRendered = null;
      diagnosticsState.workletHeartbeatCount = null;
    }
  }

  function createSharedBuffers() {
    const wasm = window.wasm_bindgen;
    frameCapacity = (wasm && wasm.defaultRingBufferFrames) ? wasm.defaultRingBufferFrames() : 524288;
    sharedPcmBuffer = new SharedArrayBuffer(
      frameCapacity * CHANNELS * Float32Array.BYTES_PER_ELEMENT,
    );
    sharedStateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * PROTOCOL_SLOTS);
    diagnosticsState.framesAvailable = 0;
    diagnosticsState.frameCapacity = frameCapacity;
    diagnosticsState.bufferFillPercent = 0;
  }

  function wireWorkletPort() {
    // Create a MessageChannel so the worker can receive messages from the worklet.
    // port1 goes to the worklet (AudioWorkletProcessor), port2 goes to the worker.
    // Both are transferred (moved), not copied.
    if (!processorNode || !playbackWorker) return;
    const { port1, port2 } = new MessageChannel();
    processorNode.port.postMessage({ type: 'set-refill-port', port: port1 }, [port1]);
    playbackWorker.postMessage({ type: 'setWorkletPort', port: port2, requestId: -1 }, [port2]);
  }

  function wireWorkletPortOnce() {
    if (workletPortWired) return;
    workletPortWired = true;
    wireWorkletPort();
  }

  function ensurePlaybackWorker() {
    if (playbackWorker) return playbackWorker;
    setWorkerState('starting');
    playbackWorker = new Worker(playbackWorkerModuleUrl, { type: 'module' });
    playbackWorker.addEventListener('message', handlePlaybackWorkerMessage);
    playbackWorker.addEventListener('error', (event) => {
      const workerErrorMessage =
        event.error?.message ?? event.message ?? 'Playback worker failed.';
      for (const pending of pendingWorkerRequests.values()) {
        pending.reject(new Error(workerErrorMessage));
      }
      pendingWorkerRequests.clear();
      setWorkerState('error');
      emitDiagnosticsEvent({
        type: 'playback-worker-error',
        label: 'Playback worker error',
        timestampMs: nowMs(),
        severity: 'error',
        message: workerErrorMessage,
      });
      if (typeof onPlaybackErrorCallback === 'function') {
        onPlaybackErrorCallback(workerErrorMessage);
      }
    });
    return playbackWorker;
  }

  function sendPlaybackWorkerCommand(type, payload = {}) {
    const worker = ensurePlaybackWorker();
    const requestId = playbackWorkerRequestId++;
    const startTime = performance.now();
    worker.postMessage({ type, requestId, ...payload });
    return new Promise((resolve, reject) => {
      pendingWorkerRequests.set(requestId, { resolve, reject, startTime });
    });
  }

  function emitStalePlaybackStarted(sessionGeneration, phase) {
    emitDiagnosticsEvent({
      type: 'playback-started-stale-ignored',
      label: 'Stale playback-started ignored',
      timestampMs: nowMs(),
      severity: 'info',
      details: {
        sessionGeneration,
        currentSessionGeneration: playbackSessionGeneration,
        phase,
      },
    });
  }

  async function unmuteTransportForPlaybackStarted(reason, sessionGeneration) {
    if (!isCurrentPlaybackSession(sessionGeneration)) {
      emitStalePlaybackStarted(sessionGeneration, 'before-transport-unmute');
      return false;
    }
    if (playbackWorker) {
      await sendPlaybackWorkerCommand('transportUnmute').catch(() => {});
    }
    if (!isCurrentPlaybackSession(sessionGeneration)) {
      emitStalePlaybackStarted(sessionGeneration, 'after-transport-unmute');
      return false;
    }
    if (transportMuteReason === 'pause') {
      return false;
    }
    transportMuted = false;
    transportMuteReason = null;
    emitDiagnosticsEvent({
      type: 'playback-transport-unmuted',
      label: `Playback transport unmuted (${reason})`,
      timestampMs: nowMs(),
      severity: 'info',
      details: { reason },
    });
    return true;
  }

  async function handlePlaybackStarted(data) {
    const sessionGeneration = data.sessionGeneration;
    if (!Number.isInteger(sessionGeneration) ||
        !isCurrentPlaybackSession(sessionGeneration)) {
      emitStalePlaybackStarted(sessionGeneration, 'message-received');
      return;
    }

    if (transportMuteReason === 'pause') {
      return;
    }

    const unmuted = await unmuteTransportForPlaybackStarted(
      'playback-started',
      sessionGeneration,
    );
    if (!unmuted || !isCurrentPlaybackSession(sessionGeneration)) {
      return;
    }

    if (audioContext?.state === 'suspended') {
      // Buffer is ready but the AudioContext is suspended (autoplay
      // blocked: Android Chrome without an installed PWA, or desktop
      // Chrome with a low Media Engagement Index — see
      // reports/logs/log113.txt). Signal Dart to show the play button so
      // the UI reflects that audio is buffered but not yet audible.
      // gesture-resume fires onPlaybackStartedCallback on the first user
      // interaction, transitioning the UI from play button → pause button
      // as audio begins. A running context (installed PWA, high MEI, or
      // gesture-initiated play) takes the else branch and starts
      // immediately.
      pendingPlaybackStartedOnResume = true;
      if (typeof onPlaybackSuspendedCallback === 'function') onPlaybackSuspendedCallback();
      markPlaybackState('paused');
    } else {
      if (needsPlaybackStartedDeclick && gainNode) {
        // Deferred from playTrack(): apply declick now that the ring buffer is
        // populated. Gain is at 0 (transport-gain-zero in beginPlaybackSession
        // set it, and no premature ramp ran). Ramp 0→currentVolume over
        // DECLICK_DURATION_S so the first audio frame fades in rather than
        // hard-starting at full gain.
        needsPlaybackStartedDeclick = false;
        scheduleDeclickRampToCurrentVolume('playback-started-startup');
      }
      if (typeof onPlaybackStartedCallback === 'function') onPlaybackStartedCallback();
      markPlaybackState('playing');
    }
    setStartupPhase('playing');
  }

  function handlePlaybackWorkerMessage(event) {
    const data = event.data ?? {};
    switch (data.type) {
      case 'response': {
        const pending = pendingWorkerRequests.get(data.requestId);
        if (!pending) return;
        pendingWorkerRequests.delete(data.requestId);
        const duration = performance.now() - pending.startTime;
        diagnosticsState.workerCommandRoundTripMs = duration;
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data.payload);
        return;
      }
      case 'diagnostics-sync':
        applyDiagnosticsSync(data.payload);
        return;
      case 'diagnostics-event':
        emitDiagnosticsEvent(data.event);
        return;
      case 'playback-started':
        void handlePlaybackStarted(data);
        return;
      case 'position':
        diagnosticsState.decodedPositionMs = data.positionMs;
        return;
      case 'duration':
        if (typeof onDurationCallback === 'function') onDurationCallback(data.durationMs);
        return;
      case 'track-changed':
        diagnosticsState.positionMs = 0;
        diagnosticsState.decodedPositionMs = 0;
        processorNode?.port.postMessage({ type: 'reset_position' });
        if (queueTrackIds && queueTrackIds.length > 0) {
          const delta = typeof data.trackDelta === 'number' ? data.trackDelta : 1;
          activeTrackIndex = Math.min(activeTrackIndex + delta, queueTrackIds.length - 1);
          activeTrackId = queueTrackIds[activeTrackIndex];
        }
        if (_nextTrackMeta !== null) {
          activeTrackTitle = _nextTrackMeta.title || '';
          saveSessionMetadataToLocalStorage();
          if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: _nextTrackMeta.title,
              artist: _nextTrackMeta.artist,
              album: _nextTrackMeta.album,
              artwork: _nextTrackMeta.artworkUrl ? [
                { src: _nextTrackMeta.artworkUrl, sizes: '96x96', type: 'image/jpeg' },
                { src: _nextTrackMeta.artworkUrl, sizes: '192x192', type: 'image/jpeg' },
                { src: _nextTrackMeta.artworkUrl, sizes: '512x512', type: 'image/jpeg' },
              ] : [],
            });
          }
          _nextTrackMeta = null;
        } else {
          activeTrackTitle = '';
          saveSessionMetadataToLocalStorage();
        }
        if (typeof onTrackChangedCallback === 'function') {
          onTrackChangedCallback({
            transitionPositionMs: data.transitionPositionMs ?? 0,
            durationMs: data.durationMs ?? 0,
            activeTrackIndex,
            activeTrackId,
          });
        }
        return;
      case 'ended':
        emitDiagnosticsEvent({
          type: 'bridge-ended-callback',
          label: 'Bridge ended callback received',
          timestampMs: nowMs(),
          severity: 'info',
          audioContextState: audioContext?.state ?? 'unknown',
          activeTrackIndex,
          activeTrackId,
        });
        if (typeof onEndedCallback === 'function') onEndedCallback();
        return;
      case 'handoff-fallback-streaming':
        emitDiagnosticsEvent({
          type: 'bridge-handoff-fallback-streaming',
          label: 'Bridge handoff-fallback-streaming received',
          timestampMs: nowMs(),
          severity: 'info',
          audioContextState: audioContext?.state ?? 'unknown',
          activeTrackIndex,
          activeTrackId,
        });
        if (typeof onHandoffFallbackCallback === 'function') onHandoffFallbackCallback();
        return;
      case 'playback-error':
        if (data.fatal !== true &&
            (!Number.isInteger(data.sessionGeneration) ||
              !isCurrentPlaybackSession(data.sessionGeneration))) {
          emitDiagnosticsEvent({
            type: 'playback-error-stale-ignored',
            label: 'Stale playback error ignored',
            timestampMs: nowMs(),
            severity: 'info',
            details: {
              sessionGeneration: data.sessionGeneration,
              currentSessionGeneration: playbackSessionGeneration,
            },
          });
          return;
        }
        diagnosticsState.transitionGapMs = null;
        markPlaybackState('error');
        setStartupPhase('error');
        if (typeof onPlaybackErrorCallback === 'function') {
          onPlaybackErrorCallback(data.message ?? 'decode error');
        }
        return;
      case 'preload-error':
        if (typeof onPreloadErrorCallback === 'function') {
          onPreloadErrorCallback(data.message ?? 'preload failed');
        }
        return;
      case 'preload-pending':
        if (typeof onPreloadPendingCallback === 'function') onPreloadPendingCallback();
        return;
      case 'buffering-started':
        if (typeof onBufferingCallback === 'function') onBufferingCallback(true);
        return;
      case 'buffering-ended':
        if (typeof onBufferingCallback === 'function') onBufferingCallback(false);
        return;
      default:
        return;
    }
  }

  let initAudioInFlightPromise = null;

  async function initAudio() {
    emitDiagnosticsEvent({
      type: 'init-audio-entered',
      label: 'initAudio() called',
      timestampMs: nowMs(),
      severity: 'info',
      audioContextState: audioContext?.state ?? 'none',
      gainNodeValue: gainNode?.gain?.value ?? null,
    });
    if (initAudioInFlightPromise) {
      return initAudioInFlightPromise;
    }
    initAudioInFlightPromise = _initAudioImpl().finally(() => {
      initAudioInFlightPromise = null;
    });
    return initAudioInFlightPromise;
  }

  async function _initAudioImpl() {
    // Idempotency gate: if the audio graph is already fully live (context
    // running, gain node and processor node both wired), skip all cold-start
    // work. This prevents a warm second call (e.g. skipToPrevious 100ms after
    // the first) from cancelling an in-flight declick ramp mid-ramp via
    // forceGainToZero — which causes an audible click (P0). It also prevents
    // the 3s silent-anchor timeout from arming on desktop where the
    // AudioContext is already running at startup (P2).
    //
    // The condition uses observable state rather than a boolean flag so it
    // self-heals: if audioContext is later suspended (browser autoplay policy),
    // the gate is false and the next initAudio() runs the full cold-start path.
    //
    // On the very first call, gainNode and processorNode are both null (created
    // inside ensureAudioGraph), so the gate is bypassed and the full cold-start
    // path runs normally.
    if (audioContext?.state === 'running' && gainNode && processorNode) {
      emitDiagnosticsEvent({
        type: 'init-audio-skipped-already-running',
        label: 'initAudio skipped: audio graph already running',
        timestampMs: nowMs(),
        severity: 'info',
        audioContextState: audioContext.state,
        gainNodeValue: gainNode?.gain?.value ?? null,
      });
      return;
    }
    ensureCrossOriginIsolation();
    ensureSilentAudio();
    await ensureWasm();
    await ensureAudioGraph();
    forceGainToZero('initAudio-before-silent-anchor');
    if (audioContext?.state !== 'running') {
      // Race silentAudioEl.play() against a 3 s timeout so a stuck browser
      // media element is always observable in diagnostics.
      // clearTimeout is called on settlement so no lingering timer outlives the call.
      const SILENT_PLAY_TIMEOUT_MS = 3000;
      const silentPlayTimeoutSymbol = Symbol('silent-play-timeout');
      let silentPlayTimeoutId;
      const silentPlayTimeoutPromise = new Promise((resolve) => {
        silentPlayTimeoutId = setTimeout(
          () => resolve(silentPlayTimeoutSymbol),
          SILENT_PLAY_TIMEOUT_MS,
        );
      });
      // Fire-and-forget: initAudio() must not block on this.
      Promise.race([silentAudioEl.play().then(() => 'resolved'), silentPlayTimeoutPromise])
        .then((result) => {
          clearTimeout(silentPlayTimeoutId);
          if (result === silentPlayTimeoutSymbol) {
            emitDiagnosticsEvent({
              type: 'silent-audio-play-timeout',
              label: `Silent audio play did not resolve within ${SILENT_PLAY_TIMEOUT_MS} ms`,
              timestampMs: nowMs(),
              severity: 'warn',
              audioContextState: audioContext?.state ?? 'none',
              gainNodeValue: gainNode?.gain?.value ?? null,
            });
          } else {
            emitDiagnosticsEvent({
              type: 'silent-audio-play-resolved',
              label: 'Silent audio play resolved (hardware may activate here)',
              timestampMs: nowMs(),
              severity: 'info',
              audioContextState: audioContext?.state ?? 'none',
              gainNodeValue: gainNode?.gain?.value ?? null,
              hasGainNode: Boolean(gainNode),
            });
          }
        })
        .catch((err) => {
          clearTimeout(silentPlayTimeoutId);
          emitDiagnosticsEvent({
            type: 'silent-audio-play-failed',
            label: 'Silent audio play failed',
            timestampMs: nowMs(),
            severity: 'warn',
            error: err?.message,
          });
        });
    }

    const resumeStartedAt = performance.now();
    emitDiagnosticsEvent({
      type: 'audio-context-resume-started',
      label: 'Audio context resume started',
      timestampMs: nowMs(),
      severity: 'info',
    });
    // Fire-and-forget: on Android Chrome the resume() promise stays PENDING until
    // a user gesture is received, so awaiting it here would hang initAudio() and
    // cause startPlayback() to detect a requestToken mismatch and silently abort.
    // Diagnostics are preserved via .then(); the AudioContext resumes as soon as
    // the browser allows (first user gesture).
    audioContext.resume().then(() => {
      const durationMs = roundMs(performance.now() - resumeStartedAt);
      recordStartupTiming('audioContextResume', durationMs);
      emitDiagnosticsEvent({
        type: 'audio-context-resumed',
        label: 'Audio context resumed',
        timestampMs: nowMs(),
        severity: 'info',
        durationMs,
      });
      if (!needsPlaybackStartedDeclick) {
        scheduleDeclickRampToCurrentVolume('initAudio-startup');
      }
    }).catch(() => {});

    // Fallback for when the AudioContext is still suspended after initAudio().
    // This happens on Chrome browser (non-installed PWA) where MEI is too low
    // to grant autoplay. On an INSTALLED Android PWA, Chrome grants
    // unrestricted autoplay and the context is already running by this point —
    // this block is a no-op. For non-installed users, register a one-time
    // capture-phase listener so the context resumes on the very first
    // interaction; the worker will have already filled the ring buffer by then,
    // so audio starts with no perceptible delay. Do NOT remove this block —
    // it is the only audio path for Chrome-browser (non-installed) deeplink
    // users. Do NOT add a "tap to play" UI overlay — use this silent fallback.
    if (audioContext.state === 'suspended') {
      console.log('[deeplink-diag] initAudio: context suspended, registering gesture-resume listener');
      const resumeOnGesture = () => {
        document.removeEventListener('click', resumeOnGesture, true);
        document.removeEventListener('touchstart', resumeOnGesture, true);
        document.removeEventListener('keydown', resumeOnGesture, true);
        if (!audioContext || audioContext.state !== 'suspended') return;
        console.log('[deeplink-diag] gesture-resume: gesture fired, calling audioContext.resume()');
        audioContext.resume().then(() => {
          console.log('[deeplink-diag] gesture-resume: audioContext.state=', audioContext.state);
          // Ramp gain from 0 → currentVolume over 15 ms to avoid the pop that
          // occurs when the context resumes into a non-zero first audio frame.
          // The ramp is imperceptible as a fade but eliminates the DC step.
          if (gainNode) {
            gainNode.gain.cancelScheduledValues(audioContext.currentTime);
            gainNode.gain.setValueAtTime(0, audioContext.currentTime);
            gainNode.gain.linearRampToValueAtTime(
              currentVolume,
              audioContext.currentTime + 0.015,
            );
          }
          // If the worker buffered audio while the context was suspended, the
          // Dart "started" callback was deferred. Fire it now so the UI
          // transitions from play button → pause button as audio begins.
          if (pendingPlaybackStartedOnResume) {
            pendingPlaybackStartedOnResume = false;
            if (typeof onPlaybackStartedCallback === 'function') onPlaybackStartedCallback();
            markPlaybackState('playing');
          }
          emitDiagnosticsEvent({
            type: 'audio-context-gesture-resumed',
            label: 'Audio context resumed via first gesture',
            timestampMs: nowMs(),
            severity: 'info',
          });
          if (silentAudioEl && silentAudioEl.paused) silentAudioEl.play().catch(() => {});
        }).catch(() => {});
      };
      document.addEventListener('click', resumeOnGesture, true);
      document.addEventListener('touchstart', resumeOnGesture, true);
      document.addEventListener('keydown', resumeOnGesture, true);
    }
  }

  async function beginPlaybackSession({
    transitionKind = 'track-replace',
    sessionGeneration = null,
  } = {}) {
    // Await the worker stop so rapid skips cannot race the stop/play sequence.
    // Without this, a second skip arriving 1-2 s after the first can send
    // playTrackBounded to the worker before the previous resetPlaybackState()
    // has completed, leaving windowedPlayer/fetchController in an inconsistent
    // state where the refill loop never starts for the new session.
    if (isAndroidTransport) {
      await runMutedAndroidTransportTransition({
        transitionKind,
        preserveMediaSession: true,
        performAction: async ({ preserveMediaSession }) => {
          if (playbackWorker) {
            // Stop the worklet BEFORE stopping the worker. Without this, the
            // worklet keeps consuming the old ring buffer after the worker is
            // stopped, causing audio from the previous session (e.g. a
            // suspended deeplink import) to bleed into the new session. The
            // worker stop follows immediately so the buffers are cleanly
            // replaced by createSharedBuffers() in the new playTrack call.
            processorNode?.port.postMessage({ type: 'stop' });
            await sendPlaybackWorkerCommand('stop').catch(() => {});
          } else {
            await stop({
              preserveMediaSession,
              invalidatePlaybackSession: false,
            });
          }
        },
      });
    } else {
      if (playbackWorker) {
        // Zero the gain atomically before stopping the worklet so the gain
        // node is already at zero in the same render quantum the worklet
        // processes its stop message. A linearRamp is fire-and-forget and
        // the worklet zeros its output within ~2.67ms (one render quantum),
        // well before the 15ms ramp completes — ramp × 0 = 0, so the ramp
        // was a no-op and the pop happened at the stop quantum. Using
        // setValueAtTime(0, now) is atomic: output = worklet_output × 0 = 0
        // starting at the very next quantum, preventing the pop.
        forceGainToZero('beginPlaybackSession-desktop-declick');
        processorNode?.port.postMessage({ type: 'stop' }); // see Android branch above
        await sendPlaybackWorkerCommand('stop').catch(() => {});
      } else {
        await stop({
          preserveMediaSession: true,
          invalidatePlaybackSession: false,
        });
      }
    }

    if (sessionGeneration !== null &&
        !isCurrentPlaybackSession(sessionGeneration)) {
      return false;
    }

    pendingPlaybackStartedOnResume = false;
    needsPlaybackStartedDeclick = false;
    transportMuted = true;
    transportMuteReason = 'track-replace';
    resumeUnmuteSent = false;
    diagnosticsState = createDiagnosticsState();
    markPlaybackState('loading', { preserveMediaSession: true });
    setStartupPhase('initializing wasm');
    startDiagnosticsLoop();
    emitDiagnosticsEvent({
      type: 'play-requested',
      label: 'Play requested',
      timestampMs: nowMs(),
      severity: 'info',
    });
    return true;
  }

  async function playTrack(audioBytes) {
    return enqueueLatestPlaybackSession(async (sessionGeneration) => {
      if (!await beginPlaybackSession({ sessionGeneration })) return;
      setTrackAudioOnSilentElement(audioBytes);
      try {
        await initAudio();
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        // Always defer the startup declick to the playback-started event (when
        // the ring buffer is actually populated). Scheduling the ramp here on
        // desktop caused it to complete before the first PCM frame arrived —
        // the gain node reached currentVolume during the decode gap and the
        // first frame hit at full gain → audible pop. Android already used this
        // deferred path; now desktop matches.
        needsPlaybackStartedDeclick = true;
        createSharedBuffers();
        setStartupPhase('creating decoder');
        await sendPlaybackWorkerCommand('playTrack', {
          sessionGeneration,
          audioBytes,
          pcmBuffer: sharedPcmBuffer,
          stateBuffer: sharedStateBuffer,
          frameCapacity,
          sampleRate: audioContext.sampleRate,
          protocolVersion: PROTOCOL_VERSION,
          protocolSlots: PROTOCOL_SLOTS,
        });
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        setStartupPhase('prebuffering');
        processorNode.port.postMessage({
          type: 'init',
          pcmBuffer: sharedPcmBuffer,
          stateBuffer: sharedStateBuffer,
          frameCapacity,
          channels: CHANNELS,
          protocolVersion: PROTOCOL_VERSION,
          protocolSlots: PROTOCOL_SLOTS,
        });
        wireWorkletPortOnce();
      } catch (error) {
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        markPlaybackState('error');
        setStartupPhase('error');
        emitDiagnosticsEvent({
          type: 'playback-startup-error',
          label: 'Playback startup error',
          timestampMs: nowMs(),
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        emitDiagnosticsSnapshot();
        stopDiagnosticsLoop();
        throw error;
      }
    });
  }

  async function playTrackStreaming() {
    return enqueueLatestPlaybackSession(async (sessionGeneration) => {
      if (!await beginPlaybackSession({ sessionGeneration })) return;
      try {
        ensureCrossOriginIsolation();
        await ensureWasm();
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        await ensureAudioGraph();
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        if (audioContext && audioContext.state === 'suspended') {
          // Await resume so the AudioContext is running before the worklet starts.
          // On the paste-button path Chrome resolves this immediately (user gesture);
          // on the no-MEI deeplink path it never resolves, so cap at 300 ms and let
          // the gesture-resume listener unblock the context after the user taps.
          await Promise.race([
            audioContext.resume(),
            new Promise((r) => setTimeout(r, 300)),
          ]).catch(() => {});
        }
        needsPlaybackStartedDeclick = true;
        createSharedBuffers();
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        setStartupPhase('creating streaming decoder');
        const sharedStateView = new Int32Array(sharedStateBuffer);
        console.log('[deeplink-diag] playTrackStreaming: pre-worker STOP=',
          Atomics.load(sharedStateView, 4),
          ' framesAvailable=', Atomics.load(sharedStateView, 2));
        await sendPlaybackWorkerCommand('playTrackStreaming', {
          sessionGeneration,
          pcmBuffer: sharedPcmBuffer,
          stateBuffer: sharedStateBuffer,
          frameCapacity,
          sampleRate: audioContext.sampleRate,
          protocolVersion: PROTOCOL_VERSION,
          protocolSlots: PROTOCOL_SLOTS,
        });
        console.log('[deeplink-diag] playTrackStreaming: post-worker STOP=',
          Atomics.load(sharedStateView, 4),
          ' framesAvailable=', Atomics.load(sharedStateView, 2),
          ' audioContext.state=', audioContext?.state);
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        setStartupPhase('prebuffering');
        processorNode.port.postMessage({
          type: 'init',
          pcmBuffer: sharedPcmBuffer,
          stateBuffer: sharedStateBuffer,
          frameCapacity,
          channels: CHANNELS,
          protocolVersion: PROTOCOL_VERSION,
          protocolSlots: PROTOCOL_SLOTS,
        });
        wireWorkletPortOnce();
      } catch (error) {
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        markPlaybackState('error');
        setStartupPhase('error');
        emitDiagnosticsEvent({
          type: 'playback-startup-error',
          label: 'Playback startup error',
          timestampMs: nowMs(),
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        emitDiagnosticsSnapshot();
        stopDiagnosticsLoop();
        throw error;
      }
    });
  }

  async function playTrackBounded(url, totalSize) {
    return enqueueLatestPlaybackSession(async (sessionGeneration) => {
      if (!await beginPlaybackSession({ sessionGeneration })) return;
      if (enableBoundedUrlAnchorExperiment) {
        setBoundedTrackAudioOnSilentElement(url);
      }
      try {
        ensureCrossOriginIsolation();
        await ensureWasm();
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        await ensureAudioGraph();
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        if (audioContext && audioContext.state === 'suspended') {
          await Promise.race([
            audioContext.resume(),
            new Promise((r) => setTimeout(r, 300)),
          ]).catch(() => {});
        }
        needsPlaybackStartedDeclick = true;
        createSharedBuffers();
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        setStartupPhase('creating streaming decoder');
        const sharedStateView = new Int32Array(sharedStateBuffer);
        console.log('[deeplink-diag] playTrackBounded: pre-worker STOP=',
          Atomics.load(sharedStateView, 4),
          ' framesAvailable=', Atomics.load(sharedStateView, 2));
        await sendPlaybackWorkerCommand('playTrackBounded', {
          sessionGeneration,
          url,
          totalSize,
          pcmBuffer: sharedPcmBuffer,
          stateBuffer: sharedStateBuffer,
          frameCapacity,
          sampleRate: audioContext.sampleRate,
          protocolVersion: PROTOCOL_VERSION,
          protocolSlots: PROTOCOL_SLOTS,
        });
        console.log('[deeplink-diag] playTrackBounded: post-worker STOP=',
          Atomics.load(sharedStateView, 4),
          ' framesAvailable=', Atomics.load(sharedStateView, 2),
          ' audioContext.state=', audioContext?.state);
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        setStartupPhase('prebuffering');
        processorNode.port.postMessage({
          type: 'init',
          pcmBuffer: sharedPcmBuffer,
          stateBuffer: sharedStateBuffer,
          frameCapacity,
          channels: CHANNELS,
          protocolVersion: PROTOCOL_VERSION,
          protocolSlots: PROTOCOL_SLOTS,
        });
        wireWorkletPortOnce();
      } catch (error) {
        if (!isCurrentPlaybackSession(sessionGeneration)) return;
        markPlaybackState('error');
        setStartupPhase('error');
        emitDiagnosticsEvent({
          type: 'playback-startup-error',
          label: 'Playback startup error',
          timestampMs: nowMs(),
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        emitDiagnosticsSnapshot();
        stopDiagnosticsLoop();
        throw error;
      }
    });
  }

  async function appendChunk(chunk) {
    const result = await sendPlaybackWorkerCommand('appendChunk', {
      audioBytes: chunk,
    });
    
    return {
      ready: result?.ready ?? false,
      playbackStarted: result?.playbackStarted ?? false,
      sessionEnded: result?.sessionEnded ?? false,
    };
  }

  function finalizeStream() {
    return sendPlaybackWorkerCommand('finalizeStream');
  }

  function transitionStreamToGapless(audioBytes, hintDurationMs = 0) {
    return sendPlaybackWorkerCommand('transitionStreamToGapless', { audioBytes, hintDurationMs });
  }

  function preloadNext(audioBytes, hintDurationMs = 0) {
    void sendPreloadCommand(
      sendPlaybackWorkerCommand,
      onPreloadErrorCallback,
      'preloadNext',
      { audioBytes, hintDurationMs },
    );
  }

  function preloadNextBounded(url, totalSize) {
    void sendPreloadCommand(
      sendPlaybackWorkerCommand,
      onPreloadErrorCallback,
      'preloadNextBounded',
      { url, totalSize },
    );
  }

  function seek(positionMs) {
    diagnosticsState.transitionGapMs = null;
    diagnosticsState.positionMs = positionMs;
    saveSessionMetadataToLocalStorage();
    if (typeof onPositionCallback === 'function') {
      onPositionCallback(positionMs);
    }
    processorNode?.port.postMessage({
      type: 'set_position',
      positionMs,
    });
    void sendPlaybackWorkerCommand('seek', { positionMs }).catch((error) => {
      if (typeof onPlaybackErrorCallback === 'function') {
        onPlaybackErrorCallback(error instanceof Error ? error.message : String(error));
      }
    });
  }

  async function pause() {
    if (!audioContext) return;

    appOwnedPauseInFlight = true;
    try {
      if (isAndroidTransport) {
        await runMutedAndroidTransportTransition({
          transitionKind: 'pause',
          preserveMediaSession: true,
          // Keep-warm: context stays running at gain=0. No DAC power-cycle = no pop.
          // runMutedAndroidTransportTransition ramps gain to zero and calls
          // waitForWorkerTransportQuiet() → transportMute (STOP_INDEX=1) before
          // performAction runs. The worklet outputs silence without advancing
          // READ_INDEX when STOP_INDEX=1. On resume, transportUnmute clears
          // STOP_INDEX=0 and the worklet resumes from the exact frame it left off.
          performAction: async () => {},
        });
      } else {
        await rampGainToValue(0, DECLICK_DURATION_S);
        // Keep-warm: no audioContext suspend call — context stays running at gain=0.
        // transportMute sets STOP_INDEX=1 so the worklet outputs silence without
        // advancing READ_INDEX (ring-buffer position frozen). This subsumes
        // pauseRefill (also stops the refill loop). transportUnmute on resume
        // clears STOP_INDEX=0 and restarts the refill loop.
        if (playbackWorker) {
          await sendPlaybackWorkerCommand('transportMute').catch(() => {});
        }
        transportMuted = true;
        transportMuteReason = 'pause';
      }

      markPlaybackState('paused');
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      emitDiagnosticsEvent({
        type: 'pause',
        label: 'Paused (keep-warm: context running, gain=0)',
        timestampMs: nowMs(),
        severity: 'info',
        audioContextState: audioContext?.state ?? 'none',
        gainNodeValue: gainNode?.gain?.value ?? null,
      });
    } finally {
      appOwnedPauseInFlight = false;
    }
  }

  async function resume() {
    if (!audioContext) return;

    clearAudioInterruptionLatch('resume');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    isAppOwnedResumeInFlight = true;
    try {
      if (isAndroidTransport) {
        await runMutedAndroidTransportTransition({
          transitionKind: 'resume',
          preserveMediaSession: true,
          fadeIn: true,
          skipInitialRamp: true,
          performAction: async () => {
            // Keep-warm: audioContext is never suspended after pause(), so no
            // audioContext resume call is needed. Gain is unfrozen by the fadeIn
            // path in runMutedAndroidTransportTransition (transportUnmute + ramp).
            if (silentAudioEl) await silentAudioEl.play().catch(() => {});
          },
        });
      } else {
        // Keep-warm: context was never suspended, so no audioContext.resume() needed.
        // transportMute was called during pause (STOP_INDEX=1 froze the worklet).
        // transportUnmute clears STOP_INDEX=0 and restarts the refill loop so audio
        // can flow before the gain ramp reaches currentVolume.
        transportMuted = false;
        transportMuteReason = null;
        resumeUnmuteSent = true;
        if (playbackWorker) {
          await sendPlaybackWorkerCommand('transportUnmute').catch(() => {});
        }
        if (gainNode) {
          const now = audioContext.currentTime;
          gainNode.gain.cancelScheduledValues(now);
          gainNode.gain.setValueAtTime(0, now);
        }
        if (silentAudioEl) await silentAudioEl.play().catch(() => {});
        if (gainNode) {
          const now = audioContext.currentTime;
          gainNode.gain.linearRampToValueAtTime(currentVolume, now + DECLICK_DURATION_S);
        }
      }
    } catch (e) {
      console.error(`[${namespace}] audioContext.resume() failed:`, e);
    } finally {
      isAppOwnedResumeInFlight = false;
    }

    markPlaybackState('playing');
    if (playbackWorker) {
      emitDiagnosticsEvent({
        type: 'worker-resume-nudge',
        label: 'Worker resume nudge sent',
        timestampMs: nowMs(),
        severity: 'info',
      });
      void sendPlaybackWorkerCommand('nudge').catch(() => {});
    }
    emitDiagnosticsEvent({ type: 'resume', label: 'Resumed', timestampMs: nowMs(), severity: 'info' });
  }

  async function getWorkerHealthStatus() {
    if (!playbackWorker) {
      return {
        framesAvailable: 0,
        decoderReady: false,
        endOfStream: false,
        pendingSeek: false,
        transportMuted,
        transportMuteReason,
        resumeUnmuteSent,
        gainNodeValue: gainNode?.gain?.value ?? null,
        audioContextState: audioContext?.state ?? 'none',
      };
    }
    const health = await sendPlaybackWorkerCommand('getHealthStatus');
    return {
      ...health,
      transportMuted,
      transportMuteReason,
      resumeUnmuteSent,
      gainNodeValue: gainNode?.gain?.value ?? null,
      audioContextState: audioContext?.state ?? 'none',
    };
  }

  async function stop(options = {}) {
    appOwnedStopInFlight = true;
    try {
      const {
        preserveMediaSession = false,
        invalidatePlaybackSession = true,
      } = options;
      if (invalidatePlaybackSession) {
        playbackSessionGeneration += 1;
      }

      // Declick: ramp gain to zero before cutting audio to avoid a pop.
      // Mirrors pause() pattern. rampGainToValue() returns early if gain is
      // already at/near zero (e.g. stop()-after-pause()), so no double-ramp occurs.
      if (gainNode && audioContext) {
        if (isAndroidTransport) {
          await runMutedAndroidTransportTransition({
            transitionKind: 'stop',
            preserveMediaSession,
            performAction: async () => {
              if (processorNode) processorNode.port.postMessage({ type: 'stop' });
              if (playbackWorker) await sendPlaybackWorkerCommand('stop').catch(() => {});
            },
          });
        } else {
          await rampGainToValue(0, DECLICK_DURATION_S);
          if (processorNode) processorNode.port.postMessage({ type: 'stop' });
          if (playbackWorker) void sendPlaybackWorkerCommand('stop').catch(() => {});
        }
      } else {
        if (processorNode) processorNode.port.postMessage({ type: 'stop' });
        if (playbackWorker) void sendPlaybackWorkerCommand('stop').catch(() => {});
      }

      transportMuted = true;
      transportMuteReason = null;
      resumeUnmuteSent = false;

      clearBoundedAnchorEndedHandler();
      restoreSilentAnchor();

      if (currentTrackBlobUrl && !preserveMediaSession) {
        URL.revokeObjectURL(currentTrackBlobUrl);
        currentTrackBlobUrl = null;
      }
      if (silentAudioEl) {
        if (!preserveMediaSession) {
          silentAudioEl.pause();
          silentAudioEl.currentTime = 0;
        } else if (silentAudioEl.paused) {
          silentAudioEl.play().catch(() => {});
        }
      }
      if ('mediaSession' in navigator && !preserveMediaSession) {
        navigator.mediaSession.playbackState = 'none';
      }
      sharedPcmBuffer = null;
      sharedStateBuffer = null;
      frameCapacity = 8192;
      lastKnownBufferedDurationMs = 0;
      diagnosticsState.transitionGapMs = null;
      markPlaybackState('idle', { preserveMediaSession });
      setStartupPhase('idle');
      emitDiagnosticsSnapshot();
      stopDiagnosticsLoop();
      if (!preserveMediaSession) stopHeartbeat();
    } finally {
      appOwnedStopInFlight = false;
      clearAudioInterruptionLatch('stop');
    }
  }

  async function forceAudioContextReset() {
    appOwnedResetInFlight = true;
    try {
      emitDiagnosticsEvent({
        type: 'force-audio-context-reset-start',
        label: 'Forcing AudioContext hard reset',
        timestampMs: nowMs(),
        severity: 'warn',
      });

      // Pop suppression: ramp gain to zero before tearing down the context
      forceGainToZero('hard-reset');

      // Stop worklet processing immediately
      processorNode?.port.postMessage({ type: 'stop' });

      // Close the AudioContext — this terminates the render thread and worklet
      try {
        await audioContext?.close();
      } catch (e) {
        emitDiagnosticsEvent({
          type: 'force-audio-context-reset-failed',
          label: 'AudioContext close failed during hard reset',
          timestampMs: nowMs(),
          severity: 'error',
          stage: 'close',
          error: String(e),
        });
        throw e;
      }

      // Null all context-dependent state. ensureAudioGraph() recreates them on
      // the next beginPlaybackSession() call (triggered by Dart's playTrack()).
      // workletReadyPromise must be nulled so addModule() runs on the new context.
      // workletPortWired must be false so wireWorkletPortOnce() re-wires the port.
      audioContext = null;
      processorNode = null;
      gainNode = null;
      workletReadyPromise = null;
      workletPortWired = false;

      // Explicit known mute state. The subsequent playTrack() → createSharedBuffers()
      // allocates a fresh SAB with sharedState.fill(0), clearing STOP_INDEX.
      // Do NOT call wireWorkletPortOnce() here — beginPlaybackSession() does it.
      transportMuted = true;
      transportMuteReason = null;
      resumeUnmuteSent = false;

      emitDiagnosticsEvent({
        type: 'force-audio-context-reset-complete',
        label: 'AudioContext hard reset complete — awaiting Dart playTrack',
        timestampMs: nowMs(),
        severity: 'info',
      });
    } finally {
      appOwnedResetInFlight = false;
    }
  }

  function setVolume(value) {
    currentVolume = clampVolume(value);
    if (gainNode) {
      if (audioContext && audioContext.state === 'running') {
        const now = audioContext.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(gainNode.gain.value, now);
        gainNode.gain.linearRampToValueAtTime(currentVolume, now + DECLICK_DURATION_S);
      } else {
        gainNode.gain.value = currentVolume;
      }
    }
  }

  function setBufferedDurationMs(value) {
    lastKnownBufferedDurationMs = Number.isFinite(value) ? Math.max(0, value) : 0;
    void sendPlaybackWorkerCommand('setBufferedDurationMs', { value });
  }

  function updatePlaybackState(state, options = {}) {
    const { preserveMediaSession = false } = options;
    if ('mediaSession' in navigator) {
      if (state === 'loading') return;
      let mapped = 'none';
      if (state === 'playing') mapped = 'playing';
      else if (state === 'paused') mapped = 'paused';

      if (mapped === 'playing' || mapped === 'paused') {
        startHeartbeat();
      } else if (!preserveMediaSession) {
        stopHeartbeat();
      }

      if (!preserveMediaSession) navigator.mediaSession.playbackState = mapped;
      if (mapped === 'playing') {
        ensureSilentAudio();
        if (silentAudioEl.paused) silentAudioEl.play().catch(() => {});
      } else if (mapped === 'paused') {
        ensureSilentAudio();
        if (NOTIFICATION_KEEP_WHILE_PAUSED) {
          if (silentAudioEl.paused) silentAudioEl.play().catch(() => {});
        } else {
          if (!silentAudioEl.paused) silentAudioEl.pause();
        }
      } else if (mapped === 'none') {
        if (!preserveMediaSession && silentAudioEl && !silentAudioEl.paused) {
          silentAudioEl.pause();
          silentAudioEl.currentTime = 0;
        }
      }
    }
  }

  function setNotificationKeepWhilePaused(value) {
    NOTIFICATION_KEEP_WHILE_PAUSED = Boolean(value);
    try {
      if (value) {
        localStorage.setItem('jamdisc_notif_keep_paused', 'true');
      } else {
        localStorage.removeItem('jamdisc_notif_keep_paused');
      }
    } catch (_) {}
  }

  function updatePositionState(durationSec, playbackRate, positionSec) {
    if (!('mediaSession' in navigator)) return;
    try {
      const duration = Number(durationSec);
      const rate = Number(playbackRate);
      const position = Number(positionSec);
      if (!Number.isFinite(duration) || duration <= 0) return;
      if (!Number.isFinite(rate) || rate <= 0) return;
      if (!Number.isFinite(position) || position < 0) return;
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.min(position, duration),
      });
      heartbeatLastKnownPositionSec = position;
      heartbeatLastKnownDurationSec = duration;
      heartbeatPositionCapturedAtMs = performance.now();
    } catch {}
  }

  function setNextTrackMeta(title, artist, album, artworkUrl) {
    _nextTrackMeta = { title: title || '', artist: artist || '', album: album || '', artworkUrl: artworkUrl || '' };
  }

  function updateMediaSession(title, artist, album, artworkUrl) {
    activeTrackTitle = title || '';
    saveSessionMetadataToLocalStorage();
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork: artworkUrl ? [
        { src: artworkUrl, sizes: '96x96', type: 'image/jpeg' },
        { src: artworkUrl, sizes: '192x192', type: 'image/jpeg' },
        { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' },
      ] : [],
    });

    navigator.mediaSession.setActionHandler('play', () => {
      emitDiagnosticsEvent({
        type: 'media-session-play-handler-entered',
        label: 'Media Session play action handler entered',
        timestampMs: nowMs(),
        severity: 'info',
        audioContextState: audioContext?.state ?? 'none',
      });
      runMediaAction('play', () => {
        mediaSessionResumeRequested = true;
        if (silentAudioEl) {
          silentAudioEl.play().catch(() => {});
        }
        if (typeof onPlayCallback === 'function') onPlayCallback();
        else {
          console.warn(`[${namespace}] onPlayCallback not registered, falling back to low-level resume()`);
          resume();
        }
      });
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      runMediaAction('pause', () => {
        if (typeof onPauseCallback === 'function') onPauseCallback();
        else {
          console.warn(`[${namespace}] onPauseCallback not registered, falling back to low-level pause()`);
          pause();
        }
      });
    });
    navigator.mediaSession.setActionHandler('stop', () => {
      runMediaAction('stop', () => {
        if (typeof onStopCallback === 'function') onStopCallback();
        else stop();
      });
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      runMediaAction('nexttrack', () => {
        if (typeof onNextCallback === 'function') onNextCallback();
      });
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      runMediaAction('previoustrack', () => {
        if (typeof onPreviousCallback === 'function') onPreviousCallback();
      });
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      runMediaAction('seekto', () => {
        if (typeof onSeekCallback === 'function' && details.seekTime != null) {
          onSeekCallback(Math.round(details.seekTime * 1000));
        }
      });
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      runMediaAction('seekbackward', () => {
        if (typeof onSeekCallback !== 'function') return;
        const currentPositionMs = diagnosticsState.playbackPositionMs ?? diagnosticsState.positionMs ?? 0;
        const durationMs = diagnosticsState.durationMs ?? Math.max(lastKnownBufferedDurationMs, 0);
        const offsetMs = (details.seekOffset || 10) * 1000;
        const nextPositionMs = Math.round(currentPositionMs - offsetMs);
        onSeekCallback(Math.min(Math.max(nextPositionMs, 0), durationMs || Infinity));
      });
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      runMediaAction('seekforward', () => {
        if (typeof onSeekCallback !== 'function') return;
        const currentPositionMs = diagnosticsState.playbackPositionMs ?? diagnosticsState.positionMs ?? 0;
        const durationMs = diagnosticsState.durationMs ?? Math.max(lastKnownBufferedDurationMs, 0);
        const offsetMs = (details.seekOffset || 10) * 1000;
        const nextPositionMs = Math.round(currentPositionMs + offsetMs);
        onSeekCallback(Math.min(Math.max(nextPositionMs, 0), durationMs || Infinity));
      });
    });
  }

  async function ensureMediaAlive() {
    ensureSilentAudio();
    let hiddenMediaPlaying = false;
    let hiddenMediaError = null;
    let audioContextState = audioContext?.state ?? 'missing';

    try {
      if (silentAudioEl.paused) {
        await silentAudioEl.play();
      }
      hiddenMediaPlaying = !silentAudioEl.paused;
    } catch (err) {
      hiddenMediaError = err?.message ?? String(err);
      emitDiagnosticsEvent({
        type: 'hidden-media-ensure-failed',
        label: 'Hidden media ensure failed',
        timestampMs: nowMs(),
        severity: 'warn',
        message: hiddenMediaError,
      });
    }

    // Fire-and-forget: same as initAudio() — awaiting resume() hangs indefinitely
    // on Android Chrome until a user gesture, which would block the health monitor.
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch((err) => {
        emitDiagnosticsEvent({
          type: 'audio-context-ensure-resume-failed',
          label: 'Audio context ensure resume failed',
          timestampMs: nowMs(),
          severity: 'warn',
          message: err?.message ?? String(err),
        });
      });
    }

    audioContextState = audioContext?.state ?? 'missing';
    return { hiddenMediaPlaying, audioContextState, hiddenMediaError };
  }

  async function nudgeWorker() {
    try {
      await sendPlaybackWorkerCommand('nudge');
      return true;
    } catch (e) {
      return false;
    }
  }

  function resetPositionHeartbeat() {
    lastPositionEventTs = nowMs();
    if (processorNode) {
      processorNode.port.postMessage({ type: 'reset_position' });
    }
  }

  async function rebindWorkletNode() {
    if (!audioContext || !gainNode) return;
    if (!sharedPcmBuffer || !sharedStateBuffer) {
      emitDiagnosticsEvent({
        type: 'rebind-skipped-null-buffers',
        label: 'Rebind skipped: null buffers after stop',
        timestampMs: nowMs(),
        severity: 'warn',
        message: 'Buffers were null after stop(); callers must reinitialize via playTrack or initAudio',
      });
      return;
    }
    const oldNode = processorNode;
    if (oldNode) {
      try {
        oldNode.disconnect(eqFilterNodes ? eqFilterNodes[0] : gainNode);
      } catch (e) {
        console.warn('rebindWorkletNode: disconnect failed', e);
      }
    }
    processorNode = new AudioWorkletNode(audioContext, 'jam-audio-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [CHANNELS],
    });
    connectProcessorToChain(processorNode, eqFilterNodes, gainNode);
    if (oldNode) {
      processorNode.port.onmessage = oldNode.port.onmessage;
    }
    processorNode.port.postMessage({
      type: 'init',
      pcmBuffer: sharedPcmBuffer,
      stateBuffer: sharedStateBuffer,
      frameCapacity,
      channels: CHANNELS,
      protocolVersion: PROTOCOL_VERSION,
      protocolSlots: PROTOCOL_SLOTS,
    });
    workletPortWired = false;
    wireWorkletPortOnce();
  }

  function scheduleSynchronousDeclickToZero() {
    appOwnedReloadInFlight = true;
    try {
      // Synchronous gain schedule for unload paths (beforeunload/pagehide).
      // setTimeout-based ramps are unreliable during unload, but AudioNode
      // scheduling is honored by the audio thread.

      // Skip entirely if the AudioContext is already closed — this happens on a
      // double page-reload within 4 seconds where prepareForReload() already
      // closed the context and cleaned up the element and processor.
      if (audioContext && audioContext.state === 'closed') return;

      emitDiagnosticsEvent({
        type: 'teardown-declick-started',
        label: 'Teardown declick started',
        timestampMs: nowMs(),
        severity: 'info',
        details: {
          audioContextState: audioContext ? audioContext.state : 'none',
          gainNodeValue: gainNode?.gain?.value ?? null,
          hiddenMediaPlaying: silentAudioEl ? !silentAudioEl.paused : false,
        },
      });

      if (silentAudioEl) {
        silentAudioEl.volume = 0;
        try { silentAudioEl.pause(); } catch {}
        try { silentAudioEl.currentTime = 0; } catch {}
      }

      if (audioContext && gainNode && audioContext.state !== 'closed') {
        const now = audioContext.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.linearRampToValueAtTime(0, now + DECLICK_DURATION_S);
      }

      if (processorNode) processorNode.port.postMessage({ type: 'stop' });
    } finally {
      appOwnedReloadInFlight = false;
    }
  }

  async function prepareForReload() {
    appOwnedReloadInFlight = true;
    try {
      emitDiagnosticsEvent({
        type: 'prepare-for-reload-started',
        label: 'Prepare for reload started',
        timestampMs: nowMs(),
        severity: 'info',
        details: {
          audioContextState: audioContext ? audioContext.state : 'none',
          gainNodeValue: gainNode?.gain?.value ?? null,
          hiddenMediaPlaying: silentAudioEl ? !silentAudioEl.paused : false,
        },
      });

      // 1. Kill the silent audio element immediately.
      //    The looping silent <audio> element (volume 0.001) is the primary source
      //    of the pop on Android PWA when audio is paused — it plays even at rest.
      if (silentAudioEl) {
        silentAudioEl.volume = 0;
        silentAudioEl.pause();
        if (silentPlayHandler) {
          silentAudioEl.removeEventListener('play', silentPlayHandler);
          silentPlayHandler = null;
        }
        silentAudioEl.onplay = null; // Prevent auto-resume race
      }

      // 2. Stop the worklet processor first — it zeroes its output buffer.
      if (processorNode) processorNode.port.postMessage({ type: 'stop' });

      // 3. Ramp + wait regardless of suspended/running state.
      if (gainNode && audioContext && audioContext.state !== 'closed') {
        if (audioContext.state === 'running') {
          const now = audioContext.currentTime;
          gainNode.gain.cancelScheduledValues(now);
          gainNode.gain.setValueAtTime(gainNode.gain.value, now);
          gainNode.gain.linearRampToValueAtTime(0, now + DECLICK_DURATION_S);
        }
        await new Promise((r) => setTimeout(r, DECLICK_DURATION_S * 1000));
        try { processorNode?.disconnect(); } catch {} // AFTER ramp
      }

      // 4. Close the AudioContext — releases OS audio hardware cleanly before
      //    the browser would forcibly do so during navigation.
      if (audioContext) {
        try { await audioContext.close(); } catch {}
      }

      emitDiagnosticsEvent({
        type: 'prepare-for-reload-completed',
        label: 'Prepare for reload completed',
        timestampMs: nowMs(),
        severity: 'info',
        details: {
          audioContextState: audioContext ? audioContext.state : 'none',
          gainNodeValue: gainNode?.gain?.value ?? null,
          hiddenMediaPlaying: silentAudioEl ? !silentAudioEl.paused : false,
        },
      });
    } finally {
      appOwnedReloadInFlight = false;
    }
  }

  function registerTeardownListeners() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const handleTeardown = () => scheduleSynchronousDeclickToZero();
    window.addEventListener('pagehide', handleTeardown, { capture: true });
    window.addEventListener('beforeunload', handleTeardown, { capture: true });
  }

  registerTeardownListeners();

  function registerLifecycleListeners() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        const visible = document.visibilityState === 'visible';
        setTimeout(() => {
          saveSessionMetadataToLocalStorage();
        }, 50);
        if (visible && audioContext && audioContext.state === 'suspended') {
          audioContext.resume().catch(() => {});
        }
        emitDiagnosticsEvent({
          type: 'visibility-changed',
          label: `Document visibility changed to ${visible ? 'visible' : 'hidden'}`,
          timestampMs: nowMs(),
          severity: 'info',
          details: {
            documentVisible: visible,
            audioContextState: audioContext ? audioContext.state : 'none',
            positionMs: diagnosticsState.positionMs,
            workerPlaying: diagnosticsState.workerPlaying,
            workerEos: diagnosticsState.workerEos,
            workerReady: diagnosticsState.workerReady,
          },
        });
      });
    }

    window.addEventListener('pagehide', () => {
      saveSessionMetadataToLocalStorage();
      emitDiagnosticsEvent({
        type: 'page-hidden',
        label: 'Window pagehide event fired',
        timestampMs: nowMs(),
        severity: 'info',
        details: {
          documentVisible: typeof document !== 'undefined' ? document.visibilityState === 'visible' : true,
          audioContextState: audioContext ? audioContext.state : 'none',
          workerPlaying: diagnosticsState.workerPlaying,
        },
      });
    }, { capture: true });

    window.addEventListener('pageshow', () => {
      emitDiagnosticsEvent({
        type: 'page-shown',
        label: 'Window pageshow event fired',
        timestampMs: nowMs(),
        severity: 'info',
        details: {
          documentVisible: typeof document !== 'undefined' ? document.visibilityState === 'visible' : true,
          audioContextState: audioContext ? audioContext.state : 'none',
          workerPlaying: diagnosticsState.workerPlaying,
          positionMs: diagnosticsState.positionMs,
        },
      });
    }, { capture: true });
  }

  registerLifecycleListeners();

  function setEqBand(bandIndex, gainDb) {
    const clamped = clampGain(gainDb);
    pendingEqGains[bandIndex] = clamped;
    applyBand(eqFilterNodes, bandIndex, clamped);
  }

  function setEqPreset(presetName) {
    const gains = EQ_PRESETS[presetName] ?? EQ_PRESETS['flat'];
    pendingEqGains = [...gains];
    applyBands(eqFilterNodes, pendingEqGains);
  }

  const bridgeApi = {
    playTrack,
    playTrackStreaming,
    playTrackBounded,
    setStreamingAnchor,
    ensureMediaAlive,
    getWorkerHealthStatus,
    appendChunk,
    finalizeStream,
    transitionStreamToGapless,
    nudgeWorker,
    resetPositionHeartbeat,
    rebindWorkletNode,

    preloadNext,
    preloadNextBounded,
    seek,
    pause,
    resume,
    stop,
    forceAudioContextReset,
    prepareForReload,
    setVolume,
    setEqBand,
    setEqPreset,
    setBufferedDurationMs,
    bufferedDurationMs: () => lastKnownBufferedDurationMs,
    setOnEnded: (cb) => { onEndedCallback = cb; },
    setOnHandoffFallback: (cb) => { onHandoffFallbackCallback = cb; },
    setOnPlaybackStarted: (cb) => { onPlaybackStartedCallback = cb; },
    setOnPlaybackSuspended: (cb) => { onPlaybackSuspendedCallback = cb; },
    setOnAudioInterrupted: (cb) => { onAudioInterruptedCallback = cb; },
    getAudioContextState: () => audioContext?.state ?? 'none',
    setOnPlay: (cb) => { onPlayCallback = cb; },
    setOnPause: (cb) => { onPauseCallback = cb; },
    setOnPosition: (cb) => { onPositionCallback = cb; },
    setOnDuration: (cb) => { onDurationCallback = cb; },
    setOnNext: (cb) => { onNextCallback = cb; },
    setOnPrevious: (cb) => { onPreviousCallback = cb; },
    setOnTrackChanged: (cb) => { onTrackChangedCallback = cb; },
    setOnDiagnosticsSnapshot: (cb) => { onDiagnosticsSnapshotCallback = cb; },
    setOnDiagnosticsEvent: (cb) => { onDiagnosticsEventCallback = cb; },
    setDiagnosticsSnapshotEnabled,
    setDiagnosticsMode,
    setOnPlaybackError: (cb) => { onPlaybackErrorCallback = cb; },
    setOnPreloadError: (cb) => { onPreloadErrorCallback = cb; },
    setOnPreloadPending: (cb) => { onPreloadPendingCallback = cb; },
    setOnSeek: (cb) => { onSeekCallback = cb; },
    setOnStop: (cb) => { onStopCallback = cb; },
    setOnBuffering: (cb) => { onBufferingCallback = cb; },
    updatePlaybackState,
    updatePositionState,
    setNotificationKeepWhilePaused,
    updateMediaSession,
    setNextTrackMeta,
    setSessionQueue,
    getPlaybackSessionSnapshot,
    initAudio,
    initEngine: async () => { await ensureWasm(); },
    __test__: {
      beginPlaybackSession,
      setBoundedTrackAudioOnSilentElement,
      setTrackAudioOnSilentElement,
    },
  };

  if (typeof window !== 'undefined' && namespace) {
    window[namespace] = bridgeApi;
    window.jamdiscAudioBridgeController = bridgeApi;
  }

  return bridgeApi;
}
