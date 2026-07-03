# Track 4K Partition Shape State Debug

**Goal:** Isolate why real CELT leaves still decode to the wrong coefficient vectors after allocation, pulse budgets, and direct PVQ leaf replay are already aligned.

**Why this exists:** Track 4J fixed a real transient allocation mismatch in `celt.rs` by reserving `anti_collapse_rsv` before encoder allocation. After that fix:

- encoder and decoder allocation traces match on the failing low-bitrate transient path
- root-band and partition-budget traces no longer diverge first
- direct PVQ leaf replay is still exact
- but real leaf vectors still diverge in `bands.rs`, and `celt_loopback_160bytes` remains at `0.72 dB`

That means the next live bug is after budget handoff and after base PVQ coding, inside real partition/split state or coefficient reconstruction.

## Target Files

- `third_party/opus-rs/src/bands.rs`
- supporting tests:
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Trace Real Partition Shape State After Budget Alignment

- Extend the existing partition trace in `bands.rs` to capture the first real encode/decode divergence after budgets already match:
  - `theta`
  - split order / branch order
  - `fill` and collapse-mask evolution
  - any transient/time-division transform inputs
  - pre-leaf vectors handed into direct PVQ coding
- Keep tracing bounded to the first mismatching leaf path in the real low-bitrate harness.

## Task 2: Prove the First Post-Budget Divergence Step

- Determine whether the remaining vector mismatch comes from:
  - `compute_theta(...)`
  - split ordering or recurse order
  - transient/time-division state
  - collapse-mask / fill evolution
  - another `bands.rs` local transform before leaf PVQ
- Stop at the first proven divergence. Do not force a downstream symptom fix.

## Task 3: Make One Bounded Fix Only If Proven

- Choose exactly one bounded fix if the first mismatch is clearly local to one `bands.rs` surface.
- Acceptable examples:
  - theta reconstruction asymmetry
  - split-order mismatch
  - transient branch-state bug
  - local fill/collapse-mask reconstruction bug
- Do not touch:
  - `celt.rs` allocation logic
  - `rate.rs`
  - `pvq.rs`
  - MDCT or emphasis code

## Task 4: Re-run the CELT Gates

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
- if a bounded fix moves the real gate, also run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`

## Success Condition

- explain the first real post-budget leaf/vector divergence with concrete trace evidence
- either:
  - land one bounded `bands.rs` fix that improves the real `160`-byte gate
  - or prove the next live bug is even earlier or outside partition state and hand off that narrower target
