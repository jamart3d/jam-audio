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
