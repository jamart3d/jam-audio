import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

const jsonPath = path.join(__dirname, 'worklet_shared_state.json');
const stateDef = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const jsConsts = [
  `const PROTOCOL_VERSION = ${stateDef.version};`,
  `const PROTOCOL_SLOTS = ${stateDef.slots};`,
];
for (const [key, value] of Object.entries(stateDef.indices)) {
  jsConsts.push(`const ${key} = ${value};`);
}
const jsReplacement = jsConsts.join('\n');

const rsReplacement = `pub const SHARED_STATE_SLOTS: usize = ${stateDef.slots};`;

const filesToUpdate = [
  {
    path: 'packages/jam-audio-engine/src/ring_buffer.rs',
    replacement: rsReplacement,
  },
  {
    path: 'packages/jam-audio-worklet/src/audio_processor.js',
    replacement: jsReplacement,
  },
  {
    path: 'packages/jam-audio-worklet/src/audio_playback_worker_controller.js',
    replacement: jsReplacement,
  },
  {
    path: 'packages/jam-audio-worklet/src/audio_bridge.js',
    replacement: jsReplacement,
  },
];

let drift = false;
const checkMode = process.argv.includes('--check');

for (const fileInfo of filesToUpdate) {
  const fullPath = path.join(root, fileInfo.path);
  const content = fs.readFileSync(fullPath, 'utf8');
  const startMarker = '// protocol:begin';
  const endMarker = '// protocol:end';
  
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);
  
  if (startIndex === -1 || endIndex === -1) {
    console.error(`Markers missing in ${fileInfo.path}`);
    process.exit(1);
  }
  
  const before = content.slice(0, startIndex + startMarker.length);
  const after = content.slice(endIndex);
  
  const expectedContent = before + '\n' + fileInfo.replacement + '\n' + after;
  
  if (content !== expectedContent) {
    if (checkMode) {
      console.error(`Drift detected in ${fileInfo.path}`);
      drift = true;
    } else {
      fs.writeFileSync(fullPath, expectedContent, 'utf8');
      console.log(`Updated ${fileInfo.path}`);
    }
  } else {
    console.log(`No changes needed for ${fileInfo.path}`);
  }
}

if (checkMode) {
  if (drift) {
    process.exit(1);
  } else {
    console.log('All files match expected protocol output.');
    process.exit(0);
  }
}
