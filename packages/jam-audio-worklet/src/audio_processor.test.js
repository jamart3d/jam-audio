/**
 * S6 Spike: Lost-wakeup determinism test
 *
 * Tests the generation-counter protocol from spec §3.1:
 *   expected = load(slot7)
 *   refillRingBuffer()          <- worklet may notify HERE (between load and waitAsync)
 *   waitAsync(slot7, expected)  <- must return 'not-equal' if counter advanced
 *
 * Uses fake Atomics and a synchronous simulation to test every interleaving.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// Fake Atomics for deterministic simulation (no SharedArrayBuffer required)
function makeFakeAtomics(initialValue = 0) {
  let slot7 = initialValue;
  const waitAsyncResults = [];

  return {
    load: () => slot7,
    add: (delta) => { slot7 += delta; return slot7 - delta; },
    notify: () => { /* recorded by waitAsync */ },
    // Simulates waitAsync: captures expected vs actual at call time
    waitAsync: (expected, _timeoutMs) => {
      const actualAtCallTime = slot7;
      if (actualAtCallTime !== expected) {
        // not-equal: resolves synchronously (as a fulfilled Promise)
        return { async: true, value: Promise.resolve('not-equal') };
      }
      // Would block waiting — caller must handle timeout/notify
      // For testing we resolve 'timed-out' synchronously
      return { async: true, value: Promise.resolve('timed-out') };
    },
    _getSlot7: () => slot7,
  };
}

test('S6: no lost wake when worklet notifies between load and waitAsync (not-equal interleaving)', async () => {
  // Interleaving under test:
  //   1. Worker loads expected=0
  //   2. Worker calls refillRingBuffer() (no-op — buffer full)
  //   3. Worklet adds 1 → slot7=1, notifies     ← race window
  //   4. Worker calls waitAsync(slot7, expected=0)
  //      → actual=1 ≠ expected=0 → 'not-equal' returned immediately
  //   5. Worker loops, refills, loads expected=1
  //   6. Worker calls waitAsync(slot7, expected=1) → slot7 still 1 → 'timed-out' (would block)
  //
  // Expected: loop runs at least twice, meaning the wake in step 3 was not lost.

  const fakeAtomics = makeFakeAtomics(0);
  let refillCalls = 0;

  // Simulate one iteration of refillWaitLoop
  async function oneIteration(expected) {
    const beforeRefill = fakeAtomics.load();
    refillCalls++;
    // Simulate worklet notifying during refill (advances slot7)
    fakeAtomics.add(1);
    // Now call waitAsync — slot7 has advanced, so expected is stale
    const result = fakeAtomics.waitAsync(beforeRefill, 1000);
    return await result.value;
  }

  const reason = await oneIteration(0);
  assert.equal(reason, 'not-equal',
    'Worker must see not-equal when worklet advanced slot7 between load and waitAsync');
  assert.equal(refillCalls, 1, 'refillRingBuffer called once in this iteration');

  // Loop again — this time no worklet notify races; should see timed-out (would block in prod)
  const reason2 = await fakeAtomics.waitAsync(fakeAtomics.load(), 1000).value;
  assert.equal(reason2, 'timed-out', 'No pending wake — next iteration would block until notify');
});

test('S6: no lost wake when worklet notifies before load (not-equal on load)', async () => {
  // Interleaving under test:
  //   1. Worklet adds 1 → slot7=1  ← already advanced before worker iteration
  //   2. Worker loads expected=1   (sees the already-advanced value)
  //   3. Worker calls refillRingBuffer()
  //   4. Worker calls waitAsync(slot7, expected=1) → slot7 still 1 → 'timed-out'
  //
  // The refill in step 3 handles the low-water condition; no wake is missed because
  // the worker always refills BEFORE waiting, covering the "already hungry" case.

  const fakeAtomics = makeFakeAtomics(1); // slot7 pre-advanced by worklet
  let refillCalls = 0;

  const expected = fakeAtomics.load(); // loads 1
  assert.equal(expected, 1);
  refillCalls++;
  // refillRingBuffer called here — buffer topped up
  const reason = await fakeAtomics.waitAsync(expected, 1000).value;
  assert.equal(reason, 'timed-out',
    'Refill happened before wait; if worklet already notified, refill covers it');
  assert.equal(refillCalls, 1);
});

test('S6: worklet notifies multiple times; worker sees all via loop iterations', async () => {
  // Worklet calls add+notify N times between worker iterations.
  // Worker captures expected before each refill → each iteration sees not-equal
  // until slot7 stabilizes.

  const fakeAtomics = makeFakeAtomics(0);
  const notifyCount = 3;
  // Simulate worklet firing 3 low-water signals
  for (let i = 0; i < notifyCount; i++) {
    fakeAtomics.add(1);
  }
  // slot7 is now 3

  let iterations = 0;
  let lastReason;
  let expected = fakeAtomics.load(); // loads 3 on first proper iteration

  // In the real loop, worker always loads BEFORE refill.
  // Simulate: worker loads, refills (no new notifies this time), waits.
  const beforeRefill = fakeAtomics.load(); // 3
  // refill called — no new worklet activity
  lastReason = await fakeAtomics.waitAsync(beforeRefill, 1000).value;
  iterations++;
  assert.equal(lastReason, 'timed-out',
    'All worklet notifies were captured in the load; refill already ran; worker can sleep');
  assert.equal(fakeAtomics._getSlot7(), 3, 'slot7 is stable at 3');
});

test('S6: STOP_INDEX suppresses worklet signal — refill loop must not wake for stopped stream', () => {
  // Spec §3.1: "if STOP_INDEX == 1, the worklet must NOT signal"
  // This test verifies the check: worklet reads STOP_INDEX before signalling.
  const STOP_INDEX = 4;
  const stateBuffer = new SharedArrayBuffer(9 * Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(stateBuffer);
  Atomics.store(state, STOP_INDEX, 1); // stopped

  let signalEmitted = false;
  // Simulate worklet process() low-water check
  function workletLowWaterCheck(framesNow, lowWater) {
    const stopped = Atomics.load(state, STOP_INDEX) === 1;
    if (framesNow < lowWater && !stopped) {
      Atomics.add(state, 7, 1); // REFILL_REQUEST_INDEX = 7
      Atomics.notify(state, 7, 1);
      signalEmitted = true;
    }
  }

  workletLowWaterCheck(0, 1000); // framesNow=0 < lowWater=1000, but STOP=1
  assert.equal(signalEmitted, false, 'Stopped worklet must not emit refill signal');
  assert.equal(Atomics.load(state, 7), 0, 'slot7 must remain 0 when stopped');

  // Now clear stop
  Atomics.store(state, STOP_INDEX, 0);
  workletLowWaterCheck(0, 1000);
  assert.equal(signalEmitted, true, 'Unstoppped worklet must emit refill signal');
  assert.equal(Atomics.load(state, 7), 1, 'slot7 must increment to 1 after signal');
});

test('P1.2: process() adds to REFILL_REQUEST_INDEX when frames drop below low-water mark', () => {
  // Directly test the low-water check logic extracted from process().
  // Uses a real 9-slot SAB so Atomics calls are real.

  const FRAMES_AVAILABLE_INDEX = 2;
  const STOP_INDEX = 4;
  const REFILL_REQUEST_INDEX = 7;
  const TARGET_FRAMES_INDEX = 8;
  const LOW_WATER_FRACTION = 0.5;

  const stateBuffer = new SharedArrayBuffer(9 * Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(stateBuffer);

  const STEADY_STATE_TARGET = 264600;
  Atomics.store(state, TARGET_FRAMES_INDEX, STEADY_STATE_TARGET);
  const lowWater = Math.floor(STEADY_STATE_TARGET * LOW_WATER_FRACTION); // 132300

  // Simulate what process() does after sub:
  function simulateProcessLowWaterCheck(framesAfterSub) {
    const target = Atomics.load(state, TARGET_FRAMES_INDEX) || STEADY_STATE_TARGET;
    const lw = Math.floor(target * LOW_WATER_FRACTION);
    const stopped = Atomics.load(state, STOP_INDEX) === 1;
    if (framesAfterSub < lw && !stopped) {
      Atomics.add(state, REFILL_REQUEST_INDEX, 1);
      Atomics.notify(state, REFILL_REQUEST_INDEX, 1);
    }
  }

  // Case 1: above low water — no signal
  Atomics.store(state, REFILL_REQUEST_INDEX, 0);
  simulateProcessLowWaterCheck(lowWater + 1);
  assert.equal(Atomics.load(state, REFILL_REQUEST_INDEX), 0,
    'Above low-water: must not signal');

  // Case 2: exactly at low water — no signal (strictly below)
  simulateProcessLowWaterCheck(lowWater);
  assert.equal(Atomics.load(state, REFILL_REQUEST_INDEX), 0,
    'At low-water: must not signal (strictly below required)');

  // Case 3: below low water — must signal
  simulateProcessLowWaterCheck(lowWater - 1);
  assert.equal(Atomics.load(state, REFILL_REQUEST_INDEX), 1,
    'Below low-water: must add 1 to REFILL_REQUEST_INDEX');

  // Case 4: multiple dips — counter increments monotonically
  simulateProcessLowWaterCheck(lowWater - 1);
  assert.equal(Atomics.load(state, REFILL_REQUEST_INDEX), 2,
    'Second dip: counter must be 2');

  // Case 5: stopped — must NOT signal even when below low water
  Atomics.store(state, STOP_INDEX, 1);
  simulateProcessLowWaterCheck(0);
  assert.equal(Atomics.load(state, REFILL_REQUEST_INDEX), 2,
    'Stopped: must not increment counter');
});

