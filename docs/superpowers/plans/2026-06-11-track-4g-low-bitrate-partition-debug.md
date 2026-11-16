# Track 4G Low-Bitrate Partition Debug Implementation Plan

**Goal:** Finish the remaining CELT quality gap after the `pvq.rs` pulse-order fix by targeting the split / partition path that still degrades the constrained `160`-byte loopback.

**Why this exists:** Track 4F fixed a real `cwrsi(...)` pulse reconstruction bug and restored the high-bitrate CELT loopback from `0.04 dB` to `2.02 dB`, but `celt_loopback_160bytes` still fails at `0.72 dB`. The worst remaining traced band is no longer a direct pulse-coding mismatch; it now points to the lower-bit split path in `quant_partition(...)`.

## Target Files

- `third_party/opus-rs/src/bands.rs`
- `third_party/opus-rs/tests/celt_budget_test.rs`
- `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Trace the Low-Bitrate Partition Path

- Add a bounded trace for the split / partition path in `quant_partition(...)` and `compute_theta(...)`:
  - chosen `mbits` / `sbits`
  - `itheta`
  - per-half recurse order
  - reconstructed half-band vectors for the worst low-bitrate band
- Keep the trace scoped to the first failing low-bitrate frame.
- Run:
  - `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`

## Task 2: Reproduce the Worst Low-Bitrate Band in Isolation

- Add a focused trace test derived from the low-bitrate worst band.
- Prove whether the mismatch comes from:
  - split bit division
  - `itheta` coding / decoding
  - recursive half ordering
  - recombination after recursion

## Task 3: Make One Bounded Fix in `bands.rs`

- Choose exactly one local fix in the split path.
- Do not touch:
  - `celt.rs` allocation heuristics
  - `mdct.rs`
  - pre/de-emphasis logic

## Task 4: Re-run the CELT Gates

- `cargo test -p opus-rs test_celt_loopback -- --nocapture`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
- `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
- `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`

## Success Condition

- keep the high-bitrate CELT loopback above its current recovered level
- improve `celt_loopback_160bytes` above the current `0.72 dB`
- if possible, clear the `>1.0 dB` gate without regressing the other CELT probes
