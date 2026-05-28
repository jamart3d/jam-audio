import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlaybackWorkerController } from './audio_playback_worker_controller.js';

const CHANNELS = 2;

test('worklet wrapper still exports createPlaybackWorkerController', () => {
  assert.equal(typeof createPlaybackWorkerController, 'function');
});

test('gapless handoff emits an integer transition position', () => {
  const messages = [];
  let intervalCallback = null;
  let duration = 1000;
  let position = 0;
  let actualTransitionPending = false;
  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        if (actualTransitionPending) {
          position = 1005.75;
          actualTransitionPending = false;
        }
        return new Float32Array(CHANNELS * 10);
      },
      durationMs() {
        return duration;
      },
      positionMs() {
        return position;
      },
      hasEnded() {
        return false;
      },
      loadNext() {
        duration = 2200;
        return null;
      },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });

  sharedState[2] = 0;
  position = 800;
  controller.preloadNext(new Uint8Array([9]));

  intervalCallback();

  sharedState[2] = 50;
  actualTransitionPending = true;
  intervalCallback();

  assert.deepEqual(
    messages.find((message) => message.type === 'track-changed'),
    { type: 'track-changed', transitionPositionMs: 1005, durationMs: 2200 },
  );
});

test('streaming to gapless transition converts thrown decoder setup into playback-error', () => {
  const messages = [];
  let intervalCallback = null;
  let decodeCalls = 0;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => {
      throw new Error('opus handoff crash');
    },
    createStreamingPlayer: () => ({
      appendChunk() { return true; },
      durationMs() { return 120; },
      positionMs() { return 1000; },
      isReady() { return true; },
      isFinalized() { return true; },
      finalize() {},
      free() {},
      decodeFrames() {
        if (decodeCalls > 0) return null;
        decodeCalls += 1;
        return new Float32Array([0.1, 0.1]);
      },
    }),
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrackStreaming({
    pcmBuffer: new SharedArrayBuffer(8 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 8,
  });
  controller.preloadNext(new Uint8Array([9]));
  controller.finalizeStream();
  
  // First refill tick decodes frames
  intervalCallback();
  
  // Second refill tick hits result === null and attempts transition
  intervalCallback();

  assert.deepEqual(
    messages.find((message) => message.type === 'playback-error'),
    { type: 'playback-error', message: 'opus handoff crash' },
  );
});

test('preloadNext error in player.loadNext is caught and emitted as preload-error', () => {
  const messages = [];
  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      loadNext() {
        throw new Error('preload crash');
      },
      durationMs() { return 1000; },
      free() {},
    }),
    emitMessage: (message) => messages.push(message),
    setIntervalFn: () => {},
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer: new SharedArrayBuffer(8 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 8,
  });

  controller.preloadNext(new Uint8Array([9]));

  assert.deepEqual(
    messages.find((message) => message.type === 'preload-error'),
    { type: 'preload-error', message: 'preload crash' },
  );
});

test('playTrack failure emits playback-error', () => {
  const messages = [];
  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => {
      throw new Error('initial crash');
    },
    emitMessage: (message) => messages.push(message),
    setIntervalFn: () => {},
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer: new SharedArrayBuffer(8 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 8,
  });

  assert.deepEqual(
    messages.find((message) => message.type === 'playback-error'),
    { type: 'playback-error', message: 'initial crash' },
  );
});

test('streaming Opus emits duration from positionMs at end-of-stream when durationMs is always 0', () => {
  const messages = [];
  let intervalCallback = null;
  let decodeCalls = 0;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => null,
    createStreamingPlayer: () => ({
      appendChunk() { return true; },
      durationMs() { return 0; },      // Opus: total frames not in OGG headers
      positionMs() { return 30000; },  // 30 s decoded
      isReady() { return true; },
      isFinalized() { return true; },
      finalize() {},
      free() {},
      decodeFrames() {
        if (decodeCalls > 0) throw new Error('end-of-stream');
        decodeCalls += 1;
        return new Float32Array([0.1, 0.1]); // 1 stereo frame
      },
    }),
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrackStreaming({
    pcmBuffer: new SharedArrayBuffer(8 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 8,
  });
  controller.finalizeStream();
  intervalCallback();

  assert.deepEqual(
    messages.find((m) => m.type === 'duration'),
    { type: 'duration', durationMs: 30000 },
    'Should emit duration from positionMs when Opus streaming reaches end-of-stream',
  );
});

test('preloadNext emits preload-pending on successful loadNext', () => {
  const messages = [];
  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      loadNext() {
        return null; // success
      },
      durationMs() { return 1000; },
      free() {},
    }),
    emitMessage: (message) => messages.push(message),
    setIntervalFn: () => {},
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer: new SharedArrayBuffer(8 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 8,
  });

  controller.preloadNext(new Uint8Array([9]));

  assert.ok(
    messages.some((message) => message.type === 'preload-pending'),
    'Should have emitted preload-pending'
  );
});

test('reentrant session switch during decode aborts stale refill work', () => {
  const messages = [];
  let intervalCallback = null;
  let decodeCalls = 0;
  let controller;

  controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        decodeCalls += 1;
        if (decodeCalls === 1) {
          return new Float32Array([0.1, 0.1]);
        }
        controller.playTrackStreaming({
          pcmBuffer: new SharedArrayBuffer(8 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
          stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
          frameCapacity: 8,
        });
        return null;
      },
      durationMs() {
        return 1000;
      },
      positionMs() {
        return 500;
      },
      hasEnded() {
        return true;
      },
      loadNext() {
        return null;
      },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => ({
      appendChunk() {
        return false;
      },
      durationMs() {
        return 0;
      },
      positionMs() {
        return 0;
      },
      isReady() {
        return false;
      },
      isFinalized() {
        return false;
      },
      finalize() {},
      free() {},
      decodeFrames() {
        return null;
      },
    }),
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer: new SharedArrayBuffer(8 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 8,
  });

  assert.doesNotThrow(() => intervalCallback());
  assert.ok(
    messages.every((message) => message.type !== 'ended'),
    'stale refill tick should not end the replacement session',
  );
});

test('transportMute silences the processor state until transportUnmute clears it', () => {
  const pcmBuffer = new SharedArrayBuffer(32 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() { return new Float32Array(CHANNELS * 8); },
      durationMs() { return 1000; },
      positionMs() { return 0; },
      hasEnded() { return false; },
      loadNext() { return null; },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: () => {},
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 16,
    sampleRate: 48000,
  });

  controller.transportMute();
  assert.equal(sharedState[4], 1, 'STOP_INDEX should be asserted during transport mute');

  controller.transportUnmute();
  assert.equal(sharedState[4], 0, 'STOP_INDEX should be cleared during transport unmute');
});

test('late duration promotion still emits exactly one handoff', () => {
  const messages = [];
  let intervalCallback = null;
  let duration = 0;
  let position = 0;
  let tick = 0;
  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        tick += 1;
        if (tick === 1) {
          return new Float32Array(CHANNELS * 10);
        }
        if (tick === 2) {
          duration = 1000;
          position = 900;
        }
        if (tick === 3) {
          position = 1015;
        }
        return new Float32Array(CHANNELS * 10);
      },
      durationMs() { return duration; },
      positionMs() { return position; },
      hasEnded() { return false; },
      loadNext() { return null; },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });

  sharedState[2] = 50;
  intervalCallback();

  sharedState[2] = 50;
  intervalCallback();

  sharedState[2] = 50;
  intervalCallback();

  sharedState[2] = 50;
  intervalCallback();

  const handoffEvents = messages.filter(
    (message) =>
      message.type === 'diagnostics-event' &&
      message.event.type === 'track-handoff',
  );

  assert.equal(handoffEvents.length, 1);
  assert.equal(handoffEvents[0].event.signedGapMs, 15);
});

test('streaming bridge hint stays one-shot after late duration promotion', () => {
  const messages = [];
  let intervalCallback = null;
  let duration = 0;
  let position = 0;
  let tick = 0;
  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        tick += 1;
        if (tick === 1) {
          position = 1005;
        }
        if (tick === 2) {
          duration = 1000;
          position = 1015;
        }
        return new Float32Array(CHANNELS * 10);
      },
      durationMs() { return duration; },
      positionMs() { return position; },
      hasEnded() { return false; },
      loadNext() { return null; },
      seekToMs(value) { position = value; },
      free() {},
    }),
    createStreamingPlayer: () => ({
      appendChunk() { return true; },
      durationMs() { return 0; },
      positionMs() { return 900; },
      isReady() { return true; },
      isFinalized() { return false; },
      finalize() {},
      free() {},
      decodeFrames() { return new Float32Array(CHANNELS * 10); },
    }),
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrackStreaming({
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });
  controller.transitionStreamToGapless(new Uint8Array([4, 5, 6]), 1000);

  sharedState[2] = 50;
  intervalCallback();

  sharedState[2] = 50;
  intervalCallback();

  assert.equal(
    messages.filter(
      (message) =>
        message.type === 'diagnostics-event' &&
        message.event.type === 'track-handoff',
    ).length,
    1,
  );
});

test('worker emits refill-starvation diagnostic at low rate', () => {
  const messages = [];
  let intervalCallback = null;
  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        return null;
      },
      durationMs() { return 1000; },
      positionMs() { return 0; },
      hasEnded() { return false; },
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.setDiagnosticsMode('extended');

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });

  // Call the interval callback repeatedly to trigger refills that return null
  for (let i = 0; i < 15; i++) {
    intervalCallback();
  }

  const starvationEvents = messages.filter(
    (message) =>
      message.type === 'diagnostics-event' &&
      message.event.type === 'refill-starvation-diagnostic',
  );

  // Since threshold is 10, i=0..14 should trigger exactly 1 starvation event (at count 10)
  assert.equal(starvationEvents.length, 1);
  const event = starvationEvents[0].event;
  assert.equal(typeof event.framesAvailable, 'number');
  assert.equal(typeof event.bufferFillPercent, 'number');
  assert.equal(typeof event.refillGapMs, 'number');
  assert.equal(event.zeroFillRun, 10);
});

test('worker suppresses refill-starvation diagnostic during gapless EOF drain', () => {
  const messages = [];
  let intervalCallback = null;
  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        return null;
      },
      durationMs() { return 1000; },
      positionMs() { return 0; },
      hasEnded() { return true; },
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.setDiagnosticsMode('extended');

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });

  sharedState[2] = 50;

  for (let i = 0; i < 15; i++) {
    intervalCallback();
  }

  const starvationEvents = messages.filter(
    (message) =>
      message.type === 'diagnostics-event' &&
      message.event.type === 'refill-starvation-diagnostic',
  );

  assert.equal(starvationEvents.length, 0);
});

test('worker suppresses refill-starvation diagnostic during finalized streaming drain', () => {
  const messages = [];
  let intervalCallback = null;
  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => null,
    createStreamingPlayer: () => ({
      appendChunk() { return true; },
      durationMs() { return 0; },
      positionMs() { return 30000; },
      isReady() { return true; },
      isFinalized() { return true; },
      finalize() {},
      free() {},
      decodeFrames() {
        return new Float32Array(0);
      },
    }),
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.setDiagnosticsMode('extended');

  controller.playTrackStreaming({
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });
  controller.finalizeStream();

  sharedState[2] = 50;

  for (let i = 0; i < 15; i++) {
    intervalCallback();
  }

  const starvationEvents = messages.filter(
    (message) =>
      message.type === 'diagnostics-event' &&
      message.event.type === 'refill-starvation-diagnostic',
  );

  assert.equal(starvationEvents.length, 0);
});

test('worker diagnostics stay gated outside extended mode', () => {
  const messages = [];
  let intervalCallback = null;
  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        return null;
      },
      durationMs() { return 1000; },
      positionMs() { return 0; },
      hasEnded() { return false; },
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  // Set to minimal or normal
  controller.setDiagnosticsMode('normal');

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });

  // Call the interval callback repeatedly
  for (let i = 0; i < 15; i++) {
    intervalCallback();
  }

  const starvationEvents = messages.filter(
    (message) =>
      message.type === 'diagnostics-event' &&
      message.event.type === 'refill-starvation-diagnostic',
  );

  assert.equal(starvationEvents.length, 0);
});

test('hold window delays ended emission when preload arrives within 500ms', () => {
  const messages = [];
  let intervalCallback = null;
  let position = 0;

  // Simulate a gapless player that has ended (positionMs >= durationMs - tolerance)
  // and no pendingGaplessBytes initially
  let pendingBytesReady = false;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: (bytes) => {
      // Second call (from hold-window gapless path after preload arrives) succeeds
      if (pendingBytesReady) {
        return {
          decodeFrames() { return new Float32Array(2); },
          durationMs() { return 2000; },
          positionMs() { return 0; },
          hasEnded() { return false; },
          loadNext() { return null; },
          seekToMs() {},
          free() {},
        };
      }
      // First call (initial track)
      return {
        decodeFrames() {
          if (position >= 1000) {
            return null;
          }
          position += 50;
          return new Float32Array(2);
        },
        durationMs() { return 1000; },
        positionMs() { return position; },
        hasEnded() { return position >= 1000; },
        loadNext() { return null; },
        seekToMs() {},
        free() {},
      };
    },
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => Date.now(),
    nowMs: () => Date.now(),
  });

  const pcmBuffer = new SharedArrayBuffer(100 * 2 * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });

  // Drain track to end — refill until player.hasEnded()
  for (let i = 0; i < 30; i++) {
    sharedState[2] = 50; // framesAvailable
    intervalCallback();
  }

  // Simulate buffer draining to 0
  sharedState[2] = 0;
  intervalCallback();

  // At this point: player has ended, no pendingGaplessBytes
  // 'ended' must NOT have been emitted yet (hold window active)
  assert.ok(
    !messages.some((m) => m.type === 'ended'),
    'ended must not be emitted immediately when preload has not arrived',
  );

  // Simulate preload arriving during the hold window
  pendingBytesReady = true;
  controller.preloadNext(new Uint8Array([9]));

  // Run one more refill tick — hold resolves via gapless bridge
  sharedState[2] = 50;
  intervalCallback();

  // Now the gapless bridge should have fired track-changed (not ended)
  assert.ok(
    messages.some((m) => m.type === 'track-changed'),
    'track-changed must be emitted when preload arrives during hold window',
  );
  assert.ok(
    !messages.some((m) => m.type === 'ended'),
    'ended must NOT be emitted when the hold window resolved via gapless handoff',
  );
});

test('hold window falls through to ended after 500ms if preload never arrives', () => {
  const messages = [];
  let intervalCallback = null;
  let position = 0;
  let nowValue = 0;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        if (position >= 1000) {
          return null;
        }
        position += 50;
        return new Float32Array(2);
      },
      durationMs() { return 1000; },
      positionMs() { return position; },
      hasEnded() { return position >= 1000; },
      loadNext() { return null; },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
    clearIntervalFn: () => {},
    performanceNow: () => nowValue,
    nowMs: () => nowValue,
  });

  const pcmBuffer = new SharedArrayBuffer(100 * 2 * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });

  // Drain track to end
  for (let i = 0; i < 30; i++) {
    sharedState[2] = 50;
    intervalCallback();
  }

  // Simulate buffer draining to 0
  sharedState[2] = 0;
  intervalCallback();

  // Still in hold window — no ended yet
  assert.ok(
    !messages.some((m) => m.type === 'ended'),
    'ended must not fire during hold window',
  );

  // Advance time past 500ms ceiling
  nowValue = 600;

  // Trigger a refill tick after ceiling expires
  sharedState[2] = 0;
  intervalCallback();

  assert.ok(
    messages.some((m) => m.type === 'ended'),
    'ended must be emitted after hold window expires (500ms ceiling)',
  );
});

test('playTrackStreaming as transition emits track-handoff with isStreamingReinit=true', () => {
  const messages = [];
  const diagnosticsEvents = [];
  let intervalCallback = null;
  let nowValue = 1000;
  let decodeCalls = 0;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() { return new Float32Array(2); },
      durationMs() { return 1000; },
      positionMs() { return 500; },
      hasEnded() { return false; },
      loadNext() { return null; },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => ({
      appendChunk() { return true; },
      durationMs() { return 0; },
      positionMs() { return decodeCalls * 100; },
      isReady() { return true; },
      isFinalized() { return false; },
      finalize() {},
      free() {},
      decodeFrames() {
        decodeCalls += 1;
        if (decodeCalls < 5) {
          return new Float32Array(0);
        }
        return new Float32Array(2);
      },
    }),
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
    clearIntervalFn: () => {},
    performanceNow: () => nowValue,
    nowMs: () => nowValue,
  });

  const makeBuffers = () => ({
    pcmBuffer: new SharedArrayBuffer(100000 * 2 * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 100000,
  });

  // Start with gapless player (establishes prior session)
  const buffers1 = makeBuffers();
  controller.playTrack(new Uint8Array([1]), buffers1);

  // Advance time to simulate gap duration
  nowValue = 1000 + 312; // 312ms "gap"

  // Call playTrackStreaming as a track transition (prior player was active)
  const buffers2 = makeBuffers();
  controller.playTrackStreaming(buffers2);
  controller.appendChunk(new Uint8Array(0));

  // Simulate startup buffer filling — run refill ticks until playback-started fires
  const sharedState2 = new Int32Array(buffers2.stateBuffer);
  for (let i = 0; i < 20; i++) {
    sharedState2[2] = 88200 + 100; // above PLAYBACK_START_FRAMES
    nowValue += 50; // Simulate time passing during buffering
    intervalCallback();
    if (messages.filter((m) => m.type === 'playback-started').length >= 2) break;
  }

  // Check that a track-handoff diagnostics event was emitted with isStreamingReinit: true.
  // NOTE: emitDiagnosticsEvent wraps events as { type: 'diagnostics-event', event: {...} }
  // via emitMessage (confirmed in playback_worker_controller_core.js line 10-12).
  const handoffWrapper = messages.find(
    (m) => m.type === 'diagnostics-event' &&
           m.event?.type === 'track-handoff' &&
           m.event?.isStreamingReinit === true,
  );
  assert.ok(handoffWrapper !== undefined, 'track-handoff with isStreamingReinit=true must be emitted as diagnostics-event');
  assert.ok(
    typeof handoffWrapper.event.audibleLateGapMs === 'number' && handoffWrapper.event.audibleLateGapMs > 0,
    `audibleLateGapMs must be > 0, got ${handoffWrapper?.event?.audibleLateGapMs}`,
  );
});

test('playTrackStreaming on initial startup does NOT emit track-handoff', () => {
  const messages = [];
  let intervalCallback = null;
  let decodeCalls = 0;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => null,
    createStreamingPlayer: () => ({
      appendChunk() { return true; },
      durationMs() { return 0; },
      positionMs() { return decodeCalls * 100; },
      isReady() { return true; },
      isFinalized() { return false; },
      finalize() {},
      free() {},
      decodeFrames() {
        decodeCalls += 1;
        return new Float32Array(2);
      },
    }),
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  const buffers = {
    pcmBuffer: new SharedArrayBuffer(100000 * 2 * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 100000,
  };

  // Initial startup — no prior player
  controller.playTrackStreaming(buffers);
  controller.appendChunk(new Uint8Array(0));

  const sharedState = new Int32Array(buffers.stateBuffer);
  for (let i = 0; i < 20; i++) {
    sharedState[2] = 88200 + 100;
    intervalCallback();
    if (messages.some((m) => m.type === 'playback-started')) break;
  }

  const handoff = messages.find(
    (m) => m.type === 'diagnostics-event' &&
           m.event?.type === 'track-handoff' &&
           m.event?.isStreamingReinit === true,
  );
  assert.ok(handoff === undefined, 'track-handoff must NOT be emitted on initial startup');
});

test('extended diagnostics returns correct indices and heartbeat when using size 7 state buffer', () => {
  const messages = [];
  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(7 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() { return null; },
      free() {},
      positionMs() { return 0; },
      durationMs() { return 0; },
      hasEnded() { return false; },
    }),
    createStreamingPlayer: () => ({
      decodeFrames() { return null; },
      free() {},
      positionMs() { return 0; },
      durationMs() { return 0; },
      hasEnded() { return false; },
    }),
    createWindowedStreamingPlayer: null,
    createRangeFetchController: null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  // Health status with no shared state bound yet should return nulls
  let initialHealth = controller.getHealthStatus();
  assert.equal(initialHealth.readIndex, null);
  assert.equal(initialHealth.writeIndex, null);
  assert.equal(initialHealth.framesRendered, null);
  assert.equal(initialHealth.workletHeartbeatCount, null);

  // Bind buffers
  controller.playTrackStreaming({ pcmBuffer, stateBuffer, frameCapacity: 100 });

  // Set values in stateBuffer after playTrackStreaming has zeroed it
  Atomics.store(sharedState, 0, 123); // READ_INDEX
  Atomics.store(sharedState, 1, 456); // WRITE_INDEX
  Atomics.store(sharedState, 5, 789); // framesRendered
  Atomics.store(sharedState, 6, 999); // workletHeartbeatCount

  // Health status should now read the atomic values
  let health = controller.getHealthStatus();
  assert.equal(health.readIndex, 123);
  assert.equal(health.writeIndex, 456);
  assert.equal(health.framesRendered, 789);
  assert.equal(health.workletHeartbeatCount, 999);

  // Default is minimal diagnosticsMode, so minimal sync payload won't include them
  const syncMsgMinimal = messages.find(m => m.type === 'diagnostics-sync');
  assert.ok(syncMsgMinimal);
  assert.equal(syncMsgMinimal.payload.readIndex, undefined);
  assert.equal(syncMsgMinimal.payload.writeIndex, undefined);

  // Switch to extended diagnosticsMode
  controller.setDiagnosticsMode('extended');

  // Trigger transportMute which calls emitDiagnosticsSync
  messages.length = 0;
  controller.transportMute();
  const syncMsgExtended = messages.find(m => m.type === 'diagnostics-sync');
  assert.ok(syncMsgExtended);
  assert.equal(syncMsgExtended.payload.readIndex, 123);
  assert.equal(syncMsgExtended.payload.writeIndex, 456);
  assert.equal(syncMsgExtended.payload.framesRendered, 789);
  assert.equal(syncMsgExtended.payload.workletHeartbeatCount, 999);
});

test('gapless handoff: second track boundary fires track-changed for third track', () => {
  // Regression test for the double-play bug (log15.txt):
  // Track 1 (TJ, duration 1000ms) → Track 2 (MaMU, duration 800ms) → Track 3 (DEMI)
  // After the first handoff fires, JS must reset its boundary detector so
  // the second handoff can fire when MaMU ends.
  const messages = [];
  let intervalCallback = null;

  // Three Rust-internal states:
  //   phase 0: decoding TJ (returns frames, durationMs=1000, positionMs climbs to ~1000)
  //   phase 1: TJ just ended, Rust swapped active→MaMU (durationMs=800, positionMs continues from ~1000)
  //   phase 2: MaMU just ended, Rust swapped active→DEMI (durationMs=1200, positionMs continues)
  let decodePhase = 0;
  let totalPosition = 0;

  const pcmBuffer = new SharedArrayBuffer(500 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  // Seed enough frames so the buffer fill percent stays above HANDOFF_FILL_THRESHOLD_PERCENT (25%)
  Atomics.store(sharedState, 2, 300); // framesAvailable

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames(n) {
        totalPosition += 10;
        return new Float32Array(CHANNELS * n);
      },
      durationMs() {
        // Phase 0: TJ playing → returns 1000
        // Phase 1: after first internal swap → returns 800 (MaMU)
        // Phase 2: after second internal swap → returns 1200 (DEMI)
        if (decodePhase === 0) return 1000;
        if (decodePhase === 1) return 800;
        return 1200;
      },
      positionMs() {
        return totalPosition;
      },
      hasEnded() { return false; },
      loadNext() {
        // Dart calls this when preloading the next track.
        // The internal swap happens in Rust; from JS, loadNext() is a no-op result.
        return null;
      },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (msg) => messages.push(msg),
    setIntervalFn: (cb) => { intervalCallback = cb; return 1; },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  // Start track 1 (TJ, duration 1000ms).
  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 400,
    sampleRate: 48000,
  });

  // Preload track 2 (MaMU) — tells JS worker next track is ready.
  controller.preloadNext(new Uint8Array([2]));

  // Simulate refill ticks while TJ plays (position well below boundary).
  totalPosition = 500;
  Atomics.store(sharedState, 2, 300);
  intervalCallback(); // tick — no handoff yet (500 < 1000-50)

  // Simulate crossing TJ's boundary: position ≥ 1000 - TRACK_HANDOFF_TOLERANCE_MS (50).
  // At this point the Rust player has internally swapped to MaMU, so durationMs() → 800.
  totalPosition = 1005;
  decodePhase = 1; // Rust has swapped; durationMs() now returns MaMU's duration (800)
  Atomics.store(sharedState, 2, 300);
  intervalCallback(); // tick — FIRST handoff should fire

  const firstHandoff = messages.filter(m => m.type === 'track-changed');
  assert.equal(firstHandoff.length, 1, 'first track-changed must fire at TJ→MaMU boundary');

  // Preload track 3 (DEMI).
  controller.preloadNext(new Uint8Array([3]));

  // Simulate crossing MaMU's boundary.
  // TJ ended at absolute position ~1005; MaMU duration is 800ms.
  // MaMU's absolute boundary = 1005 + 800 = 1805ms.
  // At this point the Rust player has swapped to DEMI, so durationMs() → 1200.
  totalPosition = 1810;
  decodePhase = 2; // Rust has swapped; durationMs() now returns DEMI's duration (1200)
  Atomics.store(sharedState, 2, 300);
  intervalCallback(); // tick — SECOND handoff must fire

  const allHandoffs = messages.filter(m => m.type === 'track-changed');
  assert.equal(
    allHandoffs.length,
    2,
    'second track-changed must fire at MaMU→DEMI boundary (regression: was 1 before fix)',
  );
  assert.equal(allHandoffs[1].durationMs, 1200, 'second track-changed must carry DEMI duration');
});

test('gapless handoff fires for third track when new-track durationMs is 0 at boundary', () => {
  // Regression test for: when durationMs() returns 0 at handoff time (VBR MP3 /
  // Ogg without embedded duration), the boundary detector for the NEXT handoff
  // must still be armed. Without the fix, currentTrackEndPositionHandled stays
  // true and the third track-changed never fires.
  const messages = [];
  let intervalCallback = null;

  // Track A: 1000ms. Track B: duration unknown at handoff (returns 0), resolves
  // to 2000ms a couple ticks later. Track C: just needs preload to be accepted.
  let position = 0;
  let handoff1Done = false;
  let durationDiscoveryTick = 0;

  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        return new Float32Array(CHANNELS * 10);
      },
      durationMs() {
        if (!handoff1Done) return 1000;        // track A: known duration
        if (durationDiscoveryTick < 2) return 0; // track B: unknown at handoff
        return 2000;                             // track B: discovered after 2 ticks
      },
      positionMs() {
        return position;
      },
      hasEnded() {
        return false;
      },
      loadNext() {
        return null;
      },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), { pcmBuffer, stateBuffer, frameCapacity: 100 });

  // Buffer at 50 frames (above HANDOFF_FILL_THRESHOLD_PERCENT) for all handoffs.
  sharedState[2] = 50;

  // Preload track B (sets loadNext, duration stays 1000 until handoff).
  controller.preloadNext(new Uint8Array([9]));

  // Tick 1: position=0, before boundary — no track-changed.
  intervalCallback();
  assert.equal(
    messages.filter((m) => m.type === 'track-changed').length,
    0,
    'no track-changed before boundary',
  );

  // Handoff 1 (A→B): position crosses 1000ms. durationMs() returns 0 for track B.
  position = 1005;
  handoff1Done = true; // durationMs() now returns 0
  sharedState[2] = 50;
  intervalCallback();

  assert.equal(
    messages.filter((m) => m.type === 'track-changed').length,
    1,
    'handoff 1 (A→B) must fire track-changed',
  );

  // Ticks 2–3 post-handoff: durationMs still 0 (durationDiscoveryTick < 2).
  durationDiscoveryTick++;
  sharedState[2] = 50;
  intervalCallback(); // tick 2 — no second track-changed yet
  durationDiscoveryTick++;
  sharedState[2] = 50;
  intervalCallback(); // tick 3 — durationMs now returns 2000; boundary should be set to 3005

  // Tick 4: position crosses the resolved boundary (1005 + 2000 - tolerance).
  // Preload track C first so fill check passes.
  controller.preloadNext(new Uint8Array([42]));
  position = 3010;
  sharedState[2] = 50;
  intervalCallback();

  assert.equal(
    messages.filter((m) => m.type === 'track-changed').length,
    2,
    'handoff 2 (B→C) must fire after deferred duration discovery arms the boundary detector',
  );

  // A corrected duration message must be emitted once the real duration is known.
  const correctedDuration = messages.findLast(
    (m) => m.type === 'duration' && m.durationMs === 2000,
  );
  assert.ok(
    correctedDuration !== undefined,
    'corrected duration message (durationMs=2000) must be emitted when track B duration resolves',
  );
});

test('recovery-mode-entered is suppressed before startup completes but fires post-startup', () => {
  const messages = [];
  let intervalCallback = null;
  let now = 100;

  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const infinitePlayer = {
    decodeFrames() {
      return new Float32Array(0);
    },
    durationMs() { return 120000; },
    positionMs() { return 0; },
    hasEnded() { return false; },
    loadNext() { return null; },
    seekToMs() {},
    free() {},
  };

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => infinitePlayer,
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => now,
    nowMs: () => Math.round(now),
  });

  controller.playTrack(new Uint8Array([1, 2, 3]), {
    pcmBuffer: new SharedArrayBuffer(100000 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer,
    frameCapacity: 100000,
  });

  // Phase 1: startup phase — framesAvailable=0 is below CRITICAL_THRESHOLD_FRAMES (44100)
  // and startupCompleted is false.  The event must NOT fire.
  messages.length = 0;
  sharedState[2] = 0;
  intervalCallback();

  assert.ok(
    messages.every(
      (m) => !(m.type === 'diagnostics-event' && m.event?.type === 'recovery-mode-entered'),
    ),
    'recovery-mode-entered must not fire before startup completes',
  );

  // Phase 2: complete startup — raise framesAvailable to capacity (100000) to bypass refill loop.
  sharedState[2] = 100000;
  messages.length = 0;
  intervalCallback();

  // Phase 3: post-startup — drop frames back below CRITICAL_THRESHOLD_FRAMES.
  sharedState[2] = 0;
  messages.length = 0;
  intervalCallback();

  assert.ok(
    messages.some(
      (m) => m.type === 'diagnostics-event' && m.event?.type === 'recovery-mode-entered',
    ),
    'recovery-mode-entered must fire post-startup when frames drop below critical threshold',
  );
});

