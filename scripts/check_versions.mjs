import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(scriptDir, '..'));

function cargoManifestVersion(relativePath) {
  const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const packageBlock = text.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? '';
  const version = packageBlock.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error(`Missing package version in ${relativePath}`);
  return version;
}

function cargoLockVersions() {
  const text = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  const versions = new Map();
  for (const block of text.split('[[package]]').slice(1)) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version) versions.set(name, version);
  }
  return versions;
}

function packageLockVersion() {
  const candidates = [
    path.join(root, 'package-lock.json'),
    path.join(root, 'packages/jam-audio-worklet/package-lock.json'),
  ];
  const lockPath = candidates.find(fs.existsSync);
  if (!lockPath) return null;
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  return { path: path.relative(root, lockPath), version: lock.packages?.['']?.version ?? lock.version };
}

const expected = cargoManifestVersion('packages/jam-audio-engine/Cargo.toml');
const observed = [
  ['jam_audio_flutter manifest', cargoManifestVersion('packages/jam-audio-flutter/Cargo.toml')],
  ['worklet manifest', JSON.parse(fs.readFileSync(path.join(root, 'packages/jam-audio-worklet/package.json'), 'utf8')).version],
];
const lockVersions = cargoLockVersions();
observed.push(['Cargo.lock jam-audio-engine', lockVersions.get('jam-audio-engine')]);
observed.push(['Cargo.lock jam_audio_flutter', lockVersions.get('jam_audio_flutter')]);

const npmLock = packageLockVersion();
if (npmLock) observed.push([`${npmLock.path} root`, npmLock.version]);

const mismatches = observed.filter(([, version]) => version !== expected);
for (const [label, version] of mismatches) {
  console.error(`${label}: expected ${expected}, found ${version ?? 'missing'}`);
}
if (mismatches.length) process.exit(1);
if (!npmLock) console.log('SKIP package-lock.json: not present');
console.log(`Version consistency OK: ${expected}`);
