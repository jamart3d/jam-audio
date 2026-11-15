# Jam Audio 0.5.2 Release Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the existing worklet fixes as a local 0.5.2 release and add a tested, interrupt-safe verifier that runs independent release gates concurrently.

**Architecture:** Add two dependency-free Node checkers (versions, package contents) and one Linux Bash orchestration script. The Bash script parses its CLI, resolves group definitions, performs preflight checks, launches isolated process groups, records status and duration sidecars, waits for every group, and aggregates failures without changing tracked source. Tooling and docs land first; the release metadata commit is created last, only after the full verifier passes, so it is the obvious tag target.

**Tech Stack:** Bash 5, GNU `setsid`, Node.js 20 ES modules and `node:test`, Cargo/Rust stable, npm 11, Git.

## Global Constraints

- Target release version is exactly `0.5.2`, dated `2026-11-15` in the existing changelog format (`Added` / `Changed` / `Fixed` sections only).
- Keep `packages/jam-audio-engine`, `packages/jam-audio-flutter`, and `packages/jam-audio-worklet` in lockstep.
- Do not add dependencies, change product behavior, delete or migrate caches, create tags, push, or publish.
- Do not claim fresh real-device or real-browser coverage.
- Verification must be read-only with respect to tracked source; protocol validation must use `node protocol/generate.mjs --check`.
- Keep Cargo build commands sequential inside one group and run them from the workspace root so they share `target/` without lock contention.
- The repository has no `package-lock.json` and no root `package.json`. The version checker must validate the top-level/root version if a root or worklet `package-lock.json` appears, but must report a non-failing `SKIP` while neither exists. Do not create a lockfile solely for this release.
- Only the tracked workspace `Cargo.lock` is release-relevant. The ignored package-local lockfiles contain historical `0.2.15` entries and must not be edited or treated as release inputs.
- The 0.5.1 release commit is `35fd5a0` (`Release 0.5.1`); there is no `v0.5.1` tag.
- Preserve the user's revised, uncommitted design-spec changes; do not overwrite or revert them.
- Restore `packages/jam-audio-flutter/src/frb_generated.rs` to HEAD (which already has rustfmt ordering) with `git restore`; do not run workspace-wide `cargo fmt`.
- All `npm pack` invocations run from inside `packages/jam-audio-worklet` (`cd … && npm pack …`), never via `--prefix`.
- `RELEASING.md` must reference the verifier as the single source of verification commands rather than duplicate its flags.
- If any baseline command fails (Task 0), stop and report to the user before scoping fixes.

---

## File Structure

- Create `scripts/check_versions.mjs`: dependency-free manifest/lockfile consistency checker with an optional repository-root argument for fixtures.
- Create `scripts/check_versions.test.mjs`: fixture-based mismatch and optional-package-lock tests.
- Create `scripts/check_pack.mjs`: reads `npm pack --dry-run --json` output on stdin; asserts required files are present and no `*.test.js` files are packed.
- Create `scripts/check_pack.test.mjs`: fixture-based tests for the pack checker.
- Create `scripts/verify-release.sh`: CLI handling, group definitions, preflight, concurrent execution, aggregation, signal cleanup, logging, provenance.
- Create `scripts/verify-release.test.sh`: black-box tests using `VERIFY_GROUPS_FILE`, `--list`, and temporary fixtures.
- Modify `RELEASING.md`: canonical verifier invocation, keep release/tag/publish steps, distinguish local package inspection from authenticated registry dry-runs.
- Modify `packages/jam-audio-engine/Cargo.toml`, `packages/jam-audio-flutter/Cargo.toml`, `packages/jam-audio-worklet/package.json`: version 0.5.2.
- Modify `Cargo.lock`: only the two tracked local crate version lines.
- Modify `CHANGELOG.md`: dated 0.5.2 release entry.
- Restore `packages/jam-audio-flutter/src/frb_generated.rs` to HEAD (no final diff).

### Commit order

1. `test: enforce lockstep release versions` (Task 1)
2. `test: assert worklet package contents` (Task 2)
3. `build: add parallel release verifier` (Task 3)
4. `docs: make release verification canonical` (Task 4)
5. `Release 0.5.2` (Task 6, after Task 5 passes)

---

### Task 0: Baseline the current tree

**Files:** none modified.

**Purpose:** Learn which production gates already fail before writing tooling, so lint/format debt does not silently expand scope.

- [ ] **Step 1: Record environment**

```bash
bash --version | head -1; node --version; npm --version; cargo --version; rustup target list --installed; command -v setsid
git status --short
```

- [ ] **Step 2: Run every planned production command once, from the workspace root, continuing past failures**

```bash
run() { printf '\n=== %s\n' "$*"; ( eval "$*" ); printf '=== exit %s\n' "$?"; }
run 'npm --prefix packages/jam-audio-worklet test'
run 'cargo clippy --all-targets -- -D warnings'
run 'cargo check --manifest-path packages/jam-audio-engine/Cargo.toml'
run 'cargo check --manifest-path packages/jam-audio-engine/Cargo.toml --target wasm32-unknown-unknown'
run 'cargo check --manifest-path packages/jam-audio-flutter/Cargo.toml'
run 'cargo test --manifest-path packages/jam-audio-engine/Cargo.toml'
run 'cargo fmt --check'
run 'node protocol/generate.mjs --check'
run 'git diff --check HEAD'
run 'git diff --check 35fd5a0..HEAD'
run 'set -o pipefail; cd packages/jam-audio-worklet && npm pack --dry-run --json --offline --ignore-scripts --cache "$(mktemp -d)" | head -c 2000'
```

Expected: `cargo fmt --check` fails only on the three known `frb_generated.rs` import lines (fixed in Task 5). Everything else should pass.

- [ ] **Step 3: Gate**

If any command other than the known `frb_generated.rs` formatting failure exits non-zero, **stop and report the failing commands and their output to the user**. Do not fix lint, formatting, whitespace, or test failures without explicit scope approval. Also confirm `npm pack --json` lists `src/audio_bridge_activation.js` and no `*.test.js`.

---

### Task 1: Version-consistency checker

**Files:**
- Create: `scripts/check_versions.mjs`
- Create: `scripts/check_versions.test.mjs`

**Interfaces:**
- Consumes: repository root as `process.argv[2]`, defaulting to the parent of `scripts/`.
- Produces: exit 0 plus `Version consistency OK: X.Y.Z`; exit 1 plus one line per mismatch; optional `SKIP package-lock.json: not present`.

- [ ] **Step 1: Write fixture-based failing tests**

Create `scripts/check_versions.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test scripts/check_versions.test.mjs`

Expected: FAIL because `scripts/check_versions.mjs` does not exist.

- [ ] **Step 3: Implement the minimal checker**

Create `scripts/check_versions.mjs`:

```js
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
```

- [ ] **Step 4: Run the checker tests and current-repository check**

```bash
node --test scripts/check_versions.test.mjs
node scripts/check_versions.mjs
```

Expected: four tests pass; current repository prints the package-lock skip and `Version consistency OK: 0.5.1`.

- [ ] **Step 5: Commit**

```bash
git add scripts/check_versions.mjs scripts/check_versions.test.mjs
git commit -m "test: enforce lockstep release versions"
```

---

### Task 2: Package-content checker

**Files:**
- Create: `scripts/check_pack.mjs`
- Create: `scripts/check_pack.test.mjs`

**Interfaces:**
- Consumes: `npm pack --dry-run --json` output on stdin; required file paths as arguments.
- Produces: exit 0 plus `Package contents OK: N files`; exit 1 plus one line per missing required file or packed test file.

- [ ] **Step 1: Write failing tests**

Create `scripts/check_pack.test.mjs`:

```js
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
```

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/check_pack.test.mjs` — expected FAIL (script missing).

- [ ] **Step 3: Implement**

Create `scripts/check_pack.mjs`:

```js
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
```

- [ ] **Step 4: Verify GREEN against fixtures and the real package**

```bash
node --test scripts/check_pack.test.mjs
(cd packages/jam-audio-worklet && npm pack --dry-run --json --offline --ignore-scripts --cache "$(mktemp -d)") \
  | node scripts/check_pack.mjs src/audio_bridge_activation.js
```

Expected: four tests pass; real package reports `Package contents OK`.

- [ ] **Step 5: Commit**

```bash
git add scripts/check_pack.mjs scripts/check_pack.test.mjs
git commit -m "test: assert worklet package contents"
```

---

### Task 3: Parallel verifier and failure aggregation

**Files:**
- Create: `scripts/verify-release.sh`
- Create: `scripts/verify-release.test.sh`

**Interfaces:**
- CLI: `--keep-logs`, `--list`, `-h|--help`; unknown arguments print usage and exit 2.
- Environment: `KEEP_LOGS=1`, `VERIFY_GROUPS_FILE=/absolute/path`, `VERIFY_GROUPS_MODE=replace|extend`, `VERIFY_BASE_REF=<git ref>`.
- Override file API: shell code calls `add_group <name> <command>`; `replace` is the default mode, `extend` retains production groups.
- `--list` prints configured group names (one per line) after override resolution and exits 0 without preflight or execution.
- Produces: a provenance line (`Verifying <sha> (clean|dirty)`), one `PASS`/`FAIL` line with integer duration per group; exit 0 only when every group succeeds.
- Release-range whitespace check fails closed: uses `VERIFY_BASE_REF` if set, else the latest `v*` tag reachable from HEAD. If neither exists, or the ref does not resolve, the static group fails with `no base ref; set VERIFY_BASE_REF=<ref> or VERIFY_BASE_REF=none to skip`. `VERIFY_BASE_REF=none` is the only skip path; it is logged in the group and repeated as a `WARNING` line in the final summary so a skip is never presented as a plain pass.

- [ ] **Step 1: Write black-box tests before the script exists**

Create `scripts/verify-release.test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
VERIFY="$ROOT/scripts/verify-release.sh"
TEST_DIR=$(mktemp -d /tmp/jam-audio-verify-test.XXXXXX)
trap 'rm -rf "$TEST_DIR"' EXIT

# --- usage error
set +e
"$VERIFY" --bogus > "$TEST_DIR/usage.out" 2>&1
status=$?
set -e
test "$status" -eq 2
grep -q '^Usage:' "$TEST_DIR/usage.out"

# --- list: production groups, replace, extend
"$VERIFY" --list > "$TEST_DIR/list-prod.out"
diff <(printf '%s\n' worklet rust static package) "$TEST_DIR/list-prod.out"

cat > "$TEST_DIR/extra-groups.sh" <<'EOF'
add_group extra 'true'
EOF
VERIFY_GROUPS_FILE="$TEST_DIR/extra-groups.sh" "$VERIFY" --list > "$TEST_DIR/list-replace.out"
diff <(printf '%s\n' extra) "$TEST_DIR/list-replace.out"
VERIFY_GROUPS_FILE="$TEST_DIR/extra-groups.sh" VERIFY_GROUPS_MODE=extend "$VERIFY" --list > "$TEST_DIR/list-extend.out"
diff <(printf '%s\n' worklet rust static package extra) "$TEST_DIR/list-extend.out"

# --- success aggregation + provenance
cat > "$TEST_DIR/success-groups.sh" <<'EOF'
add_group fast 'printf "fast complete\n"'
add_group slow 'sleep 1; printf "slow complete\n"'
EOF
VERIFY_GROUPS_FILE="$TEST_DIR/success-groups.sh" "$VERIFY" --keep-logs > "$TEST_DIR/success.out"
grep -Eq '^Verifying [0-9a-f]{40} \((clean|dirty)\)$' "$TEST_DIR/success.out"
grep -Eq '^PASS[[:space:]]+fast[[:space:]]+[0-9]+s$' "$TEST_DIR/success.out"
grep -Eq '^PASS[[:space:]]+slow[[:space:]]+[0-9]+s$' "$TEST_DIR/success.out"
grep -q '^Not covered:' "$TEST_DIR/success.out"
logdir=$(sed -n 's/^Logs retained: //p' "$TEST_DIR/success.out")
test -f "$logdir/fast.log" && rm -rf "$logdir"

# --- failure aggregation: all groups finish, failing tail printed
cat > "$TEST_DIR/failing-groups.sh" <<EOF
add_group passing 'sleep 1; touch "$TEST_DIR/passing-finished"'
add_group failing 'printf "CONTROLLED_FAILURE_SENTINEL\\\\n"; exit 23'
add_group pipefail 'false | true'
EOF
set +e
VERIFY_GROUPS_FILE="$TEST_DIR/failing-groups.sh" "$VERIFY" > "$TEST_DIR/failing.out" 2>&1
status=$?
set -e
test "$status" -eq 1
test -f "$TEST_DIR/passing-finished"
grep -Eq '^PASS[[:space:]]+passing' "$TEST_DIR/failing.out"
grep -Eq '^FAIL[[:space:]]+failing.*\(exit 23\)' "$TEST_DIR/failing.out"
grep -Eq '^FAIL[[:space:]]+pipefail' "$TEST_DIR/failing.out"
grep -q CONTROLLED_FAILURE_SENTINEL "$TEST_DIR/failing.out"

# --- release-range base ref fails closed; explicit none skips with a warning
cat > "$TEST_DIR/range-groups.sh" <<'EOF'
add_group range 'check_release_range_whitespace'
EOF
set +e
VERIFY_GROUPS_FILE="$TEST_DIR/range-groups.sh" VERIFY_BASE_REF=no-such-ref-xyz \
  "$VERIFY" > "$TEST_DIR/range-bad.out" 2>&1
status=$?
set -e
test "$status" -eq 1
grep -Eq '^FAIL[[:space:]]+range' "$TEST_DIR/range-bad.out"
grep -q 'VERIFY_BASE_REF=none to skip' "$TEST_DIR/range-bad.out"
VERIFY_GROUPS_FILE="$TEST_DIR/range-groups.sh" VERIFY_BASE_REF=none \
  "$VERIFY" > "$TEST_DIR/range-none.out" 2>&1
grep -Eq '^PASS[[:space:]]+range' "$TEST_DIR/range-none.out"
grep -q '^WARNING: release-range whitespace check skipped' "$TEST_DIR/range-none.out"
VERIFY_GROUPS_FILE="$TEST_DIR/range-groups.sh" VERIFY_BASE_REF=HEAD \
  "$VERIFY" > "$TEST_DIR/range-head.out" 2>&1
grep -Eq '^PASS[[:space:]]+range' "$TEST_DIR/range-head.out"
! grep -q '^WARNING' "$TEST_DIR/range-head.out"

# --- interrupt: descendants (incl. grandchildren) are killed
cat > "$TEST_DIR/interrupt-groups.sh" <<EOF
add_group tree 'bash -c "sleep 60 & echo \\\$! > \"$TEST_DIR/child.pid\"; wait"'
EOF
VERIFY_GROUPS_FILE="$TEST_DIR/interrupt-groups.sh" "$VERIFY" > "$TEST_DIR/interrupt.out" 2>&1 &
verifier_pid=$!
for _ in {1..50}; do test -s "$TEST_DIR/child.pid" && break; sleep 0.1; done
test -s "$TEST_DIR/child.pid"
child_pid=$(cat "$TEST_DIR/child.pid")
kill -TERM "$verifier_pid"
set +e
wait "$verifier_pid"
status=$?
set -e
test "$status" -eq 143
sleep 0.2
! kill -0 "$child_pid" 2>/dev/null

printf 'verify-release tests passed\n'
```

- [ ] **Step 2: Make executable and verify RED**

```bash
chmod +x scripts/verify-release.test.sh
bash scripts/verify-release.test.sh
```

Expected: FAIL because `scripts/verify-release.sh` does not exist.

- [ ] **Step 3: Implement CLI, group definitions, and override resolution**

Create `scripts/verify-release.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
KEEP_LOGS=${KEEP_LOGS:-0}
LIST_ONLY=0
usage() { echo "Usage: $0 [--keep-logs] [--list]"; }
for arg in "$@"; do
  case "$arg" in
    --keep-logs) KEEP_LOGS=1 ;;
    --list) LIST_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

declare -a GROUP_NAMES=() GROUP_COMMANDS=() GROUP_PIDS=() GROUP_LOGS=() GROUP_DURATIONS=()
add_group() {
  test "$#" -eq 2 || { echo 'add_group requires NAME and COMMAND' >&2; exit 2; }
  GROUP_NAMES+=("$1")
  GROUP_COMMANDS+=("$2")
}

# Single source of truth for release verification commands.
add_production_groups() {
  add_group worklet 'npm --prefix packages/jam-audio-worklet test'
  add_group rust 'cargo clippy --all-targets -- -D warnings && cargo check --manifest-path packages/jam-audio-engine/Cargo.toml && cargo check --manifest-path packages/jam-audio-engine/Cargo.toml --target wasm32-unknown-unknown && cargo check --manifest-path packages/jam-audio-flutter/Cargo.toml && cargo test --manifest-path packages/jam-audio-engine/Cargo.toml'
  add_group static 'cargo fmt --check && node protocol/generate.mjs --check && node scripts/check_versions.mjs && git diff --check HEAD && check_release_range_whitespace'
  add_group package '(cd packages/jam-audio-worklet && npm pack --dry-run --json --offline --ignore-scripts --cache "$NPM_CACHE_DIR") | node scripts/check_pack.mjs src/audio_bridge_activation.js'
}

add_production_groups
if [[ -n "${VERIFY_GROUPS_FILE:-}" ]]; then
  [[ -r "$VERIFY_GROUPS_FILE" ]] || { echo "Cannot read VERIFY_GROUPS_FILE: $VERIFY_GROUPS_FILE" >&2; exit 2; }
  case "${VERIFY_GROUPS_MODE:-replace}" in
    replace) GROUP_NAMES=(); GROUP_COMMANDS=() ;;
    extend) ;;
    *) echo 'VERIFY_GROUPS_MODE must be replace or extend' >&2; exit 2 ;;
  esac
  # shellcheck source=/dev/null
  source "$VERIFY_GROUPS_FILE"
fi
test "${#GROUP_NAMES[@]}" -gt 0 || { echo 'No verification groups configured' >&2; exit 2; }

if [[ "$LIST_ONLY" == 1 ]]; then
  printf '%s\n' "${GROUP_NAMES[@]}"
  exit 0
fi
```

- [ ] **Step 4: Implement preflight, traps, and the release-range helper**

Append. Traps are installed **before** the log directory is created; `cleanup` tolerates an unset `LOG_DIR`.

```bash
for tool in cargo node npm rustup setsid git; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 2; }
done
rustup target list --installed | grep -qx wasm32-unknown-unknown || {
  echo 'Missing Rust target: wasm32-unknown-unknown' >&2
  exit 2
}

LOG_DIR=''
cleanup() {
  local pgid
  for pgid in "${GROUP_PIDS[@]}"; do
    kill -0 -- "-$pgid" 2>/dev/null && kill -TERM -- "-$pgid" 2>/dev/null || true
  done
  for pgid in "${GROUP_PIDS[@]}"; do
    wait "$pgid" 2>/dev/null || true
  done
  if [[ -n "$LOG_DIR" ]]; then
    if [[ "$KEEP_LOGS" == 1 ]]; then
      printf 'Logs retained: %s\n' "$LOG_DIR"
    else
      rm -rf "$LOG_DIR"
    fi
  fi
}
on_signal() {
  trap - INT TERM EXIT
  cleanup
  exit "$1"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap cleanup EXIT

LOG_DIR=$(mktemp -d /tmp/jam-audio-verify.XXXXXX)
NPM_CACHE_DIR="$LOG_DIR/npm-cache"
mkdir -p "$NPM_CACHE_DIR"
export NPM_CACHE_DIR

check_release_range_whitespace() {
  local base=${VERIFY_BASE_REF:-}
  if [[ "$base" == none ]]; then
    echo 'SKIPPED release-range whitespace: VERIFY_BASE_REF=none'
    return 0
  fi
  [[ -n "$base" ]] || base=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
  if [[ -z "$base" ]] || ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    echo "no base ref${base:+ ($base does not resolve)}; set VERIFY_BASE_REF=<ref> or VERIFY_BASE_REF=none to skip" >&2
    return 1
  fi
  echo "release-range whitespace: $base..HEAD"
  git diff --check "$base..HEAD"
}
export -f check_release_range_whitespace
```

- [ ] **Step 5: Implement provenance, process-group execution, and exact status capture**

Append. Group commands run under non-login `bash -o pipefail -c`.

```bash
cd "$ROOT"
head_sha=$(git rev-parse HEAD)
if [[ -n "$(git status --porcelain)" ]]; then tree_state=dirty; else tree_state=clean; fi
printf 'Verifying %s (%s)\n' "$head_sha" "$tree_state"

for i in "${!GROUP_NAMES[@]}"; do
  name=${GROUP_NAMES[$i]}
  log="$LOG_DIR/$name.log"
  duration="$LOG_DIR/$name.duration"
  GROUP_LOGS+=("$log")
  GROUP_DURATIONS+=("$duration")
  setsid bash -c '
    start=$(date +%s)
    bash -o pipefail -c "$1"
    status=$?
    end=$(date +%s)
    printf "%s\n" "$((end - start))" > "$2"
    exit "$status"
  ' _ "${GROUP_COMMANDS[$i]}" "$duration" > "$log" 2>&1 &
  GROUP_PIDS+=("$!")
done

statuses=()
for i in "${!GROUP_PIDS[@]}"; do
  set +e
  wait "${GROUP_PIDS[$i]}"
  statuses+=("$?")
  set -e
done
```

Note: because job control (`set -m`) is disabled, the background child begins outside its own process group; `setsid` can therefore create a new session and process group, then exec in place. `$!` is both the resulting PID and PGID.

- [ ] **Step 6: Implement summary and failure-log output**

```bash
failed=0
for i in "${!GROUP_NAMES[@]}"; do
  duration=$(cat "${GROUP_DURATIONS[$i]}" 2>/dev/null || printf '?')
  if [[ "${statuses[$i]}" -eq 0 ]]; then
    printf 'PASS\t%s\t%ss\n' "${GROUP_NAMES[$i]}" "$duration"
  else
    failed=1
    printf 'FAIL\t%s\t%ss (exit %s)\n' "${GROUP_NAMES[$i]}" "$duration" "${statuses[$i]}"
    printf '%s\n' "--- tail: ${GROUP_LOGS[$i]} ---"
    tail -n 80 "${GROUP_LOGS[$i]}" || true
  fi
done

if [[ "${VERIFY_BASE_REF:-}" == none ]]; then
  printf '%s\n' 'WARNING: release-range whitespace check skipped (VERIFY_BASE_REF=none)'
fi
if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
printf '%s\n' 'Verification passed.'
printf '%s\n' 'Not covered: real-device/browser validation, registry authentication, tagging, pushing, or publication.'
```

- [ ] **Step 7: Run syntax checks and black-box tests**

```bash
chmod +x scripts/verify-release.sh
bash -n scripts/verify-release.sh scripts/verify-release.test.sh
bash scripts/verify-release.test.sh
```

Expected: syntax passes; output ends with `verify-release tests passed`.

- [ ] **Step 8: Add a missing-target preflight test without touching the Rust installation**

Append before the final `printf` in `scripts/verify-release.test.sh`:

```bash
mkdir -p "$TEST_DIR/fake-bin"
for tool in cargo node npm setsid git; do
  real=$(command -v "$tool")
  printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$real" > "$TEST_DIR/fake-bin/$tool"
  chmod +x "$TEST_DIR/fake-bin/$tool"
done
cat > "$TEST_DIR/fake-bin/rustup" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == 'target list --installed' ]]; then exit 0; fi
exit 64
EOF
chmod +x "$TEST_DIR/fake-bin/rustup"
set +e
PATH="$TEST_DIR/fake-bin:/usr/bin:/bin" VERIFY_GROUPS_FILE="$TEST_DIR/success-groups.sh" \
  "$VERIFY" > "$TEST_DIR/preflight.out" 2>&1
status=$?
set -e
test "$status" -eq 2
grep -q 'Missing Rust target: wasm32-unknown-unknown' "$TEST_DIR/preflight.out"
```

Run: `bash scripts/verify-release.test.sh` — expected: usage, list, success, failure, interrupt, and preflight cases pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/verify-release.sh scripts/verify-release.test.sh
git commit -m "build: add parallel release verifier"
```

---

### Task 4: Make the verifier canonical in release documentation

**Files:**
- Modify: `RELEASING.md`
- Modify: `scripts/verify-release.test.sh`

- [ ] **Step 1: Write a documentation-contract assertion**

Append before the final `printf` in `scripts/verify-release.test.sh`:

```bash
grep -q 'scripts/verify-release.sh' "$ROOT/RELEASING.md"
test "$(grep -c 'cargo clippy' "$ROOT/RELEASING.md" || true)" -eq 0
test "$(grep -c 'npm pack' "$ROOT/RELEASING.md" || true)" -eq 0
```

- [ ] **Step 2: Verify RED**

Run: `bash scripts/verify-release.test.sh` — expected FAIL (`RELEASING.md` does not reference the verifier).

- [ ] **Step 3: Replace duplicated validation commands with the canonical invocation**

Replace checklist step 4 with:

````markdown
4. Run the canonical local release verification:

```bash
VERIFY_BASE_REF=<previous release commit or tag> scripts/verify-release.sh
```

`VERIFY_BASE_REF` defaults to the latest `v*` tag; with no tag and no explicit ref the verifier fails rather than skipping the release-range check. `VERIFY_BASE_REF=none` skips it explicitly and is flagged with a `WARNING` in the summary. Use `--keep-logs` (or `KEEP_LOGS=1`) to keep complete group logs, and `--list` to see the configured groups. The script owns the exact verification commands and runs independent groups concurrently. It validates formatting, versions, protocol output, whitespace (working tree and release range), package contents, worklet behavior, and Rust checks/tests. It does not cover real-device/browser validation, registry authentication, tagging, pushing, or publication.
````

Keep final diff review, commit, tag, push, registry dry-run, and publication as separate numbered steps. Update the release commit example to stage `Cargo.lock` as well.

- [ ] **Step 4: Clarify local package inspection versus authenticated registry dry-run**

Add immediately below `## Registry Publishing Dry-Run`, retaining the existing authenticated worklet and Wasm commands:

```markdown
The canonical verifier performs offline package-content inspection only. Before publication, run these registry-facing dry-runs with the intended npm identity and network access; they are not covered by `scripts/verify-release.sh`.
```

- [ ] **Step 5: Run tests**

```bash
bash scripts/verify-release.test.sh
git diff --check HEAD -- RELEASING.md scripts/verify-release.test.sh
```

- [ ] **Step 6: Commit**

```bash
git add RELEASING.md scripts/verify-release.test.sh
git commit -m "docs: make release verification canonical"
```

---

### Task 5: Prepare 0.5.2 metadata (uncommitted) and run full verification

**Files:**
- Modify: `packages/jam-audio-engine/Cargo.toml`, `packages/jam-audio-flutter/Cargo.toml`, `packages/jam-audio-worklet/package.json`
- Modify: `Cargo.lock` (two local version lines only)
- Modify: `CHANGELOG.md`
- Restore: `packages/jam-audio-flutter/src/frb_generated.rs`

- [ ] **Step 1: Restore the generated bridge file**

```bash
git restore packages/jam-audio-flutter/src/frb_generated.rs
git diff --quiet -- packages/jam-audio-flutter/src/frb_generated.rs
cargo fmt --check
```

Expected: no diff; rustfmt passes. Note for the handoff that this drift likely originates from FRB codegen and may recur on regeneration.

- [ ] **Step 2: Bump all three tracked manifests to `0.5.2`**

```toml
# packages/jam-audio-engine/Cargo.toml and packages/jam-audio-flutter/Cargo.toml
version = "0.5.2"
```

```json
// packages/jam-audio-worklet/package.json
"version": "0.5.2",
```

- [ ] **Step 3: Update the tracked workspace lockfile and guard against drift**

```bash
cargo check --workspace
git diff --unified=0 Cargo.lock | grep -E '^[-+][^-+]' > /tmp/jam-audio-lock-diff.txt
cat /tmp/jam-audio-lock-diff.txt
test "$(wc -l < /tmp/jam-audio-lock-diff.txt)" -eq 4
grep -c '^-version = "0.5.1"$' /tmp/jam-audio-lock-diff.txt | grep -qx 2
grep -c '^+version = "0.5.2"$' /tmp/jam-audio-lock-diff.txt | grep -qx 2
git status --ignored --short packages/jam-audio-engine/Cargo.lock packages/jam-audio-flutter/Cargo.lock
```

Expected: exactly two version lines change (for `jam-audio-engine` and `jam_audio_flutter`); ignored package-local lockfiles unchanged. If any other line changes, stop and report.

- [ ] **Step 4: Verify changelog wording against the actual release slice**

```bash
git log --oneline 35fd5a0..HEAD
git diff --stat 35fd5a0..HEAD -- packages/
git log 35fd5a0..HEAD --format='%h %s%n%b' -- packages/jam-audio-worklet
```

Confirm each bullet below is supported by the commits (282754b, 5d1b2d7, 9cd2b24, 0e6fa00) and adjust wording if not. Do not describe tooling commits as user-visible changes.

- [ ] **Step 5: Add the 0.5.2 changelog entry**

Insert below `# Changelog`, matching the existing `Added`/`Changed`/`Fixed` format:

```markdown
## [0.5.2] - 2026-11-15

### Changed
- Require explicit Play authorization for browser-blocked audio starts instead of allowing unrelated document gestures to release pending output.

### Fixed
- Resume the audio context synchronously from explicit playback gestures and guard startup publication against stale request generations and replaced audio contexts.
- Keep Media Session playback state truthful while resume remains suspended and prevent completed or cancelled starts from re-arming stale activation state.
- Added regression coverage for activation gesture timing, cancellation, context replacement, stale settlements, held output, and Media Session state.

```

Do not add compare links because `v0.5.1` is missing.

- [ ] **Step 6: Run all checker/orchestrator tests directly**

```bash
node --test scripts/check_versions.test.mjs scripts/check_pack.test.mjs
bash -n scripts/verify-release.sh scripts/verify-release.test.sh
bash scripts/verify-release.test.sh
```

- [ ] **Step 7: Run the production verifier with the release range**

```bash
set -o pipefail
VERIFY_BASE_REF=35fd5a0 /usr/bin/time -f 'parallel_seconds=%e' scripts/verify-release.sh --keep-logs \
  2>&1 | tee /tmp/jam-audio-parallel-verification.out
```

Expected: `Verifying <sha> (dirty)`; `PASS` for worklet, rust, static, package; static log shows `Version consistency OK: 0.5.2`; package log shows `Package contents OK`; exit 0; limitation notice. Record each group duration, total wall time, and the retained log directory.

- [ ] **Step 8: Check for Cargo lock contention**

```bash
LOG_DIR=$(sed -n 's/^Logs retained: //p' /tmp/jam-audio-parallel-verification.out)
test -n "$LOG_DIR" && test -d "$LOG_DIR"
grep -l 'Blocking waiting for file lock' "$LOG_DIR"/*.log || echo 'no lock contention'
```

If the static log shows lock blocking, or the static group duration approaches the rust group duration, move `cargo fmt --check` into the rust group, re-run Task 3 tests and Step 7, and add a follow-up commit (`build: move rustfmt into rust group`).

- [ ] **Step 9: Measure the equivalent groups serially once**

Copy the commands exactly from `add_production_groups` (warm caches, do not clear `target/`):

```bash
serial_cache=$(mktemp -d /tmp/jam-audio-serial-npm.XXXXXX)
VERIFY_BASE_REF=35fd5a0 /usr/bin/time -f 'serial_seconds=%e' bash -o pipefail -c '
  source <(sed -n "/^check_release_range_whitespace()/,/^}/p" scripts/verify-release.sh)
  npm --prefix packages/jam-audio-worklet test &&
  cargo clippy --all-targets -- -D warnings &&
  cargo check --manifest-path packages/jam-audio-engine/Cargo.toml &&
  cargo check --manifest-path packages/jam-audio-engine/Cargo.toml --target wasm32-unknown-unknown &&
  cargo check --manifest-path packages/jam-audio-flutter/Cargo.toml &&
  cargo test --manifest-path packages/jam-audio-engine/Cargo.toml &&
  cargo fmt --check &&
  node protocol/generate.mjs --check &&
  node scripts/check_versions.mjs &&
  git diff --check HEAD &&
  check_release_range_whitespace &&
  (cd packages/jam-audio-worklet && npm pack --dry-run --json --offline --ignore-scripts --cache "$1") | node scripts/check_pack.mjs src/audio_bridge_activation.js
' _ "$serial_cache"
VERIFY_BASE_REF=35fd5a0 /usr/bin/time -f 'parallel_seconds=%e' scripts/verify-release.sh
```

Expected: all commands exit 0. Compare serial vs the second parallel run (same warm-cache state). If parallel is not faster, report honestly and investigate contention before claiming the success criterion.

---

### Task 6: Release commit, clean-tree re-verification, and handoff

- [ ] **Step 1: Review the release diff**

```bash
git status --short
git diff -- CHANGELOG.md Cargo.lock packages/jam-audio-engine/Cargo.toml packages/jam-audio-flutter/Cargo.toml packages/jam-audio-worklet/package.json
```

Expected: only the specified release metadata, plus the user's uncommitted design-spec revision. No `frb_generated.rs` diff.

- [ ] **Step 2: Create the release commit**

```bash
git add CHANGELOG.md Cargo.lock packages/jam-audio-engine/Cargo.toml packages/jam-audio-flutter/Cargo.toml packages/jam-audio-worklet/package.json
git commit -m "Release 0.5.2"
```

Do not stage the design spec unless the user asks. Do not tag, push, or publish.

- [ ] **Step 3: Re-verify the release commit**

```bash
VERIFY_BASE_REF=35fd5a0 scripts/verify-release.sh
```

Expected: `Verifying <release sha> (dirty)` only because of the uncommitted spec (or `clean` if the user committed it); all groups `PASS`.

- [ ] **Step 4: Review final repository state**

```bash
git status --short
git log --oneline --decorate -8
git tag --list 'v0.5.1' 'v0.5.2'
git diff 35fd5a0..HEAD --stat
```

Expected:

- the only uncommitted change is the user's revised design spec, unless the user separately asked to commit it;
- `Release 0.5.2` is HEAD;
- no `v0.5.2` tag exists;
- `v0.5.1` remains absent and is reported rather than silently backfilled.

- [ ] **Step 5: Prepare the handoff**

Report:

- Task 0 baseline results;
- exact test counts and the four production group statuses with durations;
- measured parallel and serial wall times without overstating cache effects;
- lock-contention finding and whether rustfmt moved groups;
- release commits created locally (with SHAs) and that `Release 0.5.2` is the intended tag target;
- package-content evidence (`Package contents OK` line);
- `frb_generated.rs` restored and the likely FRB-codegen origin of the drift;
- the uncommitted revised spec status, if still present;
- the lack of fresh real-device/browser validation; and
- remaining owner-authorized actions: decide whether to backfill `v0.5.1` (at `35fd5a0`), review browser caveats, create `v0.5.2`, push, run authenticated registry dry-runs, and publish.

Do not tag, push, or publish as part of this plan.
