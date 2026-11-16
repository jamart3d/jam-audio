# Track 4I Root Band Budget Handoff Debug

**Goal:** Isolate why encode and decode can enter the same root partition node with different per-band `b` budgets even while global `remaining_bits` is still aligned.

**Why this exists:** Track 4H proved the earliest real low-bitrate divergence is not at the PVQ leaf coder and not first at descendant recursion. The first hard mismatch is already present at root partition-node entry:

- example first node divergence:
  - `band=9`
  - `depth=0`
  - `encode_b=291`
  - `decode_b=292`
  - `encode_remaining_bits_before_qalloc=7111`
  - `decode_remaining_bits_before_qalloc=7111`
  - `encode_qalloc=28`
  - `decode_qalloc=28`
  - `encode_mbits=140`
  - `decode_mbits=141`

That means the next bug is likely in the band-budget handoff into `quant_partition(...)`, not in the descendant leaf coder itself.

## Target Files

- `third_party/opus-rs/src/bands.rs`
- `third_party/opus-rs/tests/celt_budget_test.rs`
- `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Trace Root `b` Budget Handoff Into `quant_partition(...)`

- Extend tracing around `quant_band(...)` / its call into `quant_partition_encode(...)` and `quant_partition(...)` to capture:
  - root `b` before partition
  - any local transforms that modify the band budget before the root split
  - `B`, `N_B`, `time_divide`, `recombine`, and `fill`
  - any encode/decode asymmetry before the first root partition node
- Keep the trace narrow and focused on the first mismatching root node.

## Task 2: Prove the First Root Budget Mismatch Step

- Determine whether the root `b` mismatch comes from:
  - `quant_band(...)` local budget math
  - time-division / recombine handling
  - root call-site handoff from the outer band loop
  - trace pairing assumptions still being insufficient
- If the mismatch is outside `quant_band(...)`, stop and hand off there instead of forcing a `bands.rs` fix.

## Task 3: Make One Bounded Fix Only If Proven

- Choose exactly one local fix if the first mismatch is clearly inside `bands.rs`.
- Acceptable examples:
  - off-by-one root budget handoff bug
  - asymmetry between `quant_partition_encode(...)` and `quant_partition(...)` root entry
  - root-band `fill` / recombine interaction that changes `b`
- Do not touch:
  - `pvq.rs`
  - `celt.rs`
  - `quant_bands.rs`
  - MDCT or emphasis code

## Task 4: Re-run the CELT Gates

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
- if a bounded fix moves the real gate, also run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`

## Success Condition

- explain the first real root-band `b` mismatch with concrete trace evidence
- either:
  - land one bounded `bands.rs` fix that improves the real `160`-byte gate
  - or prove the next live bug is earlier than root partition entry and hand off that narrower target
