# Track 4C Energy Distortion and Allocation Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure where the remaining CELT quality loss is introduced after energy encode/decode symmetry has already been proven, and determine whether the primary cause is quantizer distortion, bit allocation, or CELT integration.

**Architecture:** Keep production CELT behavior unchanged while adding narrow trace surfaces that quantify distortion instead of only checking encoder/decoder symmetry. Reuse the existing `celt_energy_roundtrip_only` harness, add a band-log-energy distortion trace in `quant_bands.rs`, and add an allocation snapshot around `clt_compute_allocation(...)` in `celt.rs` so the next production fix can target the actual failing stage.

**Tech Stack:** Rust, Cargo tests, vendored `third_party/opus-rs`, test-only trace helpers, existing Track 4 probe harnesses

---

## File Structure

- Modify: `third_party/opus-rs/src/quant_bands.rs`
  - Add test-only distortion trace structs and helpers that compare original `band_log_e` against post-coarse, post-fine, and post-finalize `old_band_e`.
- Modify: `third_party/opus-rs/src/celt.rs`
  - Add a test-only allocation snapshot helper that exposes `pulses`, `ebits`, `fine_priority`, `balance`, and `coded_bands` from the real CELT allocation path.
- Create: `third_party/opus-rs/tests/quant_energy_distortion_trace.rs`
  - Deterministic single-frame harness that prints the worst band distortion after each quantization stage.
- Modify: `third_party/opus-rs/tests/celt_synthesis_test.rs`
  - Reuse the new quantization distortion trace and CELT allocation snapshot inside `celt_energy_roundtrip_only()`.
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
  - Append the measured distortion/allocation findings and explicitly name the next bounded fix site.

### Task 1: Add Quantized-Energy Distortion Trace Surface

**Files:**
- Modify: `third_party/opus-rs/src/quant_bands.rs`
- Create: `third_party/opus-rs/tests/quant_energy_distortion_trace.rs`
- Test: `third_party/opus-rs/tests/quant_energy_distortion_trace.rs`

- [ ] **Step 1: Write the failing integration test**

Create `third_party/opus-rs/tests/quant_energy_distortion_trace.rs` with:

```rust
use opus_rs::bands::{amp2log2, compute_band_energies};
use opus_rs::modes::default_mode;
use opus_rs::quant_bands::trace_quant_energy_distortion_for_test;

#[test]
fn quant_energy_distortion_trace_reports_worst_band() {
    let mode = default_mode();
    let channels = 1;
    let frame_size = 960;
    let nb_ebands = mode.nb_ebands;
    let mut lm = 0;
    while (mode.short_mdct_size << lm) != frame_size {
        lm += 1;
    }

    let mut coeffs = vec![0.0f32; frame_size];
    for (i, coeff) in coeffs.iter_mut().enumerate() {
        let t = i as f32 / 48_000.0;
        *coeff = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.4
            + (2.0 * std::f32::consts::PI * 880.0 * t).sin() * 0.08;
    }

    let mut band_e = vec![0.0f32; nb_ebands * channels];
    compute_band_energies(mode, &coeffs, &mut band_e, nb_ebands, channels, lm);

    let mut band_log_e = vec![0.0f32; nb_ebands * channels];
    amp2log2(mode, 0, nb_ebands, &band_e, &mut band_log_e, channels);

    let trace = trace_quant_energy_distortion_for_test(
        mode,
        0,
        nb_ebands,
        &band_log_e,
        channels,
        lm,
        160,
    );

    let worst = trace
        .finalise
        .iter()
        .max_by(|a, b| a.abs_error.partial_cmp(&b.abs_error).unwrap())
        .unwrap();
    eprintln!("Worst finalised band distortion: {:?}", worst);
    assert!(worst.abs_error.is_finite(), "worst distortion was not finite");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cargo test -p opus-rs quant_energy_distortion_trace_reports_worst_band -- --nocapture
```

Expected: FAIL because `trace_quant_energy_distortion_for_test(...)` does not exist yet.

- [ ] **Step 3: Add the trace structs in `quant_bands.rs`**

Add these near the existing trace helpers in `third_party/opus-rs/src/quant_bands.rs`:

```rust
#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct QuantEnergyDistortionEntry {
    pub band: usize,
    pub channel: usize,
    pub original: f32,
    pub quantized: f32,
    pub abs_error: f32,
}

#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct QuantEnergyDistortionTrace {
    pub coarse: Vec<QuantEnergyDistortionEntry>,
    pub fine: Vec<QuantEnergyDistortionEntry>,
    pub finalise: Vec<QuantEnergyDistortionEntry>,
}
```

- [ ] **Step 4: Add the minimal distortion trace helper**

Add this helper in `third_party/opus-rs/src/quant_bands.rs`:

```rust
#[doc(hidden)]
pub fn trace_quant_energy_distortion_for_test(
    m: &CeltMode,
    start: usize,
    end: usize,
    band_log_e: &[f32],
    channels: usize,
    lm: usize,
    n_bytes: usize,
) -> QuantEnergyDistortionTrace {
    use crate::range_coder::RangeCoder;
    use crate::rate::clt_compute_allocation;

    let total_bits = n_bytes * 8;
    let mut error = vec![0.0f32; end * channels];
    let mut old_band_e = vec![-28.0f32; end * channels];
    let mut rc = RangeCoder::new_encoder(n_bytes as u32);

    rc.encode_bit_logp(false, 1);
    rc.encode_bit_logp(false, 3);

    quant_coarse_energy(
        m,
        start,
        end,
        band_log_e,
        &mut old_band_e,
        (total_bits << 3) as u32,
        &mut error,
        &mut rc,
        channels,
        lm,
        false,
        total_bits,
    );

    let coarse = (start..end)
        .flat_map(|band| {
            (0..channels).map(move |channel| {
                let idx = channel * m.nb_ebands + band;
                QuantEnergyDistortionEntry {
                    band,
                    channel,
                    original: band_log_e[idx],
                    quantized: old_band_e[idx],
                    abs_error: (band_log_e[idx] - old_band_e[idx]).abs(),
                }
            })
        })
        .collect::<Vec<_>>();

    let mut tf_res = vec![0i32; end];
    let offsets = vec![0i32; end];
    let mut cap = vec![0i32; end];
    for i in 0..end {
        cap[i] = (m.cache.caps[end * (2 * lm + channels - 1) + i] as i32 + 64)
            * channels as i32
            * 2;
    }
    let alloc_trim = 6;
    rc.encode_icdf(alloc_trim, &crate::modes::TRIM_ICDF, 7);

    let mut intensity = 0i32;
    let mut dual_stereo = 0i32;
    let mut balance = 0;
    let mut pulses = vec![0i32; end];
    let mut ebits = vec![0i32; end];
    let mut fine_priority = vec![0i32; end];
    let _coded_bands = clt_compute_allocation(
        m,
        start,
        end,
        &offsets,
        &cap,
        alloc_trim,
        &mut intensity,
        &mut dual_stereo,
        total_bits << 3,
        &mut balance,
        &mut pulses,
        &mut ebits,
        &mut fine_priority,
        channels as i32,
        lm as i32,
        &mut rc,
        true,
        0,
        end as i32 - 1,
    );

    quant_fine_energy(
        m,
        start,
        end,
        &mut old_band_e,
        &mut error,
        &ebits,
        &mut rc,
        channels,
    );

    let fine = (start..end)
        .flat_map(|band| {
            (0..channels).map(move |channel| {
                let idx = channel * m.nb_ebands + band;
                QuantEnergyDistortionEntry {
                    band,
                    channel,
                    original: band_log_e[idx],
                    quantized: old_band_e[idx],
                    abs_error: (band_log_e[idx] - old_band_e[idx]).abs(),
                }
            })
        })
        .collect::<Vec<_>>();

    quant_energy_finalise(
        m,
        start,
        end,
        &mut old_band_e,
        &mut error,
        &ebits,
        &fine_priority,
        (total_bits - rc.tell()) << 3,
        &mut rc,
        channels,
    );

    let finalise = (start..end)
        .flat_map(|band| {
            (0..channels).map(move |channel| {
                let idx = channel * m.nb_ebands + band;
                QuantEnergyDistortionEntry {
                    band,
                    channel,
                    original: band_log_e[idx],
                    quantized: old_band_e[idx],
                    abs_error: (band_log_e[idx] - old_band_e[idx]).abs(),
                }
            })
        })
        .collect::<Vec<_>>();

    QuantEnergyDistortionTrace {
        coarse,
        fine,
        finalise,
    }
}
```

- [ ] **Step 5: Run the integration test and commit**

Run:

```bash
cargo test -p opus-rs quant_energy_distortion_trace_reports_worst_band -- --nocapture
```

Expected: PASS and one `Worst finalised band distortion` print with a real band/error value.

Commit:

```bash
git add third_party/opus-rs/src/quant_bands.rs third_party/opus-rs/tests/quant_energy_distortion_trace.rs
git commit -m "test: trace quantized energy distortion"
```

### Task 2: Add CELT Allocation Snapshot Around the Real Encoder Path

**Files:**
- Modify: `third_party/opus-rs/src/celt.rs`
- Test: `third_party/opus-rs/src/celt.rs`

- [ ] **Step 1: Write the failing unit test for allocation snapshot**

Add this test inside the existing `#[cfg(test)] mod tests` in `third_party/opus-rs/src/celt.rs`:

```rust
    #[test]
    fn test_celt_allocation_trace_returns_nonempty_ebits() {
        let mode = crate::modes::default_mode();
        let trace = trace_celt_energy_allocation_for_test(&mode, 0, mode.nb_ebands, 1, 3, 160);
        assert_eq!(trace.ebits.len(), mode.nb_ebands);
        assert_eq!(trace.fine_priority.len(), mode.nb_ebands);
        assert!(trace.coded_bands > 0, "coded_bands should be positive");
    }
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run:

```bash
cargo test -p opus-rs test_celt_allocation_trace_returns_nonempty_ebits -- --nocapture
```

Expected: FAIL because the snapshot helper does not exist yet.

- [ ] **Step 3: Add the snapshot struct**

Add this near the allocation code in `third_party/opus-rs/src/celt.rs`:

```rust
#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct CeltEnergyAllocationTrace {
    pub coded_bands: i32,
    pub balance: i32,
    pub pulses: Vec<i32>,
    pub ebits: Vec<i32>,
    pub fine_priority: Vec<i32>,
}
```

- [ ] **Step 4: Add the minimal snapshot helper**

Add this in `third_party/opus-rs/src/celt.rs`:

```rust
#[doc(hidden)]
pub fn trace_celt_energy_allocation_for_test(
    mode: &CeltMode,
    start: usize,
    end: usize,
    channels: usize,
    lm: usize,
    n_bytes: usize,
) -> CeltEnergyAllocationTrace {
    use crate::range_coder::RangeCoder;
    use crate::rate::clt_compute_allocation;

    let total_bits = n_bytes * 8;
    let mut rc = RangeCoder::new_encoder(n_bytes as u32);
    rc.encode_bit_logp(false, 1);
    rc.encode_bit_logp(false, 3);

    let mut tf_res = vec![0i32; end];
    let offsets = vec![0i32; end];
    let mut cap = vec![0i32; end];
    for i in 0..end {
        cap[i] = (mode.cache.caps[end * (2 * lm + channels - 1) + i] as i32 + 64)
            * channels as i32
            * 2;
    }

    let alloc_trim = 6;
    rc.encode_icdf(alloc_trim, &crate::modes::TRIM_ICDF, 7);

    let mut intensity = 0i32;
    let mut dual_stereo = 0i32;
    let mut balance = 0;
    let mut pulses = vec![0i32; end];
    let mut ebits = vec![0i32; end];
    let mut fine_priority = vec![0i32; end];

    let coded_bands = clt_compute_allocation(
        mode,
        start,
        end,
        &offsets,
        &cap,
        alloc_trim,
        &mut intensity,
        &mut dual_stereo,
        total_bits << 3,
        &mut balance,
        &mut pulses,
        &mut ebits,
        &mut fine_priority,
        channels as i32,
        lm as i32,
        &mut rc,
        true,
        0,
        end as i32 - 1,
    );

    let _ = tf_res;
    CeltEnergyAllocationTrace {
        coded_bands,
        balance,
        pulses,
        ebits,
        fine_priority,
    }
}
```

- [ ] **Step 5: Run the unit test and commit**

Run:

```bash
cargo test -p opus-rs test_celt_allocation_trace_returns_nonempty_ebits -- --nocapture
```

Expected: PASS.

Commit:

```bash
git add third_party/opus-rs/src/celt.rs
git commit -m "test: expose celt energy allocation snapshot"
```

### Task 3: Reuse Both Traces in the Real CELT Energy Harness

**Files:**
- Modify: `third_party/opus-rs/tests/celt_synthesis_test.rs`
- Test: `third_party/opus-rs/tests/celt_synthesis_test.rs`

- [ ] **Step 1: Add the new imports**

In `third_party/opus-rs/tests/celt_synthesis_test.rs`, update the imports inside `celt_energy_roundtrip_only()` to include:

```rust
    use opus_rs::celt::trace_celt_energy_allocation_for_test;
    use opus_rs::quant_bands::trace_quant_energy_distortion_for_test;
```

- [ ] **Step 2: Print the worst distortion and allocation snapshot**

Insert this immediately after `amp2log2(mode, 0, nb_ebands, &band_e, &mut band_log_e, channels);`:

```rust
        let distortion = trace_quant_energy_distortion_for_test(
            mode,
            0,
            nb_ebands,
            &band_log_e,
            channels,
            lm,
            n_bytes,
        );
        let worst_final = distortion
            .finalise
            .iter()
            .max_by(|a, b| a.abs_error.partial_cmp(&b.abs_error).unwrap())
            .unwrap();
        eprintln!("Worst quantized band distortion: {:?}", worst_final);

        let allocation = trace_celt_energy_allocation_for_test(
            mode,
            0,
            nb_ebands,
            channels,
            lm,
            n_bytes,
        );
        eprintln!(
            "Allocation snapshot: coded_bands={} balance={} ebits={:?} fine_priority={:?}",
            allocation.coded_bands,
            allocation.balance,
            allocation.ebits,
            allocation.fine_priority
        );
```

- [ ] **Step 3: Run the real energy harness**

Run:

```bash
cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture
```

Expected:
- `Energy trace first divergence: None`
- `Band roundtrip worst entry: ... max_coeff_error` near zero
- `Worst quantized band distortion: ...`
- `Allocation snapshot: ...`
- `Energy roundtrip only: Best SNR = ...`

- [ ] **Step 4: Commit**

```bash
git add third_party/opus-rs/tests/celt_synthesis_test.rs
git commit -m "test: trace celt energy distortion and allocation"
```

### Task 4: Reproduce End-to-End Quality and Update Findings

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`
- Test: `third_party/opus-rs/tests/celt_realistic_test.rs`
- Test: `third_party/opus-rs/tests/opus_celt_roundtrip.rs`

- [ ] **Step 1: Run the verification set**

Run:

```bash
cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture
cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture
```

Expected: the quality tests still fail or stay very low, but now with enough printed trace data to identify whether loss clusters in:
- quantized `old_band_e` values themselves
- zero or tiny `ebits` allocation in high-impact bands
- finalize-stage bands that never recover after coarse/fine quantization

- [ ] **Step 2: Append the results to the findings report**

Add this section to `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`:

```markdown
**Energy Distortion and Allocation Follow-Up**

- Worst finalised quantized-energy distortion: [paste real trace entry]
- Allocation snapshot: `coded_bands=[real]`, `balance=[real]`
- `ebits`: [paste real vector]
- `fine_priority`: [paste real vector]
- Post-correction `celt_energy_roundtrip_only`: [real SNR]
- `celt_loopback_160bytes`: [real SNR]
- `test_celt_realistic_bitrate`: [real SNR]
- `opus_celt_roundtrip_basic`: [real SNR]

**Decision**

- Primary next fix site: `[quant_bands.rs or celt.rs]`
- Reason: [one sentence based on the real traces]
```

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md
git commit -m "docs: record energy distortion and allocation findings"
```

### Task 5: Write the Next Bounded Fix Plan From the Trace Evidence

**Files:**
- Create: `docs/superpowers/plans/2026-06-11-track-4d-<chosen-fix-surface>.md`

- [ ] **Step 1: Pick the next fix surface from the findings**

Choose exactly one:
- `quant_bands.rs` if the traces show acceptable allocation but excessively lossy quantized `old_band_e`
- `celt.rs` if the traces show allocation starving important bands even before finalization

- [ ] **Step 2: Write the next focused plan**

Create one of:

```text
docs/superpowers/plans/2026-06-11-track-4d-quant-energy-step-size-fix.md
docs/superpowers/plans/2026-06-11-track-4d-celt-allocation-fix.md
```

The new plan must:
- target one production file only
- include one narrow regression test first
- include one bounded production edit
- verify `celt_energy_roundtrip_only` plus the relevant end-to-end CELT quality test

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/plans/2026-06-11-track-4d-*.md
git commit -m "docs: plan next focused celt energy fix"
```
