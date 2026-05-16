import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlaybackWorkerController } from './audio_playback_worker_controller.js';

const CHANNELS = 2;

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
    { type: 'track-changed', transitionPositionMs: 1005 },
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
