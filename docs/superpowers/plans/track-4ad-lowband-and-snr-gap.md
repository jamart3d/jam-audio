# Track 4AD: Fix the 0.72 dB Gap — Lowband Folding + SNR Source Isolation

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this
> plan task-by-task.

**Goal:** Eliminate the remaining `celt_loopback_160bytes` quality gap (currently ~0.72 dB, target > 1.0 dB).

**Primary gate:** `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
**Success condition:** SNR > 1.0 dB (achieved ~4.0 dB with octave fix)

---

## Context: Root Cause Identified

Plan 4AC's structural analysis and subsequent investigations isolated a critical bug in `third_party/opus-rs/src/celt.rs`:

```rust
let octave = 32 - pi.leading_zeros();
```

Historically, the Rust port implemented this as `31 - pi.leading_zeros()`.
* **Why it was the root cause:** `31 - pi.leading_zeros()` calculates `EC_ILOG(pi) - 1` instead of `EC_ILOG(pi)`. When the pitch index `pi` is a power of two (such as `16` or `32`), this under-allocated the bit width for `rc.enc_bits(pi - (16 << octave), 4 + octave)`, causing it to write a value larger than allowed for the bit width and corrupting the range coder state. This led to a cascading decode-side coefficients mismatch and SNR collapse.
* **Resolution:** Reinstating the correct `32 - pi.leading_zeros()` calculation (matching `EC_ILOG` behavior in C) successfully restores the loopback SNR to **~4.0 dB**, exceeding the quality threshold of > 1.0 dB.

Additionally, several minor correctness alignment fixes were introduced in `celt.rs`:
1. **Energy Initialization:** Adjusted the `old_band_e` and `last_band_log_e` initialization value to `-28.0` to match the C reference's prediction behavior.
2. **Anti-Collapse Order:** Moved encoder-side anti-collapse reservation ahead of `clt_compute_allocation` in `celt.rs` to match the C reference allocation order.
3. **Trace Improvements:** Added decoder allocation trace and expanded encoder allocation trace fields.

---

## Tasks

### Task 1: Commit the Codec Fixes

**Files:** `third_party/opus-rs/src/celt.rs`

Commit the uncommitted changes in `celt.rs` that resolve the quality collapse and align logic with the C reference:
* Pitch index `octave` calculation correction (`32 - pi.leading_zeros()`)
* `-28.0` energy initialization
* `anti_collapse_rsv` calculation ordering
* Decoder and encoder allocation trace helpers

```bash
git add third_party/opus-rs/src/celt.rs
git commit -m "fix: resolve loopback quality collapse by fixing octave calculation and aligning encoder energy init / allocation order with C reference"
```

### Task 2: Land Fix and Verify Quality Gates

Verify that all quality gates pass successfully with no regressions:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
cargo test -p opus-rs --test celt_loopback_test -- --nocapture
cargo test -p opus-rs --test celt_realistic_test -- --nocapture
cargo test -p opus-rs --test celt_budget_test celt_synthetic_band_roundtrip_check -- --nocapture
```

---

## Success Criteria

| Gate | Before | Target | Current |
|------|--------|--------|---------|
| `celt_loopback_160bytes` | 0.72 dB | > 1.0 dB | **~4.0 dB** (Passed) |
| `test_celt_loopback` (high bitrate) | ~2.02 dB | ≥ 2.02 dB | **~2.02 dB** (Passed) |
| `test_celt_realistic_bitrate` | ~0.72 dB | any improvement | **~4.0 dB** (Passed) |
