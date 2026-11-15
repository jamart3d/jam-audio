import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check_pack.mjs', import.meta.url));
const run = (paths, required = ['src/audio_bridge_activation.js']) =>
  spawnSync(process.execPath, [script, ...required], {
    input: JSON.stringify([{ files: paths.map((p) => ({ path: p })) }]),
    encoding: 'utf8',
  });

test('accepts required files without tests', () => {
  const r = run(['package.json', 'src/audio_bridge.js', 'src/audio_bridge_activation.js']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Package contents OK: 3 files/);
});

test('rejects a missing required file', () => {
  const r = run(['package.json', 'src/audio_bridge.js']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing required file: src\/audio_bridge_activation\.js/);
});

test('rejects packed test files', () => {
  const r = run(['src/audio_bridge_activation.js', 'src/audio_bridge_activation.test.js']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test file packed: src\/audio_bridge_activation\.test\.js/);
});

test('rejects unparseable input', () => {
  const r = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 1);
});
