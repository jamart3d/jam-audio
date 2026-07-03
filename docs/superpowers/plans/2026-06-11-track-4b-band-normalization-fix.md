# Track 4B Band Normalization Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find and fix the coefficient normalization/denormalization defect in `third_party/opus-rs/src/bands.rs` that leaves quantized energy tracing symmetric but still collapses CELT energy-path SNR to near zero.

**Architecture:** Keep the working MDCT and quantized-energy predictor code untouched. Add narrow probes around `compute_band_energies`, `normalise_bands`, and `denormalise_bands`, prove where coefficient magnitude or per-band reconstruction diverges, then make one bounded fix in `bands.rs` and verify the energy-only and CELT loopback SNR improves.

**Tech Stack:** Rust, Cargo tests, vendored `third_party/opus-rs`, test-only probes, existing Track 4 energy harnesses

---

## File Structure

- Modify: `third_party/opus-rs/src/bands.rs`
  - Add test-only probes around band-energy computation, normalization, and denormalization.
  - Implement one bounded production fix in the identified function only.
- Create: `third_party/opus-rs/tests/bands_energy_roundtrip_trace.rs`
  - Single-frame coefficient roundtrip diagnostic for `compute_band_energies -> normalise_bands -> denormalise_bands`.
- Modify: `third_party/opus-rs/tests/celt_synthesis_test.rs`
  - Reuse the band trace in `celt_energy_roundtrip_only()` to verify the real failing path.
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
  - Append the confirmed `bands.rs` diagnosis and the measured post-fix change.

### Task 1: Add Band Roundtrip Trace Without Changing Production Logic

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Create: `third_party/opus-rs/tests/bands_energy_roundtrip_trace.rs`
- Test: `third_party/opus-rs/tests/bands_energy_roundtrip_trace.rs`

- [ ] **Step 1: Write the failing integration test**

Create `third_party/opus-rs/tests/bands_energy_roundtrip_trace.rs` with:

```rust
use opus_rs::bands::{
    amp2log2, compute_band_energies, denormalise_bands, normalise_bands,
};
use opus_rs::modes::default_mode;

fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (x - y).abs())
        .fold(0.0f32, f32::max)
}

#[test]
fn bands_roundtrip_recovers_coefficients_before_quantization() {
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
        *coeff = ((i as f32) * 0.013).sin() * 0.35 + ((i as f32) * 0.021).cos() * 0.1;
    }

    let mut band_e = vec![0.0f32; nb_ebands * channels];
    compute_band_energies(mode, &coeffs, &mut band_e, nb_ebands, channels, lm);

    let mut normalised = vec![0.0f32; frame_size * channels];
    normalise_bands(
        mode,
        &coeffs,
        &mut normalised,
        &band_e,
        nb_ebands,
        channels,
        1 << lm,
    );

    let mut band_log_e = vec![0.0f32; nb_ebands * channels];
    amp2log2(
        mode,
        nb_ebands,
        nb_ebands,
        &band_e,
        &mut band_log_e,
        channels,
    );

    let mut reconstructed = vec![0.0f32; frame_size * channels];
    denormalise_bands(
        mode,
        &normalised,
        &mut reconstructed,
        &band_log_e,
        0,
        nb_ebands,
        channels,
        1 << lm,
    );

    let diff = max_abs_diff(&coeffs, &reconstructed[..frame_size]);
    assert!(diff < 1e-3, "band roundtrip diff too large: {}", diff);
}
```

- [ ] **Step 2: Run the test to verify the current behavior**

Run:

```bash
cargo test -p opus-rs bands_roundtrip_recovers_coefficients_before_quantization -- --nocapture
```

Expected: either FAIL with a large coefficient difference or PASS with a surprisingly small difference. Record the exact number before any fix.

- [ ] **Step 3: Add trace helpers in `bands.rs`**

Add test-only probe structs and helpers in `third_party/opus-rs/src/bands.rs` that can report:
- per-band input energy
- per-band normalized vector RMS
- per-band denormalized vector RMS
- max coefficient error per band

Use these exact names:

```rust
#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct BandTraceEntry {
    pub band: usize,
    pub input_energy: f32,
    pub normalised_rms: f32,
    pub reconstructed_rms: f32,
    pub max_coeff_error: f32,
}

#[doc(hidden)]
pub fn trace_band_roundtrip_for_test(
    mode: &CeltMode,
    coeffs: &[f32],
    channels: usize,
    lm: usize,
) -> Vec<BandTraceEntry>
```

- [ ] **Step 4: Re-run the integration test with trace output**

Update the test to print the worst band:

```rust
    let trace = opus_rs::bands::trace_band_roundtrip_for_test(mode, &coeffs, channels, lm);
    let worst = trace
        .iter()
        .max_by(|a, b| a.max_coeff_error.partial_cmp(&b.max_coeff_error).unwrap())
        .unwrap();
    eprintln!("Worst band trace: {:?}", worst);
```

Run:

```bash
cargo test -p opus-rs bands_roundtrip_recovers_coefficients_before_quantization -- --nocapture
```

Expected: one explicit worst-band print that identifies where reconstruction starts going wrong.

- [ ] **Step 5: Commit**

```bash
git add third_party/opus-rs/src/bands.rs third_party/opus-rs/tests/bands_energy_roundtrip_trace.rs
git commit -m "test: trace band normalization roundtrip"
```

### Task 2: Reuse the Band Trace in the Real CELT Energy Harness

**Files:**
- Modify: `third_party/opus-rs/tests/celt_synthesis_test.rs`
- Test: `third_party/opus-rs/tests/celt_synthesis_test.rs`

- [ ] **Step 1: Add the band trace to `celt_energy_roundtrip_only()`**

Insert this immediately before `denormalise_bands(...)`:

```rust
        let band_trace = opus_rs::bands::trace_band_roundtrip_for_test(
            mode,
            &freq_coeffs,
            channels,
            lm,
        );
        let worst_band = band_trace
            .iter()
            .max_by(|a, b| a.max_coeff_error.partial_cmp(&b.max_coeff_error).unwrap())
            .unwrap();
        eprintln!("Band roundtrip worst entry: {:?}", worst_band);
```

- [ ] **Step 2: Run the real energy harness**

Run:

```bash
cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture
```

Expected:
- existing SNR output
- `Energy trace first divergence: None`
- one `Band roundtrip worst entry` print showing the first band-level reconstruction problem

- [ ] **Step 3: Commit**

```bash
git add third_party/opus-rs/tests/celt_synthesis_test.rs
git commit -m "test: trace band roundtrip in celt energy harness"
```

### Task 3: Make One Bounded Fix in `bands.rs`

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Test: `third_party/opus-rs/tests/bands_energy_roundtrip_trace.rs`

- [ ] **Step 1: Pick the one function named by the trace**

Choose exactly one of:
- `compute_band_energies`
- `normalise_bands`
- `denormalise_bands`

Do not edit more than one of those functions in this task.

- [ ] **Step 2: Add a failing assertion that captures the identified bug**

Use the failing test from Task 1 or add a second narrow assertion in `bands_energy_roundtrip_trace.rs` that pins the actual band or invariant, for example:

```rust
    assert!(
        worst.band != 17 || worst.max_coeff_error < 0.05,
        "band 17 reconstruction exploded: {:?}",
        worst
    );
```

Adjust the band number and threshold to the trace you actually observed.

- [ ] **Step 3: Implement the minimal production fix**

Change only the chosen function in `third_party/opus-rs/src/bands.rs` and keep the edit local. No refactor sweep.

- [ ] **Step 4: Run the narrow regression tests**

Run:

```bash
cargo test -p opus-rs bands_roundtrip_recovers_coefficients_before_quantization -- --nocapture
cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture
```

Expected:
- band roundtrip diff improves materially
- energy-only SNR improves from the current `0.01 dB`

- [ ] **Step 5: Commit**

```bash
git add third_party/opus-rs/src/bands.rs third_party/opus-rs/tests/bands_energy_roundtrip_trace.rs third_party/opus-rs/tests/celt_synthesis_test.rs
git commit -m "fix: correct band normalization roundtrip"
```

### Task 4: Verify CELT Quality Improvement and Update Findings

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`
- Test: `third_party/opus-rs/tests/celt_realistic_test.rs`
- Test: `third_party/opus-rs/tests/opus_celt_roundtrip.rs`

- [ ] **Step 1: Run the quality verification set**

Run:

```bash
cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture
cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture
```

Expected: all commands succeed or at minimum show materially improved SNR versus:
- `0.01 dB`
- `0.28 dB`
- `0.21 dB`

- [ ] **Step 2: Append the post-fix result to the findings report**

Add:

```markdown
**Band Normalization Follow-Up**

- Worst pre-fix band trace: [paste real band entry]
- Chosen fix site: `third_party/opus-rs/src/bands.rs:[function name]`
- Post-fix `celt_energy_roundtrip_only`: [real SNR]
- Post-fix `celt_loopback_160bytes`: [real SNR]
- Post-fix `test_celt_realistic_bitrate`: [real SNR]
- Post-fix `opus_celt_roundtrip_basic`: [real SNR]
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md
git commit -m "docs: record band normalization fix results"
```
