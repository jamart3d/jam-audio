import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check_versions.mjs', import.meta.url));

function fixture({ flutter = '0.5.2', lockFlutter = '0.5.2', packageLock } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jam-audio-versions-'));
  for (const dir of ['packages/jam-audio-engine', 'packages/jam-audio-flutter', 'packages/jam-audio-worklet']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, 'packages/jam-audio-engine/Cargo.toml'), '[package]\nname = "jam-audio-engine"\nversion = "0.5.2"\n');
  writeFileSync(path.join(root, 'packages/jam-audio-flutter/Cargo.toml'), `[package]\nname = "jam_audio_flutter"\nversion = "${flutter}"\n`);
  writeFileSync(path.join(root, 'packages/jam-audio-worklet/package.json'), JSON.stringify({ name: '@jamart3d/jam-audio-worklet', version: '0.5.2' }));
  writeFileSync(path.join(root, 'Cargo.lock'), `[[package]]\nname = "jam-audio-engine"\nversion = "0.5.2"\n\n[[package]]\nname = "jam_audio_flutter"\nversion = "${lockFlutter}"\n`);
  if (packageLock) writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(packageLock));
  return root;
}

test('accepts matching manifests and Cargo.lock without package-lock.json', () => {
  const output = execFileSync(process.execPath, [script, fixture()], { encoding: 'utf8' });
  assert.match(output, /Version consistency OK: 0\.5\.2/);
  assert.match(output, /SKIP package-lock\.json: not present/);
});

test('rejects a manifest mismatch', () => {
  const result = spawnSync(process.execPath, [script, fixture({ flutter: '0.5.1' })], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /jam_audio_flutter manifest: expected 0\.5\.2, found 0\.5\.1/);
});

test('rejects a Cargo.lock mismatch', () => {
  const result = spawnSync(process.execPath, [script, fixture({ lockFlutter: '0.5.1' })], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cargo\.lock jam_audio_flutter: expected 0\.5\.2, found 0\.5\.1/);
});

test('checks a package-lock root version when present', () => {
  const packageLock = { name: '@jamart3d/jam-audio-worklet', version: '0.5.1', packages: { '': { version: '0.5.1' } } };
  const result = spawnSync(process.execPath, [script, fixture({ packageLock })], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package-lock\.json root: expected 0\.5\.2, found 0\.5\.1/);
});
