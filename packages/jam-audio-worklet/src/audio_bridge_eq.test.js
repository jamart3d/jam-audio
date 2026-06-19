import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRESETS,
  createEqChain,
  wireEqChain,
  connectProcessorToChain,
  applyBand,
  applyBands,
  clampGain,
} from './audio_bridge_eq.js';

function makeMockAudioContext() {
  return {
    createBiquadFilter() {
      return { type: '', frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, connect() {} };
    },
  };
}

test('createEqChain produces 5 filters with correct types and frequencies', () => {
  const chain = createEqChain(makeMockAudioContext());
  assert.equal(chain.length, 5);
  assert.equal(chain[0].type, 'lowshelf');
  assert.equal(chain[0].frequency.value, 80);
  assert.equal(chain[1].type, 'peaking');
  assert.equal(chain[1].frequency.value, 250);
  assert.equal(chain[1].Q.value, 1.4);
  assert.equal(chain[2].type, 'peaking');
  assert.equal(chain[2].frequency.value, 1000);
  assert.equal(chain[3].type, 'peaking');
  assert.equal(chain[3].frequency.value, 4000);
  assert.equal(chain[4].type, 'highshelf');
  assert.equal(chain[4].frequency.value, 12000);
});

test('createEqChain initialises all gains to 0', () => {
  const chain = createEqChain(makeMockAudioContext());
  chain.forEach(f => assert.equal(f.gain.value, 0));
});

test('applyBands bass_boost sets correct gains', () => {
  const chain = createEqChain(makeMockAudioContext());
  applyBands(chain, PRESETS.bass_boost);
  assert.equal(chain[0].gain.value, 6);
  assert.equal(chain[1].gain.value, 3);
  assert.equal(chain[2].gain.value, 0);
  assert.equal(chain[3].gain.value, 0);
  assert.equal(chain[4].gain.value, 0);
});

test('applyBands flat resets all gains to 0', () => {
  const chain = createEqChain(makeMockAudioContext());
  applyBands(chain, PRESETS.bass_boost);
  applyBands(chain, PRESETS.flat);
  chain.forEach(f => assert.equal(f.gain.value, 0));
});

test('applyBand sets only the specified band', () => {
  const chain = createEqChain(makeMockAudioContext());
  applyBand(chain, 2, 5);
  assert.equal(chain[0].gain.value, 0);
  assert.equal(chain[2].gain.value, 5);
  assert.equal(chain[4].gain.value, 0);
});

test('applyBands is a no-op when eqFilterNodes is null', () => {
  assert.doesNotThrow(() => applyBands(null, PRESETS.flat));
});

test('clampGain clamps to [-12, 12]', () => {
  assert.equal(clampGain(-20), -12);
  assert.equal(clampGain(20), 12);
  assert.equal(clampGain(6), 6);
  assert.equal(clampGain(-12), -12);
  assert.equal(clampGain(12), 12);
});

test('connectProcessorToChain wires processor to first EQ node', () => {
  const connections = [];
  const first = { _n: 'eq0', connect(t) { connections.push(['eq0', t._n]); } };
  const gain  = { _n: 'gain' };
  const proc  = { connect(t) { connections.push(['proc', t._n]); } };
  connectProcessorToChain(proc, [first, { _n: 'eq1', connect() {} }], gain);
  assert.deepEqual(connections, [['proc', 'eq0']]);
});

test('connectProcessorToChain falls back to gainNode when chain is null', () => {
  const connections = [];
  const gain = { _n: 'gain' };
  const proc = { connect(t) { connections.push(['proc', t._n]); } };
  connectProcessorToChain(proc, null, gain);
  assert.deepEqual(connections, [['proc', 'gain']]);
});

test('wireEqChain connects nodes in sequence and last to gainNode', () => {
  const log = [];
  const makeNode = n => ({ _n: n, connect(t) { log.push([n, t._n]); } });
  const chain = [makeNode('a'), makeNode('b'), makeNode('c')];
  const gain  = { _n: 'gain' };
  wireEqChain(chain, gain);
  assert.deepEqual(log, [['a','b'], ['b','c'], ['c','gain']]);
});
