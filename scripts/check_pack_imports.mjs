// Verifies every relative import in packed non-test .js files resolves to a
// file that is itself in the package. Usage:
//   npm pack --dry-run --json | node scripts/check_pack_imports.mjs <package-dir>
import fs from 'node:fs';
import path from 'node:path';

const packageDir = process.argv[2];
if (!packageDir) {
  console.error('usage: check_pack_imports.mjs <package-dir> (npm pack --json on stdin)');
  process.exit(1);
}

let files;
try {
  const parsed = JSON.parse(fs.readFileSync(0, 'utf8'));
  files = new Set(parsed.flatMap((entry) => entry.files.map((f) => f.path)));
} catch (error) {
  console.error(`Cannot parse npm pack --json output: ${error.message}`);
  process.exit(1);
}

const specifierPatterns = [
  /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
];

const problems = [];
for (const file of files) {
  if (!file.endsWith('.js') || file.endsWith('.test.js')) continue;
  const source = fs.readFileSync(path.join(packageDir, file), 'utf8');
  for (const pattern of specifierPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!files.has(resolved)) {
        problems.push(`${file} imports ${specifier}, which is not packed (${resolved})`);
      }
    }
  }
}

for (const problem of problems) console.error(problem);
if (problems.length) process.exit(1);
console.log(`Package imports OK: ${files.size} files`);
