# Track 4O Band Recombine State Debug

**Goal:** Isolate the first mismatch above exact leaf reconstruction in the recursive CELT band-shape path.

**Why this exists:** Track 4N proved:

- ordinary `q>0` partition leaves are exact against the quantized reference
- decoder-local `q=0` zero-pulse replay is also exact
- the real `160`-byte CELT gate still fails at `0.72 dB`
- the strongest remaining signal is still the real PVQ band trace at band `17`, with large `max_abs_error_vs_quantized`

So the next live bug is no longer in leaf coding. It is likely in how exact leaf results are recombined into the parent band shape.

## Target Files

- `third_party/opus-rs/src/bands.rs`
- supporting tests:
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Add Parent-Level Recombine Trace

- Add bounded diagnostics around the recursive partition recombine path:
  - parent band input on encode
  - parent band output on decode
  - child outputs immediately before recombine
  - vectors immediately after recombine / deinterleave / Hadamard stages
- Keep this limited to the first significant traced band on the failing low-bitrate path.

## Task 2: Prove the First Mismatch Above the Leaves

- Determine whether the first real error appears in:
  - split child reassembly
  - Hadamard / deinterleave transforms
  - sign / ordering / stride handling after exact child decode
- Stop at the first proven divergence. Do not drift back into leaf coding or allocation.

## Task 3: Make One Bounded Fix Only If Proven

- Only land a production change if a local recombine-stage bug is proven.
- Acceptable fix surfaces:
  - parent-level assembly in `quant_partition(...)`
  - deinterleave / Hadamard helpers in `bands.rs`
- Do not touch:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse branch logic

## Task 4: Re-run the CELT Gates

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
- if a bounded fix is proven and landed, also run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`

## Success Condition

- prove the first real mismatch above exact leaf reconstruction with concrete trace evidence
- either:
  - land one bounded `bands.rs` fix that improves the real CELT gate
  - or prove the next live bug is narrower than parent-level recombination and hand off that exact target
