import test from 'node:test';
import assert from 'node:assert/strict';
import { initPlaybackWorker } from './audio_playback_worker.js';

const PROTOCOL_VERSION = 2;
const PROTOCOL_SLOTS = 12;

function makeFakeSelf() {
  const posted = [];
  return {
    posted,
    postMessage: (m) => posted.push(m),
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
  };
}

class StubPlayer {
  constructor() {}
  // Mirror the minimal surface the existing controller tests stub; extend from
  // audio_playback_worker_controller.test.js if the controller calls more.
  free() {}
}

test('worker entry forwards protocol fields from a bridge-shaped playTrack message', async () => {
  const fakeSelf = makeFakeSelf();
  globalThis.self = fakeSelf;
  globalThis.performance = globalThis.performance ?? { now: () => 0 };

  initPlaybackWorker({
    wasmModuleLoader: async () => {},
    GaplessPlayerClass: StubPlayer,
    StreamingPlayerClass: StubPlayer,
    WindowedStreamingPlayerClass: StubPlayer,
  });

  const frameCapacity = 1024;
  const stateBuffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * PROTOCOL_SLOTS,
  );
  const pcmBuffer = new SharedArrayBuffer(
    Float32Array.BYTES_PER_ELEMENT * frameCapacity * 2,
  );

  let caughtError;
  try {
    await fakeSelf.onmessage({
      data: {
        type: 'playTrack',
        requestId: 1,
        audioBytes: new Uint8Array(4),
        pcmBuffer,
        stateBuffer,
        frameCapacity,
        sampleRate: 48000,
        sessionGeneration: 1,
        protocolVersion: PROTOCOL_VERSION,
        protocolSlots: PROTOCOL_SLOTS,
      },
    });
  } catch (err) {
    caughtError = err;
  }

  const mismatch = fakeSelf.posted.find(
    (m) =>
      (typeof m.message === 'string' && m.message.includes('Protocol mismatch')) ||
      (typeof m.error === 'string' && m.error.includes('Protocol mismatch')),
  );

  if (caughtError && caughtError.message && caughtError.message.includes('Protocol mismatch')) {
    assert.fail(`worker entry stripped protocol fields (thrown): ${caughtError.message}`);
  }

  assert.equal(
    mismatch,
    undefined,
    `worker entry stripped protocol fields: ${mismatch?.error || mismatch?.message}`,
  );
});
