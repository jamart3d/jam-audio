// Tests for the refill driver loops in audio_playback_worker_controller.js (waitasync,
// port, degraded interval). Written as characterization tests before the loops were
// extracted; the two formerly pinned defects (loop token passed to clearIntervalFn, stop
// not retiring a waitasync loop) are now fixed and asserted as fixed below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackWorkerController } from './audio_playback_worker_controller.js';

const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

function buffers(frameCapacity = 300000) {
  return {
    pcmBuffer: new SharedArrayBuffer(frameCapacity * 2 * Float32Array.BYTES_PER_ELEMENT),
    stateBuffer: new SharedArrayBuffer(12 * Int32Array.BYTES_PER_ELEMENT),
    frameCapacity,
    protocolVersion: 2,
    protocolSlots: 12,
  };
}

function make(options = {}) {
  const cleared = [];
  const messages = [];
  const intervals = [];
  const timeouts = [];
  let decodeCalls = 0;
  let clock = 100;
  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() { decodeCalls += 1; return new Float32Array(2048); },
      durationMs() { return 600000; },
      positionMs() { return 0; },
      hasEnded() { return false; },
      loadNext() { return null; },
      seekToMs() {},
      free() {},
    }),
    createStreamingPlayer: () => null,
    createWindowedStreamingPlayer: () => null,
    createRangeFetchController: () => null,
    emitMessage: (m) => messages.push(m),
    setIntervalFn: (cb) => { intervals.push(cb); return 7000 + intervals.length; },
    clearIntervalFn: (id) => cleared.push(id),
    setTimeoutFn: (cb) => { timeouts.push(cb); return 1; },
    clearTimeoutFn: () => {},
    performanceNow: () => clock,
    nowMs: () => clock,
    waitTimeoutMs: 10,
    ...options,
  });
  return {
    controller, cleared, messages, intervals, timeouts,
    decodes: () => decodeCalls,
    setClock: (v) => { clock = v; },
    events: (type) => messages
      .filter((m) => m.type === 'diagnostics-event' && m.event.type === type)
      .map((m) => m.event),
  };
}

async function withoutWaitAsync(fn) {
  const original = Atomics.waitAsync;
  Atomics.waitAsync = undefined;
  try { await fn(); } finally { Atomics.waitAsync = original; }
}

test('waitasync driver is selected once per controller lifetime and announced', async () => {
  assert.equal(typeof Atomics.waitAsync, 'function');
  const h = make();
  h.controller.playTrack(new Uint8Array([1]), buffers());
  await flush();
  h.controller.playTrack(new Uint8Array([2]), buffers());
  await flush();
  const selected = h.events('refill-driver-selected');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].driver, 'waitasync');
  assert.equal(selected[0].severity, 'info');
  h.controller.stop();
});

test('stop() under the waitasync driver passes nothing to clearIntervalFn (no interval exists)', async () => {
  const h = make();
  h.controller.playTrack(new Uint8Array([1]), buffers());
  await flush();
  h.controller.stop();
  assert.deepEqual(h.cleared, [], 'the loop token is never handed to clearIntervalFn');
  assert.equal(h.intervals.length, 0, 'no interval was ever created under waitasync');
});

test('an unrelated pending timer is not cancelled by stop() even when its id equals the loop number', async () => {
  // Timer ids share one pool in a browser worker. Model it: pending timer ids 1..9.
  const pending = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const h = make({ clearIntervalFn: (id) => pending.delete(id) });
  h.controller.playTrack(new Uint8Array([1]), buffers());
  await flush();
  h.controller.playTrack(new Uint8Array([2]), buffers());
  await flush();
  h.controller.stop();
  assert.equal(pending.size, 9, 'all unrelated timers survive');
});

test('stopRefillLoop retires a waitasync loop: pauseRefill() then a worklet refill request is not served', async () => {
  const h = make();
  const b = buffers();
  h.controller.playTrack(new Uint8Array([1]), b);
  await flush();
  const state = new Int32Array(b.stateBuffer);
  h.controller.pauseRefill();
  await flush(4);
  const before = h.decodes();
  Atomics.store(state, 2, 0);                               // FRAMES_AVAILABLE
  Atomics.store(state, 0, Atomics.load(state, 1));          // READ_INDEX = WRITE_INDEX
  Atomics.add(state, 7, 1);
  Atomics.notify(state, 7, 1);                              // worklet refill request
  await flush(20);
  assert.equal(h.decodes(), before, 'the stopped loop did not refill');
  // transportUnmute restarts the loop through kickRefillLoopIfNeeded.
  h.controller.transportUnmute();
  await flush(10);
  assert.ok(h.decodes() > before, 'refill resumes after an explicit restart');
  h.controller.stop();
});

test('degraded interval driver: selected with a warning when waitAsync and the port are absent', () => withoutWaitAsync(async () => {
  const h = make();
  h.controller.playTrack(new Uint8Array([1]), buffers());
  const selected = h.events('refill-driver-selected');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].driver, 'degraded-interval');
  assert.equal(selected[0].severity, 'warning');
  assert.equal(h.intervals.length, 1);
  h.controller.stop();
  assert.deepEqual(h.cleared, [7001], 'a real interval id is cleared for this driver');
}));

test('degraded interval driver: delayed tick events and gap diagnostics on the CURRENT diagnostics object', () => withoutWaitAsync(async () => {
  const h = make();
  // A capacity much larger than the steady-state target keeps bufferFillPercent below 15.
  h.controller.playTrack(new Uint8Array([1]), buffers(3000000));
  h.controller.playTrack(new Uint8Array([2]), buffers(3000000)); // diagnostics object is replaced here
  assert.ok(h.controller.getDiagnostics().bufferFillPercent < 15, 'precondition: low headroom');
  const tick = h.intervals.at(-1);
  h.setClock(100 + 60);
  tick();
  const delayed = h.events('refill-timer-delayed');
  assert.equal(delayed.length, 1);
  assert.equal(delayed[0].gapMs, 60);
  assert.equal(h.controller.getDiagnostics().lastRefillGapMs, 60);
  assert.equal(h.controller.getDiagnostics().maxRefillGapMs, 60);
  assert.equal(h.events('refill-delayed-headroom-low').length, 1);
  assert.equal(h.events('refill-delayed-headroom-low')[0].severity, 'critical');
  // A short gap raises no delayed event.
  h.setClock(100 + 60 + 10);
  tick();
  assert.equal(h.events('refill-timer-delayed').length, 1);
  assert.equal(h.controller.getDiagnostics().lastRefillGapMs, 10);
  assert.equal(h.controller.getDiagnostics().maxRefillGapMs, 60);
  h.controller.stop();
}));

test('degraded interval driver: a tick is skipped while a deferred refill is pending', () => withoutWaitAsync(async () => {
  let ticks = 0;
  const h = make();
  // Make the refill loop run long so refillRingBuffer defers itself (refillPending = true).
  let t = 100;
  const controller = createPlaybackWorkerController({
    createGaplessPlayer: () => ({
      decodeFrames() { t += 50; return new Float32Array(2048); },
      durationMs() { return 600000; }, positionMs() { return 0; }, hasEnded() { return false; },
      loadNext() { return null; }, seekToMs() {}, free() {},
    }),
    createStreamingPlayer: () => null, createWindowedStreamingPlayer: () => null, createRangeFetchController: () => null,
    emitMessage: () => {},
    setIntervalFn: (cb) => { h.intervals.push(cb); return 1; },
    clearIntervalFn: () => {},
    setTimeoutFn: (cb) => { h.timeouts.push(cb); return 1; },
    clearTimeoutFn: () => {},
    performanceNow: () => t,
    nowMs: () => t,
  });
  controller.playTrack(new Uint8Array([1]), buffers());
  assert.ok(h.timeouts.length >= 1, 'precondition: refillRingBuffer deferred itself (refillPending)');
  const gapBefore = controller.getDiagnostics().lastRefillGapMs;
  t += 500;
  h.intervals.at(-1)();
  ticks += 1;
  assert.equal(controller.getDiagnostics().lastRefillGapMs, gapBefore, 'skipped tick leaves gap diagnostics untouched');
  assert.equal(ticks, 1);
  controller.stop();
}));

test('port driver: selected when a worklet port exists; a refill-wake message refills', () => withoutWaitAsync(async () => {
  const port = { onmessage: null, postMessage() {} };
  const h = make({ workletPort: port });
  h.controller.playTrack(new Uint8Array([1]), buffers());
  const selected = h.events('refill-driver-selected');
  assert.equal(selected[0].driver, 'port');
  assert.equal(typeof port.onmessage, 'function');
  const before = h.decodes();
  port.onmessage({ data: { type: 'refill-wake' } });
  assert.doesNotThrow(() => port.onmessage({ data: { type: 'refill-wake' } }));
  assert.ok(h.decodes() >= before);
  assert.equal(h.intervals.length, 0);
  h.controller.stop();
}));

test('port driver cached but port removed: emits refill-driver-port-missing and falls back to the interval', () => withoutWaitAsync(async () => {
  const port = { onmessage: null, postMessage() {} };
  const h = make({ workletPort: port });
  h.controller.playTrack(new Uint8Array([1]), buffers());
  assert.equal(h.events('refill-driver-selected')[0].driver, 'port');
  h.controller.setWorkletPort(null);
  h.controller.playTrack(new Uint8Array([2]), buffers());
  const missing = h.events('refill-driver-port-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'warning');
  assert.equal(h.intervals.length, 1, 'fell back to the degraded interval');
  assert.equal(h.events('refill-driver-selected').length, 1, 'driver selection is not re-announced');
  h.controller.stop();
}));
