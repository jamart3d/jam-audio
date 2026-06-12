# Track 4F Real PVQ Shape Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Replace the broken Track 4E allocation-fix premise with a real diagnosis of the CELT pulse-vector / band-shape path. Prove where shape information is lost in the actual encoder/decoder loop, using the existing high-bitrate `test_celt_loopback` failure as the primary gate.

**Why this exists:** Fresh evidence shows `test_celt_loopback` still fails at `0.04 dB` with `RangeCoder::new_encoder(2048)`. That rules out ordinary packet-budget starvation as the main fault and moves the next investigation target to `quant_all_bands(...)` and the VQ helpers it uses.

## File Structure

- Modify: `third_party/opus-rs/src/bands.rs`
  - Add bounded, test-visible PVQ / band-shape trace helpers around `quant_all_bands(...)`.
- Modify: any directly-called VQ helper under `third_party/opus-rs/src/` only if needed for trace surfaces.
- Modify: `third_party/opus-rs/tests/celt_loopback_test.rs`
  - Add one high-bitrate trace-driven regression hook.
- Create if needed: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
  - Focused integration test for one-frame encode/decode shape preservation.
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`
  - Append the PVQ / shape findings.

## Task 1: Add a Real PVQ Shape Trace

- [ ] Add a test-visible trace structure that captures, for at least one band/frame:
  - input normalized coefficients before PVQ
  - encoded pulse allocation used by `quant_all_bands(...)`
  - reconstructed normalized coefficients after decode
  - per-band reconstruction error summary
- [ ] Keep the trace bounded to one frame / one or a few bands. Do not dump whole-stream state.
- [ ] Add a focused integration test that exercises one real CELT encode/decode frame and asserts the trace is populated.
- [ ] Run:
  - `cargo test -p opus-rs celt_pvq_shape_trace -- --nocapture`
- [ ] Commit:
  - `git commit -m "test: trace real celt pvq shape path"`

## Task 2: Pin the High-Bitrate Failure Where Allocation Is Not the Constraint

- [ ] Modify `third_party/opus-rs/tests/celt_loopback_test.rs` to capture the new PVQ / shape trace from the existing high-bitrate `test_celt_loopback` path.
- [ ] Add one assertion or printed summary that makes the first real shape-loss signal obvious.
- [ ] Run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
- [ ] Expected result:
  - still fails, but now with concrete shape-loss evidence rather than only low SNR
- [ ] Commit:
  - `git commit -m "test: pin high-bitrate celt shape regression"`

## Task 3: Make One Bounded Production Fix in the PVQ / Shape Path

- [ ] Re-read only the live path implicated by the new trace.
- [ ] Choose exactly one local fix in the real shape path, for example:
  - incorrect normalization before PVQ
  - pulse reconstruction mismatch
  - sign / collapse-mask handling
  - band-shape scaling mismatch after decode
- [ ] Do not touch:
  - `mdct.rs`
  - pre/de-emphasis logic
  - broad `celt.rs` allocation heuristics unless the trace directly requires it
- [ ] Re-run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
- [ ] Expected:
  - high-bitrate loopback improves materially above the current `0.04 dB`
- [ ] Commit:
  - `git commit -m "fix: improve real celt pvq shape reconstruction"`

## Task 4: Verify on the End-to-End CELT Gates and Update Findings

- [ ] Run:
  - `cargo test -p opus-rs test_celt_loopback -- --nocapture`
  - `cargo test -p opus-rs celt_loopback_160bytes -- --nocapture`
  - `cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture`
  - `cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture`
- [ ] Append actual results to `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`.
- [ ] Commit:
  - `git commit -m "docs: record real celt pvq shape findings"`
