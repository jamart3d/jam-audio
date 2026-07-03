# Track 4A Energy Quantization Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the first encoder/decoder divergence inside `third_party/opus-rs/src/quant_bands.rs` and produce a band-by-band diagnosis of whether coarse prediction, fine quantization, or finalization bits cause the CELT quality collapse.

**Architecture:** Keep the production algorithm unchanged while adding narrowly scoped, test-only tracing around the quantized energy path. Reuse the existing `celt_energy_roundtrip_only` integration harness and the extracted `coarse_energy_prediction_step(...)` seam to compare encoder and decoder state after each energy stage with deterministic, single-frame input.

**Tech Stack:** Rust, Cargo tests, vendored `third_party/opus-rs`, test-only trace structs/helpers behind `#[cfg(test)]`

---

## File Structure

- Modify: `third_party/opus-rs/src/quant_bands.rs`
  - Add test-only trace structs and helpers for coarse-energy encode/decode, fine-energy updates, and finalization updates.
  - Keep all instrumentation behind `#[cfg(test)]` so release behavior does not change.
- Create: `third_party/opus-rs/tests/quant_bands_energy_trace.rs`
  - Single-frame deterministic integration harness that reproduces the failing energy-only path and asserts the first divergence stage explicitly.
- Modify: `third_party/opus-rs/tests/celt_synthesis_test.rs`
  - Reuse the new trace helper from the energy-only test path so the same signal is available from the existing CELT quality regression surface.
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
  - Append the concrete band/stage diagnosis after the trace run confirms the first mismatch.

### Task 1: Add Coarse-Energy Trace Surface

**Files:**
- Modify: `third_party/opus-rs/src/quant_bands.rs`
- Test: `third_party/opus-rs/src/quant_bands.rs`

- [ ] **Step 1: Write the failing unit test for coarse-energy symmetry**

Add this test inside the existing `#[cfg(test)] mod tests` in `third_party/opus-rs/src/quant_bands.rs`:

```rust
    #[test]
    fn test_coarse_energy_trace_matches_decoder_band_by_band() {
        let mode = crate::modes::default_mode();
        let channels = 1;
        let lm = 3;
        let start = 0;
        let end = mode.nb_ebands;

        let mut e_bands = vec![0.0f32; mode.nb_ebands];
        for (i, v) in e_bands.iter_mut().enumerate() {
            *v = 5.0 + (i as f32 * 0.35).sin() * 1.5;
        }

        let initial_old_e = vec![-28.0f32; mode.nb_ebands];
        let budget = (160 * 8 * 8) as u32;
        let tell_start = 2;
        let intra = false;
        let max_decay = 16.0f32;
        let lfe = false;

        let (enc_trace, packet) = trace_quant_coarse_energy_for_test(
            mode,
            start,
            end,
            &e_bands,
            &initial_old_e,
            budget,
            tell_start,
            channels,
            lm,
            intra,
            max_decay,
            lfe,
        );

        let dec_trace = trace_unquant_coarse_energy_for_test(
            mode,
            start,
            end,
            &initial_old_e,
            &packet,
            channels,
            lm,
            intra,
        );

        assert_eq!(enc_trace.len(), dec_trace.len());
        for (enc, dec) in enc_trace.iter().zip(dec_trace.iter()) {
            assert_eq!((enc.band, enc.channel), (dec.band, dec.channel));
            assert_eq!(enc.qi, dec.qi, "qi mismatch at band {}", enc.band);
            assert!(
                (enc.predicted_old_e - dec.predicted_old_e).abs() < 1e-5,
                "predicted old_e mismatch at band {}: enc={} dec={}",
                enc.band,
                enc.predicted_old_e,
                dec.predicted_old_e
            );
            assert!(
                (enc.next_prev - dec.next_prev).abs() < 1e-5,
                "prev mismatch at band {}: enc={} dec={}",
                enc.band,
                enc.next_prev,
                dec.next_prev
            );
        }
    }
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run:

```bash
cargo test -p opus-rs test_coarse_energy_trace_matches_decoder_band_by_band -- --nocapture
```

Expected: FAIL because the trace helpers do not exist yet.

- [ ] **Step 3: Add the minimal test-only trace structs**

Add this near `coarse_energy_prediction_step(...)` in `third_party/opus-rs/src/quant_bands.rs`:

```rust
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct CoarseEnergyBandTrace {
    pub band: usize,
    pub channel: usize,
    pub qi: i32,
    pub predicted_old_e: f32,
    pub next_prev: f32,
}
```

- [ ] **Step 4: Add the minimal encoder trace helper**

Add this test-only helper in `third_party/opus-rs/src/quant_bands.rs`:

```rust
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub fn trace_quant_coarse_energy_for_test(
    m: &CeltMode,
    start: usize,
    end: usize,
    e_bands: &[f32],
    initial_old_e_bands: &[f32],
    budget: u32,
    tell_start: i32,
    channels: usize,
    lm: usize,
    intra: bool,
    max_decay: f32,
    lfe: bool,
) -> (Vec<CoarseEnergyBandTrace>, Vec<u8>) {
    let prob_model = &E_PROB_MODEL[lm][if intra { 1 } else { 0 }];
    let coef = if intra { 0.0 } else { PRED_COEF[lm] };
    let beta = if intra { BETA_INTRA } else { BETA_COEF[lm] };
    let mut old_e_bands = initial_old_e_bands.to_vec();
    let mut error = vec![0.0f32; old_e_bands.len()];
    let mut prev = [0.0f32; 2];
    let mut enc = RangeCoder::new_encoder(160);
    let mut trace = Vec::new();

    if tell_start + 3 <= budget as i32 {
        enc.encode_bit_logp(intra, 3);
    }

    for i in start..end {
        for c in 0..channels {
            let x = e_bands[c * m.nb_ebands + i];
            let old_e = old_e_bands[c * m.nb_ebands + i];
            let clamped_old_e = old_e.max(-9.0);
            let f = x - coef * clamped_old_e - prev[c];
            let mut qi = (f + 0.5).floor() as i32;

            let decay_bound = old_e.max(-28.0) - max_decay;
            if qi < 0 && x < decay_bound {
                qi += ((decay_bound - x) as i32).max(0);
                if qi > 0 {
                    qi = 0;
                }
            }

            let tell = enc.tell();
            let bits_left = budget as i32 - tell - 3 * channels as i32 * (end - i) as i32;
            if i != start && bits_left < 30 {
                if bits_left < 24 {
                    qi = qi.min(1);
                }
                if bits_left < 16 {
                    qi = qi.max(-1);
                }
            }
            if lfe && i >= 2 {
                qi = qi.min(0);
            }

            if tell + 15 <= budget as i32 {
                let prob_idx = 2 * i.min(20);
                let fs = (prob_model[prob_idx] as u32) << 7;
                let decay = (prob_model[prob_idx + 1] as i32) << 6;
                enc.laplace_encode(&mut qi, fs, decay);
            } else if tell + 2 <= budget as i32 {
                qi = qi.clamp(-1, 1);
                enc.encode_icdf(
                    (2 * qi) ^ (if qi < 0 { -1 } else { 0 }),
                    &SMALL_ENERGY_ICDF,
                    2,
                );
            } else if tell < budget as i32 {
                qi = qi.min(0);
                enc.encode_bit_logp(qi != 0, 1);
            } else {
                qi = -1;
            }

            let q = qi as f32;
            error[c * m.nb_ebands + i] = f - q;
            let (predicted_old_e, next_prev) =
                coarse_energy_prediction_step(old_e, prev[c], coef, beta, qi);
            old_e_bands[c * m.nb_ebands + i] = predicted_old_e;
            prev[c] = next_prev;
            trace.push(CoarseEnergyBandTrace {
                band: i,
                channel: c,
                qi,
                predicted_old_e,
                next_prev,
            });
        }
    }

    enc.done();
    (trace, enc.buf.clone())
}
```

- [ ] **Step 5: Add the minimal decoder trace helper**

Add this test-only helper in `third_party/opus-rs/src/quant_bands.rs`:

```rust
#[cfg(test)]
pub fn trace_unquant_coarse_energy_for_test(
    m: &CeltMode,
    start: usize,
    end: usize,
    initial_old_e_bands: &[f32],
    packet: &[u8],
    channels: usize,
    lm: usize,
    intra: bool,
) -> Vec<CoarseEnergyBandTrace> {
    let prob_model = &E_PROB_MODEL[lm][if intra { 1 } else { 0 }];
    let coef = if intra { 0.0 } else { PRED_COEF[lm] };
    let beta = if intra { BETA_INTRA } else { BETA_COEF[lm] };
    let mut old_e_bands = initial_old_e_bands.to_vec();
    let mut prev = [0.0f32; 2];
    let mut dec = RangeCoder::new_decoder(packet);
    let budget = (dec.storage * 8) as i32;
    let mut trace = Vec::new();

    let _decoded_intra = dec.decode_bit_logp(3);

    for i in start..end {
        for c in 0..channels {
            let qi;
            let tell = dec.tell();
            if budget - tell >= 15 {
                let prob_idx = 2 * i.min(20);
                let fs = (prob_model[prob_idx] as u32) << 7;
                let decay = (prob_model[prob_idx + 1] as i32) << 6;
                qi = dec.laplace_decode(fs, decay);
            } else if budget - tell >= 2 {
                let s = dec.decode_icdf(&SMALL_ENERGY_ICDF, 2);
                qi = (s >> 1) ^ -(s & 1);
            } else if budget - tell >= 1 {
                qi = if dec.decode_bit_logp(1) { -1 } else { 0 };
            } else {
                qi = -1;
            }

            let old_e = old_e_bands[c * m.nb_ebands + i];
            let (predicted_old_e, next_prev) =
                coarse_energy_prediction_step(old_e, prev[c], coef, beta, qi);
            old_e_bands[c * m.nb_ebands + i] = predicted_old_e;
            prev[c] = next_prev;
            trace.push(CoarseEnergyBandTrace {
                band: i,
                channel: c,
                qi,
                predicted_old_e,
                next_prev,
            });
        }
    }

    trace
}
```

- [ ] **Step 6: Run the unit test to verify it passes**

Run:

```bash
cargo test -p opus-rs test_coarse_energy_trace_matches_decoder_band_by_band -- --nocapture
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add third_party/opus-rs/src/quant_bands.rs
git commit -m "test: add coarse energy trace helpers"
```

### Task 2: Trace Fine-Energy and Finalization Stages Separately

**Files:**
- Modify: `third_party/opus-rs/src/quant_bands.rs`
- Test: `third_party/opus-rs/src/quant_bands.rs`

- [ ] **Step 1: Write the failing unit test for full energy-stage symmetry**

Add this test inside `third_party/opus-rs/src/quant_bands.rs`:

```rust
    #[test]
    fn test_full_energy_trace_matches_decoder_stage_by_stage() {
        let mode = crate::modes::default_mode();
        let channels = 1;
        let lm = 3;
        let start = 0;
        let end = mode.nb_ebands;

        let mut e_bands = vec![0.0f32; mode.nb_ebands];
        for (i, v) in e_bands.iter_mut().enumerate() {
            *v = 5.0 + (i as f32 * 0.35).sin() * 1.5;
        }

        let fine_quant: Vec<i32> = (0..mode.nb_ebands).map(|i| (i % 3) as i32).collect();
        let fine_priority: Vec<i32> = (0..mode.nb_ebands).map(|i| (i % 2) as i32).collect();

        let trace = trace_full_energy_roundtrip_for_test(
            mode,
            start,
            end,
            &e_bands,
            &fine_quant,
            &fine_priority,
            channels,
            lm,
        );

        assert!(
            trace.first_divergence.is_none(),
            "first divergence = {:?}",
            trace.first_divergence
        );
    }
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run:

```bash
cargo test -p opus-rs test_full_energy_trace_matches_decoder_stage_by_stage -- --nocapture
```

Expected: FAIL because the full trace helper does not exist yet.

- [ ] **Step 3: Add stage-trace structs**

Add these test-only structs in `third_party/opus-rs/src/quant_bands.rs`:

```rust
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnergyTraceStage {
    Coarse,
    Fine,
    Finalise,
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub struct EnergyStageTrace {
    pub stage: EnergyTraceStage,
    pub band: usize,
    pub channel: usize,
    pub encoder_old_e: f32,
    pub decoder_old_e: f32,
    pub encoder_error: f32,
    pub decoder_error: Option<f32>,
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub struct EnergyRoundtripTrace {
    pub stages: Vec<EnergyStageTrace>,
    pub first_divergence: Option<EnergyStageTrace>,
}
```

- [ ] **Step 4: Add the full trace helper**

Add a test-only helper in `third_party/opus-rs/src/quant_bands.rs` that:
- runs `quant_coarse_energy`
- runs `quant_fine_energy`
- runs `quant_energy_finalise`
- decodes with `unquant_coarse_energy`
- decodes with `unquant_fine_energy`
- decodes with `unquant_energy_finalise`
- records `EnergyStageTrace` entries after each stage
- sets `first_divergence` when `abs(encoder_old_e - decoder_old_e) >= 1e-5`

Use this exact function signature:

```rust
#[cfg(test)]
pub fn trace_full_energy_roundtrip_for_test(
    mode: &CeltMode,
    start: usize,
    end: usize,
    e_bands: &[f32],
    fine_quant: &[i32],
    fine_priority: &[i32],
    channels: usize,
    lm: usize,
) -> EnergyRoundtripTrace
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run:

```bash
cargo test -p opus-rs test_full_energy_trace_matches_decoder_stage_by_stage -- --nocapture
```

Expected: PASS if full stage symmetry holds for the synthetic unit-level path. If it fails, keep the failure output and do not proceed to broader fixes until the first divergence is explicit.

- [ ] **Step 6: Commit**

```bash
git add third_party/opus-rs/src/quant_bands.rs
git commit -m "test: add full energy stage tracing"
```

### Task 3: Reproduce the First Divergence From the Real CELT Energy Path

**Files:**
- Create: `third_party/opus-rs/tests/quant_bands_energy_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_synthesis_test.rs`
- Test: `third_party/opus-rs/tests/quant_bands_energy_trace.rs`

- [ ] **Step 1: Write the failing integration test**

Create `third_party/opus-rs/tests/quant_bands_energy_trace.rs` with this test:

```rust
use opus_rs::bands::{amp2log2, compute_band_energies};
use opus_rs::modes::default_mode;
use opus_rs::quant_bands::trace_full_energy_roundtrip_for_test;

#[test]
fn celt_energy_trace_reports_first_divergence_band() {
    let mode = default_mode();
    let channels = 1;
    let frame_size = 960;
    let overlap = mode.overlap;
    let nb_ebands = mode.nb_ebands;
    let mut lm = 0;
    while (mode.short_mdct_size << lm) != frame_size {
        lm += 1;
    }
    let shift = mode.max_lm - lm;

    let mut input = vec![0.0f32; frame_size];
    for (i, sample) in input.iter_mut().enumerate() {
        let t = i as f32 / 48_000.0;
        *sample = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.4;
    }

    let mut syn_mem = vec![0.0f32; 2048 + overlap];
    let coef = mode.preemph[0];
    let mut mem = 0.0f32;
    for i in 0..frame_size {
        let x = input[i];
        syn_mem[2048 + overlap - frame_size + i] = x - mem;
        mem = x * coef;
    }

    let mut freq_coeffs = vec![0.0f32; frame_size];
    mode.mdct.forward(
        &syn_mem[2048 - frame_size..],
        &mut freq_coeffs,
        mode.window,
        overlap,
        shift,
        1,
    );

    let mut band_e = vec![0.0f32; nb_ebands * channels];
    compute_band_energies(mode, &freq_coeffs, &mut band_e, nb_ebands, channels, lm);

    let mut band_log_e = vec![0.0f32; nb_ebands * channels];
    amp2log2(
        mode,
        nb_ebands,
        nb_ebands,
        &band_e,
        &mut band_log_e,
        channels,
    );

    let fine_quant: Vec<i32> = (0..nb_ebands).map(|i| (i % 3) as i32).collect();
    let fine_priority: Vec<i32> = (0..nb_ebands).map(|i| (i % 2) as i32).collect();

    let trace = trace_full_energy_roundtrip_for_test(
        mode,
        0,
        nb_ebands,
        &band_log_e,
        &fine_quant,
        &fine_priority,
        channels,
        lm,
    );

    assert!(
        trace.first_divergence.is_none(),
        "unexpected energy divergence: {:?}",
        trace.first_divergence
    );
}
```

- [ ] **Step 2: Run the integration test to verify it fails or produces the first explicit divergence**

Run:

```bash
cargo test -p opus-rs celt_energy_trace_reports_first_divergence_band -- --nocapture
```

Expected: either PASS with no unit-level divergence, or FAIL with a concrete `EnergyTraceStage`/band. Preserve the exact output either way.

- [ ] **Step 3: Hook the same trace helper into the existing regression harness**

In `third_party/opus-rs/tests/celt_synthesis_test.rs`, add this assertion block inside `celt_energy_roundtrip_only()` immediately after the energy quantization calls and before denormalization:

```rust
        let fine_priority_snapshot = fine_priority.clone();
        let fine_quant_snapshot = ebits.clone();
        let trace = opus_rs::quant_bands::trace_full_energy_roundtrip_for_test(
            mode,
            0,
            nb_ebands,
            &band_log_e,
            &fine_quant_snapshot,
            &fine_priority_snapshot,
            channels,
            lm,
        );
        eprintln!("Energy trace first divergence: {:?}", trace.first_divergence);
```

- [ ] **Step 4: Re-run the real CELT energy harness**

Run:

```bash
cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture
```

Expected: PASS, plus one explicit `first divergence` print or `None`.

- [ ] **Step 5: Commit**

```bash
git add third_party/opus-rs/tests/quant_bands_energy_trace.rs third_party/opus-rs/tests/celt_synthesis_test.rs
git commit -m "test: trace real celt energy divergence"
```

### Task 4: Record the First Divergence and Choose the First Fix Target

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
- Test: `third_party/opus-rs/tests/quant_bands_energy_trace.rs`

- [ ] **Step 1: Re-run the minimum evidence set**

Run:

```bash
cargo test -p opus-rs test_coarse_energy_trace_matches_decoder_band_by_band -- --nocapture
cargo test -p opus-rs test_full_energy_trace_matches_decoder_stage_by_stage -- --nocapture
cargo test -p opus-rs celt_energy_trace_reports_first_divergence_band -- --nocapture
cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture
```

Expected:
- coarse trace test passes
- full trace test either passes or names the first divergence stage
- integration trace prints the first divergence stage/band or confirms symmetry through quantization
- real energy roundtrip still reproduces the low-SNR signal unless a real fix has already been made

- [ ] **Step 2: Append the diagnosis to the findings report**

Append a new section to `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md` in this shape:

```markdown
**Energy Trace Follow-Up**

- Coarse trace result: [PASS/FAIL and first mismatching band if any]
- Fine trace result: [PASS/FAIL and first mismatching band if any]
- Finalise trace result: [PASS/FAIL and first mismatching band if any]
- Real CELT energy harness divergence: [first divergence or none]

**Next Fix Target**

- Chosen file: `third_party/opus-rs/src/quant_bands.rs` or `third_party/opus-rs/src/bands.rs`
- Reason: [one paragraph grounded in the trace output]
- Explicit non-targets for the next fix pass: `mdct.rs`, pre/de-emphasis, unrelated CELT control flow
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md
git commit -m "docs: record energy quantization divergence diagnosis"
```

### Task 5: Write the Next Focused Fix Plan

**Files:**
- Create: `docs/superpowers/plans/2026-06-11-track-4b-energy-quantization-fix.md`
- Test: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Draft the next plan from the recorded divergence**

Create `docs/superpowers/plans/2026-06-11-track-4b-energy-quantization-fix.md` with:
- one target file only unless the diagnosis proves otherwise
- one measurable regression command (`cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture`)
- one success criterion expressed as SNR and/or removal of the first divergence

- [ ] **Step 2: Sanity-check that the next fix plan matches the report**

Run:

```bash
sed -n '1,260p' docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md
sed -n '1,260p' docs/superpowers/plans/2026-06-11-track-4b-energy-quantization-fix.md
```

Expected: the next fix plan targets the same stage and file identified in the findings report.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-11-track-4b-energy-quantization-fix.md
git commit -m "docs: plan next energy quantization fix pass"
```
