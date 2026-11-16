# Track 4H Low-Bitrate Leaf Budget Divergence Debug

**Goal:** Isolate why low-bitrate CELT partition leaves can arrive at different `q` / remaining-bit state between encode and decode even when the direct leaf PVQ coder itself roundtrips correctly.

**Why this exists:** Track 4G proved that the remaining `celt_loopback_160bytes` failure is not the base PVQ leaf coder. The real low-bitrate path still fails at `0.72 dB`, and focused tracing now shows some leaves enter the leaf coder with divergent state:

- example focused leaf:
  - `band=11`
  - `path_bits=1`
  - `depth=1`
  - `encode_q=8`
  - `decode_q=7`
  - `encode_remaining_bits_after_budget=6383`
  - `decode_remaining_bits_after_budget=6391`
- direct replay of that leaf coder still succeeds exactly

That means the next bug is likely in recursive partition bookkeeping, not in PVQ pulse reconstruction.

## Target Files

- `third_party/opus-rs/src/bands.rs`
- `third_party/opus-rs/tests/celt_budget_test.rs`
- `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Trace Per-Leaf Budget Evolution Through Recursion

- Extend the partition trace so each descendant leaf can be paired with:
  - parent `remaining_bits` on entry
  - `curr_bits`
  - `q`
  - post-reservation `remaining_bits`
  - `fill`
  - exact recurse order and sibling rebalance context
- Make it easy to compare the full ancestor chain for one mismatching leaf between encode and decode.
- Run:
  - `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`

## Task 2: Prove the First Real Budget Divergence Point

- Use the new trace to identify the earliest step where encode and decode stop matching for the same leaf path:
  - same parent node but different descendant path choice
  - same path but different `remaining_bits`
  - same budget but different `q`
- If the real issue is path matching rather than budget math, say that explicitly and stop there.

## Task 3: Make One Bounded Fix in `bands.rs`

- Choose exactly one local fix based on the first proven divergence.
- Examples of acceptable fixes:
  - path bookkeeping / recurse-order bug
  - sibling rebalance accounting bug
  - low-bitrate leaf bit reservation bug
- Do not touch:
  - `pvq.rs`
  - `celt.rs`
  - `quant_bands.rs`
  - MDCT or emphasis code

## Task 4: Re-run the CELT Gates

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
- if the bounded fix moves the real gate, also run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`

## Success Condition

- explain the first real encode/decode divergence at a low-bitrate leaf with concrete trace evidence
- either:
  - land one bounded `bands.rs` fix that improves `celt_loopback_160bytes`
  - or prove that the next live bug is outside partition recursion and hand off a narrower follow-on target
