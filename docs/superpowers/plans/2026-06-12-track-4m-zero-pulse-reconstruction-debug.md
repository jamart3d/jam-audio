# Track 4M Zero-Pulse Reconstruction Debug

**Goal:** Isolate whether the remaining CELT quality loss is coming from the `q=0` leaf reconstruction path in `bands.rs`.

**Why this exists:** Track 4L corrected the leaf trace model and showed the current worst real divergences are not on ordinary PVQ leaves. They are on zero-pulse leaves:

- `q=0`
- `k=0`
- matched budgets
- matched `tell_frac()`
- no ordinary pulse coding involved

That shifts the next investigation away from symbol-state sync and onto the no-pulse reconstruction branch itself.

## Target Files

- `third_party/opus-rs/src/bands.rs`
- supporting tests:
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Trace Real `q=0` Reconstruction Behavior

- Add bounded traces for the first significant `q=0` leaf in the real failing path:
  - whether `lowband` is present
  - `fill` / masked fill
  - branch taken in the zero-pulse path
  - pre/post renormalization vectors
  - resulting collapse-mask behavior if relevant

## Task 2: Prove the First `q=0` Reconstruction Mismatch

- Determine whether the remaining loss comes from:
  - noise fill branch behavior
  - lowband-assisted synthesis branch behavior
  - renormalization in the no-pulse path
  - a trace-pairing assumption that is still invalid
- Stop at the first proven mismatch. Do not force a broader PVQ or allocation fix.

## Task 3: Make One Bounded Fix Only If Proven

- Choose exactly one local fix only if the `q=0` reconstruction bug is clear and bounded.
- Acceptable examples:
  - masked-fill handling bug
  - lowband copy/noise mix bug
  - renormalization bug in the zero-pulse path
- Do not touch:
  - `celt.rs`
  - `rate.rs`
  - ordinary `q>0` PVQ paths
  - MDCT or emphasis code

## Task 4: Re-run the CELT Gates

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
- if a bounded fix moves the real gate, also run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`

## Success Condition

- explain the first real `q=0` reconstruction mismatch with concrete trace evidence
- either:
  - land one bounded `bands.rs` fix that improves the real `160`-byte gate
  - or prove the next live bug is narrower than the zero-pulse branch and hand off that exact target
