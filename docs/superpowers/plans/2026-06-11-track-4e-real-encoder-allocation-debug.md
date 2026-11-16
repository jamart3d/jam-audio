# Track 4E Real Encoder Allocation Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose and fix the remaining CELT quality collapse through the actual `CeltEncoder` production path in `third_party/opus-rs/src/celt.rs`, using regression tests that exercise the real encoder rather than the synthetic energy-only harness.

**Architecture:** Keep the existing quantized-energy and band roundtrip trace helpers, but stop using `celt_energy_roundtrip_only()` as the gate for `celt.rs` production fixes. Add a real-encoder trace surface around the live `CeltEncoder::encode` allocation handoff, prove where end-to-end quality loss correlates with the live allocation state, then make one bounded `celt.rs` production fix and verify it against the real CELT loopback and roundtrip tests.

**Tech Stack:** Rust, Cargo tests, vendored `third_party/opus-rs`, `CeltEncoder` real-path tracing, end-to-end CELT quality tests

---

## File Structure

- Modify: `third_party/opus-rs/src/celt.rs`
  - Add a test-visible snapshot of the real encoder’s allocation state taken from the actual `CeltEncoder::encode` path.
  - Implement one bounded production fix in `CeltEncoder::encode` only.
- Create: `third_party/opus-rs/tests/celt_encoder_allocation_trace.rs`
  - Add a real-encoder integration test that runs a single frame through `CeltEncoder` and asserts the live allocation snapshot is populated.
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
  - Add one assertion or trace-driven check tied to the real failing `celt_loopback_160bytes` path.
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
  - Append the real-encoder trace result and the post-fix quality numbers.

### Task 1: Add a Real Encoder Allocation Snapshot

**Files:**
- Modify: `third_party/opus-rs/src/celt.rs`
- Create: `third_party/opus-rs/tests/celt_encoder_allocation_trace.rs`
- Test: `third_party/opus-rs/tests/celt_encoder_allocation_trace.rs`

- [ ] **Step 1: Write the failing integration test**

Create `third_party/opus-rs/tests/celt_encoder_allocation_trace.rs` with:

```rust
use opus_rs::celt::{CeltEncoder, take_last_encoder_allocation_trace_for_test};
use opus_rs::modes::default_mode;

#[test]
fn celt_encoder_records_allocation_trace_for_single_frame() {
    let mode = default_mode();
    let mut encoder = CeltEncoder::new(mode, 1);
    let frame_size = 960;
    let mut pcm = vec![0.0f32; frame_size];
    for (i, sample) in pcm.iter_mut().enumerate() {
        let t = i as f32 / 48_000.0;
        *sample = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.4;
    }

    let mut packet = vec![0u8; 160];
    let encoded = encoder.encode(&pcm, frame_size, &mut packet).unwrap();
    assert!(encoded > 0, "encoder produced no packet bytes");

    let trace = take_last_encoder_allocation_trace_for_test()
        .expect("expected encoder allocation trace");
    eprintln!("Real encoder allocation trace: {:?}", trace);
    assert!(trace.coded_bands > 0, "coded_bands should be positive");
    assert_eq!(trace.ebits.len(), mode.nb_ebands);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cargo test -p opus-rs celt_encoder_records_allocation_trace_for_single_frame -- --nocapture
```

Expected: FAIL because `take_last_encoder_allocation_trace_for_test()` does not exist yet.

- [ ] **Step 3: Add the minimal trace storage and accessor**

In `third_party/opus-rs/src/celt.rs`, add:

```rust
use std::sync::{Mutex, OnceLock};
```

and define near `CeltEnergyAllocationTrace`:

```rust
static LAST_ENCODER_ALLOCATION_TRACE: OnceLock<Mutex<Option<CeltEnergyAllocationTrace>>> =
    OnceLock::new();

fn encoder_allocation_trace_slot() -> &'static Mutex<Option<CeltEnergyAllocationTrace>> {
    LAST_ENCODER_ALLOCATION_TRACE.get_or_init(|| Mutex::new(None))
}

#[doc(hidden)]
pub fn take_last_encoder_allocation_trace_for_test() -> Option<CeltEnergyAllocationTrace> {
    encoder_allocation_trace_slot().lock().unwrap().take()
}
```

- [ ] **Step 4: Store the real allocation snapshot from `CeltEncoder::encode`**

Immediately after the real encoder call to `clt_compute_allocation(...)`, store:

```rust
        *encoder_allocation_trace_slot().lock().unwrap() = Some(CeltEnergyAllocationTrace {
            coded_bands: self.last_coded_bands,
            balance,
            pulses: pulses.to_vec(),
            ebits: ebits.to_vec(),
            fine_priority: fine_priority.to_vec(),
        });
```

- [ ] **Step 5: Run the integration test and commit**

Run:

```bash
cargo test -p opus-rs celt_encoder_records_allocation_trace_for_single_frame -- --nocapture
```

Expected: PASS and one `Real encoder allocation trace` print from the actual encoder path.

Commit:

```bash
git add third_party/opus-rs/src/celt.rs third_party/opus-rs/tests/celt_encoder_allocation_trace.rs
git commit -m "test: trace real celt encoder allocation"
```

### Task 2: Pin the Real Failing CELT Loopback Path

**Files:**
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Add a real-path trace assertion**

Inside `celt_loopback_160bytes()`, after the first successful `encode(...)` call and before the final SNR assertion, add:

```rust
    let trace = opus_rs::celt::take_last_encoder_allocation_trace_for_test()
        .expect("expected real encoder allocation trace");
    eprintln!("Loopback allocation trace: {:?}", trace);
    assert!(
        trace.ebits[trace.ebits.len() - 1] > 1 || trace.coded_bands == trace.ebits.len() as i32,
        "real encoder tail allocation still starved: {:?}",
        trace
    );
```

- [ ] **Step 2: Run the failing real-path regression**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected: FAIL either on the new allocation assertion or on the existing low-SNR assertion, but now with the real encoder trace printed from the true path.

- [ ] **Step 3: Commit the regression scaffold**

```bash
git add third_party/opus-rs/tests/celt_budget_test.rs
git commit -m "test: pin real celt encoder tail allocation"
```

### Task 3: Make One Bounded `celt.rs` Production Fix

**Files:**
- Modify: `third_party/opus-rs/src/celt.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Re-read only the live encoder path**

Re-read the exact production sequence in `CeltEncoder::encode`:

```rust
        dynalloc_analysis_simple(...)
        self.last_coded_bands = clt_compute_allocation(...)
        quant_fine_energy(...)
        quant_all_bands(...)
        quant_energy_finalise(...)
```

Do not change:
- `quant_bands.rs`
- `rate.rs`
- `celt_energy_roundtrip_only()`

- [ ] **Step 2: Implement one bounded fix in `celt.rs`**

Choose exactly one local change based on the real encoder trace, for example:
- adjust the bit budget passed into `clt_compute_allocation(...)`
- adjust the local reservation accounting around `total_boost`, `rc.tell_frac()`, or anti-collapse reservation
- adjust the handoff between allocation and finalization so the real encoder does not strand the highest-error band at `1` bit

Keep the edit local to `third_party/opus-rs/src/celt.rs`.

- [ ] **Step 3: Re-run the real-path regression**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- the real encoder allocation assertion passes
- loopback SNR improves above the current `0.28 dB`

- [ ] **Step 4: Commit**

```bash
git add third_party/opus-rs/src/celt.rs third_party/opus-rs/tests/celt_budget_test.rs
git commit -m "fix: improve real celt encoder allocation"
```

### Task 4: Verify End-to-End Improvement and Update Findings

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`
- Test: `third_party/opus-rs/tests/celt_realistic_test.rs`
- Test: `third_party/opus-rs/tests/opus_celt_roundtrip.rs`

- [ ] **Step 1: Run the verification set**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture
cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture
```

Expected:
- `celt_loopback_160bytes` improves from `0.28 dB`
- `test_celt_realistic_bitrate` improves from `0.28 dB`
- `opus_celt_roundtrip_basic` improves from `0.21 dB`

- [ ] **Step 2: Append the real-path result to the findings report**

Add:

```markdown
**Real Encoder Allocation Fix Follow-Up**

- Chosen fix site: `third_party/opus-rs/src/celt.rs`
- Real encoder allocation trace after fix: [paste real trace]
- Post-fix `celt_loopback_160bytes`: [real SNR]
- Post-fix `test_celt_realistic_bitrate`: [real SNR]
- Post-fix `opus_celt_roundtrip_basic`: [real SNR]
```

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md
git commit -m "docs: record real celt encoder allocation fix results"
```
