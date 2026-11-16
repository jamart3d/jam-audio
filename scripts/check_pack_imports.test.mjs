import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check_pack_imports.mjs', import.meta.url));

function run(files, packed = Object.keys(files)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-imports-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return spawnSync(process.execPath, [script, dir], {
      input: JSON.stringify([{ files: packed.map((p) => ({ path: p })) }]),
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('accepts relative imports that resolve to packed files', () => {
  const r = run({
    'src/a.js': "import { x } from './b.js';\nexport { x };\n",
    'src/b.js': 'export const x = 1;\n',
  });
  assert.equal(r.status, 0, r.stderr);
});

test('rejects a relative import that escapes the packed files', () => {
  const r = run(
    {
      'src/a.js': "import { x } from '../shared/core.js';\n",
      'shared/core.js': 'export const x = 1;\n',
    },
    ['src/a.js'],
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/a\.js imports \.\.\/shared\/core\.js, which is not packed \(shared\/core\.js\)/);
});

test('checks multi-line, export-from and dynamic imports, ignores bare specifiers', () => {
  const r = run(
    {
      'src/a.js': "import {\n  x,\n} from './missing.js';\nexport * from './gone.js';\nimport('./lazy.js');\nimport fs from 'node:fs';\n",
    },
    ['src/a.js'],
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.\/missing\.js/);
  assert.match(r.stderr, /\.\/gone\.js/);
  assert.match(r.stderr, /\.\/lazy\.js/);
  assert.doesNotMatch(r.stderr, /node:fs/);
});

test('ignores packed test files', () => {
  const r = run({ 'src/a.test.js': "import './nowhere.js';\n" });
  assert.equal(r.status, 0, r.stderr);
});
