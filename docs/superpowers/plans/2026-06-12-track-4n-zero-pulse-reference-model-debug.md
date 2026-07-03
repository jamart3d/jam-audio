# Track 4N Zero-Pulse Reference Model Debug

**Goal:** Replace the invalid `q=0` leaf comparison model with a decoder-local expected-reference trace, then determine whether the lowband-assisted zero-pulse branch is actually wrong.

**Why this exists:** Track 4M showed that the worst remaining leaf-level errors land on `q=0` leaves, but it also proved the current trace model is not valid there:

- worst leaves are `q=0`, `k=0`
- nonzero-q leaves still match exactly against quantized references
- on the worst zero-pulse leaves:
  - `encode_has_lowband=false`
  - `decode_has_lowband=true`
  - `encode_zero_pulse_mode=3`
  - `decode_zero_pulse_mode=2`

That means the current encode/decode leaf pairing is comparing decode output against the wrong expectation for zero-pulse reconstruction.

## Target Files

- `third_party/opus-rs/src/bands.rs`
- supporting tests:
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Capture Decoder-Local Zero-Pulse Inputs

- Add bounded trace support for decoder-side `q=0` leaves only:
  - pre-branch vector
  - lowband slice used by the branch, when present
  - seed on entry to the branch
  - branch mode (`zero fill`, `lowband+noise`, `noise only`)
  - post-branch / pre-renormalization vector
  - post-renormalization vector
- Keep the trace local to the first significant `q=0` mismatch path. Do not broaden the trace surface unnecessarily.

## Task 2: Build a Decoder-Local Expected Reference

- Add a small helper that reproduces the `q=0` reconstruction branch out of band for diagnostics only.
- Use the traced decoder-local inputs to generate an expected zero-pulse reference:
  - same lowband slice
  - same fill mask
  - same RNG seed sequence
  - same renormalization step
- Compare actual decode output against that modeled expected output, not against the encode-side input vector.

## Task 3: Determine the First Real Mismatch

- Decide which of these is true:
  1. the decoder-local zero-pulse model matches actual decode output, meaning Track 4M’s worst-leaf signal was a trace-model artifact
  2. the model does not match, and the bug is inside:
     - lowband-assisted synthesis
     - noise-fill generation
     - renormalization
- Stop at the first proven mismatch. Do not drift back into `celt.rs`, allocation, or ordinary PVQ paths.

## Task 4: Make One Bounded Fix Only If Proven

- Only land a production change if the decoder-local expected-reference model proves a local bug.
- Acceptable fix surfaces:
  - zero-pulse lowband/noise branch in `bands.rs`
  - renormalization immediately following that branch
- Do not touch:
  - `celt.rs`
  - `rate.rs`
  - ordinary `q>0` PVQ logic
  - MDCT / emphasis code

## Task 5: Re-run the CELT Gates

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
- if a bounded fix is proven and landed, also run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`

## Success Condition

- prove whether the remaining `q=0` signal is a real zero-pulse reconstruction bug or just a trace-model artifact
- either:
  - land one bounded `bands.rs` fix that improves the real CELT gate
  - or prove the next live bug is narrower than the zero-pulse branch and hand off that exact target
