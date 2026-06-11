import assert from 'node:assert/strict';
import test from 'node:test';

import { RangeFetchController } from './range_fetch_controller.js';

test('fetchFrom first-byte timeout aborts and reports network-timeout error', async () => {
  const errors = [];
  const scheduled = [];

  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalAbortController = globalThis.AbortController;

  let rejectFetch;
  let abortCount = 0;

  class FakeAbortController {
    constructor() {
      this.signal = {};
    }

    abort() {
      abortCount += 1;
      if (rejectFetch) {
        rejectFetch(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }
    }
  }

  globalThis.AbortController = FakeAbortController;
  globalThis.setTimeout = (fn, ms) => {
    scheduled.push({ fn, ms });
    return scheduled.length;
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = () => new Promise((_resolve, reject) => {
    rejectFetch = reject;
  });

  try {
    const controller = new RangeFetchController('https://example.test/audio', {
      onChunk: () => {},
      onComplete: () => {},
      onError: (error) => errors.push(error.message),
      firstByteTimeoutMs: 25,
    });

    const fetchPromise = controller.fetchFrom(0);

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 25);

    scheduled[0].fn();
    await fetchPromise;

    assert.equal(abortCount, 1);
    assert.deepEqual(errors, ['network-timeout: first byte']);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.AbortController = originalAbortController;
  }
});
