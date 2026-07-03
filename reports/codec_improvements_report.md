# Codec Improvements & Ratings: track-4-codec-quality vs main

This report summarizes the improvements made in the `track-4-codec-quality` branch compared to the `main` branch. It covers production bugfixes for the `opus-rs` codec, audio playback worklet improvements, test/trace infrastructure additions, and comprehensive research documentation.

---

## 1. Production Codec Correctness Fixes (`opus-rs`)

These five key fixes align the Rust implementation of the CELT/Opus codec with the original C reference, resolving major encoder/decoder divergences and restoring high-quality audio reproduction.

*   **Encoder Energy Init Alignment** — [celt.rs](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/src/celt.rs)  
    Initialized `old_band_e` and `last_band_log_e` to `-28.0` (instead of `0.0`), matching the C reference `opus_encoder_init()` behavior. This prevents the first-frame energy predictor from treating initial silence as a massive delta.
*   **Octave Calculation Off-by-One** — [celt.rs](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/src/celt.rs)  
    Corrected the pitch pre-filter octave calculation:
    ```diff
    -let octave = 31 - pi.leading_zeros();
    +let octave = 32 - pi.leading_zeros();
    ```
    This fix ensures the range coder state doesn't consume incorrect bits and misalign downstream symbols.
*   **Anti-Collapse Reservation Ordering** — [celt.rs](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/src/celt.rs)  
    Moved anti-collapse bit reservation calculation to run **before** `clt_compute_allocation` (matching the C reference sequence). Previously, computing this after allocation caused the encoder/decoder bit budgets to diverge at the allocation level.
*   **PVQ Pulse Decoding Order** — [pvq.rs](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/src/pvq.rs)  
    Fixed the pulse placement inside `cwrsi()` from forward order to reverse order (`y[n - 1 - j]`), aligning with the combinatorial number system decoding required by CELT.
*   **Enabling Encoder Resynthesis (Lowband Folding Alignment)** — [celt.rs](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/src/celt.rs)  
    Enabled `resynth = true` in the encoder's main loop (previously restricted to stereo tracks). This ensures mono tracks correctly track lowband folding context offsets, populate reconstructed coefficients in the `norm[]` buffer, and prevent partition-tree drift.

---

## 2. Audio Playback Worker Controller Simplifications

Cleaned up track handoff and boundary transition logic inside the audio worklet.

*   **Watchdog Removal** — [audio_playback_worker_controller.js](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/packages/jam-audio-worklet/src/audio_playback_worker_controller.js)  
    Removed the complex arithmetic-boundary watchdog timer and its associated state (`arithmeticBoundaryArmedAtMs`).
*   **Simplified Track-End Logic** — [audio_playback_worker_controller.js](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/packages/jam-audio-worklet/src/audio_playback_worker_controller.js)  
    Replaced the watchdog suppression path with a direct position check relative to track duration and handoff tolerance.
*   **Tightened Gapless Fallback** — [audio_playback_worker_controller.js](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/packages/jam-audio-worklet/src/audio_playback_worker_controller.js)  
    Restored proper guards to ensure `scheduleGaplessFallback()` is only scheduled when the next gapless track is loaded and no pending gapless bytes remain.

---

## 3. Test Infrastructure & Diagnostics

*   **Deep Roundtrip Traces** — Added diagnostic structures in [bands.rs](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/src/bands.rs) and [quant_bands.rs](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/src/quant_bands.rs) to trace partition-tree nodes, coarse energy stages, and PVQ shape allocations.
*   **8 Integration / Unit Test Files** — Added targeted tests for regression protection (e.g., [celt_budget_test.rs](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/tests/celt_budget_test.rs), [celt_loopback_test.rs](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/third_party/opus-rs/tests/celt_loopback_test.rs)).
*   **Tightened SNR Assertions**:
    *   `celt_loopback_160bytes` SNR: Raised floor to `>= 1.3 dB` (now passes at **1.46 dB**).
    *   `test_celt_loopback` SNR: Raised floor to `>= 15.0 dB` (now passes at **18.14 dB**).

---

## 4. Codec Research & Planning Documentation

*   **Research Findings Journal** — [track-4-codec-research-findings.md](file:///home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality/docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md) (1,662 lines documenting the full debugging methodology and partition divergence bisection).
*   **Fix Plans** — Structured plans tracking normalization, CELT allocation, PVQ shape debug, and low-bitrate partition issues.

---

## 5. Improvement Ratings (1–10)

| # | Improvement | Key Impact | Confidence | Risk | Rating (1-10) |
|---|---|---|---|---|---|
| 1 | **Encoder resynth enabling (`resynth = true`)** | **10** (Critical fix resolving the partition-tree divergence, restoring loopback SNR from 0.72 dB to 18.14 dB) | 10 | 1 | **10 / 10** |
| 2 | **Anti-collapse reservation ordering** | **9** (Corrected structural order, resolving the encoder/decoder allocation bit-budget mismatches) | 10 | 1 | **9 / 10** |
| 3 | **Encoder energy init (`-28.0`)** | **8** (Aligns initial coarse quantization energy prediction with reference to avoid silence cascading errors) | 10 | 1 | **9 / 10** |
| 4 | **PVQ pulse decode order (`y[n-1-j]`)** | **8** (Fundamental correctness fix for combinatorial decoding; was previously scrambling PVQ shapes) | 10 | 1 | **9 / 10** |
| 5 | **Octave calculation off-by-one** | **7** (Corrects bit coder alignment; prevented downstream bit-level decoding corruption) | 10 | 1 | **8 / 10** |
| 6 | **8 new test files & budget regression tests** | **7** (Robust verification pinning loopback budgets and catching regressions early) | 9 | 1 | **8 / 10** |
| 7 | **Trace infrastructure (~3,000 lines)** | **6** (Extremely helpful debug hooks, though adds some developer overhead/volume in source files) | 9 | 2 | **7 / 10** |
| 8 | **Research & methodology journal** | **5** (Detailed institutional knowledge and debugging documentation) | 10 | 0 | **7 / 10** |
| 9 | **Workspace config (cargo integration)** | **3** (Necessary developer tooling setup; zero production impact) | 10 | 1 | **6 / 10** |
| 10 | **Audio worklet simplification** | **4** (Improves code clarity, but reduces watchdog safety-net coverage) | 7 | 3 | **5 / 10** |
