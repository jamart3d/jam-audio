import assert from 'node:assert/strict';
import test from 'node:test';

import { createBridgeSessionState } from './audio_bridge_session.js';

test('setSessionQueue updates active track and emits reset when track changes', () => {
  const resets = [];
  const storage = new Map();
  const session = createBridgeSessionState({
    storage: {
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    resetProcessorPosition: () => resets.push('reset'),
  });

  session.setSessionQueue(['a', 'b'], 0);
  session.setSessionQueue(['a', 'b'], 1);

  assert.equal(session.getPlaybackSessionSnapshot().activeTrackId, 'b');
  assert.deepEqual(resets, ['reset', 'reset']);
});

test('clearSessionMetadata removes persisted keys', () => {
  const deleted = [];
  const session = createBridgeSessionState({
    storage: {
      setItem: () => {},
      removeItem: (k) => deleted.push(k),
    },
    resetProcessorPosition: () => {},
  });

  session.clearSessionMetadataFromLocalStorage();

  assert.ok(deleted.includes('jamdisc-session-track-id'));
  assert.ok(deleted.includes('jamdisc-session-position-ms'));
});

import { clampVolume } from './audio_bridge_transport.js';

test('clampVolume constrains values into 0..1', () => {
  assert.equal(clampVolume(-1), 0);
  assert.equal(clampVolume(0.5), 0.5);
  assert.equal(clampVolume(2), 1);
});
