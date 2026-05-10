import {
  buildSnapshot,
  createDiagnosticsState,
  pushEvent,
  pushHistoryPoint,
} from './audio_diagnostics_state.js';

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

  let wasmReadyPromise;
  let audioContext;
  let workletReadyPromise;
  let gainNode;
  let processorNode;
  let currentVolume = 1.0;
  let sharedPcmBuffer;
  let sharedStateBuffer;
  let frameCapacity = 8192;
  let playbackWorker;
  let playbackWorkerRequestId = 0;
  const pendingWorkerRequests = new Map();
  let diagnosticsSnapshotTimerId;
  let heartbeatIntervalId;
  let heartbeatLastKnownPositionSec = 0;
  let heartbeatLastKnownDurationSec = 0;
  let heartbeatPositionCapturedAtMs = 0;

  /** @type {((error: any) => void) | null} */
  let onPlaybackErrorCallback = null;
  /** @type {((error: any) => void) | null} */
  let onPreloadErrorCallback = null;
  /** @type {(() => void) | null} */
  let onPlaybackStartedCallback = null;
  /** @type {(() => void) | null} */
  let onEndedCallback = null;
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

  let diagnosticsState = createDiagnosticsState();
  let lastKnownBufferedDurationMs = 0;
  let silentAudioEl = null;
  let currentTrackBlobUrl = null;
  let isAppOwnedResumeInFlight = false;

  function ensureSilentAudio() {
    if (silentAudioEl) return;
    silentAudioEl = new Audio(silentWavUrl);
    silentAudioEl.id = `${namespace}-silent-audio`;
    silentAudioEl.loop = true;
    silentAudioEl.volume = 0.001;
    silentAudioEl.style.display = 'none';

    document.body.appendChild(silentAudioEl);

    silentAudioEl.addEventListener('play', () => {
      if (isAppOwnedResumeInFlight) {
        return;
      }
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }
    });
  }

  function setTrackAudioOnSilentElement(bytes) {
    ensureSilentAudio();
    if (currentTrackBlobUrl) {
      URL.revokeObjectURL(currentTrackBlobUrl);
      currentTrackBlobUrl = null;
    }
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    currentTrackBlobUrl = URL.createObjectURL(blob);

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
    if (currentTrackBlobUrl) {
      URL.revokeObjectURL(currentTrackBlobUrl);
      currentTrackBlobUrl = null;
    }
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    currentTrackBlobUrl = URL.createObjectURL(blob);

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
    if (currentTrackBlobUrl) {
      URL.revokeObjectURL(currentTrackBlobUrl);
      currentTrackBlobUrl = null;
    }

    emitDiagnosticsEvent({
      type: 'hidden-media-asset-ready',
      label: 'Hidden media asset ready (url)',
      timestampMs: nowMs(),
      severity: 'info',
      details: {
        source: 'url',
        url: url,
      },
    });
  }

  function clampVolume(value) {
    return Math.min(1, Math.max(0, value));
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
    pushEvent(diagnosticsState, event);
    if (typeof onDiagnosticsEventCallback === 'function') {
      onDiagnosticsEventCallback(JSON.stringify(event));
    }
  }

  function emitDiagnosticsSnapshot() {
    if (typeof onDiagnosticsSnapshotCallback !== 'function') {
      return;
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
        } catch (_) {}
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

  async function ensureAudioGraph() {
    if (!audioContext) {
      setStartupPhase('initializing audio graph');
      audioContext = new AudioContext();
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
      gainNode.gain.value = currentVolume;
      gainNode.connect(audioContext.destination);
    }

    if (!processorNode) {
      processorNode = new AudioWorkletNode(audioContext, 'jam-audio-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [CHANNELS],
      });
      processorNode.connect(gainNode);
      processorNode.port.onmessage = (event) => {
        if (event.data.type === 'underrun') {
          diagnosticsState.underrunCount =
            event.data.underrunCount ?? diagnosticsState.underrunCount + 1;
          emitDiagnosticsEvent({
            type: 'underrun',
            label: 'Underrun',
            timestampMs: nowMs(),
            severity: 'error',
            framesAvailable:
              event.data.framesAvailable ?? diagnosticsState.framesAvailable,
            bufferFillPercent: diagnosticsState.bufferFillPercent,
          });
        } else if (event.data.type === 'position') {
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
  }

  function createSharedBuffers() {
    const wasm = window.wasm_bindgen;
    frameCapacity = (wasm && wasm.defaultRingBufferFrames) ? wasm.defaultRingBufferFrames() : 524288;
    sharedPcmBuffer = new SharedArrayBuffer(
      frameCapacity * CHANNELS * Float32Array.BYTES_PER_ELEMENT,
    );
    sharedStateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5);
    diagnosticsState.framesAvailable = 0;
    diagnosticsState.frameCapacity = frameCapacity;
    diagnosticsState.bufferFillPercent = 0;
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
    worker.postMessage({ type, requestId, ...payload });
    return new Promise((resolve, reject) => {
      pendingWorkerRequests.set(requestId, { resolve, reject });
    });
  }

  function handlePlaybackWorkerMessage(event) {
    const data = event.data ?? {};
    switch (data.type) {
      case 'response': {
        const pending = pendingWorkerRequests.get(data.requestId);
        if (!pending) return;
        pendingWorkerRequests.delete(data.requestId);
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
        if (typeof onPlaybackStartedCallback === 'function') onPlaybackStartedCallback();
        markPlaybackState('playing');
        setStartupPhase('playing');
        return;
      case 'position':
        diagnosticsState.decodedPositionMs = data.positionMs;
        return;
      case 'duration':
        if (typeof onDurationCallback === 'function') onDurationCallback(data.durationMs);
        return;
      case 'track-changed':
        if (typeof onTrackChangedCallback === 'function') onTrackChangedCallback();
        return;
      case 'ended':
        if (typeof onEndedCallback === 'function') onEndedCallback();
        return;
      case 'playback-error':
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
      default:
        return;
    }
  }

  async function initAudio() {
    ensureCrossOriginIsolation();
    ensureSilentAudio();
    silentAudioEl.play().catch((err) => {
      emitDiagnosticsEvent({
        type: 'silent-audio-play-failed',
        label: 'Silent audio play failed',
        timestampMs: nowMs(),
        severity: 'warn',
        error: err?.message,
      });
    });

    if (!audioContext) {
      setStartupPhase('initializing audio graph');
      audioContext = new AudioContext();
      emitDiagnosticsEvent({
        type: 'audio-context-created',
        label: 'Audio context created',
        timestampMs: nowMs(),
        severity: 'info',
        sampleRate: audioContext.sampleRate,
      });
    }

    const resumeStartedAt = performance.now();
    emitDiagnosticsEvent({
      type: 'audio-context-resume-started',
      label: 'Audio context resume started',
      timestampMs: nowMs(),
      severity: 'info',
    });
    const resumePromise = audioContext.resume();

    await ensureWasm();
    await ensureAudioGraph();

    await resumePromise;
    const durationMs = roundMs(performance.now() - resumeStartedAt);
    recordStartupTiming('audioContextResume', durationMs);
    emitDiagnosticsEvent({
      type: 'audio-context-resumed',
      label: 'Audio context resumed',
      timestampMs: nowMs(),
      severity: 'info',
      durationMs,
    });
  }

  function beginPlaybackSession() {
    stop({ preserveMediaSession: true });
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
  }

  async function playTrack(audioBytes) {
    beginPlaybackSession();
    setTrackAudioOnSilentElement(audioBytes);
    try {
      await initAudio();
      createSharedBuffers();
      setStartupPhase('creating decoder');
      await sendPlaybackWorkerCommand('playTrack', {
        audioBytes,
        pcmBuffer: sharedPcmBuffer,
        stateBuffer: sharedStateBuffer,
        frameCapacity,
        sampleRate: audioContext.sampleRate,
      });
      setStartupPhase('prebuffering');
      processorNode.port.postMessage({
        type: 'init',
        pcmBuffer: sharedPcmBuffer,
        stateBuffer: sharedStateBuffer,
        frameCapacity,
        channels: CHANNELS,
      });
    } catch (error) {
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
  }

  async function playTrackStreaming() {
    beginPlaybackSession();
    try {
      ensureCrossOriginIsolation();
      await ensureWasm();
      await ensureAudioGraph();
      gainNode.gain.value = currentVolume;
      createSharedBuffers();
      setStartupPhase('creating streaming decoder');
      await sendPlaybackWorkerCommand('playTrackStreaming', {
        pcmBuffer: sharedPcmBuffer,
        stateBuffer: sharedStateBuffer,
        frameCapacity,
        sampleRate: audioContext.sampleRate,
      });
      setStartupPhase('prebuffering');
      processorNode.port.postMessage({
        type: 'init',
        pcmBuffer: sharedPcmBuffer,
        stateBuffer: sharedStateBuffer,
        frameCapacity,
        channels: CHANNELS,
      });
    } catch (error) {
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
  }

  async function playTrackBounded(url, totalSize) {
    beginPlaybackSession();
    setBoundedTrackAudioOnSilentElement(url);
    try {
      ensureCrossOriginIsolation();
      await ensureWasm();
      await ensureAudioGraph();
      gainNode.gain.value = currentVolume;
      createSharedBuffers();
      setStartupPhase('creating streaming decoder');
      await sendPlaybackWorkerCommand('playTrackBounded', {
        url,
        totalSize,
        pcmBuffer: sharedPcmBuffer,
        stateBuffer: sharedStateBuffer,
        frameCapacity,
        sampleRate: audioContext.sampleRate,
      });
      setStartupPhase('prebuffering');
      processorNode.port.postMessage({
        type: 'init',
        pcmBuffer: sharedPcmBuffer,
        stateBuffer: sharedStateBuffer,
        frameCapacity,
        channels: CHANNELS,
      });
    } catch (error) {
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
  }

  async function appendChunk(chunk) {
    const result = await sendPlaybackWorkerCommand('appendChunk', { audioBytes: chunk });
    return {
      ready: result?.ready ?? false,
      playbackStarted: result?.playbackStarted ?? false,
    };
  }

  function finalizeStream() {
    return sendPlaybackWorkerCommand('finalizeStream');
  }

  function preloadNext(audioBytes) {
    void sendPlaybackWorkerCommand('preloadNext', { audioBytes });
  }

  function preloadNextBounded(url, totalSize) {
    void sendPlaybackWorkerCommand('preloadNextBounded', { url, totalSize });
  }

  function seek(positionMs) {
    diagnosticsState.transitionGapMs = null;
    diagnosticsState.positionMs = positionMs;
    if (typeof onPositionCallback === 'function') {
      onPositionCallback(positionMs);
    }
    void sendPlaybackWorkerCommand('seek', { positionMs }).catch((error) => {
      if (typeof onPlaybackErrorCallback === 'function') {
        onPlaybackErrorCallback(error instanceof Error ? error.message : String(error));
      }
    });
  }

  async function pause() {
    if (audioContext) {
      if (gainNode && audioContext.state === 'running') {
        const now = audioContext.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(gainNode.gain.value, now);
        gainNode.gain.linearRampToValueAtTime(0, now + DECLICK_DURATION_S);
        await new Promise((resolve) => setTimeout(resolve, DECLICK_DURATION_S * 1000));
      }
      await audioContext.suspend();
      markPlaybackState('paused');
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      emitDiagnosticsEvent({ type: 'pause', label: 'Paused', timestampMs: nowMs(), severity: 'info' });
    }
  }

  async function resume() {
    if (audioContext) {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      isAppOwnedResumeInFlight = true;
      try {
        if (gainNode) {
          const now = audioContext.currentTime;
          gainNode.gain.cancelScheduledValues(now);
          gainNode.gain.setValueAtTime(0, now);
        }
        if (audioContext.state === 'suspended') await audioContext.resume();
        if (silentAudioEl) {
          try { await silentAudioEl.play(); } catch (e) { console.warn(`[${namespace}] silentAudioEl.play() failed:`, e); }
        }
        if (gainNode) {
          const now = audioContext.currentTime;
          gainNode.gain.linearRampToValueAtTime(currentVolume, now + DECLICK_DURATION_S);
        }
      } catch (e) {
        console.error(`[${namespace}] audioContext.resume() failed:`, e);
      } finally {
        isAppOwnedResumeInFlight = false;
      }
      markPlaybackState('playing');
      if (playbackWorker) void sendPlaybackWorkerCommand('nudge').catch(() => {});
      emitDiagnosticsEvent({ type: 'resume', label: 'Resumed', timestampMs: nowMs(), severity: 'info' });
    }
  }

  async function getWorkerHealthStatus() {
    if (!playbackWorker) {
      return {
        framesAvailable: 0,
        decoderReady: false,
        endOfStream: false,
        pendingSeek: false,
      };
    }
    return await sendPlaybackWorkerCommand('getHealthStatus');
  }

  function stop(options = {}) {
    const { preserveMediaSession = false } = options;
    if (processorNode) processorNode.port.postMessage({ type: 'stop' });
    if (playbackWorker) void sendPlaybackWorkerCommand('stop').catch(() => {});
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
        // [MODIFIED] Retain the hidden media anchor while paused.
        // Browsers like Android Chrome dismiss the media session if the anchor is paused.
        ensureSilentAudio();
        if (silentAudioEl.paused) silentAudioEl.play().catch(() => {});
      } else if (mapped === 'none') {
        if (!preserveMediaSession && silentAudioEl && !silentAudioEl.paused) {
          silentAudioEl.pause();
          silentAudioEl.currentTime = 0;
        }
      }
    }
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
    } catch (_) {}
  }

  function updateMediaSession(title, artist, album, artworkUrl) {
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
      runMediaAction('play', () => {
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

    if (audioContext && audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
      } catch (err) {
        emitDiagnosticsEvent({
          type: 'audio-context-ensure-resume-failed',
          label: 'Audio context ensure resume failed',
          timestampMs: nowMs(),
          severity: 'warn',
          message: err?.message ?? String(err),
        });
      }
    }

    audioContextState = audioContext?.state ?? 'missing';
    return { hiddenMediaPlaying, audioContextState, hiddenMediaError };
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

    preloadNext,
    preloadNextBounded,
    seek,
    pause,
    resume,
    stop,
    setVolume,
    setBufferedDurationMs,
    bufferedDurationMs: () => lastKnownBufferedDurationMs,
    setOnEnded: (cb) => { onEndedCallback = cb; },
    setOnPlaybackStarted: (cb) => { onPlaybackStartedCallback = cb; },
    setOnPlay: (cb) => { onPlayCallback = cb; },
    setOnPause: (cb) => { onPauseCallback = cb; },
    setOnPosition: (cb) => { onPositionCallback = cb; },
    setOnDuration: (cb) => { onDurationCallback = cb; },
    setOnNext: (cb) => { onNextCallback = cb; },
    setOnPrevious: (cb) => { onPreviousCallback = cb; },
    setOnTrackChanged: (cb) => { onTrackChangedCallback = cb; },
    setOnDiagnosticsSnapshot: (cb) => { onDiagnosticsSnapshotCallback = cb; },
    setOnDiagnosticsEvent: (cb) => { onDiagnosticsEventCallback = cb; },
    setOnPlaybackError: (cb) => { onPlaybackErrorCallback = cb; },
    setOnPreloadError: (cb) => { onPreloadErrorCallback = cb; },
    setOnSeek: (cb) => { onSeekCallback = cb; },
    setOnStop: (cb) => { onStopCallback = cb; },
    updatePlaybackState,
    updatePositionState,
    updateMediaSession,
    initAudio,
    initEngine: async () => { await ensureWasm(); },
  };

  if (typeof window !== 'undefined' && namespace) {
    window[namespace] = bridgeApi;
  }

  return bridgeApi;
}
