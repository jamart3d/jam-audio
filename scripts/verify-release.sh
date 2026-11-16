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
  add_group rust 'cargo clippy --all-targets -- -D warnings && cargo check --manifest-path packages/jam-audio-engine/Cargo.toml --target wasm32-unknown-unknown && cargo check --manifest-path packages/jam-audio-flutter/Cargo.toml && cargo test --manifest-path packages/jam-audio-engine/Cargo.toml'
  add_group static 'cargo fmt --check && node protocol/generate.mjs --check && node scripts/check_versions.mjs && git diff --check HEAD && check_release_range_whitespace'
  add_group package '(cd packages/jam-audio-worklet && npm pack --dry-run --json --offline --ignore-scripts --cache "$NPM_CACHE_DIR") | node scripts/check_pack.mjs src/audio_bridge_activation.js src/audio_bridge_media_session.js'
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
