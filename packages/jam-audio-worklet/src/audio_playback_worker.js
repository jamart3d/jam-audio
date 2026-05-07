import { createPlaybackWorkerController } from './audio_playback_worker_controller.js';
import { RangeFetchController } from './range_fetch_controller.js';

export function initPlaybackWorker({
  wasmModuleLoader,
  initializePanicHook = () => {},
  GaplessPlayerClass,
  StreamingPlayerClass,
  WindowedStreamingPlayerClass,
}) {
  let wasmReadyPromise;

  function ensureWasm() {
    if (!wasmReadyPromise) {
      wasmReadyPromise = wasmModuleLoader().then(() => {
        initializePanicHook();
      });
    }
    return wasmReadyPromise;
  }

  function formatUnhandledWorkerReason(reason) {
    if (reason instanceof Error) {
      return reason.message;
    }
    if (typeof reason === 'string') {
      return reason;
    }
    if (reason && typeof reason.message === 'string') {
      return reason.message;
    }
    return String(reason ?? 'Playback worker failed.');
  }

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: (audioBytes, sampleRate) =>
      new GaplessPlayerClass(audioBytes, sampleRate),
    createStreamingPlayer: (sampleRate) => new StreamingPlayerClass(sampleRate),
    createWindowedStreamingPlayer: (totalSize, maxWindowMb) =>
      new WindowedStreamingPlayerClass(totalSize, maxWindowMb),
    createRangeFetchController: (url, opts) => new RangeFetchController(url, opts),
    emitMessage: (message) => self.postMessage(message),
    setIntervalFn: (callback, intervalMs) => self.setInterval(callback, intervalMs),
    clearIntervalFn: (timerId) => self.clearInterval(timerId),
    performanceNow: () => performance.now(),
    nowMs: () => Math.round(performance.now()),
  });

  self.addEventListener('error', (event) => {
    self.postMessage({
      type: 'playback-error',
      message: formatUnhandledWorkerReason(event.error ?? event.message),
    });
  });

  self.addEventListener('unhandledrejection', (event) => {
    self.postMessage({
      type: 'playback-error',
      message: formatUnhandledWorkerReason(event.reason),
    });
  });

  self.onmessage = async (event) => {
    const data = event.data ?? {};
    const requestId = data.requestId;

    try {
      switch (data.type) {
        case 'playTrack':
          await ensureWasm();
          controller.playTrack(data.audioBytes, {
            pcmBuffer: data.pcmBuffer,
            stateBuffer: data.stateBuffer,
            frameCapacity: data.frameCapacity,
            sampleRate: data.sampleRate,
          });
          self.postMessage({ type: 'response', requestId });
          return;
        case 'playTrackStreaming':
          await ensureWasm();
          controller.playTrackStreaming({
            pcmBuffer: data.pcmBuffer,
            stateBuffer: data.stateBuffer,
            frameCapacity: data.frameCapacity,
            sampleRate: data.sampleRate,
          });
          self.postMessage({ type: 'response', requestId });
          return;
        case 'playTrackBounded': {
          await ensureWasm();
          const { url, totalSize, sampleRate, pcmBuffer, stateBuffer, frameCapacity } = data;
          controller.playTrackBounded(url, totalSize, sampleRate, {
            pcmBuffer,
            stateBuffer,
            frameCapacity,
            sampleRate,
          });
          self.postMessage({ type: 'response', requestId });
          return;
        }
        case 'appendChunk': {
          const result = controller.appendChunk(data.audioBytes);
          self.postMessage({ type: 'response', requestId, payload: result });
          return;
        }
        case 'finalizeStream':
          controller.finalizeStream();
          self.postMessage({ type: 'response', requestId });
          return;
        case 'preloadNext':
          controller.preloadNext(data.audioBytes);
          self.postMessage({ type: 'response', requestId });
          return;
        case 'preloadNextBounded':
          controller.preloadNextBounded(data.url, data.totalSize);
          self.postMessage({ type: 'response', requestId });
          return;
        case 'seek':
          controller.seek(data.positionMs);
          self.postMessage({ type: 'response', requestId });
          return;
        case 'stop':
          controller.stop();
          self.postMessage({ type: 'response', requestId });
          return;
        case 'nudge': {
          const status = controller.nudge();
          self.postMessage({ type: 'response', requestId, payload: status });
          return;
        }
        case 'getHealthStatus': {
          const status = controller.getHealthStatus();
          self.postMessage({ type: 'response', requestId, payload: status });
          return;
        }
        case 'setBufferedDurationMs':
          controller.setBufferedDurationMs(data.value);
          self.postMessage({ type: 'response', requestId });
          return;
        case 'bufferedDurationMs':
          self.postMessage({
            type: 'response',
            requestId,
            payload: { value: controller.bufferedDurationMs() },
          });
          return;
        default:
          self.postMessage({
            type: 'response',
            requestId,
            error: `Unknown playback worker command: ${data.type}`,
          });
      }
    } catch (error) {
      self.postMessage({
        type: 'response',
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
