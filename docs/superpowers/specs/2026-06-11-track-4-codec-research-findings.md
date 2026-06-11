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
