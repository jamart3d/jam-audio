import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBufferPolicy, validProfiles } from './buffer_policy.js';

test('Baseline: expose rate-variability of current raw constants', () => {
  // Constants from audio_playback_worker_controller.js
  const PLAYBACK_START_FRAMES = 88200;
  const STEADY_STATE_TARGET_FRAMES = 264600;
  const CRITICAL_THRESHOLD_FRAMES = 44100;

  // 44.1 kHz
  assert.equal(PLAYBACK_START_FRAMES / 44100, 2.0);
  assert.equal(STEADY_STATE_TARGET_FRAMES / 44100, 6.0);
  assert.equal(CRITICAL_THRESHOLD_FRAMES / 44100, 1.0);

  // 48 kHz
  assert.equal(PLAYBACK_START_FRAMES / 48000, 1.8375);
  assert.equal(STEADY_STATE_TARGET_FRAMES / 48000, 5.5125);
  assert.equal(CRITICAL_THRESHOLD_FRAMES / 48000, 0.91875);

  // 96 kHz
  assert.equal(PLAYBACK_START_FRAMES / 96000, 0.91875);
  assert.equal(STEADY_STATE_TARGET_FRAMES / 96000, 2.75625);
  assert.equal(CRITICAL_THRESHOLD_FRAMES / 96000, 0.459375);
});

test('resilient profile stability at different sample rates', () => {
  const rates = [44100, 48000, 96000];
  for (const rate of rates) {
    const policy = computeBufferPolicy({
      sampleRate: rate,
      profile: 'resilient',
      frameCapacity: 1000000,
    });
    
    // Check durations are stable (within floating point precision / rounding to frames)
    assert.ok(Math.abs(policy.startupDurationSec - 2.0) < 1/rate);
    assert.ok(Math.abs(policy.steadyDurationSec - 6.0) < 1/rate);
    assert.ok(Math.abs(policy.criticalDurationSec - 1.0) < 1/rate);
    
    // Check frame counts are exactly ceil(duration * rate)
    assert.equal(policy.playbackStartFrames, rate * 2.0);
    assert.equal(policy.steadyStateTargetFrames, rate * 6.0);
    assert.equal(policy.criticalThresholdFrames, rate * 1.0);
  }
});

test('Other profile durations (interactive, balanced)', () => {
  const interactive = computeBufferPolicy({
    sampleRate: 48000,
    profile: 'interactive',
    frameCapacity: 1000000,
  });
  
  assert.equal(interactive.startupDurationSec, 0.5);
  assert.equal(interactive.steadyDurationSec, 2.0);
  assert.equal(interactive.criticalDurationSec, 0.25);
  
  const balanced = computeBufferPolicy({
    sampleRate: 48000,
    profile: 'balanced',
    frameCapacity: 1000000,
  });
  
  assert.equal(balanced.startupDurationSec, 1.0);
  assert.equal(balanced.steadyDurationSec, 4.0);
  assert.equal(balanced.criticalDurationSec, 0.5);
});

test('Impossible combination rejection', () => {
  assert.throws(() => {
    computeBufferPolicy({
      sampleRate: 48000,
      profile: 'resilient',
      frameCapacity: 10000, // Too small for steady (6.0s * 48000 = 288000)
    });
  }, /exceeds frame capacity/);
});

test('Invalid inputs', () => {
  // Bad sample rate
  assert.throws(() => computeBufferPolicy({ sampleRate: 0, frameCapacity: 1000000 }), /Invalid sample rate/);
  assert.throws(() => computeBufferPolicy({ sampleRate: 500000, frameCapacity: 1000000 }), /Invalid sample rate/);
  
  // Bad frame capacity
  assert.throws(() => computeBufferPolicy({ sampleRate: 48000, frameCapacity: 100 }), /below the minimum/);
  
  // Unknown profile
  assert.throws(() => computeBufferPolicy({ sampleRate: 48000, profile: 'unknown', frameCapacity: 1000000 }), /Unknown latency profile/);
});

test('Frame conversion accuracy at uncommon rates', () => {
  const rates = [22050, 96000];
  for (const rate of rates) {
    const policy = computeBufferPolicy({
      sampleRate: rate,
      profile: 'resilient',
      frameCapacity: 1000000,
    });
    
    assert.equal(policy.playbackStartFrames, Math.ceil(2.0 * rate));
    assert.equal(policy.steadyStateTargetFrames, Math.ceil(6.0 * rate));
    assert.equal(policy.criticalThresholdFrames, Math.ceil(1.0 * rate));
  }
});

test('validProfiles returns correct list', () => {
  const profiles = validProfiles();
  assert.deepEqual(profiles, ['interactive', 'balanced', 'resilient']);
});
