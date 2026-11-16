# Track 4D CELT Allocation Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one bounded production fix in `third_party/opus-rs/src/celt.rs` that improves CELT quality by correcting how the real encoder path allocates or carries remaining energy bits into high-distortion bands.

**Architecture:** Keep `quant_bands.rs` unchanged. Reuse the new Track 4C distortion and allocation traces to pin one concrete allocation invariant in the real CELT path, then make a local edit in `celt.rs` only. Verify the fix first in `celt_energy_roundtrip_only()` and then in one end-to-end CELT quality test.

**Tech Stack:** Rust, Cargo tests, vendored `third_party/opus-rs`, existing Track 4 trace helpers, single-file production edit in `celt.rs`

---

## File Structure

- Modify: `third_party/opus-rs/src/celt.rs`
  - Add one narrow regression assertion/helper for the chosen allocation invariant.
  - Implement one bounded production fix in the real CELT allocation / remaining-bit path.
- Modify: `third_party/opus-rs/tests/celt_synthesis_test.rs`
  - Tighten the existing energy-only harness with one assertion that pins the diagnosed allocation problem.
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
  - Append the post-fix SNR and the chosen `celt.rs` fix site.

### Task 1: Pin the Allocation Failure With a Regression Test

**Files:**
- Modify: `third_party/opus-rs/tests/celt_synthesis_test.rs`
- Test: `third_party/opus-rs/tests/celt_synthesis_test.rs`

- [ ] **Step 1: Add a failing assertion around the current allocation pattern**

Inside `celt_energy_roundtrip_only()`, immediately after:

```rust
        let allocation = trace_celt_energy_allocation_for_test(
            mode,
            0,
            nb_ebands,
            channels,
            lm,
            n_bytes,
        );
```

add:

```rust
        assert!(
            allocation.ebits[nb_ebands - 2] > 1 || allocation.ebits[nb_ebands - 1] > 1,
            "high-distortion tail bands are starved: ebits={:?}",
            allocation.ebits
        );
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture
```

Expected: FAIL because the current trace shows the last two bands stuck at `1` bit each.

- [ ] **Step 3: Commit the failing regression scaffold**

```bash
git add third_party/opus-rs/tests/celt_synthesis_test.rs
git commit -m "test: pin celt tail-band allocation starvation"
```

### Task 2: Make One Bounded Allocation Fix in `celt.rs`

**Files:**
- Modify: `third_party/opus-rs/src/celt.rs`
- Test: `third_party/opus-rs/tests/celt_synthesis_test.rs`

- [ ] **Step 1: Inspect the exact real-path allocation handoff**

Re-read the encoder path around:

```rust
        self.last_coded_bands = clt_compute_allocation(
            ...
            (total_bits << BITRES) - rc.tell_frac() - 1,
            ...
        );
```

and the immediately following:

```rust
        quant_fine_energy(...)
        quant_all_bands(...)
        quant_energy_finalise(...)
```

Do not change `clt_compute_allocation(...)` itself. Only adjust the local `celt.rs` handling around the value passed in or the reserved/remaining-bit bookkeeping that follows.

- [ ] **Step 2: Implement one bounded fix**

Choose one local fix only, for example:
- correct an off-by-one or too-aggressive subtraction in the bit budget passed to `clt_compute_allocation(...)`
- adjust how anti-collapse reservation interacts with the fine-energy / finalise budget
- correct the real-path handoff so high bands are not prematurely starved before finalization

Do not edit more than one production file. Do not touch `quant_bands.rs`.

- [ ] **Step 3: Re-run the narrow regression**

Run:

```bash
cargo test -p opus-rs celt_energy_roundtrip_only -- --nocapture
```

Expected:
- the new allocation assertion passes
- `Energy roundtrip only: Best SNR = ...` improves above the current `0.16 dB`

- [ ] **Step 4: Commit**

```bash
git add third_party/opus-rs/src/celt.rs third_party/opus-rs/tests/celt_synthesis_test.rs
git commit -m "fix: improve celt tail-band energy allocation"
```

### Task 3: Verify End-to-End CELT Quality Improvement

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

Expected:
- `celt_energy_roundtrip_only` is meaningfully above `0.16 dB`
- `celt_loopback_160bytes` improves from `0.28 dB`
- `test_celt_realistic_bitrate` improves from `0.28 dB`
- `opus_celt_roundtrip_basic` improves from `0.21 dB`

- [ ] **Step 2: Append post-fix results to the findings report**

Add:

```markdown
**CELT Allocation Fix Follow-Up**

- Chosen fix site: `third_party/opus-rs/src/celt.rs`
- Post-fix `celt_energy_roundtrip_only`: [real SNR]
- Post-fix `celt_loopback_160bytes`: [real SNR]
- Post-fix `test_celt_realistic_bitrate`: [real SNR]
- Post-fix `opus_celt_roundtrip_basic`: [real SNR]
```

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md
git commit -m "docs: record celt allocation fix results"
```
