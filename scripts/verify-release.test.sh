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
add_group failing 'printf "CONTROLLED_FAILURE_SENTINEL\\n"; exit 23'
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

grep -q 'scripts/verify-release.sh' "$ROOT/RELEASING.md"
test "$(grep -c 'cargo clippy' "$ROOT/RELEASING.md" || true)" -eq 0
test "$(grep -c 'npm pack --dry-run' "$ROOT/RELEASING.md" || true)" -eq 0

# --- build.sh opt-in web app sync tests
bash -n "$ROOT/packages/jam-audio-engine/build.sh"
if grep -q '\.\./\.\./apps/jamdisc_web/web/pkg' "$ROOT/packages/jam-audio-engine/build.sh"; then
  echo "FAIL: build.sh still references the broken sibling path"; exit 1
fi
if grep -q 'jamdisc/apps\|DEFAULT_WEB_DIR' "$ROOT/packages/jam-audio-engine/build.sh"; then
  echo "FAIL: build.sh still auto-detects a sibling jamdisc checkout"; exit 1
fi

ENGINE_TEST_ROOT="$TEST_DIR/engine_sandbox"
mkdir -p "$ENGINE_TEST_ROOT/repo/packages/jam-audio-engine"
cp "$ROOT/packages/jam-audio-engine/build.sh" "$ENGINE_TEST_ROOT/repo/packages/jam-audio-engine/build.sh"
chmod +x "$ENGINE_TEST_ROOT/repo/packages/jam-audio-engine/build.sh"

mkdir -p "$TEST_DIR/engine-bin"
cat > "$TEST_DIR/engine-bin/wasm-pack" <<'EOF'
#!/usr/bin/env bash
mkdir -p pkg
touch pkg/jam_audio_engine_bg.wasm pkg/jam_audio_engine.js
echo '{"name": "test"}' > pkg/package.json
EOF
chmod +x "$TEST_DIR/engine-bin/wasm-pack"

# Case A: JAMDISC_WEB_PKG_DIR set -> artifacts land in that temp dir
CUSTOM_PKG="$TEST_DIR/custom_web_pkg"
PATH="$TEST_DIR/engine-bin:$PATH" JAMDISC_WEB_PKG_DIR="$CUSTOM_PKG" \
  "$ENGINE_TEST_ROOT/repo/packages/jam-audio-engine/build.sh" > "$TEST_DIR/case-a.out"
test -f "$CUSTOM_PKG/jam_audio_engine_bg.wasm"
test -f "$CUSTOM_PKG/jam_audio_engine.js"
if ! grep -q "Syncing artifacts to $CUSTOM_PKG" "$TEST_DIR/case-a.out"; then
  echo "FAIL: Case A did not sync to custom dir"; exit 1
fi

# Case B: no override -> skip message, nothing created outside the package
rm -rf "$CUSTOM_PKG"
PATH="$TEST_DIR/engine-bin:$PATH" \
  "$ENGINE_TEST_ROOT/repo/packages/jam-audio-engine/build.sh" > "$TEST_DIR/case-b.out"
if ! grep -q 'Skipping web app sync' "$TEST_DIR/case-b.out"; then
  echo "FAIL: Case B did not output skipping message"; exit 1
fi
if [ -d "$ENGINE_TEST_ROOT/apps" ] || [ -d "$ENGINE_TEST_ROOT/repo/apps" ]; then
  echo "FAIL: Case B created stray apps directory"; exit 1
fi

# Case C: a sibling jamdisc checkout exists but the env var is unset -> NOT synced (opt-in only)
SIBLING_WEB="$ENGINE_TEST_ROOT/jamdisc/apps/jamdisc_web/web"
mkdir -p "$SIBLING_WEB"
PATH="$TEST_DIR/engine-bin:$PATH" \
  "$ENGINE_TEST_ROOT/repo/packages/jam-audio-engine/build.sh" > "$TEST_DIR/case-c.out"
if [ -e "$SIBLING_WEB/pkg" ]; then
  echo "FAIL: Case C synced into a sibling jamdisc checkout without JAMDISC_WEB_PKG_DIR"; exit 1
fi
if ! grep -q 'Skipping web app sync' "$TEST_DIR/case-c.out"; then
  echo "FAIL: Case C did not output skipping message"; exit 1
fi

printf 'verify-release tests passed\n'
