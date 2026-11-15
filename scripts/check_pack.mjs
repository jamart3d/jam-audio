import fs from 'node:fs';

const required = process.argv.slice(2);
let files;
try {
  const parsed = JSON.parse(fs.readFileSync(0, 'utf8'));
  files = parsed.flatMap((entry) => entry.files.map((f) => f.path));
} catch (error) {
  console.error(`Cannot parse npm pack --json output: ${error.message}`);
  process.exit(1);
}

const problems = [
  ...required.filter((p) => !files.includes(p)).map((p) => `missing required file: ${p}`),
  ...files.filter((p) => p.endsWith('.test.js')).map((p) => `test file packed: ${p}`),
];
for (const problem of problems) console.error(problem);
if (problems.length) process.exit(1);
console.log(`Package contents OK: ${files.length} files`);
