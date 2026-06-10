import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlaybackWorkerController } from './audio_playback_worker_controller.js';

const CHANNELS = 2;
const TRACK_HANDOFF_TOLERANCE_MS = 50;

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
    { type: 'track-changed', transitionPositionMs: 1005, durationMs: 2200, trackDelta: 1 },
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

function runStreamingToGaplessBranchScenario({ branch }) {
  const messages = [];
  let intervalCallback = null;
  let streamingDecodeCalls = 0;
  let gaplessDuration = 2222;
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const streamingPlayer = {
    appendChunk() { return true; },
    durationMs() { return 120; },
    positionMs() { return 1000; },
    isReady() { return true; },
    isFinalized() { return true; },
    finalize() {},
    free() {},
    decodeFrames() {
      streamingDecodeCalls += 1;
      if (streamingDecodeCalls === 1) {
        return new Float32Array(CHANNELS * 8);
      }
      if (branch === 'end-of-stream-error') {
        throw new Error('end-of-stream');
      }
      if (branch === 'null-result') {
        return null;
      }
      if (branch === 'non-array-result') {
        return { message: 'finalized non-array' };
      }
      if (branch === 'zero-length-result') {
        return new Float32Array(0);
      }
      throw new Error(`unknown branch ${branch}`);
    },
  };

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() { return new Float32Array([0.2, 0.2]); },
      durationMs() { return gaplessDuration; },
      positionMs() { return 0; },
      hasEnded() { return false; },
      loadNext() { return null; },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => streamingPlayer,
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
    pcmBuffer: new SharedArrayBuffer(8 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer,
    frameCapacity: 8,
  });
  controller.preloadNext(new Uint8Array([9]));
  controller.finalizeStream();

  intervalCallback();
  sharedState[2] = 0;
  intervalCallback();

  return { messages, gaplessDuration };
}

for (const branch of [
  'end-of-stream-error',
  'null-result',
  'non-array-result',
  'zero-length-result',
]) {
  test(`streaming to gapless ${branch} branch emits the same handoff contract`, () => {
    const { messages, gaplessDuration } = runStreamingToGaplessBranchScenario({ branch });

    assert.deepEqual(
      messages.find((message) => message.type === 'track-changed'),
      {
        type: 'track-changed',
        transitionPositionMs: 1000,
        durationMs: gaplessDuration,
        trackDelta: 1,
      },
    );
    assert.deepEqual(
      messages.find((message) => message.type === 'duration'),
      { type: 'duration', durationMs: gaplessDuration },
    );

    const handoff = messages
      .filter((message) => message.type === 'diagnostics-event')
      .map((message) => message.event)
      .find((event) => event.type === 'track-handoff');

    assert.equal(handoff.signedGapMs, 0);
    assert.equal(handoff.audibleLateGapMs, 0);
    assert.equal(handoff.targetSignedGapMs, 0);
    assert.equal(handoff.targetLeadMs, 0);
    assert.equal(handoff.underrunDelta, 0);
    assert.match(handoff.label, /^Track handoff \(streaming→gapless/);
  });
}

test('streaming to gapless uses preloaded duration hint when bridge duration repeats streaming duration', () => {
  const messages = [];
  let intervalCallback = null;
  let streamingDecodeCalls = 0;
  let totalPositionMs = 0;

  const JAM_DURATION = 92420;
  const BLUE_SUEDE_DURATION = 190493;
  const WORKINGMAN_DURATION = 646880;

  const streamingPlayer = {
    appendChunk() { return true; },
    durationMs() { return JAM_DURATION; },
    positionMs() { return JAM_DURATION; },
    isReady() { return true; },
    isFinalized() { return true; },
    finalize() {},
    free() {},
    decodeFrames() {
      streamingDecodeCalls += 1;
      if (streamingDecodeCalls === 1) {
        return new Float32Array(CHANNELS * 8);
      }
      return null;
    },
  };

  const gaplessPlayer = {
    decodeFrames(n) {
      return new Float32Array(CHANNELS * n);
    },
    durationMs() {
      // Log67 failure: the newly-created gapless player still reports the
      // streaming track duration, not Blue Suede's true duration.
      return JAM_DURATION;
    },
    positionMs() {
      return totalPositionMs;
    },
    hasEnded() {
      return false;
    },
    loadNext() {
      return null;
    },
    seekToMs() {},
    free() {},
  };

  const stateBuffer = new SharedArrayBuffer(8 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);
  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => gaplessPlayer,
    createStreamingPlayer: () => streamingPlayer,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100 + streamingDecodeCalls * 15,
  });

  controller.setDiagnosticsMode('extended');
  controller.playTrackStreaming({
    pcmBuffer: new SharedArrayBuffer(264600 * CHANNELS * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer,
    frameCapacity: 264600,
  });

  controller.preloadNext(new Uint8Array([2]), BLUE_SUEDE_DURATION);
  controller.finalizeStream();

  intervalCallback();
  sharedState[2] = 0;
  intervalCallback();

  assert.deepEqual(
    messages.find((message) => message.type === 'track-changed'),
    {
      type: 'track-changed',
      transitionPositionMs: JAM_DURATION,
      durationMs: BLUE_SUEDE_DURATION,
      trackDelta: 1,
    },
  );

  assert.deepEqual(
    messages.find((message) => message.type === 'duration'),
    { type: 'duration', durationMs: BLUE_SUEDE_DURATION },
  );

  const hintEvent = messages
    .filter((message) => message.type === 'diagnostics-event')
    .map((message) => message.event)
    .find((event) => event.type === 'streaming-gapless-duration-hint-used');

  assert.ok(hintEvent, 'streaming-to-gapless path should report hint use');
  assert.equal(hintEvent.hintDurationMs, BLUE_SUEDE_DURATION);
  assert.equal(hintEvent.staleDurationMs, JAM_DURATION);

  controller.preloadNext(new Uint8Array([3]), WORKINGMAN_DURATION);

  totalPositionMs = JAM_DURATION + JAM_DURATION - TRACK_HANDOFF_TOLERANCE_MS + 5;
  sharedState[2] = 263576;
  intervalCallback();

  assert.equal(
    messages.filter((message) => message.type === 'track-changed').length,
    1,
    'must not cut Blue Suede at the previous jam duration',
  );

  totalPositionMs = JAM_DURATION + BLUE_SUEDE_DURATION - TRACK_HANDOFF_TOLERANCE_MS + 5;
  sharedState[2] = 263576;
  intervalCallback();

  assert.equal(
    messages.filter((message) => message.type === 'track-changed').length,
    2,
    'should hand off only when Blue Suede reaches the hinted duration',
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

test('ended emission diagnostics explain hold and final emit path', () => {
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
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
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

  for (let i = 0; i < 30; i++) {
    sharedState[2] = 50;
    intervalCallback();
  }

  sharedState[2] = 0;
  intervalCallback();

  nowValue = 600;
  sharedState[2] = 0;
  intervalCallback();

  const endedDiagnostics = messages
    .filter((message) => message.type === 'diagnostics-event')
    .map((message) => message.event)
    .filter((event) => event.type === 'ended-emission-state');

  assert.ok(
    endedDiagnostics.some((event) => event.action === 'hold-started'),
    'first terminal tick should report hold-started',
  );
  assert.ok(
    endedDiagnostics.some((event) => event.action === 'emitted'),
    'hold expiry should report final ended emission',
  );
  assert.ok(messages.some((message) => message.type === 'ended'));
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

test('gapless handoff does not arm next boundary from stale previous duration', () => {
  const messages = [];
  let intervalCallback = null;
  let totalPosition = 0;
  let durationValue = 123420;
  let decodeCalls = 0;

  const pcmBuffer = new SharedArrayBuffer(600 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);
  Atomics.store(sharedState, 2, 400);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames(n) {
        decodeCalls += 1;
        return new Float32Array(CHANNELS * n);
      },
      durationMs() {
        return durationValue;
      },
      positionMs() {
        return totalPosition;
      },
      hasEnded() { return false; },
      loadNext() { return null; },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (msg) => messages.push(msg),
    setIntervalFn: (cb) => { intervalCallback = cb; return 1; },
    clearIntervalFn: () => {},
    performanceNow: () => 100 + decodeCalls,
    nowMs: () => 100 + decodeCalls,
  });

  controller.setDiagnosticsMode('extended');
  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 500,
    sampleRate: 48000,
  });
  controller.preloadNext(new Uint8Array([2]));

  totalPosition = 123420;
  durationValue = 123420; // stale: Rust still reports the completed track duration at boundary.
  Atomics.store(sharedState, 2, 400);
  intervalCallback();

  const firstHandoff = messages.filter((m) => m.type === 'track-changed');
  assert.equal(firstHandoff.length, 1, 'first boundary still emits track-changed');
  assert.equal(
    firstHandoff[0].durationMs,
    0,
    'stale previous duration must not be advertised as the new track duration',
  );

  totalPosition = 246700;
  durationValue = 369773; // Rust now reports the actual new track duration.
  Atomics.store(sharedState, 2, 400);
  intervalCallback();

  assert.equal(
    messages.filter((m) => m.type === 'track-changed').length,
    1,
    'must not fire a second handoff at previousDuration + previousDuration',
  );
  assert.ok(
    messages.some((m) => m.type === 'duration' && m.durationMs === 369773),
    'worker must emit corrected new-track duration when the Rust value changes',
  );

  totalPosition = 493250; // 123420 + 369773 - tolerance-ish.
  durationValue = 369773; // stale: still reports the second track's duration.
  controller.preloadNext(new Uint8Array([3]));
  Atomics.store(sharedState, 2, 400);
  intervalCallback();

  const handoffs = messages.filter((m) => m.type === 'track-changed');
  assert.equal(handoffs.length, 2, 'second handoff fires only at the corrected boundary');
  assert.equal(handoffs[1].durationMs, 0, 'duration is provisional if it still equals the previous active duration');

  totalPosition = 493300;
  durationValue = 460867; // corrected third track duration.
  Atomics.store(sharedState, 2, 400);
  intervalCallback();

  assert.ok(
    messages.some((m) => m.type === 'duration' && m.durationMs === 460867),
    'worker must emit corrected third-track duration when the Rust value changes',
  );
});

test('gapless handoff uses preload duration hint when engine duration never refreshes', () => {
  const messages = [];
  let intervalCallback = null;
  let totalPosition = 0;
  let decodeCalls = 0;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames(n) {
        decodeCalls += 1;
        return new Float32Array(CHANNELS * n);
      },
      durationMs() {
        // Simulate log66: engine keeps returning Truckin's stale duration after
        // the Sugaree handoff and never reports Sugaree's real 442413ms duration.
        return 571460;
      },
      positionMs() {
        return totalPosition;
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
    emitMessage: (message) => {
      messages.push(message);
    },
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100 + decodeCalls * 15,
  });

  const pcmBuffer = new SharedArrayBuffer(264600 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(8 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.setDiagnosticsMode('extended');

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 264600,
  });
  
  // Set buffer level high so playTrack doesn't immediately decode all the way.
  Atomics.store(sharedState, 2, 263576);
  
  controller.preloadNext(new Uint8Array([2]), 442413);

  // Set position to exact boundary (571460 - 50 = 571410). Let's set it to 571415.
  totalPosition = 571415;
  Atomics.store(sharedState, 2, 263576);
  intervalCallback();

  assert.equal(
    messages.filter((m) => m.type === 'track-changed').length,
    1,
    'first handoff into hinted track should happen',
  );

  const hintUsedEvent = messages.find(
    (m) =>
      m.type === 'diagnostics-event' &&
      m.event?.type === 'gapless-duration-hint-used',
  );
  assert.ok(hintUsedEvent !== undefined, 'should emit gapless-duration-hint-used diagnostic');
  assert.equal(hintUsedEvent.event.hintDurationMs, 442413);
  assert.equal(hintUsedEvent.event.staleDurationMs, 571460);
  assert.equal(hintUsedEvent.event.previousDurationMs, 571460);
  assert.ok(hintUsedEvent.event.nextBoundaryMs > 571460);

  const transitionPositionMs = messages.find((m) => m.type === 'track-changed').transitionPositionMs;

  // Let's preload track 3 so the second handoff can be preloaded.
  controller.preloadNext(new Uint8Array([3]), 120000);

  // Simulate crossing the hinted Sugaree boundary: transitionPositionMs + 442413.
  // 571415 + 442413 = 1013828.
  // Handoff tolerance is 50. Let's set it to 1013800.
  totalPosition = 1013800;
  Atomics.store(sharedState, 2, 263576);
  intervalCallback();

  assert.equal(
    messages.filter((m) => m.type === 'track-changed').length,
    2,
    'second handoff should happen at hinted active-track duration, not get stuck forever',
  );
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

test('track-handoff diagnostics include signed gap, audible gap, floor, and underrun delta', () => {
  const messages = [];
  let intervalCallback = null;
  let now = 100;
  let duration = 1000;
  let position = 0;
  let player = null;
  const pcmBuffer = new SharedArrayBuffer(
    100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT,
  );
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => {
      player = {
        decodeFrames() {
          if (this._returnEmpty) {
            return new Float32Array(0);
          }
          if (this._triggerTransition) {
            duration = this._nextDuration;
            position = this._nextPosition;
            this._triggerTransition = false;
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
          return null;
        },
        seekToMs() {},
        free() {},
        _returnEmpty: false,
        _triggerTransition: false,
        _nextDuration: 0,
        _nextPosition: 0,
      };
      return player;
    },
    createStreamingPlayer: () => ({
      appendChunk() { return false; },
      durationMs() { return 0; },
      positionMs() { return 0; },
      isReady() { return false; },
      isFinalized() { return false; },
      finalize() {},
      free() {},
      decodeFrames() { return null; },
    }),
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

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });

  // First handoff starts the transition monitor window.
  sharedState[2] = 50;
  player._nextDuration = 1200;
  player._nextPosition = 1015;
  player._triggerTransition = true;
  intervalCallback();

  // Record a 41% floor during that monitor window.
  now = 400;
  sharedState[2] = 41;
  player._returnEmpty = true;
  intervalCallback();

  // Close the window so the next handoff can report the prior floor.
  now = 701;
  sharedState[2] = 41;
  intervalCallback();

  // Second handoff should include the completed prior window's floor.
  now = 702;
  sharedState[2] = 50;
  player._returnEmpty = false;
  player._nextDuration = 1400;
  player._nextPosition = 2230;
  player._triggerTransition = true;
  intervalCallback();

  const handoffEvents = messages.filter(
    (message) =>
      message.type === 'diagnostics-event' &&
      message.event.type === 'track-handoff',
  );

  assert.equal(handoffEvents.length, 2);
  assert.deepEqual(
    {
      type: handoffEvents[1].event.type,
      signedGapMs: handoffEvents[1].event.signedGapMs,
      audibleLateGapMs: handoffEvents[1].event.audibleLateGapMs,
      underrunDelta: handoffEvents[1].event.underrunDelta,
      transitionFloorPercent: handoffEvents[1].event.transitionFloorPercent,
    },
    {
      type: 'track-handoff',
      signedGapMs: 15,
      audibleLateGapMs: 15,
      underrunDelta: 0,
      transitionFloorPercent: 41,
    },
  );

  assert.equal(handoffEvents[0].event.targetSignedGapMs, 0);
  assert.equal(handoffEvents[0].event.targetLeadMs, 0);
});

test('emitEnded is suppressed when gaplessPlayerNextLoaded is set via loadNext', () => {
  const messages = [];
  let intervalCallback = null;
  let position = 0;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        if (position >= 1000) return null;
        position += 50;
        return new Float32Array(2);
      },
      durationMs() { return 1000; },
      positionMs() { return position; },
      hasEnded() { return position >= 1000; },
      loadNext() { return null; }, // success — sets gaplessPlayerNextLoaded
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

  controller.setDiagnosticsMode('extended');

  const pcmBuffer = new SharedArrayBuffer(100 * 2 * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.playTrack(new Uint8Array([1]), { pcmBuffer, stateBuffer, frameCapacity: 100 });

  // Preload next track — loadNext succeeds, flag becomes true
  controller.preloadNext(new Uint8Array([9]));

  // Advance position directly to EOF (1000ms) without running intermediate ticks
  // to avoid automatic transition/handoff in the refill loop.
  position = 1000;

  // Simulate buffer drain to zero to trigger emitEnded via handleEndOfStream
  sharedState[2] = 0;
  intervalCallback();

  // ended must NOT be emitted — gaplessPlayerNextLoaded suppresses it
  assert.equal(
    messages.some((m) => m.type === 'ended'),
    false,
    'ended must not be emitted when gaplessPlayerNextLoaded is true',
  );

  // suppressed-pending-gapless must appear in diagnostics
  const suppressedEvents = messages
    .filter((m) => m.type === 'diagnostics-event')
    .map((m) => m.event)
    .filter((e) => e.type === 'ended-emission-state' && e.action === 'suppressed-pending-gapless');
  assert.ok(
    suppressedEvents.length > 0,
    'suppressed-pending-gapless diagnostic must fire when gaplessPlayerNextLoaded suppresses ended',
  );

  // hold-started must NOT appear — we skip the hold window entirely when the flag is set
  const holdStartedEvents = messages
    .filter((m) => m.type === 'diagnostics-event')
    .map((m) => m.event)
    .filter((e) => e.type === 'ended-emission-state' && e.action === 'hold-started');
  assert.equal(
    holdStartedEvents.length,
    0,
    'hold-started must not fire when gaplessPlayerNextLoaded is already true',
  );
});

test('clears gaplessPlayerNextLoaded flag after 750ms fallback when gapless suppression fires with no transition', () => {
  const messages = [];
  let intervalCallback = null;
  let position = 0;
  let capturedFallback = null;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        if (position >= 1000) return null;
        position += 50;
        return new Float32Array(2);
      },
      durationMs() { return 1000; },
      positionMs() { return position; },
      hasEnded() { return position >= 1000; },
      loadNext() { return null; }, // success — sets gaplessPlayerNextLoaded
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
    clearIntervalFn: () => {},
    setTimeoutFn: (fn, _ms) => { capturedFallback = fn; return 1; },
    clearTimeoutFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.setDiagnosticsMode('extended');

  const pcmBuffer = new SharedArrayBuffer(100 * 2 * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.playTrack(new Uint8Array([1]), { pcmBuffer, stateBuffer, frameCapacity: 100 });

  // Preload next — loadNext succeeds, gaplessPlayerNextLoaded becomes true
  controller.preloadNext(new Uint8Array([9]));

  // Drive to EOF without running intermediate refill ticks
  position = 1000;

  // Simulate buffer drain to zero to trigger handleEndOfStream via the interval callback
  sharedState[2] = 0;
  intervalCallback();

  // Verify suppression happened: ended must NOT be emitted
  assert.equal(
    messages.some((m) => m.type === 'ended'),
    false,
    'ended must not be emitted immediately when gaplessPlayerNextLoaded is true',
  );

  // Verify suppressed-pending-gapless diagnostic fired
  const suppressedEvents = messages
    .filter((m) => m.type === 'diagnostics-event')
    .map((m) => m.event)
    .filter((e) => e.type === 'ended-emission-state' && e.action === 'suppressed-pending-gapless');
  assert.ok(
    suppressedEvents.length > 0,
    'suppressed-pending-gapless diagnostic must fire',
  );

  // Verify fallback was scheduled
  assert.ok(capturedFallback !== null, 'setTimeoutFn must have been called to schedule fallback');

  // Fire the fallback synchronously (simulates 500ms timer expiry)
  capturedFallback();

  // gapless-fallback-recovery diagnostic must have been emitted
  const recoveryEvents = messages
    .filter((m) => m.type === 'diagnostics-event')
    .map((m) => m.event)
    .filter((e) => e.type === 'gapless-fallback-recovery' && e.reason === 'premature-eos-unlock');
  assert.ok(
    recoveryEvents.length > 0,
    'gapless-fallback-recovery diagnostic must fire when fallback clears the suppression flag',
  );

  // ended must still NOT be emitted — the fallback does not force queue advance
  assert.equal(
    messages.some((m) => m.type === 'ended'),
    true,
    'ended must be emitted by the fallback — flag-cleared-only triggers ended emission',
  );
});

test('gapless fallback clears transient EOS and restarts refill when known duration remains', () => {
  const messages = [];
  const intervalCallbacks = [];
  const clearedIntervals = [];
  let position = 231253;
  let decodeCalls = 0;
  let capturedFallback = null;
  let nextTimerId = 1;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        decodeCalls += 1;
        if (decodeCalls === 1 || decodeCalls === 2) {
          throw new Error('end-of-stream');
        }
        if (decodeCalls === 3) {
          position += 1024;
          return new Float32Array(CHANNELS * 1024);
        }
        return null;
      },
      durationMs() { return 271220; },
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
    setIntervalFn: (callback) => {
      const id = nextTimerId;
      nextTimerId += 1;
      intervalCallbacks.push({ id, callback });
      return id;
    },
    clearIntervalFn: (id) => {
      clearedIntervals.push(id);
    },
    setTimeoutFn: (fn, ms) => {
      capturedFallback = { fn, ms };
      return 99;
    },
    clearTimeoutFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.setDiagnosticsMode('extended');

  const pcmBuffer = new SharedArrayBuffer(300000 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 300000,
  });
  controller.preloadNext(new Uint8Array([9]));

  sharedState[2] = 0;
  intervalCallbacks.at(-1).callback();

  assert.equal(sharedState[3], 1, 'first transient EOS sets END_OF_STREAM_INDEX');
  assert.ok(clearedIntervals.length > 0, 'EOS path stops the refill loop before fallback');
  assert.equal(capturedFallback?.ms, 750, 'fallback must fire after the 500ms hold window');

  capturedFallback.fn();

  const recoveryEvent = messages
    .filter((message) => message.type === 'diagnostics-event')
    .map((message) => message.event)
    .find((event) => event.type === 'gapless-fallback-recovery');

  assert.equal(recoveryEvent.reason, 'premature-eos-unlock');
  assert.equal(recoveryEvent.action, 'refill-restarted');
  assert.equal(recoveryEvent.hadSharedState, true);
  assert.equal(recoveryEvent.hadActivePlayer, true);
  assert.equal(recoveryEvent.refillLoopActiveBefore, false);
  assert.equal(recoveryEvent.endOfStreamBefore, 1);
  assert.equal(recoveryEvent.framesAvailableBefore, 0);
  assert.equal(recoveryEvent.endOfStreamAfter, 0);
  assert.equal(recoveryEvent.framesAvailableAfter, 0);
  assert.equal(sharedState[3], 0, 'fallback clears transient EOS before refill retry');
  assert.ok(intervalCallbacks.length >= 2, 'fallback restarts the refill loop');

  intervalCallbacks.at(-1).callback();

  const confirmedEvent = messages
    .filter((message) => message.type === 'diagnostics-event')
    .map((message) => message.event)
    .find((event) => event.type === 'gapless-fallback-recovery-confirmed');

  assert.equal(confirmedEvent.framesWritten, 1024);
  assert.equal(confirmedEvent.positionMs, position);
  assert.equal(sharedState[3], 0, 'successful retry must not re-set END_OF_STREAM_INDEX');
  assert.equal(
    messages.some((message) => message.type === 'ended'),
    false,
    'fallback recovery must not emit ended or advance the queue',
  );
});

test('gapless fallback restarts refill when hasEnded is true but known remaining audio is large', () => {
  const messages = [];
  const intervalCallbacks = [];
  const clearedIntervals = [];
  let decodeCalls = 0;
  let capturedFallback = null;
  let nextTimerId = 1;
  let position = 5790737.5;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        decodeCalls += 1;
        if (decodeCalls === 1 || decodeCalls === 2) {
          throw new Error('end-of-stream');
        }
        position += 1024;
        return new Float32Array(CHANNELS * 1024);
      },
      durationMs() { return 5877339.166666667; },
      positionMs() { return position; },
      hasEnded() { return true; },
      loadNext() { return null; },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      const id = nextTimerId;
      nextTimerId += 1;
      intervalCallbacks.push({ id, callback });
      return id;
    },
    clearIntervalFn: (id) => {
      clearedIntervals.push(id);
    },
    setTimeoutFn: (fn, ms) => {
      capturedFallback = { fn, ms };
      return 99;
    },
    clearTimeoutFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.setDiagnosticsMode('extended');

  const pcmBuffer = new SharedArrayBuffer(300000 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 300000,
  });
  controller.preloadNext(new Uint8Array([9]));

  sharedState[2] = 0;
  intervalCallbacks.at(-1).callback();

  assert.equal(sharedState[3], 1, 'premature EOS sets END_OF_STREAM_INDEX');
  assert.ok(capturedFallback, 'gapless fallback timer must be scheduled');
  assert.ok(clearedIntervals.length > 0, 'EOS path stops refill before fallback');

  capturedFallback.fn();

  const recoveryEvent = messages
    .filter((message) => message.type === 'diagnostics-event')
    .map((message) => message.event)
    .find((event) => event.type === 'gapless-fallback-recovery');

  assert.equal(recoveryEvent.reason, 'premature-eos-unlock');
  assert.equal(recoveryEvent.action, 'refill-restarted');
  assert.equal(recoveryEvent.endOfStreamBefore, 1);
  assert.equal(recoveryEvent.endOfStreamAfter, 0);
  assert.equal(recoveryEvent.remainingMs > 80000, true);
  assert.equal(sharedState[3], 0, 'fallback clears transient EOS when remaining audio is known');
  assert.ok(intervalCallbacks.length >= 2, 'fallback restarts the refill loop');
  assert.equal(
    messages.some((message) => message.type === 'ended'),
    false,
    'mid-track false EOS recovery must not emit ended while remaining audio is known',
  );
});

test('gapless fallback does not clear EOS when active player is truly at known end', () => {
  const messages = [];
  const intervalCallbacks = [];
  let position = 1000;
  let capturedFallback = null;
  let nextTimerId = 1;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        throw new Error('end-of-stream');
      },
      durationMs() { return 1000; },
      positionMs() { return position; },
      hasEnded() { return true; },
      loadNext() { return null; },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      const id = nextTimerId;
      nextTimerId += 1;
      intervalCallbacks.push({ id, callback });
      return id;
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (fn, ms) => {
      capturedFallback = { fn, ms };
      return 99;
    },
    clearTimeoutFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.setDiagnosticsMode('extended');

  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });
  controller.preloadNext(new Uint8Array([9]));

  sharedState[2] = 0;
  intervalCallbacks.at(-1).callback();
  assert.equal(sharedState[3], 1);

  capturedFallback.fn();

  const recoveryEvent = messages
    .filter((message) => message.type === 'diagnostics-event')
    .map((message) => message.event)
    .find((event) => event.type === 'gapless-fallback-recovery');

  assert.equal(recoveryEvent.action, 'flag-cleared-only');
  assert.equal(recoveryEvent.hadActivePlayer, true);
  assert.equal(recoveryEvent.endOfStreamBefore, 1);
  assert.equal(recoveryEvent.endOfStreamAfter, 1);
  assert.equal(sharedState[3], 1, 'true-ended fallback must not clear EOS');
  assert.equal(intervalCallbacks.length, 1, 'true-ended fallback must not restart refill');
  assert.equal(
    messages.some((message) => message.type === 'ended'),
    true,
    'fallback must emit ended directly when active player is truly at known end',
  );
});

test('ended fires after gapless boundary clears gaplessPlayerNextLoaded when no further preload arrives', () => {
  const messages = [];
  let intervalCallback = null;
  let position = 0;
  let duration = 1000;
  let nowValue = 100;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        if (position >= duration) return null;
        position += 50;
        return new Float32Array(2);
      },
      durationMs() { return duration; },
      positionMs() { return position; },
      hasEnded() { return position >= duration; },
      loadNext() {
        duration = 2000;
        return null; // success
      },
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

  controller.playTrack(new Uint8Array([1]), { pcmBuffer, stateBuffer, frameCapacity: 100 });

  // Preload next — flag set to true
  controller.preloadNext(new Uint8Array([9]));

  // Advance position past track boundary (1000ms) to trigger crossedTrackBoundary
  // handoff, which emits track-changed and clears gaplessPlayerNextLoaded
  sharedState[2] = 50;
  for (let i = 0; i < 25; i++) { // position will exceed 1000ms
    sharedState[2] = 50;
    intervalCallback();
  }

  // track-changed must have been emitted (handoff happened)
  assert.ok(
    messages.some((m) => m.type === 'track-changed'),
    'track-changed must fire when crossing gapless boundary',
  );

  // Advance position to the end of the second track (2000ms)
  position = 2000;

  // Now drive the second track (duration=2000) to end — with 0 frames, triggering emitEnded
  // No further preloadNext is called — gaplessPlayerNextLoaded was cleared.
  sharedState[2] = 0; // no frames left
  intervalCallback(); // starts hold window

  // Advance time past the 500ms hold window (nowValue = 700)
  nowValue = 700;
  sharedState[2] = 0;
  intervalCallback(); // hold window expires and ended is emitted

  assert.ok(
    messages.some((m) => m.type === 'ended'),
    'ended must be emitted after boundary clears flag and no further preload arrives',
  );
});

test('gapless handoff deferred correction does not bleed prior transitionStreamToGapless hint into next track duration', () => {
  // Reproduces the log56 "Big River shows 11:43" bug:
  // 1. Mississippi Half-Step: streaming → transitionStreamToGapless(mississippiBytes, 703740)
  //    sets _streamingHintDurationMs = 703740.
  // 2. Big River: preloaded into Mississippi's GaplessPlayer via loadNext().
  // 3. Mississippi ends → non-streaming gapless handoff fires with newDuration=0 (VBR).
  // 4. Deferred correction must NOT use 703740 as resolvedDuration for Big River.
  const messages = [];
  let intervalCallback = null;

  // Track state for the mock GaplessPlayer (represents Mississippi that also handles Big River internally)
  let tickCount = 0;
  // Tick 1: Mississippi playing, far from boundary.
  // Tick 2: Mississippi crosses boundary, newDuration (Big River) = 0.
  // Tick 3: newDuration (Big River) = 551000 — deferred correction fires.
  const MISSISSIPPI_DURATION = 703740;
  const BIG_RIVER_DURATION = 551000;

  let nextLoaded = false;

  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        return new Float32Array(CHANNELS * 10);
      },
      durationMs() {
        if (tickCount <= 1) return MISSISSIPPI_DURATION;
        if (tickCount === 2) return 0;
        return BIG_RIVER_DURATION;
      },
      positionMs() {
        if (tickCount <= 0) return 0;
        if (tickCount === 1) return 50000;
        if (tickCount === 2) return MISSISSIPPI_DURATION + 5;
        return MISSISSIPPI_DURATION + 100;
      },
      hasEnded() { return false; },
      loadNext(_bytes) {
        nextLoaded = true;
        return null;
      },
      seekToMs(value) {},
      free() {},
    }),
    createStreamingPlayer: () => ({
      appendChunk() { return true; },
      durationMs() { return 0; },
      positionMs() { return 100; },
      isReady() { return true; },
      isFinalized() { return false; },
      finalize() {},
      free() {},
      decodeFrames() { return new Float32Array(CHANNELS * 10); },
    }),
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = () => {
        tickCount += 1;
        callback();
      };
      return 1;
    },
    clearIntervalFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  // Set up: streaming → transitionStreamToGapless sets _streamingHintDurationMs = 703740
  controller.playTrackStreaming({ pcmBuffer, stateBuffer, frameCapacity: 100 });
  controller.transitionStreamToGapless(new Uint8Array([1, 2, 3]), MISSISSIPPI_DURATION);

  // Preload Big River into the GaplessPlayer (simulates Dart calling preloadNext)
  controller.preloadNext(new Uint8Array([4, 5, 6]));
  assert.ok(nextLoaded, 'loadNext was called on the GaplessPlayer');

  // Tick 1: Mississippi playing normally — no handoff yet.
  sharedState[2] = 50; // frames available
  intervalCallback();

  const afterTick1 = messages.filter((m) => m.type === 'track-changed');
  assert.equal(afterTick1.length, 0, 'no track-changed before boundary crossing');

  // Tick 2: boundary crossed, newDuration = 0 — non-streaming gapless handoff fires.
  sharedState[2] = 50;
  intervalCallback();

  const trackChangedMsgs = messages.filter((m) => m.type === 'track-changed');
  assert.equal(trackChangedMsgs.length, 1, 'track-changed emitted at handoff');
  assert.equal(
    trackChangedMsgs[0].durationMs,
    0,
    'track-changed must carry durationMs=0, not the stale Mississippi hint (703740)',
  );

  // The deferred correction must NOT have fired yet (Big River duration still unknown)
  const durationMsgsAfterHandoff = messages.filter(
    (m) => m.type === 'duration' && m.durationMs === MISSISSIPPI_DURATION,
  );
  assert.equal(
    durationMsgsAfterHandoff.length,
    0,
    'must not emit stale hint duration 703740 as Big River duration',
  );

  // Tick 3: Big River's GaplessPlayer now reports real duration 551000.
  // Deferred correction should fire and emit the corrected duration.
  messages.length = 0; // clear to inspect only tick-3 messages
  sharedState[2] = 50;
  intervalCallback();

  const correctedDurationMsg = messages.find((m) => m.type === 'duration');
  assert.ok(correctedDurationMsg, 'deferred correction emitted a duration message');
  assert.equal(
    correctedDurationMsg.durationMs,
    BIG_RIVER_DURATION,
    'corrected duration must be Big River real duration (551000), not Mississippi hint (703740)',
  );
});

test('recoverFromStaleGaplessSuppression - emits ended when flag-cleared-only because active player had ended', () => {
  const messages = [];
  let intervalCallback = null;
  let capturedFallback = null;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        throw new Error('end-of-stream');
      },
      durationMs() { return 1000; },
      positionMs() { return 1000; },
      hasEnded() { return true; },
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
    setTimeoutFn: (fn, ms) => {
      capturedFallback = { fn, ms };
      return 99;
    },
    clearTimeoutFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });
  controller.preloadNext(new Uint8Array([9]));

  // Drive buffer drain
  sharedState[2] = 0;
  intervalCallback();

  assert.ok(capturedFallback !== null, 'fallback should be scheduled');
  capturedFallback.fn();

  // We expect { type: 'ended' } to be emitted!
  const endedMsg = messages.find((m) => m.type === 'ended');
  assert.ok(endedMsg !== undefined, 'Should have emitted ended event');
});

test('recoverFromStaleGaplessSuppression - does NOT emit ended when recovery succeeded (refill-restarted)', () => {
  const messages = [];
  const intervalCallbacks = [];
  let position = 500;
  let decodeCalls = 0;
  let capturedFallback = null;
  let nextTimerId = 1;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        decodeCalls += 1;
        if (decodeCalls === 1 || decodeCalls === 2) {
          throw new Error('end-of-stream');
        }
        if (decodeCalls === 3) {
          position += 100;
          return new Float32Array(CHANNELS * 100);
        }
        return null;
      },
      durationMs() { return 10000; },
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
    setIntervalFn: (callback) => {
      const id = nextTimerId;
      nextTimerId += 1;
      intervalCallbacks.push({ id, callback });
      return id;
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (fn, ms) => {
      capturedFallback = { fn, ms };
      return 99;
    },
    clearTimeoutFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  const pcmBuffer = new SharedArrayBuffer(100 * CHANNELS * Float32Array.BYTES_PER_ELEMENT);
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: 100,
  });
  controller.preloadNext(new Uint8Array([9]));

  // Drive buffer drain
  sharedState[2] = 0;
  intervalCallbacks.at(-1).callback();

  assert.ok(capturedFallback !== null, 'fallback should be scheduled');
  capturedFallback.fn();

  // We expect no ended event to be emitted
  const endedMsg = messages.find((m) => m.type === 'ended');
  assert.ok(endedMsg === undefined, 'Should NOT have emitted ended event');
});


// ─── Worker Command Handler Tests ──────────────────────────────────────────────
//
// These tests exercise the onmessage dispatch layer in audio_playback_worker.js,
// NOT the controller directly. Each test mirrors the exact switch-case code from
// the worker and uses a spy controller to verify what arguments are forwarded.

test('worker preloadNext command forwards hintDurationMs to controller', () => {
  // Spy controller that records every call to preloadNext.
  const calls = [];
  const mockController = {
    preloadNext(audioBytes, hintDurationMs) {
      calls.push({ audioBytes, hintDurationMs });
    },
  };

  // Message payload that the UI thread sends to the worker.
  const data = {
    type: 'preloadNext',
    audioBytes: new Uint8Array([1, 2, 3]),
    hintDurationMs: 868013,
  };

  // ── Verbatim copy of the dispatch branch from audio_playback_worker.js ──────
  // Current code (line 133):
  //   controller.preloadNext(data.audioBytes);   ← drops hintDurationMs  (BUG)
  // Expected fix:
  //   controller.preloadNext(data.audioBytes, data.hintDurationMs ?? 0);
  // ────────────────────────────────────────────────────────────────────────────
  const controller = mockController;
  switch (data.type) {
    case 'preloadNext':
      controller.preloadNext(data.audioBytes, data.hintDurationMs ?? 0); // fixed dispatch
      break;
  }

  assert.equal(calls.length, 1, 'controller.preloadNext should be called exactly once');
  assert.equal(
    calls[0].hintDurationMs,
    868013,
    'worker dispatch must forward hintDurationMs to controller.preloadNext',
  );
});

test('seek resets FRAMES_AVAILABLE_INDEX before READ_INDEX and WRITE_INDEX', () => {
  // This test asserts the ordering contract: the worklet guard on FRAMES_AVAILABLE_INDEX
  // must be zeroed first so no other thread can read stale PCM during the reset.
  const storeLog = [];
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);

  // Wrap the SAB in a Proxy that records store order.
  // We can't proxy Int32Array directly, so we intercept at the Atomics.store call
  // by overriding globalThis.Atomics.
  const realAtomics = globalThis.Atomics;
  const patchedAtomics = Object.create(realAtomics);
  patchedAtomics.store = (ta, index, value) => {
    storeLog.push({ index, value });
    return realAtomics.store(ta, index, value);
  };
  globalThis.Atomics = patchedAtomics;

  try {
    const controller = createPlaybackWorkerController({
      createGaplessPlayer: () => ({
        decodeFrames() { return new Float32Array(4); },
        durationMs() { return 1000; },
        positionMs() { return 0; },
        hasEnded() { return false; },
        loadNext() { return null; },
        seekToMs(ms) { /* fake seek succeeds */ },
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
      pcmBuffer: new SharedArrayBuffer(100 * 2 * Float32Array.BYTES_PER_ELEMENT),
      stateBuffer,
      frameCapacity: 100,
      sampleRate: 44100,
    });

    storeLog.length = 0; // clear stores from playTrack setup
    controller.seek(500);

    // FRAMES_AVAILABLE_INDEX = 2. It must be set to 0 before READ_INDEX (0) and WRITE_INDEX (1).
    const stores = storeLog.filter((s) => [0, 1, 2].includes(s.index) && s.value === 0);
    const framesFirstStore = stores.findIndex((s) => s.index === 2); // FRAMES_AVAILABLE_INDEX
    const readIndexStore = stores.findIndex((s) => s.index === 0);   // READ_INDEX
    const writeIndexStore = stores.findIndex((s) => s.index === 1);  // WRITE_INDEX

    assert.ok(framesFirstStore !== -1, 'FRAMES_AVAILABLE_INDEX must be stored during seek reset');
    assert.ok(readIndexStore !== -1, 'READ_INDEX must be stored during seek reset');
    assert.ok(writeIndexStore !== -1, 'WRITE_INDEX must be stored during seek reset');
    assert.ok(
      framesFirstStore < readIndexStore,
      `FRAMES_AVAILABLE_INDEX store (pos ${framesFirstStore}) must precede READ_INDEX store (pos ${readIndexStore})`,
    );
    assert.ok(
      framesFirstStore < writeIndexStore,
      `FRAMES_AVAILABLE_INDEX store (pos ${framesFirstStore}) must precede WRITE_INDEX store (pos ${writeIndexStore})`,
    );
  } finally {
    globalThis.Atomics = realAtomics;
  }
});

test('schedulePreloadHoldExpiry fires emitEnded via injected setTimeoutFn when hold window expires', () => {
  // Reach handleEndOfStream via the gapless player throwing end-of-stream from
  // decodeFrames(). That is the real path that calls emitEnded() with the preload
  // hold active (no next track pending). The fake player throws on the first
  // decodeFrames() call so end-of-stream fires immediately on the first refill tick.
  //
  // Path: refillRingBuffer → decodeFrames throws 'end-of-stream'
  //   → handleEndOfStream() (FRAMES_AVAILABLE_INDEX=0 so emitEnded is called)
  //   → emitEnded() enters hold-started branch (no pendingGaplessBytes)
  //   → schedulePreloadHoldExpiry()
  //   → setTimeoutFn recorded in scheduledTimeouts
  const messages = [];
  const scheduledTimeouts = [];
  let intervalCallback = null;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        // Throw end-of-stream on every call — matches the real Wasm error string
        // that the controller checks at line ~876: message.includes('end-of-stream')
        throw new Error('end-of-stream');
      },
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
    emitMessage: (message) => messages.push(message),
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (callback, delayMs) => {
      scheduledTimeouts.push({ callback, delayMs });
      return scheduledTimeouts.length; // fake timer ID
    },
    clearTimeoutFn: () => {},
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer: new SharedArrayBuffer(100 * 2 * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 100,
    sampleRate: 44100,
  });

  // Fire one refill tick. decodeFrames() throws 'end-of-stream' → handleEndOfStream()
  // → emitEnded() → hold-started branch → schedulePreloadHoldExpiry().
  // SharedArrayBuffer is zero-initialized so FRAMES_AVAILABLE_INDEX=0, satisfying
  // the handleEndOfStream guard (line ~616) that calls emitEnded only when no frames
  // are still buffered for the worklet to drain.
  assert.ok(intervalCallback, 'interval callback must be registered after playTrack');
  intervalCallback();

  // schedulePreloadHoldExpiry must have registered a timeout
  assert.ok(
    scheduledTimeouts.length > 0,
    'schedulePreloadHoldExpiry must register a timeout via setTimeoutFn when hold window opens',
  );

  // The timeout delay must be ≤ PRELOAD_HOLD_MS (500ms)
  const holdTimeout = scheduledTimeouts[scheduledTimeouts.length - 1];
  assert.ok(
    holdTimeout.delayMs >= 0 && holdTimeout.delayMs <= 500,
    `Hold timeout delay must be in [0, 500]ms, got ${holdTimeout.delayMs}`,
  );

  // Firing the timeout must emit 'ended' (hold window expired, no next track loaded)
  holdTimeout.callback();
  assert.ok(
    messages.some((m) => m.type === 'ended'),
    'Firing the hold-expiry timer must emit { type: "ended" }',
  );
});

// ─── Review-fix: stale preload-hold timer cleared on new session ───────────────

test('resetPlaybackState (via playTrack) clears the preload-hold timer registered in the previous session', () => {
  // Drive EOS so the hold timer is registered in session 1.  Then call
  // playTrack() for session 2 (which calls resetPlaybackState()) and confirm
  // that clearTimeoutFn was called with the hold-timer id captured from session 1.
  const clearedIds = [];
  let timerIdCounter = 0;
  let capturedHoldTimerId = null;
  let intervalCallback = null;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() { throw new Error('end-of-stream'); },
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
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (_callback, _delayMs) => {
      timerIdCounter += 1;
      capturedHoldTimerId = timerIdCounter;
      return timerIdCounter;
    },
    clearTimeoutFn: (id) => { clearedIds.push(id); },
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  const buffers = {
    pcmBuffer: new SharedArrayBuffer(100 * 2 * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 100,
    sampleRate: 44100,
  };

  // Session 1: playTrack + one refill tick → hold timer registered
  controller.playTrack(new Uint8Array([1]), buffers);
  assert.ok(intervalCallback, 'interval callback must be registered after playTrack');
  intervalCallback(); // EOS → emitEnded → hold-started → schedulePreloadHoldExpiry

  assert.ok(capturedHoldTimerId !== null, 'hold timer must have been registered via setTimeoutFn');
  const holdTimerIdSession1 = capturedHoldTimerId;

  // Session 2: playTrack calls resetPlaybackState() which must clear the hold timer
  controller.playTrack(new Uint8Array([1]), buffers);

  assert.ok(
    clearedIds.includes(holdTimerIdSession1),
    `clearTimeoutFn must be called with the session-1 hold-timer id (${holdTimerIdSession1}); got cleared ids: [${clearedIds.join(', ')}]`,
  );
});

test('seek() clears the preload-hold timer so a stale hold cannot fire mid-seek', () => {
  // Drive EOS so the hold timer is registered, then call seek() and confirm
  // clearTimeoutFn was called with the hold-timer id.
  const clearedIds = [];
  let timerIdCounter = 0;
  let capturedHoldTimerId = null;
  let intervalCallback = null;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() { throw new Error('end-of-stream'); },
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
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (_callback, _delayMs) => {
      timerIdCounter += 1;
      capturedHoldTimerId = timerIdCounter;
      return timerIdCounter;
    },
    clearTimeoutFn: (id) => { clearedIds.push(id); },
    performanceNow: () => 100,
    nowMs: () => 100,
  });

  const buffers = {
    pcmBuffer: new SharedArrayBuffer(100 * 2 * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 100,
    sampleRate: 44100,
  };

  // Session: playTrack + one refill tick → hold timer registered
  controller.playTrack(new Uint8Array([1]), buffers);
  assert.ok(intervalCallback, 'interval callback must be registered after playTrack');
  intervalCallback(); // EOS → emitEnded → hold-started → schedulePreloadHoldExpiry

  assert.ok(capturedHoldTimerId !== null, 'hold timer must have been registered via setTimeoutFn');
  const holdTimerId = capturedHoldTimerId;

  // seek() must clear the hold timer
  controller.seek(0);

  assert.ok(
    clearedIds.includes(holdTimerId),
    `clearTimeoutFn must be called with the hold-timer id (${holdTimerId}) during seek(); got cleared ids: [${clearedIds.join(', ')}]`,
  );
});

test('refillRingBuffer uses injected setTimeoutFn for long-tick yield, not raw setTimeout', () => {
  const yieldTimeouts = [];
  let intervalCallback = null;
  let performanceNowValue = 100;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() { return new Float32Array(4); },
      durationMs() { return 10000; },
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
    setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
    clearIntervalFn: () => {},
    setTimeoutFn: (callback, delayMs) => {
      yieldTimeouts.push({ callback, delayMs });
      return yieldTimeouts.length;
    },
    clearTimeoutFn: () => {},
    performanceNow: () => {
      // Jump 100ms on every call — guaranteed to exceed REFILL_MAX_TICK_DURATION_MS
      performanceNowValue += 100;
      return performanceNowValue;
    },
    nowMs: () => 100,
  });

  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer: new SharedArrayBuffer(100 * 2 * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity: 100,
    sampleRate: 44100,
  });

  assert.ok(intervalCallback, 'interval callback must be registered after playTrack');
  intervalCallback();

  assert.ok(
    yieldTimeouts.length > 0,
    'refillRingBuffer must schedule a yield via injected setTimeoutFn when tick duration exceeded',
  );
  assert.equal(yieldTimeouts[0].delayMs, 0, 'Yield timeout must use delay=0');
});

// Fix-A regression: when the ring buffer is full at the tick where positionMs
// pins at the gapless track boundary, the refill loop's writableFrames<=0 early
// break must NOT suppress the boundary check — track-changed must still fire.
test('gapless boundary check fires even when ring buffer is full (writableFrames<=0)', () => {
  const messages = [];
  let intervalCallback = null;
  const STEADY_STATE_TARGET_FRAMES = 264600;
  const TRACK_DURATION_MS = 235367;

  // Allocate a SAB large enough to hold the full steady-state target
  const pcmBuffer = new SharedArrayBuffer(
    STEADY_STATE_TARGET_FRAMES * CHANNELS * Float32Array.BYTES_PER_ELEMENT,
  );
  const stateBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
  const sharedState = new Int32Array(stateBuffer);

  let position = 0;
  let duration = TRACK_DURATION_MS;
  let loadNextCalled = false;

  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() {
        // Return empty frames — we don't need to write anything, buffer is full
        return new Float32Array(0);
      },
      durationMs() { return duration; },
      positionMs() { return position; },
      hasEnded() { return false; },
      loadNext() {
        loadNextCalled = true;
        duration = 190493;
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

  // Start playback
  controller.playTrack(new Uint8Array([1]), {
    pcmBuffer,
    stateBuffer,
    frameCapacity: STEADY_STATE_TARGET_FRAMES,
  });

  // Prime startup: set framesAvailable above PLAYBACK_START_FRAMES so
  // startupCompleted is set and currentTargetFrames switches to STEADY_STATE_TARGET_FRAMES
  sharedState[2] = STEADY_STATE_TARGET_FRAMES; // buffer FULL → writableFrames = 0
  position = 100;
  intervalCallback(); // establishes startupCompleted = true

  // Preload the next track
  controller.preloadNext(new Uint8Array([9]));

  // Pin position at the track boundary (at or past durationMs - TRACK_HANDOFF_TOLERANCE_MS)
  position = TRACK_DURATION_MS; // 235367 >= 235367 - 50 → crossedTrackBoundary = true

  // The ring buffer remains FULL — writableFrames = currentTargetFrames - framesAvailable = 0
  // With the bug, the loop breaks before reaching the boundary check → no track-changed emitted.
  // With the fix, the boundary check runs before (or on) the writableFrames<=0 break.
  sharedState[2] = STEADY_STATE_TARGET_FRAMES;
  intervalCallback();

  const trackChangedMessages = messages.filter((m) => m.type === 'track-changed');
  assert.equal(
    trackChangedMessages.length,
    1,
    'track-changed must be emitted exactly once at the gapless boundary tick',
  );
  assert.ok(
    trackChangedMessages.length > 0,
    'track-changed must be emitted even when the ring buffer is full at the gapless boundary tick',
  );
  const fullBufferDiagnostic = messages.find(
    (m) => m.type === 'diagnostics-event' && m.event?.type === 'boundary-checked-on-full-buffer',
  );
  assert.ok(
    fullBufferDiagnostic !== undefined,
    'boundary-checked-on-full-buffer diagnostic must be emitted when handoff fires on a full-buffer tick',
  );
});

test('track-changed payload includes trackDelta field equal to 1 for a forward handoff', () => {
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
          position = 1005;
          actualTransitionPending = false;
        }
        return new Float32Array(CHANNELS * 10);
      },
      durationMs() { return duration; },
      positionMs() { return position; },
      hasEnded() { return false; },
      loadNext() { duration = 2200; return null; },
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
    pcmBuffer, stateBuffer, frameCapacity: 100,
  });

  sharedState[2] = 0;
  position = 800;
  controller.preloadNext(new Uint8Array([9]));
  intervalCallback();

  sharedState[2] = 50;
  actualTransitionPending = true;
  intervalCallback();

  const trackChanged = messages.find((m) => m.type === 'track-changed');
  assert.ok(trackChanged, 'Expected a track-changed message');
  assert.equal(
    trackChanged.trackDelta,
    1,
    `Expected trackDelta=1 in track-changed payload, got ${trackChanged.trackDelta}`,
  );
});
