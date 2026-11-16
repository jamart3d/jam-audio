# Track 4J Pulse Budget Source Divergence Debug

**Goal:** Isolate why decode-side `pulses[i]` diverges from encode-side `pulses[i]` before `quant_all_bands(...)` enters root partition coding.

**Why this exists:** Track 4I proved the remaining low-bitrate CELT failure is not first in `bands.rs`. The earliest real mismatch is already present in the per-band pulse budget handed into `quant_all_bands(...)`:

- first root budget divergence:
  - `band=9`
  - `encode_pulses=291`
  - `decode_pulses=292`
  - `encode_b=291`
  - `decode_b=292`
  - all of `tell`, `balance`, `remaining_bits`, and `curr_balance` still match

That means the next live bug is upstream in the real pulse-budget source, not inside partition recursion.

## Target Files

- `third_party/opus-rs/src/celt.rs`
- `third_party/opus-rs/src/rate.rs`
- supporting tests:
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Trace Real Encode/Decode Pulse Budget Sources

- Add bounded trace surfaces that expose the real per-band arrays feeding `quant_all_bands(...)` on both encode and decode:
  - `pulses[]`
  - `ebits[]`
  - coded-bands count
  - any related trim / cap / allocation inputs that feed the final pulse budget
- Keep the trace scoped to the first low-bitrate frame.

## Task 2: Prove the First Pulse Budget Divergence Step

- Determine whether decode-side `pulses[i]` diverges because of:
  - `rate.rs` bit allocation math
  - decoder-side reconstruction of allocation state
  - coded-band bookkeeping mismatch
  - an earlier mismatch in the bitstream fields that feed pulse allocation
- Stop at the first proven divergence. Do not force a downstream `bands.rs` fix.

## Task 3: Make One Bounded Fix Only If Proven

- Choose exactly one bounded fix only if the divergence is clearly local to one source surface.
- Acceptable examples:
  - off-by-one pulse allocation reconstruction
  - coded-band boundary mismatch
  - decoder-side allocation-state reconstruction bug
- Do not touch:
  - `bands.rs` partition math
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

- explain the first real encode/decode `pulses[i]` divergence with concrete trace evidence
- either:
  - land one bounded upstream fix that improves the real `160`-byte gate
  - or prove the next live bug is earlier than pulse-budget reconstruction and hand off that narrower source
