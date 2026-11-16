# Track 4L Band Symbol/State Sync Debug

**Goal:** Isolate why real CELT leaf vectors still diverge when allocation, partition budgets, `tell_frac()`, and leaf `q/k` already match.

**Why this exists:** Track 4K proved the remaining bug is deeper than partition-budget math:

- allocation traces match
- partition node budgets match
- leaf budget counters match
- leaf `tell_frac()` matches
- leaf `q` and `k` match
- direct PVQ replay is exact in isolation
- but the real decoded leaf vectors still differ materially

That means the next live bug is likely in symbol/state synchronization inside the real recursive band-shape path, or in deeper range-coder state that `tell_frac()` alone does not expose.

## Target Files

- `third_party/opus-rs/src/bands.rs`
- instrumentation only if needed:
  - `third_party/opus-rs/src/range_coder.rs`
- supporting tests:
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Trace Real Symbol/State Sync at the First Divergent Leaf

- Add bounded trace surfaces for the first real divergent leaf path that expose:
  - full range-coder state, not just `tell_frac()`
  - symbol-level operations immediately before and during the failing leaf decode
  - any per-leaf local transforms that happen between node trace and PVQ decode
- Keep the trace scoped to the first mismatching leaf in the real low-bitrate harness.

## Task 2: Prove the First Symbol/State Divergence Step

- Determine whether the first remaining mismatch comes from:
  - hidden range-coder state divergence despite matching `tell_frac()`
  - an encode/decode asymmetry in the real leaf symbol stream
  - a pre-leaf local transform inside `bands.rs`
  - another not-yet-traced symbol path feeding PVQ decode
- Stop at the first proven divergence. Do not force another partition-budget fix.

## Task 3: Make One Bounded Fix Only If Proven

- Choose exactly one bounded fix only if the divergence is clearly local.
- Acceptable examples:
  - symbol encode/decode asymmetry in `bands.rs`
  - local state-update bug around the real leaf path
  - range-coder usage bug if instrumentation proves it locally
- Do not touch:
  - `celt.rs` allocation logic
  - `rate.rs`
  - MDCT or emphasis code

## Task 4: Re-run the CELT Gates

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
- if a bounded fix moves the real gate, also run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`

## Success Condition

- explain the first real symbol/state divergence with concrete trace evidence
- either:
  - land one bounded fix that improves the real `160`-byte gate
  - or prove the next live bug is even narrower and hand off that specific source
