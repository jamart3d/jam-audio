import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDecodeMetric,
  buildExtraSyncPayload,
  computeBufferFill,
  createWorkerDiagnostics,
  updateLowWaterMark,
} from './playback_worker_controller_diagnostics.js';

const SLOTS = {
  READ_INDEX: 0,
  WRITE_INDEX: 1,
  TOTAL_FRAMES_RENDERED_INDEX: 5,
  HEARTBEAT_COUNT_INDEX: 6,
  UNDERRUN_EPISODES_INDEX: 9,
  SILENT_FRAMES_INDEX: 10,
};

test('createWorkerDiagnostics has controller fields and applies overrides', () => {
  const d = createWorkerDiagnostics({ workerState: 'playing', retainedBytes: 7 });
  assert.equal(d.workerState, 'playing');
  assert.equal(d.retainedBytes, 7);
  assert.equal(d.lowWaterMarkCount, 0);
  assert.equal(d.recoveryModeActive, false);
  assert.equal(d.activeBoundedWindowSize, 0);
  assert.equal(d.pendingSeekDistanceMs, 0);
  assert.equal(d.fetchToDecodeLagMs, 0);
  assert.equal(d.resumeAfterStallLatencyMs, 0);
  assert.equal(d.underrunCount, 0);
});

test('createWorkerDiagnostics reads underrun and silent counts from shared state, ignoring writes', () => {
  let state = null;
  const d = createWorkerDiagnostics({}, { getSharedState: () => state, slots: SLOTS });
  assert.equal(d.underrunCount, 0);
  assert.equal(d.silentFrameCount, 0);
  state = new Int32Array(12);
  state[9] = 2;
  state[10] = 480;
  d.underrunCount = 99;
  assert.equal(d.underrunCount, 2);
  assert.equal(d.silentFrameCount, 480);
});

test('applyDecodeMetric tracks last, max, count and rounded moving average', () => {
  const d = createWorkerDiagnostics();
  applyDecodeMetric(d, 10);
  applyDecodeMetric(d, 25.5);
  applyDecodeMetric(d, 4);
  assert.equal(d.lastDecodeMs, 4);
  assert.equal(d.maxDecodeMs, 25.5);
  assert.equal(d.refillCount, 3);
  assert.equal(d.movingAverageDecodeMs, 13.17);
});

test('computeBufferFill handles zero capacity and rounds to one decimal', () => {
  assert.equal(computeBufferFill(100, 0), 0);
  assert.equal(computeBufferFill(1, 3), 33.3);
  assert.equal(computeBufferFill(50, 100), 50);
});

test('updateLowWaterMark latches below 10 and clears at 15', () => {
  const d = createWorkerDiagnostics();
  let below = false;
  below = updateLowWaterMark(d, 5, below);
  below = updateLowWaterMark(d, 4, below);
  assert.equal(d.lowWaterMarkCount, 1);
  assert.equal(below, true);
  below = updateLowWaterMark(d, 12, below);
  assert.equal(below, true);
  below = updateLowWaterMark(d, 15, below);
  assert.equal(below, false);
  below = updateLowWaterMark(d, 9, below);
  assert.equal(d.lowWaterMarkCount, 2);
});

test('buildExtraSyncPayload omits shared-state fields outside extended mode', () => {
  const d = createWorkerDiagnostics({ retainedBytes: 3 });
  const p = buildExtraSyncPayload({
    diagnostics: d, activePolicy: null, diagnosticsMode: 'minimal', sharedState: null, slots: SLOTS,
  });
  assert.equal(p.retainedBytes, 3);
  assert.equal('readIndex' in p, false);
  assert.equal('latencyPolicy' in p, false);
});

test('buildExtraSyncPayload includes latencyPolicy when a policy is active', () => {
  const policy = {
    profile: 'resilient', playbackStartFrames: 1, steadyStateTargetFrames: 2,
    criticalThresholdFrames: 3, startupDurationSec: 4, steadyDurationSec: 5, extra: 'ignored',
  };
  const p = buildExtraSyncPayload({
    diagnostics: createWorkerDiagnostics(), activePolicy: policy, diagnosticsMode: 'normal', sharedState: null, slots: SLOTS,
  });
  assert.deepEqual(p.latencyPolicy, {
    profile: 'resilient', playbackStartFrames: 1, steadyStateTargetFrames: 2,
    criticalThresholdFrames: 3, startupDurationSec: 4, steadyDurationSec: 5,
  });
});

test('buildExtraSyncPayload extended mode reads slots or returns nulls', () => {
  const state = new Int32Array(12);
  state[0] = 11; state[1] = 22; state[5] = 33; state[6] = 44;
  const args = { diagnostics: createWorkerDiagnostics(), activePolicy: null, diagnosticsMode: 'extended', slots: SLOTS };
  const p = buildExtraSyncPayload({ ...args, sharedState: state });
  assert.deepEqual(
    [p.readIndex, p.writeIndex, p.framesRendered, p.workletHeartbeatCount],
    [11, 22, 33, 44],
  );
  const short = buildExtraSyncPayload({ ...args, sharedState: new Int32Array(5) });
  assert.equal(short.framesRendered, null);
  assert.equal(short.workletHeartbeatCount, null);
  const none = buildExtraSyncPayload({ ...args, sharedState: null });
  assert.deepEqual(
    [none.readIndex, none.writeIndex, none.framesRendered, none.workletHeartbeatCount],
    [null, null, null, null],
  );
});
