import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkletPortState,
  currentPlayerFrom,
  playerHasEnded,
  playerPositionMs,
} from './playback_worker_controller_runtime.js';

test('createWorkletPortState exposes get/set and notifies when port becomes ready', () => {
  const seen = [];
  const state = createWorkletPortState({
    initialPort: null,
    onWorkletPortReady: (port) => seen.push(port),
  });

  assert.equal(state.getWorkletPort(), null);
  state.setWorkletPort('port-1');
  assert.equal(state.getWorkletPort(), 'port-1');
  assert.deepEqual(seen, ['port-1']);
});

test('currentPlayerFrom prefers windowed, then streaming, then gapless player', () => {
  assert.equal(
    currentPlayerFrom({ player: 'gapless', streamingPlayer: 'streaming', windowedPlayer: 'windowed' }),
    'windowed',
  );
  assert.equal(
    currentPlayerFrom({ player: 'gapless', streamingPlayer: 'streaming', windowedPlayer: null }),
    'streaming',
  );
  assert.equal(
    currentPlayerFrom({ player: 'gapless', streamingPlayer: null, windowedPlayer: null }),
    'gapless',
  );
});

test('playerHasEnded and playerPositionMs are null-safe', () => {
  assert.equal(playerHasEnded(null), false);
  assert.equal(playerPositionMs(null), 0);
  assert.equal(playerHasEnded({ hasEnded: () => true }), true);
  assert.equal(playerPositionMs({ positionMs: () => 1234 }), 1234);
});
