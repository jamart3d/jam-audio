# Track 4P Recursive Partition Assembly Debug

**Goal:** Isolate the first mismatch inside recursive `quant_partition(...)` assembly, below the top-level band recombine path and above exact leaf reconstruction.

**Why this exists:** Track 4O proved:

- exact leaf reconstruction is already established for:
  - ordinary `q>0` leaves
  - decoder-local `q=0` zero-pulse leaves
- the real low-bitrate failure remains at `0.72 dB`
- the worst real band is still `band=17`
- its error is already present at `post_partition`:
  - `post_partition_max_abs_error=0.40040216`
  - `post_recombine_max_abs_error=0.40040216`

That rules out the top-level `quant_band(...)` recombine undo. The remaining live bug is still inside recursive partition assembly.

## Target Files

- `third_party/opus-rs/src/bands.rs`
- supporting tests:
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- findings report:
  - `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

## Task 1: Add Recursive Parent Assembly Trace

- Add bounded diagnostics for parent partition returns inside `quant_partition(...)`:
  - child vectors immediately after each recursive return
  - parent vector immediately after both child returns
  - path bits / depth / band id for the traced parent
- Keep this limited to the first significant mismatching band/path in the low-bitrate failing case.

## Task 2: Prove the First Mismatch Inside `quant_partition(...)`

- Determine whether the first real divergence appears in:
  - left/right child placement in the parent buffer
  - parent-side branch ordering
  - `compute_theta(...)`-driven parent assembly
  - branch-local layout after recursive return
- Stop at the first proven mismatch.

## Task 3: Make One Bounded Fix Only If Proven

- Only land a production change if a local recursive assembly bug is proven.
- Acceptable fix surfaces:
  - parent buffer assembly in `quant_partition(...)`
  - branch-order / slice-placement logic around recursive returns
- Do not touch:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - top-level `quant_band(...)` recombine helpers
  - zero-pulse branch logic

## Task 4: Re-run the CELT Gates

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
- if a bounded fix is proven and landed, also run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`

## Success Condition

- prove the first real mismatch inside recursive `quant_partition(...)` assembly with concrete trace evidence
- either:
  - land one bounded `bands.rs` fix that improves the real CELT gate
  - or prove the next live bug is narrower than recursive parent assembly and hand off that exact target
