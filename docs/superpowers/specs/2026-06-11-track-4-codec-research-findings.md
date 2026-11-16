**Track 4 Findings**

Date: 2026-06-11
Worktree: `track-4-codec-quality`
Plan: `2026-06-11-track-4-codec-quality-research.md`

**Scope**

This run executed the Track 4 research plan for vendored `third_party/opus-rs` quality issues. The goal was to separate stage-local correctness from end-to-end CELT/Opus quality loss before any algorithmic fix plan.

**What Changed**

- Added `third_party/opus-rs` as a workspace member so root-level `cargo test -p opus-rs ...` works.
- Added shared SNR/delay probe helpers in `third_party/opus-rs/tests/quality_probe_common.rs`.
- Added a CELT pre/de-emphasis probe in `third_party/opus-rs/tests/celt_stage_probe.rs`.
- Added an MDCT TDAC-stage probe in `third_party/opus-rs/tests/mdct_stage_probe.rs`.
- Unified the CELT quality tests to use the shared SNR/delay helper.
- Extracted a bounded coarse-energy predictor seam in [`third_party/opus-rs/src/quant_bands.rs`](/home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/src/quant_bands.rs) with no intended behavior change.

**Observed Measurements**

- `cargo test -p opus-rs celt_preemphasis_roundtrip_probe -- --nocapture`
  - `CELT pre/de-emphasis roundtrip: best SNR = 147.30 dB at delay 0`
- `cargo test -p opus-rs celt_synthesis_chain_bypass -- --nocapture`
  - `Synthesis chain bypass: Best SNR = 136.65 dB at delay 120`
- `cargo test -p opus-rs test_mdct_identity_full -- --nocapture`
  - `Best SNR: 125.55 dB at offset 0`
- `cargo test -p opus-rs mdct_tdac_stage_probe -- --nocapture`
  - `MDCT TDAC stage: best SNR = 11.64 dB at delay 109`
- `cargo test -p opus-rs test_celt_mdct_passthrough -- --nocapture`
  - `CELT MDCT passthrough: best SNR = 11.95 dB at delay = 851`
- `cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture`
  - `Energy roundtrip only: Best SNR = 0.01 dB at delay 884`
- `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `CELT realistic bitrate (160 bytes): Best SNR = 0.28 dB at delay 1195`
- `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`
  - `SUCCESS: Best SNR = 0.21 dB at delay 1192`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - fails at `0.28 dB`

**Interpretation**

1. The pre/de-emphasis path is not the root cause.
   - Standalone probe is effectively perfect at `147.30 dB`.

2. The CELT synthesis bypass path is not the root cause.
   - The path that includes pre-emphasis, forward MDCT, inverse MDCT, and de-emphasis but skips quantized band-energy loss is effectively healthy at `136.65 dB`.

3. The strongest first failure appears when quantized band energy is introduced.
   - `celt_energy_roundtrip_only` collapses to `0.01 dB`, which is materially worse than the healthy bypass path.

4. End-to-end CELT and Opus quality failures are consistent with that energy-path collapse.
   - `test_celt_realistic_bitrate`: `0.28 dB`
   - `opus_celt_roundtrip_basic`: `0.21 dB`
   - `celt_loopback_160bytes`: `0.28 dB`

5. MDCT is split into two different stories and should not be over-generalized.
   - Pure identity/full-window MDCT tests are healthy (`125.55 dB`).
   - The production-like MDCT passthrough/TDAC probes are much lower (`11-12 dB`), but they are still far better than the energy-quantized path and do not explain the near-zero CELT quality by themselves.

**Likely Root-Cause Area**

Primary next target:
- `third_party/opus-rs/src/quant_bands.rs`

Secondary follow-up surfaces if the first targeted fix does not explain the collapse:
- `third_party/opus-rs/src/bands.rs`
- `third_party/opus-rs/src/celt.rs` around energy allocation/integration

Not first target:
- `third_party/opus-rs/src/mdct.rs`
- CELT pre/de-emphasis logic

**Why `quant_bands.rs` Comes First**

- It is the first shared production module on the failing path after the healthy synthesis-bypass path.
- Encoder and decoder coarse/fine energy prediction symmetry is concentrated there.
- The added helper seam in `coarse_energy_prediction_step(...)` gives a narrow place to instrument predictor state without broad refactors.

**Verification Snapshot**

- `cargo test -p opus-rs test_coarse_fine_energy -- --nocapture` -> pass
- `cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture` -> pass, but SNR remains `0.01 dB`
- `cargo test -p opus-rs celt_synthesis_chain_bypass -- --nocapture` -> pass at `136.65 dB`
- `cargo test -p opus-rs` -> library unit tests pass; integration sweep stops at `celt_budget_test` failure (`0.28 dB`)

**Recommended Next Plan**

Write a focused follow-on plan for energy quantization diagnostics, for example:
- `2026-06-11-track-4a-energy-quantization-debug.md`

That plan should:
- instrument encoder vs decoder `old_e_bands`, `error`, and per-band `qi`
- compare `quant_coarse_energy_impl` against `unquant_coarse_energy` band-by-band
- verify whether the predictor update, fine quantization offsets, or finalization bits diverge first
- avoid touching MDCT or pre/de-emphasis unless new evidence contradicts this report

**Commits Produced During This Research Run**

- `8d0d357 build: add vendored opus-rs to workspace members`
- `8785b79 test: add shared codec quality probe helpers`
- `eb45e5a test: add mdct stage quality probe`
- `2e4bda8 test: unify celt quality measurements`
- `1b492db refactor: expose first codec quality investigation seam`

**Energy Trace Follow-Up**

- Coarse trace result: PASS, encoder and decoder coarse prediction stay aligned band-by-band.
- Fine trace result: PASS, unit-level fine-energy updates remain symmetric with no first mismatching band.
- Finalise trace result: PASS, unit-level finalization also remains symmetric with no first mismatching band.
- Real CELT energy harness divergence: none reported by `trace_full_energy_roundtrip_for_test(...)`; `celt_energy_roundtrip_only` still prints `Energy trace first divergence: None` while end-to-end SNR stays at `0.01 dB`.

**Next Fix Target**

- Chosen file: `third_party/opus-rs/src/bands.rs`
- Reason: the quantized energy encode/decode path is symmetric both in isolation and when fed by the real CELT energy-only harness, yet overall quality still collapses. That moves the likely fault to how coefficients are normalized and denormalized around the quantized energies, especially `compute_band_energies`, `normalise_bands`, and `denormalise_bands`.
- Explicit non-targets for the next fix pass: `mdct.rs`, pre/de-emphasis logic, and additional `quant_bands.rs` predictor surgery unless new evidence appears.

**Band Trace Correction Follow-Up**

- The initial `bands.rs` suspicion was based on two diagnostic mistakes in the test harness:
  - feeding `denormalise_bands(...)` raw `amp2log2(...)` output instead of `log2amp(...)` output
  - calling `amp2log2(mode, nb_ebands, nb_ebands, ...)`, which fills the entire working range with `-14` instead of computing real band log energies
- After correcting those diagnostics to match the actual CELT path:
  - `bands_roundtrip_recovers_coefficients_before_quantization` passes
  - worst in-band reconstruction error is effectively zero (`5.9604645e-8`)
  - `trace_band_roundtrip_for_test(...)` stays clean inside `celt_energy_roundtrip_only`
- Corrected `celt_energy_roundtrip_only` improves from `0.01 dB` to `0.16 dB`, but still remains far below the expected `>10 dB`
- Real production quality remains unchanged at the same order of magnitude:
  - `celt_loopback_160bytes`: still fails at `0.28 dB`

**Updated Interpretation**

- `third_party/opus-rs/src/bands.rs` is not the current primary suspect.
- The band energy normalization/denormalization seam is functioning correctly when exercised with codec-accurate inputs.
- The remaining collapse is more likely upstream in how quantized energies are chosen or integrated, not how already-chosen energies are applied to coefficients.

**Updated Next Target**

- Primary next target shifts back to `third_party/opus-rs/src/quant_bands.rs` and `third_party/opus-rs/src/celt.rs`
- Specifically:
  - measure distortion between original `band_log_e` and post-quantization `old_band_e`
  - verify whether coarse/fine/finalize symmetry is masking a quantizer step-size, allocation, or predictor-bias problem
  - inspect how `clt_compute_allocation(...)`, `ebits`, and `fine_priority` interact with the CELT-only energy path

**Energy Distortion and Allocation Follow-Up**

- Worst finalised quantized-energy distortion:
  - `QuantEnergyDistortionEntry { band: 20, channel: 0, original: -22.148365, quantized: -22.02472, abs_error: 0.12364578 }`
- Allocation snapshot:
  - corrected helper matching the real encoder budget now reports:
    - `coded_bands=20`
    - `balance=0`
    - `ebits=[3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1]`
    - `fine_priority=[0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0]`
- `Energy trace first divergence: None` still holds.
- `Band roundtrip worst entry` remains effectively lossless, with max coefficient errors in the `1e-8` range.
- Post-correction `celt_energy_roundtrip_only`: `0.16 dB`
- `celt_loopback_160bytes`: `0.28 dB` and still fails
- `test_celt_realistic_bitrate`: `0.28 dB`
- `opus_celt_roundtrip_basic`: `0.21 dB`

**Decision**

- Primary next fix site remains `third_party/opus-rs/src/celt.rs`, but the exact target changed.
- Reason: after correcting the allocation helper to match the real encoder budget handoff, the earlier “both tail bands are starved” claim is no longer true. The live issue is now narrower: the last band still receives only `1` bit while the worst quantized distortion still concentrates in bands `19-20`, and Track 4D's energy-only regression cannot validate a `celt.rs` production fix because that harness bypasses the production encoder path entirely.

**Real Encoder Allocation Follow-Up**

- Added a real encoder trace surface via `take_last_encoder_allocation_trace_for_test()` and a single-frame integration test that records allocation directly from `CeltEncoder::encode`.
- First real encoder trace at `160` bytes:
  - `coded_bands=20`
  - `balance=0`
  - `pulses=[262, 250, 278, 268, 212, 202, 192, 190, 365, 345, 325, 305, 595, 543, 503, 707, 647, 791, 1054, 1062, 0]`
  - `ebits=[3, 3, 4, 4, 3, 3, 3, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 1]`
  - `fine_priority=[0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1, 1, 0]`
  - `alloc_trim=6`
  - `total_boost=96`
  - `is_transient=false`
  - `anti_collapse_rsv=0`
  - `alloc_budget_bitres=9608`
- `celt_loopback_160bytes` fails immediately against that real trace with the final band still at `1` fine bit.

**Track 4E Premise Check**

- The Track 4E assumption was that the remaining quality collapse might be primarily caused by `celt.rs` allocation pressure in the real encoder path.
- Fresh verification contradicts that:
  - `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
    - still fails with the trace above
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
    - fails at `0.04 dB` even with `RangeCoder::new_encoder(2048)`
- That high-bitrate loopback result matters more than the 160-byte allocation trace:
  - if CELT quality remains near zero with a very large packet budget, the dominant fault is not ordinary bitrate starvation or allocation trim pressure
  - the remaining fault is more likely in pulse-vector quantization / band-shape coding or in how the encoded band shapes are reconstructed

**Allocation Hypothesis Outcome**

- Tested one bounded encoder-only hypothesis: forcing neutral `alloc_trim = 5`
- Result:
  - `test_celt_realistic_bitrate` moved only from `0.28 dB` to `0.29 dB`
  - `opus_celt_roundtrip_basic` moved only from `0.21 dB` to `0.22 dB`
- That is not a meaningful fix. The change was reverted.

**Updated Conclusion**

- Track 4E should stop at diagnostics.
- The real encoder allocation trace is useful and should be kept.
- A production allocation tweak in `third_party/opus-rs/src/celt.rs` is not justified as the next main fix.
- The next targeted investigation should move to the real PVQ / band-shape path under:
  - `third_party/opus-rs/src/bands.rs`
  - supporting VQ helpers it calls during `quant_all_bands(...)`

**Track 4F Real PVQ Shape Follow-Up**

- Added a real PVQ / band-shape trace surface in `third_party/opus-rs/src/bands.rs`.
- Added high-bitrate regression evidence in:
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
  - `third_party/opus-rs/tests/celt_loopback_test.rs`
- First high-bitrate trace showed a hard mismatch between the encoded pulse vector and the decoded pulse vector on the worst band:
  - `y_enc=[-1, 1, -3, 3, -5, 6, -8, 9]`
  - `y_dec=[9, -8, 6, -5, 3, -3, 1, -1]`
- Root cause was in `third_party/opus-rs/src/pvq.rs`:
  - `cwrsi(...)` was reconstructing decoded pulses in reverse order for this real CELT path.
- Bounded production fix:
  - changed `cwrsi(...)` to write decoded magnitudes back in forward vector order instead of reversed order

**Fresh Verification After the PVQ Fix**

- `cargo test -p opus-rs celt_traced_band_pulse_coding_roundtrip_matches -- --nocapture`
  - PASS
- `cargo test -p opus-rs test_pvq_sync -- --nocapture`
  - PASS
- `cargo test -p opus-rs celt_traced_band_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
- `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - PASS at `2.02 dB` best SNR, up from `0.04 dB`
- `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - PASS at `0.72 dB`, up from `0.28 dB`
- `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`
  - PASS at `1.26 dB`, up from `0.21 dB`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB` against the test’s `>1.0 dB` gate

**Interpretation After the Fix**

- The reversed pulse reconstruction bug in `pvq.rs` was real and materially affected CELT quality.
- Fixing it is enough to restore the high-bitrate CELT loopback test above its regression threshold.
- It is not enough to finish the constrained 160-byte loopback path.

**Remaining Live Surface**

- The remaining 160-byte failure no longer looks like the same direct pulse-order bug.
- The worst low-bitrate traced band now points deeper into the split / partition path:
  - band `17`
  - len `64`
  - allocated bitres `804`
  - `pvq_k=5`
  - `max_abs_error_vs_quantized=0.40040216`
- That suggests the next investigation target should move from base PVQ coding to recursive band partition / split handling in `third_party/opus-rs/src/bands.rs`, especially the `quant_partition(...)` and `compute_theta(...)` path under tighter budgets.

**Track 4M Zero-Pulse Reconstruction Follow-Up**

- Added zero-pulse trace metadata to partition-leaf diagnostics in `third_party/opus-rs/src/bands.rs`:
  - `has_lowband`
  - `zero_pulse_mode`
  - `fill_masked`
- Zero-pulse mode encoding used by the trace:
  - `0`: ordinary `q>0` path
  - `1`: `q=0` with `fill_masked == 0` (true zero fill)
  - `2`: `q=0` with `lowband` present (lowband-assisted synthesis + renormalize)
  - `3`: `q=0` with no `lowband` (random-noise synthesis + renormalize)

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - worst overall traced leaf:
    - `band=20`
    - `q=0`
    - `k=0`
    - `encode_has_lowband=false`
    - `decode_has_lowband=true`
    - `encode_zero_pulse_mode=3`
    - `decode_zero_pulse_mode=2`
    - `encode_fill_masked=15`
    - `decode_fill_masked=15`
  - worst nonzero-q leaf:
    - `band=19`
    - `encode_q=6`
    - `decode_q=6`
    - `encode_k=6`
    - `decode_k=6`
    - `max_abs_error_vs_quantized=0.0`
    - i.e. ordinary PVQ leaf replay remains exact against the quantized reference
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - FAILS at `0.72 dB`
  - worst overall traced leaf:
    - `band=20`
    - `q=0`
    - `k=0`
    - `encode_has_lowband=false`
    - `decode_has_lowband=true`
    - `encode_zero_pulse_mode=3`
    - `decode_zero_pulse_mode=2`
    - `encode_fill_masked=1`
    - `decode_fill_masked=1`
  - worst nonzero-q partition leaf:
    - `band=19`
    - `encode_q=4`
    - `decode_q=4`
    - `encode_k=4`
    - `decode_k=4`
    - `max_abs_error_vs_quantized=0.0`

**Interpretation After Track 4M**

- The remaining quality loss is no longer pointing at ordinary `q>0` PVQ coding.
- The largest observed leaf-level errors now land on `q=0` leaves.
- But the current encode/decode leaf pairing is not a valid expected-output model for those leaves:
  - encode-side trace has no lowband context on the worst leaf
  - decode-side trace does have lowband context and takes the lowband-assisted zero-pulse branch
  - so comparing decode output against encode input / encode “quantized” reference overstates error on `q=0` leaves

**Decision**

- Track 4M should stop at diagnostics.
- It does **not** prove a production bug in the zero-pulse reconstruction path yet.
- It does prove the current trace model is still invalid for `q=0` leaves.

**Correct Next Target**

- Build a decoder-local `q=0` expected-reference model for the lowband-assisted branch in `third_party/opus-rs/src/bands.rs`.
- Compare decode output against that modeled zero-pulse expectation before making any production fix to:
  - lowband-assisted synthesis
  - noise fill
  - renormalization

**Track 4N Zero-Pulse Reference Model Follow-Up**

- Added a shared decoder-local replay helper in `third_party/opus-rs/src/bands.rs`:
  - `model_zero_pulse_reference_for_test(...)`
- Added bounded decoder-side `q=0` trace capture:
  - seed on entry
  - lowband slice used by the branch
  - pre-renormalization vector
  - post-renormalization vector
- Added those diagnostics to:
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
  - `third_party/opus-rs/tests/celt_budget_test.rs`

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - worst overall leaf still lands at:
    - `band=20`
    - `q=0`
    - `decode_zero_pulse_mode=2`
  - decoder-local zero-pulse modeled replay:
    - `mode=2`
    - `fill_masked=15`
    - `worst_error=0.000000`
  - worst nonzero-q leaf still has:
    - `max_abs_error_vs_quantized=0.0`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - worst overall leaf still lands at:
    - `band=20`
    - `q=0`
    - `decode_zero_pulse_mode=2`
  - decoder-local zero-pulse modeled replay:
    - `mode=2`
    - `fill_masked=1`
    - `worst_error=0.000000`
  - worst nonzero-q partition leaf still has:
    - `max_abs_error_vs_quantized=0.0`

**Interpretation After Track 4N**

- The zero-pulse reconstruction branch is behaving correctly.
- The apparent `q=0` leaf error from Track 4M was a trace-model artifact, not a production bug.
- Ordinary `q>0` partition leaves remain exact against the quantized reference.
- Therefore the remaining live CELT bug is now narrower than:
  - allocation
  - PVQ pulse coding
  - zero-pulse reconstruction

**Remaining Live Surface**

- The strongest remaining signal is still the real PVQ band-shape trace:
  - `Budget loopback worst PVQ band: band=17`
  - `max_abs_error_vs_quantized=0.40040216`
- Since leaf-level replay is clean for both:
  - `q>0` leaves
  - `q=0` leaves with a decoder-local reference
- the next likely fault is higher in the recursive band-shape path:
  - split/recombine handling after leaf decode
  - Hadamard / deinterleave stage interactions
  - parent-level band assembly around `quant_partition(...)`

**Decision**

- Track 4N stops at diagnostics.
- No bounded production change is justified in the zero-pulse branch.

**Correct Next Target**

- Investigate post-leaf band-shape recombination in `third_party/opus-rs/src/bands.rs`, especially:
  - parent-level partition recombine flow
  - deinterleave / Hadamard transforms
  - any decode-side normalization or assembly step after exact leaf reconstruction

**Track 4O Band Recombine Follow-Up**

- Added stage-level band-shape trace data to `PvqBandShapeTrace`:
  - `encode_post_partition_norm`
  - `decode_post_partition_norm`
  - `encode_post_recombine_norm`
  - `decode_post_recombine_norm`
  - `post_partition_max_abs_error`
  - `post_recombine_max_abs_error`
- Added the minimal seam needed for that:
  - `BandCtx.trace_post_partition_norm`

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - stage comparison on the worst real band now reports:
    - `Budget loopback worst PVQ band: band=17`
    - `post_partition_max_abs_error=0.40040216`
    - `post_recombine_max_abs_error=0.40040216`
    - `Budget loopback worst post-partition band: band=17 err=0.400402`
    - `Budget loopback worst post-recombine band: band=17 err=0.400402`

**Interpretation After Track 4O**

- The top-level `quant_band(...)` recombine undo path is not the remaining bug.
- If the error were introduced by:
  - `interleave_hadamard(...)`
  - top-level `haar1(...)` undo
  - final band reassembly after `quant_partition(...)`
  then `post_recombine_max_abs_error` would be materially worse than `post_partition_max_abs_error`.
- It is not. They are identical on the worst traced band.

**Decision**

- Track 4O stops at diagnostics.
- No bounded production fix is justified in:
  - `interleave_hadamard(...)`
  - `deinterleave_hadamard(...)`
  - top-level `quant_band(...)` recombine undo

**Correct Next Target**

- Move one level deeper into recursive partition assembly inside `quant_partition(...)` itself:
  - child split / merge order
  - parent buffer layout after recursive returns
  - branch-local assembly around `compute_theta(...)`
- In other words, the remaining live bug is narrower than top-level band recombination and still inside the recursive partition path in `third_party/opus-rs/src/bands.rs`.

**Track 4J Pulse Budget Source Follow-Up**

- Added decoder-side allocation tracing in `third_party/opus-rs/src/celt.rs` so encoder and decoder `clt_compute_allocation(...)` inputs/outputs can be compared on the same real frame.
- First failing low-bitrate transient trace before the fix showed:
  - identical `start_band`, `end_band`, `signal_bandwidth`, `offsets`, `cap`, `coded_bands`, `ebits`, and `fine_priority`
  - first `pulses[]` divergence at band `9`
  - encoder `alloc_budget_bitres=9548`
  - decoder `alloc_budget_bitres=9540`
  - the exact gap was `8` bitres, matching `anti_collapse_rsv`
- Root cause:
  - encoder-side `CeltEncoder::encode` was calling `clt_compute_allocation(...)` before subtracting `anti_collapse_rsv`
  - decoder-side `CeltDecoder::decode` already subtracted `anti_collapse_rsv` before allocation
  - that created a real transient-only allocation mismatch upstream of `bands.rs`

**Track 4J Bounded Fix**

- Moved encoder-side anti-collapse reservation ahead of `clt_compute_allocation(...)` in `third_party/opus-rs/src/celt.rs`
- After the fix, the low-bitrate transient allocation trace fully aligns:
  - encoder `alloc_budget_bitres=9540`
  - decoder `alloc_budget_bitres=9540`
  - encoder and decoder `pulses[]` now match exactly

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - no first allocation pulse divergence remains
  - no first root-budget / node-budget / leaf-budget divergence remains
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`

**Interpretation After Track 4J**

- Track 4J found and fixed a real upstream bug in `third_party/opus-rs/src/celt.rs`.
- That bug was sufficient to explain the earlier transient low-bitrate `pulses[]` mismatch.
- It is not sufficient to fix the main `160`-byte CELT gate.
- After allocation alignment, the remaining live failure has changed shape:
  - low-bitrate traced leaves now retain matching `q`, `k`, and remaining-bit budgets but still decode to the wrong coefficient vectors
  - direct PVQ leaf replay remains clean (`worst_error=0.000000`)
  - the real loopback gate still shows aligned allocation traces and aligned ancestor partition budgets at the worst leaf, yet the reconstructed vectors still diverge

**Updated Next Target**

- Primary next target shifts back to `third_party/opus-rs/src/bands.rs`
- Specifically:
  - recursive partition / split state after budget handoff is already aligned
  - likely surfaces are `quant_partition(...)`, `compute_theta(...)`, split ordering, or transient/time-division state that affects real vector reconstruction while budget accounting remains matched
- Explicit non-targets for the next pass:
  - `celt.rs` allocation math
  - `rate.rs`
  - base PVQ pulse coding in `pvq.rs`

**Track 4K Partition Shape State Follow-Up**

- Extended `bands.rs` partition tracing to capture real node/leaf `tell_frac()` alongside the existing budget and theta traces.
- Fresh low-bitrate verification now proves:
  - allocation traces align
  - node budgets align
  - leaf budgets align
  - leaf `tell_frac()` aligns
  - leaf `q` and `k` align
  - but the decoded leaf vector still diverges materially
- Representative failing low-bitrate leaf after Track 4J:
  - `band=18`
  - `path_bits=5`
  - `depth=3`
  - `n=12`
  - `b=131`
  - `encode_tell_on_entry=7902`
  - `decode_tell_on_entry=7902`
  - `encode_q=5`
  - `decode_q=5`
  - `encode_k=5`
  - `decode_k=5`
  - `max_abs_error=0.5232569`
  - `rms_error=0.1960812`
- High-bitrate loopback shows the same pattern:
  - matched allocation traces
  - matched ancestor node budgets and `tell_frac()`
  - but a worst leaf still reconstructs the wrong vector

**Interpretation After Track 4K**

- The remaining failure is no longer explainable by:
  - allocation math
  - partition-budget handoff
  - theta bookkeeping visible at the current node trace level
  - leaf budget counters
  - `tell_frac()` misalignment
- Direct PVQ replay remains exact in isolation, so the base pulse coder is still not the first failing surface.
- The next live suspect is narrower:
  - symbol/state synchronization inside the real recursive band-shape path
  - likely inside `bands.rs` around the actual symbol stream consumed before or during leaf PVQ, or in a deeper range-coder state mismatch that `tell_frac()` does not expose

**Updated Next Target After Track 4K**

- Primary next target becomes a symbol/state sync investigation rather than more partition-budget math.
- Focus area:
  - `third_party/opus-rs/src/bands.rs`
  - possibly `third_party/opus-rs/src/range_coder.rs` instrumentation only
- Explicit non-targets for the next pass:
  - `celt.rs` allocation logic
  - `rate.rs`
  - MDCT or emphasis code

**Track 4L Band Symbol/State Sync Follow-Up**

- Extended leaf tracing to compare decode output against a true encode-side quantized reference instead of the old mutated encode buffer.
- That corrected another diagnostic error: earlier leaf-vector comparisons were overstating divergence because the encode-side trace was not a real quantized reconstruction.
- After the correction, the first/worst traced divergent leaves shift to the `q=0` branch:
  - low-bitrate representative leaf:
    - `band=20`
    - `path_bits=0`
    - `depth=0`
    - `n=176`
    - `q=0`
    - `k=0`
    - `fill=15`
    - matched `remaining_bits` and matched `tell_frac()`
  - loopback representative leaf:
    - `band=20`
    - `path_bits=0`
    - `depth=0`
    - `n=176`
    - `q=0`
    - `k=0`
    - `fill=1`
    - matched `remaining_bits` and matched `tell_frac()`
- This matters because the `q=0` branch does not use normal PVQ pulse coding at all:
  - encoder leaves the input vector untouched when no pulses are allocated
  - decoder synthesizes noise / lowband-derived content in the zero-pulse path
- So the remaining live mismatch is not evidence of hidden symbol-stream divergence inside PVQ.
- The real live surface is now narrower:
  - zero-pulse reconstruction / noise-fill / lowband synthesis behavior in `bands.rs`

**Interpretation After Track 4L**

- Track 4L did not justify a bounded symbol/state fix.
- It disproved the current symbol-sync hypothesis and corrected the trace model.
- The remaining quality gap is now concentrated in the zero-pulse (`q=0`) reconstruction path, not in:
  - allocation math
  - range-coder budget sync
  - ordinary PVQ pulse coding

**Updated Next Target After Track 4L**

- Primary next target becomes `q=0` leaf reconstruction in `third_party/opus-rs/src/bands.rs`
- Focus areas:
  - no-pulse noise fill
  - lowband-assisted reconstruction
  - renormalization behavior in the zero-pulse path
- Explicit non-targets for the next pass:
  - `celt.rs` allocation logic
  - `rate.rs`
  - ordinary `q>0` PVQ encode/decode

**Track 4G Low-Bitrate Partition Follow-Up**

- Added bounded partition tracing in `third_party/opus-rs/src/bands.rs`:
  - split-node snapshots for `itheta`, `qalloc`, `delta`, `mbits`, `sbits`, recurse order, and branch path
  - leaf snapshots for `q`, `k`, remaining-bit budget after the leaf reservation, and the encoded/decoded leaf vectors
- Added focused low-bitrate diagnostics in:
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`

**What the Trace Proved**

- The failing `160`-byte loopback still stalls at `0.72 dB`.
- The worst real low-bitrate partition leaf in the first failing frame is:
  - band `17`
  - `path_bits=1`
  - `depth=2`
  - `n=16`
  - `lm=1`
  - `b=186`
  - `encode_q=7`
  - `decode_q=7`
  - `encode_remaining_bits_after_budget=2539`
  - `decode_remaining_bits_after_budget=2539`
  - `max_abs_error=0.40040216`
  - `rms_error=0.23956227`
- Its ancestor split nodes match exactly between encode and decode:
  - depth `0`: `itheta=8192`, `qalloc=22`, `mbits=391`, `sbits=391`
  - depth `1`: `itheta=8192`, `qalloc=19`, `mbits=186`, `sbits=186`
- The best cross-match for that decoded leaf is not its same-path encoded leaf:
  - encoded leaf from the same band with `path_bits=2`, `depth=2`
  - RMS error vs the decoded worst leaf: `0.075893`

**Focused Replay Result**

- The focused low-bitrate replay test isolates the worst traced leaf and replays it through direct PVQ quantize/unquantize.
- That direct replay passes exactly:
  - `Low-bitrate leaf replay: band=11 path=1 depth=1 k=7 worst_error=0.000000`
- In that same focused trace, the real encoder/decoder do not arrive at the leaf with matching leaf budget state:
  - `encode_q=8`
  - `decode_q=7`
  - `encode_remaining_bits_after_budget=6383`
  - `decode_remaining_bits_after_budget=6391`
  - `max_abs_error=0.8584037`

**Bounded Hypothesis That Was Ruled Out**

- A bounded production hypothesis was tested and rejected:
  - removing the encode-only no-split shortcuts for `n == 4`, `n == 8`, and `n == 16` inside `quant_partition_encode(...)`
- Result:
  - `celt_loopback_160bytes` stayed at `0.72 dB`
  - the same real worst-leaf diagnostics remained
- That change was reverted. It was a dead end, not a fix.

**Updated Interpretation**

- Base PVQ leaf coding is not the remaining root cause.
- The live low-bitrate bug is deeper in recursive partition handling:
  - either leaf-path mapping drifts under recursion
  - or encode/decode reach some leaves with different bit-budget state before the leaf coder runs
- The strongest live signal is no longer “bad leaf decode math”; it is “encode/decode leaf state divergence under low-bitrate recursion”.

**Updated Next Target**

- Primary next target remains `third_party/opus-rs/src/bands.rs`
- The next focused investigation should narrow to:
  - recursive branch/path bookkeeping
  - split-bit rebalance effects on descendant leaf budgets
  - any low-bitrate interaction between `fill`, recurse order, and path-local bit accounting before the leaf coder runs

**Track 4H Low-Bitrate Leaf Budget Divergence Follow-Up**

- Extended the partition trace in `third_party/opus-rs/src/bands.rs` to capture:
  - stable encode/decode visit indices
  - root and descendant node entry budgets
  - `qn`
  - `b` before and after `compute_theta(...)`
  - leaf entry `remaining_bits`
  - `curr_bits`
  - post-leaf `remaining_bits`
- Updated:
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  so the first real node divergence is reported, not just the worst final leaf error.

**What Track 4H Proved**

- Direct low-bitrate leaf PVQ replay still passes exactly:
  - `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - `Low-bitrate leaf replay ... worst_error=0.000000`
- The first hard divergence appears before the failing leaf coder runs.

Focused low-bitrate trace:
- first partition-node divergence:
  - `band=9`
  - `depth=0`
  - `encode_b=291`
  - `decode_b=292`
  - `encode_remaining_bits_before_qalloc=7111`
  - `decode_remaining_bits_before_qalloc=7111`
  - `encode_qalloc=28`
  - `decode_qalloc=28`
  - `encode_b_after_theta=263`
  - `decode_b_after_theta=264`
  - `encode_mbits=140`
  - `decode_mbits=141`
- This matters because it shows the split node is entered with different `b` on encode and decode even though the running `remaining_bits` budget is still identical.

Later failing branch evidence:
- divergent ancestor of the first mismatching leaf:
  - `band=11`
  - `depth=0`
  - `encode_b=269`
  - `decode_b=271`
  - `encode_qn=8`
  - `decode_qn=10`
  - `encode_qalloc=25`
  - `decode_qalloc=27`
  - `encode_b_after_theta=244`
  - `decode_b_after_theta=244`
- first mismatching leaf below that node:
  - `encode_remaining_bits_on_entry=6522`
  - `decode_remaining_bits_on_entry=6520`
  - `encode_curr_bits=139`
  - `decode_curr_bits=129`
  - `encode_q=8`
  - `decode_q=7`
  - `encode_remaining_bits_after_budget=6383`
  - `decode_remaining_bits_after_budget=6391`

**Interpretation**

- The remaining low-bitrate bug is not a base PVQ leaf coding bug.
- It is not first explained by local leaf budget reservation either.
- The earliest proven divergence is that encode and decode enter some root partition nodes with different per-band `b` budgets while the global running `remaining_bits` is still aligned.
- That pushes the live bug earlier than `compute_theta(...)` on those nodes.
- The next likely surface is the per-band budget handoff into `quant_partition(...)`, not the descendant recursion itself.

**Updated Next Target**

- Primary next target remains `third_party/opus-rs/src/bands.rs`
- But the focus should shift upward to:
  - root band-budget handoff into `quant_partition(...)`
  - any encode/decode asymmetry in `quant_band(...)` or the caller path that computes per-band `b`
  - interactions between time-division / recombine handling and the root budget passed into each band

**Track 4I Root Band Budget Handoff Follow-Up**

- Added a root-band budget trace in `third_party/opus-rs/src/bands.rs` at the `quant_all_bands(...)` level.
- The trace records, per mono band:
  - `tell`
  - `balance` before and after tell adjustment
  - `remaining_bits`
  - `curr_balance`
  - `pulses[i]`
  - root `b`
  - `b_blocks`
  - `tf_change`
  - `n`
- Updated:
  - `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
  - `third_party/opus-rs/tests/celt_budget_test.rs`
  so the first root-band budget divergence is printed before the partition-node trace.

**What Track 4I Proved**

- The first real root budget mismatch is already present before `quant_band(...)` calls into `quant_partition(...)`.
- Focused low-bitrate trace:
  - first root budget divergence:
    - `band=9`
    - `encode_tell=3120`
    - `decode_tell=3120`
    - `encode_balance_before_tell_adjust=3121`
    - `decode_balance_before_tell_adjust=3121`
    - `encode_balance_after_tell_adjust=1`
    - `decode_balance_after_tell_adjust=1`
    - `encode_remaining_bits=7111`
    - `decode_remaining_bits=7111`
    - `encode_curr_balance=0`
    - `decode_curr_balance=0`
    - `encode_pulses=291`
    - `decode_pulses=292`
    - `encode_b=291`
    - `decode_b=292`
- That is decisive:
  - the impossible-looking `b` mismatch is not a tracing error inside `bands.rs`
  - decode-side `pulses[i]` is already different before root partition entry

**Interpretation**

- The remaining low-bitrate CELT failure is no longer credibly a `bands.rs` partition bug.
- `bands.rs` is only exposing a mismatch that already exists in the per-band pulse budget handed to it.
- The next live bug is upstream of root partition entry, in the logic that computes or reconstructs the per-band pulse budget array used by `quant_all_bands(...)`.

**Updated Next Target**

- The next focused investigation should move out of `bands.rs`
- Primary likely surfaces:
  - `third_party/opus-rs/src/celt.rs`
  - `third_party/opus-rs/src/rate.rs`
- Specifically:
  - trace where the decoder-side `pulses[i]` first diverges from the encoder-side allocation
  - compare the source of `pulses[]`, `ebits[]`, and coded-band bookkeeping between real encode and decode paths

**Track 4Q Recursive Node Pairing Follow-Up**

- Track 4P stopped on a trace bug, not a codec fix:
  - encode-side recursive parent snapshots were being captured
  - decode-side roundtrip nodes were not receiving post-recursion child and parent vectors
- The concrete repair in `third_party/opus-rs/src/bands.rs` was narrow:
  - keep the node visit index returned by `record_partition_node_snapshot(...)` on the decode path
  - call `record_partition_node_post_children(...)` after decode-side child recursion returns
  - no codec math changed

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - the trace now contains populated encode/decode child and parent post-children vectors
  - first recursive node mismatch:
    - `stage=left_child`
    - `band=1`
    - `path_bits=0`
    - `depth=0`
    - `left_child_max_abs_error=0.040468752`
    - `right_child_max_abs_error=0.039943874`
    - `parent_after_children_max_abs_error=0.040468752`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - first recursive node mismatch in the real gate:
    - `stage=left_child`
    - `band=2`
    - `path_bits=0`
    - `depth=0`
    - `left_child_max_abs_error=0.01598692`
    - `right_child_max_abs_error=0.072287835`
    - `parent_after_children_max_abs_error=0.072287835`
  - worst recursive node mismatch in the real gate:
    - `band=17`
    - `path_bits=0`
    - `depth=1`
    - `left_child_max_abs_error=0.40008312`
    - `right_child_max_abs_error=0.40040216`
    - `parent_after_children_max_abs_error=0.40040216`

**Interpretation After Track 4Q**

- The old Track 4P premise failed because the recursive node trace was incomplete.
- Track 4Q fixed that instrumentation gap.
- The first real recursive mismatch is now proven above exact leaf coding:
  - it appears as soon as child vectors return to a parent node
  - the earliest visible mismatch is on the left child branch
- This narrows the next live surface to recursive child-return / parent partition assembly inside `third_party/opus-rs/src/bands.rs`.

**Updated Next Boundary**

- Primary next target:
  - recursive child return placement and parent-side partition assembly in `third_party/opus-rs/src/bands.rs`
- Explicit non-targets for the next pass:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - another broad CELT allocation pass

**Track 4R Recursive Child Return / Assembly Follow-Up**

- Added explicit step-local recursive node vectors in `third_party/opus-rs/src/bands.rs`:
  - `encode_left_child_after_return`
  - `decode_left_child_after_return`
  - `encode_right_child_after_return`
  - `decode_right_child_after_return`
  - `encode_parent_before_final_return`
  - `decode_parent_before_final_return`
- Tightened the focused trace guard so the earliest recursive mismatch must carry populated child-return vectors.

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - earliest recursive mismatch remains:
    - `stage=left_child`
    - `band=1`
    - `path_bits=0`
    - `depth=0`
    - `left_child_max_abs_error=0.040468752`
    - `right_child_max_abs_error=0.039943874`
    - `parent_after_children_max_abs_error=0.040468752`
  - the new step-local vectors confirm the same thing:
    - `encode_left_child_after_return` already differs from `decode_left_child_after_return`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - earliest recursive mismatch in the real gate remains:
    - `stage=left_child`
    - `band=2`
    - `path_bits=0`
    - `depth=0`
    - `left_child_max_abs_error=0.01598692`
    - `right_child_max_abs_error=0.072287835`
    - `parent_after_children_max_abs_error=0.072287835`
  - worst recursive mismatch in the real gate still clusters at:
    - `band=17`
    - `depth=1`
    - `left_child_max_abs_error=0.40008312`
    - `right_child_max_abs_error=0.40040216`

**Interpretation After Track 4R**

- Parent-side partition assembly is not the earliest live defect.
- The first proven drift is already present when the left child returns to its parent.
- Because the earliest mismatch is upstream of parent recombination, a bounded parent-assembly fix is not justified from this pass.
- No production codec math changed during Track 4R.

**Updated Next Boundary**

- Primary next target narrows again:
  - recursive left-child return path inside `third_party/opus-rs/src/bands.rs`
  - specifically the sub-branch reached before the first parent assembly site at root depth
- Explicit non-targets stay the same:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - parent-after-children recombine tweaks without earlier proof

**Track 4S Left-Child Return Follow-Up**

- Added one more bounded seam in `third_party/opus-rs/src/bands.rs`:
  - `encode_parent_left_slice_after_left_return`
  - `decode_parent_left_slice_after_left_return`
  - `left_return_parent_slice_max_abs_error`
- This captures the exact parent-observed left slice immediately after left recursion returns, then pairs it into the decode trace.
- A post-children fallback keeps the same node populated if the earlier hook is not visible in that traced path. No codec math changed.

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - earliest recursive mismatch now reports:
    - `stage=child_local_visible_in_parent_left_slice`
    - `band=1`
    - `path_bits=0`
    - `depth=0`
    - `left_child_max_abs_error=0.040468752`
    - `left_return_parent_slice_max_abs_error=0.040468752`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - earliest recursive mismatch in the real gate now reports:
    - `stage=child_local_visible_in_parent_left_slice`
    - `band=2`
    - `path_bits=0`
    - `depth=0`
    - `left_child_max_abs_error=0.01598692`
    - `left_return_parent_slice_max_abs_error=0.01598692`
  - worst recursive mismatch remains deeper in the same family:
    - `band=17`
    - `depth=1`
    - `left_child_max_abs_error=0.40008312`
    - `right_child_max_abs_error=0.40040216`
    - `parent_after_children_max_abs_error=0.40040216`

**Interpretation After Track 4S**

- The parent-observed left slice is not introducing new drift.
- At the first mismatch, the parent-left-slice error is numerically identical to the left-child-return error.
- That means the parent is only observing an already-bad child result; it is not corrupting it during writeback.
- No bounded parent writeback fix in `third_party/opus-rs/src/bands.rs` is justified from this pass.

**Updated Next Boundary**

- Primary next target narrows again:
  - inside the recursive left-child path itself, before the parent observes the returned slice
  - still within `third_party/opus-rs/src/bands.rs`
- Explicit non-targets remain:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - parent writeback / parent-after-children recombine tweaks without earlier proof

**Track 4T Deeper Left-Child Recursion Follow-Up**

- Added deeper descendant reporting under the first bad left-child branch in both focused and real CELT traces.
- Added branch-local left-child call input fields to recursive node traces in `third_party/opus-rs/src/bands.rs`:
  - `encode_left_child_budget_before_call`
  - `decode_left_child_budget_before_call`
  - `encode_left_child_fill_before_call`
  - `decode_left_child_fill_before_call`
  - `encode_left_child_gain_before_call`
  - `decode_left_child_gain_before_call`
- Fixed encode-side snapshot seeding so left-first descendants no longer default those fields to zero.
- No production codec math changed during Track 4T.

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - earliest recursive mismatch remains:
    - `stage=child_local_visible_in_parent_left_slice`
    - `band=1`
    - `path_bits=0`
    - `depth=0`
    - `left_child_max_abs_error=0.040468752`
  - first deeper descendant under that left branch now reports:
    - `stage=child_internal_after_equal_call_inputs`
    - `band=12`
    - `path_bits=0`
    - `depth=1`
    - `encode_left_child_budget_before_call=194`
    - `decode_left_child_budget_before_call=194`
    - `encode_left_child_fill_before_call=15`
    - `decode_left_child_fill_before_call=15`
    - `encode_left_child_gain_before_call=0.78361416`
    - `decode_left_child_gain_before_call=0.78361416`
    - `left_child_max_abs_error=0.039156854`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - earliest recursive mismatch in the real gate remains:
    - `stage=child_local_visible_in_parent_left_slice`
    - `band=2`
    - `path_bits=0`
    - `depth=0`
    - `left_child_max_abs_error=0.01598692`
  - first deeper descendant under that real left branch now reports:
    - `stage=child_internal_after_equal_call_inputs`
    - `band=12`
    - `path_bits=0`
    - `depth=1`
    - `encode_left_child_budget_before_call=144`
    - `decode_left_child_budget_before_call=144`
    - `encode_left_child_fill_before_call=7`
    - `decode_left_child_fill_before_call=7`
    - `encode_left_child_gain_before_call=0.5720988`
    - `decode_left_child_gain_before_call=0.5720988`
    - `left_child_max_abs_error=0.08876771`

**Interpretation After Track 4T**

- The earlier `left_child_call_inputs_diverge` result was an instrumentation artifact. That is now resolved.
- At the first deeper descendant where the trace stays stable, encode and decode enter the left-child recursion with matching budget, fill, and gain inputs.
- The mismatch is therefore child-internal after equal inputs, not another budget handoff or trace pairing problem.
- This moves the live boundary deeper into recursive left-child processing inside `third_party/opus-rs/src/bands.rs`.

**Updated Next Boundary**

- Primary next target narrows again:
  - the deeper left-child recursive path inside `third_party/opus-rs/src/bands.rs`
  - specifically the child-internal branch reached after equal left-child call inputs are established
- Explicit non-targets remain:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - parent writeback / parent-after-children recombine tweaks
  - left-child budget handoff changes without earlier proof

**Track 4U Child-Internal Left Recursion Follow-Up**

- Added child-local scalar trace fields in `third_party/opus-rs/src/bands.rs` for the current recursive node itself:
  - `encode_child_remaining_bits_on_entry`
  - `decode_child_remaining_bits_on_entry`
  - `encode_child_tell_on_entry`
  - `decode_child_tell_on_entry`
  - `encode_child_fill_on_entry`
  - `decode_child_fill_on_entry`
  - `encode_child_theta_qalloc`
  - `decode_child_theta_qalloc`
  - `encode_child_theta_delta`
  - `decode_child_theta_delta`
  - `encode_child_theta_itheta`
  - `decode_child_theta_itheta`
- Refined both CELT trace tests so they now classify the first child-internal node as one of:
  - `child_entry_state_diverges`
  - `child_local_theta_state_diverges`
  - `child_subrecursion_or_leaf_return_diverges`
- No production codec math changed during Track 4U.

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - first deeper descendant under the bad left branch remains:
    - `band=12`
    - `depth=1`
    - equal left-child call inputs
    - equal child entry state:
      - `encode_child_remaining_bits_on_entry=6256`
      - `decode_child_remaining_bits_on_entry=6256`
      - `encode_child_tell_on_entry=3975`
      - `decode_child_tell_on_entry=3975`
      - `encode_child_fill_on_entry=15`
      - `decode_child_fill_on_entry=15`
    - equal child theta state:
      - `encode_child_theta_qalloc=28`
      - `decode_child_theta_qalloc=28`
      - `encode_child_theta_delta=-149`
      - `decode_child_theta_delta=-149`
      - `encode_child_theta_itheta=1638`
      - `decode_child_theta_itheta=1638`
    - `left_child_max_abs_error=0.039156854`
  - first child-internal node classification now reports:
    - `stage=child_subrecursion_or_leaf_return_diverges`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - first deeper descendant under the real bad left branch remains:
    - `band=12`
    - `depth=1`
    - equal left-child call inputs
    - equal child entry state:
      - `encode_child_remaining_bits_on_entry=5883`
      - `decode_child_remaining_bits_on_entry=5883`
      - `encode_child_tell_on_entry=4356`
      - `decode_child_tell_on_entry=4356`
      - `encode_child_fill_on_entry=3`
      - `decode_child_fill_on_entry=3`
    - equal child theta state:
      - `encode_child_theta_qalloc=23`
      - `decode_child_theta_qalloc=23`
      - `encode_child_theta_delta=-26`
      - `decode_child_theta_delta=-26`
      - `encode_child_theta_itheta=6553`
      - `decode_child_theta_itheta=6553`
    - `left_child_max_abs_error=0.08876771`
  - first child-internal node classification now reports:
    - `stage=child_subrecursion_or_leaf_return_diverges`

**Interpretation After Track 4U**

- The remaining defect is not at child entry state.
- The remaining defect is not in the child node’s local theta/split scalar state.
- With equal parent-to-child call inputs, equal child entry state, and equal child theta state, the next live boundary is deeper:
  - returned subchild state
  - or leaf-return state beneath that child
- No bounded production fix is justified from Track 4U.

**Updated Next Boundary**

- Primary next target narrows again:
  - inside the child’s own returned-subchild / leaf-return path within `third_party/opus-rs/src/bands.rs`
  - below the current child entry and local theta state seams
- Explicit non-targets remain:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - parent assembly
  - left-child call input handoff
  - child entry-state or child local-theta changes without deeper proof

**Track 4V Returned-Subchild / Leaf-Return Follow-Up**

- Added bounded return-path ancestry fields in `third_party/opus-rs/src/bands.rs`:
  - `encode_parent_node_visit_index`
  - `decode_parent_node_visit_index`
- Extended the CELT trace tests to report:
  - the stable child node under equal call inputs, equal child entry state, and equal child theta state
  - the first descendant below that node
  - the first leaf below that node
  - a return-path stage classification:
    - `returned_subchild_diverges`
    - `leaf_return_diverges`
    - `no_deeper_return_divergence`
- No production codec math changed during Track 4V.

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - stable child remains:
    - `band=12`
    - `depth=1`
    - equal left-child call inputs
    - equal child entry state
    - equal child theta state
  - first descendant below that stable child is a recursive node, not a leaf:
    - `band=18`
    - `depth=2`
    - nonzero recursive node errors are already present there
  - first leaf below the stable child is also present, but the return-path stage reports:
    - `returned_subchild_diverges`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - stable child remains:
    - `band=12`
    - `depth=1`
    - equal left-child call inputs
    - equal child entry state
    - equal child theta state
  - first descendant below that stable child is again a recursive node with nonzero recursive errors
  - first leaf below that stable child is present and now carries parent ancestry:
    - representative traced nonzero-q leaf:
      - `band=19`
      - `depth=2`
      - `encode_parent_node_visit_index=27`
      - `decode_parent_node_visit_index=27`
      - `max_abs_error_vs_quantized=0.0`
  - the real-gate return-path stage also reports:
    - `returned_subchild_diverges`

**Interpretation After Track 4V**

- The next live defect is not first visible at leaf return.
- The next live defect is already present at the returned-subchild level below the stable child node.
- That means the remaining boundary is now narrower than:
  - child entry state
  - child local theta state
  - first leaf-return state
- No bounded production fix is justified from Track 4V.

**Updated Next Boundary**

- Primary next target narrows again:
  - the returned-subchild recursive node directly below the current stable child inside `third_party/opus-rs/src/bands.rs`
  - before any deeper leaf-return modeling
- Explicit non-targets remain:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - leaf-return handling without an earlier returned-subchild proof

**Track 4W Returned-Subchild Recursive Node Follow-Up**

- Added returned-subchild-local scalar fields in `third_party/opus-rs/src/bands.rs`:
  - `encode_subchild_remaining_bits_on_entry`
  - `decode_subchild_remaining_bits_on_entry`
  - `encode_subchild_tell_on_entry`
  - `decode_subchild_tell_on_entry`
  - `encode_subchild_fill_on_entry`
  - `decode_subchild_fill_on_entry`
  - `encode_subchild_theta_qalloc`
  - `decode_subchild_theta_qalloc`
  - `encode_subchild_theta_delta`
  - `decode_subchild_theta_delta`
  - `encode_subchild_theta_itheta`
  - `decode_subchild_theta_itheta`
- Refined the CELT trace tests to report:
  - the first returned-subchild recursive node directly below the current stable child
  - the first deeper descendant below that returned-subchild node
  - the first leaf below that returned-subchild node
  - a returned-subchild stage classification:
    - `returned_subchild_entry_state_diverges`
    - `returned_subchild_local_theta_diverges`
    - `returned_subchild_left_return_diverges`
    - `returned_subchild_right_return_diverges`
    - `returned_subchild_post_children_or_leaf_diverges`
- No production codec math changed during Track 4W.

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - stable child remains:
    - `band=12`
    - `depth=1`
    - equal left-child call inputs
    - equal child entry state
    - equal child theta state
  - first returned-subchild node below that stable child is:
    - `band=18`
    - `depth=2`
  - there is no deeper recursive descendant below that returned-subchild node in the focused trace
  - the first leaf below that returned-subchild node is:
    - `band=18`
    - `depth=3`
    - `encode_parent_node_visit_index=23`
    - `decode_parent_node_visit_index=23`
    - `max_abs_error_vs_quantized=0.0`
  - the focused returned-subchild stage is:
    - `returned_subchild_left_return_diverges`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - current stable child in the real gate is:
    - `band=2`
    - `depth=0`
    - equal left-child call inputs
    - equal child entry state
    - equal child theta state
  - first returned-subchild node below that stable child is:
    - `band=12`
    - `depth=1`
  - first deeper descendant below that returned-subchild node is:
    - `band=19`
    - `depth=2`
    - its own left-child and right-child recursive errors are already nonzero
  - first leaf below that returned-subchild node is:
    - `band=12`
    - `depth=2`
    - `encode_parent_node_visit_index=7`
    - `decode_parent_node_visit_index=7`
    - `max_abs_error_vs_quantized=0.0`
  - the real-gate returned-subchild stage is:
    - `returned_subchild_left_return_diverges`

**Interpretation After Track 4W**

- The next live defect is not:
  - returned-subchild entry state
  - returned-subchild local theta state
  - returned-subchild leaf return
- The first exact returned-subchild substage is now proven:
  - `returned_subchild_left_return_diverges`
- In the focused trace, that left-return seam lands directly on the returned-subchild node.
- In the real `160`-byte gate, the returned-subchild node itself already classifies as left-return divergence and also contains a deeper recursive descendant with nonzero recursive errors.
- No bounded production fix is justified from Track 4W because the trace still only localizes the defect to the returned-subchild left-return path; it does not yet distinguish:
  - that node's own left-child return writeback
  - the next deeper recursive left-child seam beneath it

**Updated Next Boundary**

- Primary next target narrows again:
  - the returned-subchild left-return path inside `third_party/opus-rs/src/bands.rs`
  - specifically, the first left-child return seam under the proven returned-subchild node
- Explicit non-targets remain:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - right-child return handling before left-return is resolved
  - leaf-return handling before the returned-subchild left-return seam is exhausted

**Track 4X Returned-Subchild Left-Return Follow-Up**

- Added returned-subchild-left call-input scalar fields in `third_party/opus-rs/src/bands.rs`:
  - `encode_subchild_left_budget_before_call`
  - `decode_subchild_left_budget_before_call`
  - `encode_subchild_left_fill_before_call`
  - `decode_subchild_left_fill_before_call`
  - `encode_subchild_left_gain_before_call`
  - `decode_subchild_left_gain_before_call`
- Refined the CELT trace tests to report:
  - the first deeper left-branch descendant below the returned-subchild node
  - the first leaf below that returned-subchild left branch
  - a returned-subchild-left stage classification:
    - `returned_subchild_left_call_inputs_diverge`
    - `returned_subchild_left_child_visible_before_parent_writeback`
    - `returned_subchild_parent_left_slice_after_left_return_diverges`
    - `returned_subchild_left_return_unresolved`
- No production codec math changed during Track 4X.

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - stable child remains:
    - `band=12`
    - `depth=1`
  - first returned-subchild node remains:
    - `band=18`
    - `depth=2`
  - its left-call inputs match:
    - `encode_subchild_left_budget_before_call=141`
    - `decode_subchild_left_budget_before_call=141`
    - `encode_subchild_left_fill_before_call=31`
    - `decode_subchild_left_fill_before_call=31`
    - `encode_subchild_left_gain_before_call=0.36661366`
    - `decode_subchild_left_gain_before_call=0.36661366`
  - there is no deeper left-branch descendant below that returned-subchild node in the focused trace
  - the first leaf below that returned-subchild left branch exists, but:
    - `band=18`
    - `depth=3`
    - `max_abs_error_vs_quantized=0.0`
  - the focused left-return substage is:
    - `returned_subchild_left_child_visible_before_parent_writeback`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - stable child remains:
    - `band=2`
    - `depth=0`
  - first returned-subchild node remains:
    - `band=12`
    - `depth=1`
  - its left-call inputs also match:
    - `encode_subchild_left_budget_before_call=144`
    - `decode_subchild_left_budget_before_call=144`
    - `encode_subchild_left_fill_before_call=7`
    - `decode_subchild_left_fill_before_call=7`
    - `encode_subchild_left_gain_before_call=0.5720988`
    - `decode_subchild_left_gain_before_call=0.5720988`
  - the first deeper left-branch descendant below that returned-subchild node is:
    - `band=19`
    - `depth=2`
    - and it already carries divergent left-call inputs in its own local trace
  - the first leaf below that returned-subchild left branch exists, but:
    - `band=12`
    - `depth=2`
    - `max_abs_error_vs_quantized=0.0`
  - the real-gate left-return substage is:
    - `returned_subchild_left_child_visible_before_parent_writeback`

**Interpretation After Track 4X**

- The returned-subchild left seam is not:
  - a returned-subchild left-call input mismatch
  - a pure parent-left-slice writeback defect
- The first exact left-return substage is now proven:
  - `returned_subchild_left_child_visible_before_parent_writeback`
- In both focused and real traces, the child-return vector is already wrong before any additional parent-left-slice amplification.
- The real gate also proves that, below the returned-subchild node, a deeper left-branch recursive descendant (`band=19`, `depth=2`) already has divergent local left-call inputs.
- No bounded production fix is justified from Track 4X because the left-return defect is now shown to originate deeper than the returned-subchild node’s own left-call surface.

**Updated Next Boundary**

- Primary next target narrows again:
  - the deeper left-branch recursive descendant under the returned-subchild node in `third_party/opus-rs/src/bands.rs`
  - specifically, the first descendant whose own left-call inputs diverge in the real gate
- Explicit non-targets remain:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - parent-left-slice writeback changes at the returned-subchild node itself
  - leaf-return handling before the deeper left-branch descendant is exhausted

**Track 4Y Deeper Left-Branch Descendant Follow-Up**

- Added bounded recursive-node ancestry fields in `third_party/opus-rs/src/bands.rs`:
  - `encode_parent_node_visit_index`
  - `decode_parent_node_visit_index`
- Refined the CELT trace tests to report:
  - the first deeper left-branch descendant under the returned-subchild node whose own local left-call inputs diverge
  - whether that descendant is the first local divergence or is inheriting an already-bad left child from its traced parent
- No production codec math changed during Track 4Y.

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - stable child remains:
    - `band=12`
    - `depth=1`
  - returned-subchild remains:
    - `band=18`
    - `depth=2`
  - there is still no deeper left-branch descendant below that returned-subchild in the focused trace
  - focused left-return stage remains:
    - `returned_subchild_left_child_visible_before_parent_writeback`
  - focused deeper-descendant stage is now explicitly:
    - `no_descendant_left_call_input_divergence`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - stable child remains:
    - `band=2`
    - `depth=0`
  - returned-subchild remains:
    - `band=12`
    - `depth=1`
  - first deeper left-branch descendant with local left-call-input divergence is now pinned exactly:
    - `band=19`
    - `depth=2`
    - `encode_parent_node_visit_index=24`
    - `decode_parent_node_visit_index=24`
    - `encode_subchild_left_budget_before_call=0`
    - `decode_subchild_left_budget_before_call=146`
    - `encode_subchild_left_fill_before_call=0`
    - `decode_subchild_left_fill_before_call=15`
    - `encode_subchild_left_gain_before_call=0.0`
    - `decode_subchild_left_gain_before_call=0.396716`
  - the real-gate deeper-descendant stage is now explicitly:
    - `parent_already_returns_bad_left_child`

**Interpretation After Track 4Y**

- The focused trace and the real `160`-byte gate now separate cleanly:
  - focused path has no deeper descendant with local left-call-input divergence below the returned-subchild node
  - real gate does have one, but it is not the first live seam
- The immediate traced parent of that real-gate descendant is already returning a bad left child before the descendant’s own local divergence is observed.
- That means the Track 4X hypothesis was incomplete:
  - the deeper descendant’s local left-call-input mismatch is real
  - but it is inherited from an earlier bad left-child return, not the first defect
- No bounded production fix is justified from Track 4Y because the trace still points to an earlier recursive left-return seam above the descendant.

**Updated Next Boundary**

- Primary next target narrows again:
  - the earlier recursive left-return seam above the `band=19`, `depth=2` descendant in `third_party/opus-rs/src/bands.rs`
  - specifically, the first parent on that branch that already returns a bad left child before the descendant’s own local inputs diverge
- Explicit non-targets remain:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - local descendant call-input fixes at `band=19`, `depth=2` before the earlier parent seam is exhausted

**Track 4Z Earlier Parent Left-Return Follow-Up**

- Refined the CELT trace tests to report:
  - the earlier parent above the Track 4Y `band=19`, `depth=2` descendant
  - whether that parent is already bad on left-child return or only on its parent-left slice
  - whether that earlier parent’s immediate left child is already locally divergent
- No production codec math changed during Track 4Z.

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - stable child remains:
    - `band=12`
    - `depth=1`
  - returned-subchild remains:
    - `band=18`
    - `depth=2`
  - there is still no deeper left-branch descendant with local left-call-input divergence in the focused trace
  - earlier parent stage is:
    - `missing_earlier_parent`
  - earlier parent child stage is:
    - `missing_earlier_parent_child`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - stable child remains:
    - `band=2`
    - `depth=0`
  - returned-subchild remains:
    - `band=12`
    - `depth=1`
  - the earlier parent above the Track 4Y descendant is now pinned exactly:
    - `band=19`
    - `depth=1`
    - `encode_left_child_budget_before_call=309`
    - `decode_left_child_budget_before_call=309`
    - `encode_left_child_fill_before_call=7`
    - `decode_left_child_fill_before_call=7`
    - `encode_left_child_gain_before_call=0.5610284`
    - `decode_left_child_gain_before_call=0.5610284`
  - the earlier parent left-return stage is:
    - `earlier_parent_left_child_visible_before_parent_writeback`
  - the earlier parent’s immediate left child is the already-pinned descendant:
    - `band=19`
    - `depth=2`
    - `encode_left_child_budget_before_call=0`
    - `decode_left_child_budget_before_call=146`
    - `encode_left_child_fill_before_call=0`
    - `decode_left_child_fill_before_call=15`
    - `encode_left_child_gain_before_call=0.0`
    - `decode_left_child_gain_before_call=0.396716`
  - the earlier parent child stage is:
    - `earlier_parent_child_left_call_inputs_diverge`

**Interpretation After Track 4Z**

- The earlier-parent seam is now resolved one level further:
  - the parent at `band=19`, `depth=1` is already bad on left-child return
  - but its own left-call inputs still match
- The immediate left child under that parent is the previously pinned node at:
  - `band=19`
  - `depth=2`
- That child is the first node on this branch with locally divergent left-call inputs.
- No bounded production fix is justified from Track 4Z because the trace still stops at classification; it does not yet prove which exact `bands.rs` call site or state handoff causes the `band=19`, `depth=2` node to enter with zeroed encode-side left-call inputs.

**Updated Next Boundary**

- Primary next target narrows again:
  - the local left-call-input construction at the `band=19`, `depth=2` node in `third_party/opus-rs/src/bands.rs`
  - specifically, why encode-side `left_child_budget_before_call`, `left_child_fill_before_call`, and `left_child_gain_before_call` collapse to zero while the earlier parent still enters with aligned state
- Explicit non-targets remain:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - parent-left-slice writeback changes at `band=19`, `depth=1`

**Track 4AA Band 19 Depth 2 Left-Call-Input Follow-Up**

- Added bounded local source-state trace fields in `third_party/opus-rs/src/bands.rs`:
  - `encode_left_call_source_b_after_theta`
  - `decode_left_call_source_b_after_theta`
  - `encode_left_call_source_fill_after_theta`
  - `decode_left_call_source_fill_after_theta`
  - `encode_left_call_source_recurse_mid_first`
  - `decode_left_call_source_recurse_mid_first`
- Fixed a trace-only gap in `quant_partition_encode(...)`:
  - when `recurse_mid_first == false`, the encode-side snapshot was leaving
    `encode_left_child_budget_before_call`,
    `encode_left_child_fill_before_call`, and
    `encode_left_child_gain_before_call`
    at their zero-initialized placeholder values instead of recording the real deferred-left call inputs.
- Refined the CELT trace tests to report:
  - the pinned `band=19`, `depth=2` node directly
  - whether its source state diverges before left-call construction
  - whether the left-call-input construction itself diverges

**Fresh Verification**

- `cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture`
  - PASS
  - focused path still does not reach a real `band=19`, `depth=2` local seam
  - `Band19 depth2 left-call node: None`
  - `Band19 depth2 left-call stage=missing_band19_depth2_left_call_node`
- `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - still FAILS at `0.72 dB`
  - pinned real-gate node remains:
    - `band=19`
    - `depth=2`
  - local source state now matches exactly:
    - `encode_left_call_source_b_after_theta=293`
    - `decode_left_call_source_b_after_theta=293`
    - `encode_left_call_source_fill_after_theta=15`
    - `decode_left_call_source_fill_after_theta=15`
    - `encode_left_call_source_recurse_mid_first=false`
    - `decode_left_call_source_recurse_mid_first=false`
  - local left-call inputs now also match exactly:
    - `encode_left_child_budget_before_call=146`
    - `decode_left_child_budget_before_call=146`
    - `encode_left_child_fill_before_call=15`
    - `decode_left_child_fill_before_call=15`
    - `encode_left_child_gain_before_call=0.396716`
    - `decode_left_child_gain_before_call=0.396716`
  - exact local stage is now:
    - `left_call_inputs_aligned`
  - the parent-level classification also changes accordingly:
    - `earlier_parent_child_internal_after_equal_call_inputs`

**Interpretation After Track 4AA**

- The `band=19`, `depth=2` local left-call-input divergence was not a real codec-state bug.
- It was a trace artifact caused by missing encode-side snapshot updates on the deferred-left path in `quant_partition_encode(...)`.
- After fixing that trace-only gap:
  - the `band=19`, `depth=2` node’s source state matches
  - its constructed left-call inputs match
  - so the surviving defect is deeper than local left-call-input construction
- No bounded production codec fix is justified from Track 4AA because the only real change in this pass was instrumentation correction.

**Updated Next Boundary**

- Primary next target narrows again:
  - the child-internal recursive behavior below the `band=19`, `depth=2` node in `third_party/opus-rs/src/bands.rs`
  - specifically, the first sub-recursion or leaf-return seam that still diverges after equal local left-call inputs
- Explicit non-targets remain:
  - `celt.rs`
  - `rate.rs`
  - `pvq.rs`
  - zero-pulse reconstruction
  - local left-call-input construction at `band=19`, `depth=2`

**Track 4AC Structural Diff**

- Lines compared: encode `quant_partition_encode` (2309–2672) vs decode `quant_partition` (2676–3220)
- Differences found (ignoring alg_quant/alg_unquant and trace hooks):
  - No functional/logical differences found in recursion structure, split conditions, mbits/sbits calculation, or rebalance logic.
  - Encoder implements specialized short-circuits for n == 2, 4, 8, 16.
  - The zero-pulse reconstruction (`q == 0` path) contains different logic on decode (resynth path reconstruction) vs encode (simple bit allocation/fill path), which is expected behavior.
- Reference C diff: The Rust functions match the reference C `quant_partition` structure exactly in terms of recursive flow, split checks, and arithmetic bounds.
- Next suspected bug site: Since the recursion structure is identical, the divergence in the real codec path must come from context state handed in (remaining_bits, fill, lowband) or in how the results are processed in the `quant_band` wrapper.

