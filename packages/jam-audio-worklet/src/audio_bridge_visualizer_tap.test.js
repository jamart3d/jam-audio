import assert from 'node:assert/strict';
import test from 'node:test';
import { createJamAudioBridge } from './audio_bridge.js';

test('getVisualizerAudioTap returns null before initAudio', async () => {
  const bridge = createJamAudioBridge({ wasmModuleLoader: async () => ({}) });
  assert.equal(bridge.getVisualizerAudioTap(), null);
});
