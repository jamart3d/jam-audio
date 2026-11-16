import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefillLoop } from './playback_worker_controller_refill_loop.js';

const REFILL_REQUEST_INDEX = 7;
const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

function make(overrides = {}) {
  const ctx = {
    sharedState: new Int32Array(new SharedArrayBuffer(12 * 4)),
    diagnostics: { lastRefillGapMs: 0, maxRefillGapMs: 0, bufferFillPercent: 50 },
    port: null,
    refillPending: false,
    clock: 100,
    refills: 0,
    stops: 0,
    events: [],
    intervals: [],
    onRefill: null,
    ...overrides.ctx,
  };
  const loop = createRefillLoop({
    getSharedState: () => ctx.sharedState,
    getDiagnostics: () => ctx.diagnostics,
    getWorkletPort: () => ctx.port,
    refillRingBuffer: () => { ctx.refills += 1; ctx.onRefill?.(); },
    stopRefillLoop: () => { ctx.stops += 1; loop.setTimerId(null); },
    isRefillPending: () => ctx.refillPending,
    emitDiagnosticsEvent: (e) => ctx.events.push(e),
    nowMs: () => ctx.clock,
    performanceNow: () => ctx.clock,
    setIntervalFn: (cb) => { ctx.intervals.push(cb); return 9000 + ctx.intervals.length; },
    waitTimeoutMs: 10,
    refillRequestIndex: REFILL_REQUEST_INDEX,
    refillIntervalMs: 15,
    ...overrides.deps,
  });
  return { loop, ctx };
}

async function withWaitAsync(value, fn) {
  const original = Atomics.waitAsync;
  Atomics.waitAsync = value;
  try { await fn(); } finally { Atomics.waitAsync = original; }
}

test('driver precedence: waitasync, then port, then degraded interval; selected once and announced', async () => {
  const a = make();
  assert.equal(a.loop.selectDriver(), 'waitasync');
  assert.equal(a.loop.selectDriver(), 'waitasync');
  assert.equal(a.ctx.events.filter((e) => e.type === 'refill-driver-selected').length, 1);

  await withWaitAsync(undefined, async () => {
    const b = make({ ctx: { port: { onmessage: null } } });
    assert.equal(b.loop.selectDriver(), 'port');
    const c = make();
    assert.equal(c.loop.selectDriver(), 'degraded-interval');
    assert.equal(c.ctx.events[0].severity, 'warning');
  });

  const small = make({ ctx: { sharedState: new Int32Array(5) } });
  assert.notEqual(small.loop.selectDriver(), 'waitasync', 'a state array without slot 7 never uses waitAsync');
});

test('start() bumps the session, stops any previous timer, and marks the loop active', async () => {
  await withWaitAsync(undefined, async () => {
    const { loop, ctx } = make();
    assert.equal(loop.isActive(), false);
    const before = loop.sessionId();
    loop.start();
    assert.equal(loop.sessionId(), before + 1);
    assert.equal(ctx.stops, 1);
    assert.equal(loop.isActive(), true);
    assert.equal(ctx.intervals.length, 1);
    assert.equal(loop.getTimerId(), 9001, 'the interval id is held for the shared core to clear');
  });
});

test('waitasync loop exits on invalidate() and clears its sentinel only while still current', async () => {
  const { loop, ctx } = make();
  loop.start();
  const token = loop.getTimerId();
  assert.equal(token, loop.sessionId());
  await flush();
  assert.ok(ctx.refills >= 1);
  loop.invalidate();
  Atomics.add(ctx.sharedState, REFILL_REQUEST_INDEX, 1);
  Atomics.notify(ctx.sharedState, REFILL_REQUEST_INDEX, 1);
  await flush();
  const refillsAfterInvalidate = ctx.refills;
  await flush(10);
  assert.equal(ctx.refills, refillsAfterInvalidate, 'retired loop no longer refills');
  assert.equal(loop.getTimerId(), null, 'retired loop cleared its own sentinel');

  // A replacement loop started meanwhile keeps its sentinel when an older loop exits.
  const second = make();
  second.loop.start();
  await flush();
  const firstToken = second.loop.getTimerId();
  second.loop.start();
  await flush();
  assert.notEqual(second.loop.getTimerId(), firstToken);
  assert.equal(second.loop.getTimerId(), second.loop.sessionId(), 'newer sentinel survives the older loop exiting');
  second.loop.invalidate();
  await flush();
});

test('invalidate() during a refill stops the loop before it waits again', async () => {
  const { loop, ctx } = make();
  ctx.onRefill = () => { if (ctx.refills === 1) loop.invalidate(); };
  loop.start();
  await flush(10);
  assert.equal(ctx.refills, 1, 'no further refill after the session changed mid-refill');
});

test('port driver wires onmessage to refill and stops when the session is invalidated', async () => {
  await withWaitAsync(undefined, async () => {
    const port = { onmessage: null };
    const { loop, ctx } = make({ ctx: { port } });
    loop.start();
    assert.equal(ctx.refills, 1, 'initial refill on loop start');
    port.onmessage();
    assert.equal(ctx.refills, 2);
    loop.invalidate();
    port.onmessage();
    assert.equal(ctx.refills, 2, 'stale port loop ignores wake messages');
  });
});

test('port driver selected but port removed: refill-driver-port-missing then degraded interval', async () => {
  await withWaitAsync(undefined, async () => {
    const port = { onmessage: null };
    const { loop, ctx } = make({ ctx: { port } });
    loop.selectDriver();
    ctx.port = null;
    loop.start();
    assert.equal(ctx.events.filter((e) => e.type === 'refill-driver-port-missing').length, 1);
    assert.equal(ctx.intervals.length, 1);
  });
});

test('degraded interval tick: skips while a refill is pending, records gaps on the CURRENT diagnostics', async () => {
  await withWaitAsync(undefined, async () => {
    const { loop, ctx } = make();
    loop.start();
    const tick = ctx.intervals[0];
    ctx.refillPending = true;
    ctx.clock = 500;
    tick();
    assert.equal(ctx.refills, 0, 'pending refill: tick returns early');
    assert.equal(ctx.diagnostics.lastRefillGapMs, 0);

    ctx.refillPending = false;
    const replaced = { lastRefillGapMs: 0, maxRefillGapMs: 0, bufferFillPercent: 5 };
    ctx.diagnostics = replaced; // the controller reassigns diagnostics between ticks
    ctx.clock = 600;
    tick();
    // A skipped (pending) tick does not advance the last-tick time, so the gap spans both.
    assert.equal(replaced.lastRefillGapMs, 500, 'gap written to the replaced object, not a stale reference');
    assert.equal(ctx.events.filter((e) => e.type === 'refill-timer-delayed').length, 1);
    assert.equal(ctx.events.filter((e) => e.type === 'refill-delayed-headroom-low').length, 1);
    assert.equal(ctx.refills, 1);

    ctx.diagnostics.bufferFillPercent = 80;
    ctx.clock = 700;
    tick();
    assert.equal(ctx.events.filter((e) => e.type === 'refill-timer-delayed').length, 2);
    assert.equal(ctx.events.filter((e) => e.type === 'refill-delayed-headroom-low').length, 1, 'no headroom event at 80% fill');
    ctx.clock = 710;
    tick();
    assert.equal(ctx.events.filter((e) => e.type === 'refill-timer-delayed').length, 2, 'a 10ms gap raises no delayed event');
    assert.equal(replaced.lastRefillGapMs, 10);
    assert.equal(replaced.maxRefillGapMs, 500);
  });
});

test('nudgeIfWaitAsync bumps and notifies slot 7 only for the waitasync driver with state', async () => {
  const { loop, ctx } = make();
  loop.nudgeIfWaitAsync();
  assert.equal(Atomics.load(ctx.sharedState, REFILL_REQUEST_INDEX), 0, 'no driver selected yet');
  loop.selectDriver();
  loop.nudgeIfWaitAsync();
  assert.equal(Atomics.load(ctx.sharedState, REFILL_REQUEST_INDEX), 1);
  ctx.sharedState = null;
  assert.doesNotThrow(() => loop.nudgeIfWaitAsync());
});
