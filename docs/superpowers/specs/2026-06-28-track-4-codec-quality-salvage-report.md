# Track 4 Codec Quality Salvage Report

**Source branch:** `track-4-codec-quality`
**Source worktree:** `/home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality`
**Integration branch:** `track-4-codec-quality-salvage`
**Integration worktree:** `/home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality-salvage`
**Base branch:** `main`

## Topology

- Merge base: `68e84a71435fd8c46c8a547241b14471e1999324`
- Source branch unique commits: 36
- Main branch unique commits: 28
- Current main release: `v0.4.5` at `b164219625c49d463bdedee7b5ca8982a5aa8311`
- Source branch head: `5711b6db2c1c83b6774b9e1b897c9bc111913796`
- Main worktree status at snapshot: clean
- Source worktree status at snapshot: clean

## Classification Summary

| Category | Keep | Drop | Notes |
| --- | ---: | ---: | --- |
| Source | 5 | 3 | Keep means "port selected hunks", not whole files |
| Tests | 6 | 7 | Keep tests only after removing trace dependencies and noisy output |
| Docs/reports | 2 | 29 | Preserve final summaries, not the full intermediate plan pile |
| Scratch/generated/binary | 0 | 9 | Drop all scratch files, raw outputs, and binaries |

## Keep Decisions

| Path | Reason | Port method |
| --- | --- | --- |
| `third_party/opus-rs/src/pvq.rs` | Production correctness candidate: `cwrsi(...)` writes decoded pulse magnitudes in reverse order with `y[n - 1 - j]`, matching the branch's claimed CELT combinatorial decoding fix. | Cherry-pick or manually port the one-line hunk, then add/directly retain a small deterministic pulse reconstruction regression. |
| `third_party/opus-rs/src/celt.rs` | Production correctness candidates: initialize encoder energy state to `-28.0`, correct octave calculation, reserve anti-collapse bits before allocation, and force encoder resynthesis so mono lowband folding context remains aligned. | Manually port only production hunks. Exclude `OnceLock` allocation traces, `take_last_*_trace_for_test`, `trace_celt_energy_allocation_for_test`, and `get_old_band_e` unless a retained regression proves they are needed. |
| `third_party/opus-rs/src/quant_bands.rs` | Mixed production/test candidate: `coarse_energy_prediction_step(...)` removes duplicated predictor update logic and keeps encoder/decoder coarse energy prediction symmetric. The branch also changes decoder coarse-energy behavior by avoiding in-place clamp before prediction; this needs focused review before porting. | Manually port the helper and only reviewed behavior changes. Exclude distortion/roundtrip trace structs and long trace helpers. |
| `third_party/opus-rs/src/bands.rs` | Mixed production/test candidate: branch contains likely production fixes around encoder collapse-mask finalization in non-resynth mode and zero-pulse reconstruction factoring, but most of the file diff is trace infrastructure. | High-risk manual port only. Review with extra care before applying because this file has 2,170 added lines and most are diagnostic state snapshots. |
| `third_party/opus-rs/tests/quality_probe_common.rs` | Small reusable test helper for deterministic sine generation and best-SNR-with-delay calculation. | Port as a helper if retaining the SNR regression tests. |
| `third_party/opus-rs/tests/celt_loopback_test.rs` | Useful high-level regression target: branch raises expected CELT loopback SNR to `>= 15.0 dB` after the claimed fixes. | Convert to a quiet CI regression by removing `println!`/trace dependence and asserting only decoded length plus SNR floor. |
| `third_party/opus-rs/tests/celt_budget_test.rs` | Useful low-bitrate regression target: branch raises `celt_loopback_160bytes` floor to `>= 1.3 dB` and adds a synthetic band roundtrip case. | Keep only compact assertions. Remove the 700+ lines of diagnostic trace printing and global trace dependencies. |
| `third_party/opus-rs/tests/celt_realistic_test.rs` | Existing integration test cleanup uses shared SNR helper and remains deterministic. | Port helper refactor if the test still exists unchanged on `main`; keep assertion threshold modest unless production fixes justify a stronger floor. |
| `third_party/opus-rs/tests/celt_synthesis_test.rs` | Contains useful shared-helper cleanup and energy/synthesis regression surfaces, but much of the added content is diagnostic. | Port helper cleanup and stable assertions only. Drop trace calls and diagnostic `eprintln!` blocks. |
| `third_party/opus-rs/tests/opus_celt_roundtrip.rs` | Existing Opus/CELT roundtrip test cleanup uses shared helper. | Port helper refactor, remove debug sample prints, retain pass/fail SNR assertion. |
| `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md` | Valuable forensic history explaining how the investigation moved from energy quantization to PVQ/partition divergence and resynthesis. | Preserve as an archived research note only if repository policy allows historical docs. Do not treat it as release documentation. |
| `reports/codec_improvements_report.md` | Useful concise summary of the five claimed production fixes and their relative value, but it also mentions worklet changes not present in this branch diff against current `main`. | Convert into a short final salvage summary or fold its useful fix list into this report. Do not port verbatim. |

## Drop Decisions

| Path | Reason |
| --- | --- |
| `.gitignore` | Branch removes ignores for `docs/`, `reports/`, and `plans/`. Current repo intentionally ignores new local planning artifacts, so do not port this wholesale. Force-add selected docs instead. |
| `Cargo.toml` | Conditional only: adding `third_party/opus-rs` as a workspace member is useful for `cargo test -p opus-rs`, but it should be done deliberately on the clean integration branch, not by merging the old branch hunk. |
| `Cargo.lock` | Drop branch lockfile wholesale. It was generated from an older package graph and would regress `jam-audio-engine` to `0.4.0` in lock metadata. Regenerate from current `main` if workspace membership changes. |
| `celt_bands_ref.c` | Reference/debug file, not production code. Archive externally if needed. |
| `docs/superpowers/plans/2026-06-11-track-4a-energy-quantization-debug.md` | Intermediate investigation plan. Superseded by final findings. |
| `docs/superpowers/plans/2026-06-11-track-4b-band-normalization-fix.md` | Intermediate investigation plan. Superseded by final findings. |
| `docs/superpowers/plans/2026-06-11-track-4c-energy-distortion-allocation-debug.md` | Intermediate investigation plan. Superseded by final findings. |
| `docs/superpowers/plans/2026-06-11-track-4d-celt-allocation-fix.md` | Intermediate investigation plan. Superseded by final findings. |
| `docs/superpowers/plans/2026-06-11-track-4e-real-encoder-allocation-debug.md` | Intermediate investigation plan. Superseded by final findings. |
| `docs/superpowers/plans/2026-06-11-track-4f-real-pvq-shape-debug.md` | Intermediate investigation plan. Superseded by final findings. |
| `docs/superpowers/plans/2026-06-11-track-4g-low-bitrate-partition-debug.md` | Intermediate investigation plan. Superseded by final findings. |
| `docs/superpowers/plans/2026-06-12-track-4aa-band19-depth2-left-call-input-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4ab-band19-depth2-child-internal-recursion-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4h-low-bitrate-leaf-budget-divergence-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4i-root-band-budget-handoff-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4j-pulse-budget-source-divergence-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4k-partition-shape-state-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4l-band-symbol-state-sync-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4m-zero-pulse-reconstruction-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4n-zero-pulse-reference-model-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4o-band-recombine-state-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4p-recursive-partition-assembly-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4q-recursive-node-trace-pairing-fix.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4r-recursive-child-return-assembly-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4s-left-child-recursion-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4t-deeper-left-child-recursion-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4u-child-internal-left-recursion-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4v-returned-subchild-leaf-return-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4w-returned-subchild-recursive-node-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4x-returned-subchild-left-return-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4y-deeper-left-branch-descendant-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/2026-06-12-track-4z-earlier-parent-left-return-seam-debug.md` | Intermediate recursive tracing plan. Do not port. |
| `docs/superpowers/plans/track-4ad-lowband-and-snr-gap.md` | Intermediate follow-up plan. Do not port before source/tests are selected. |
| `reports/track4_eval_plans_report.md` | Useful meta-evaluation but not needed in `main` unless intentionally archiving process history. |
| `test.out` | Raw test output. |
| `test_160.out` | Raw test output. |
| `third_party/opus-rs/scratch/parse_transcript.py` | Scratch script. |
| `third_party/opus-rs/scratch/parsed_diffs.txt` | Scratch output. |
| `third_party/opus-rs/scratch/test_160_real.txt` | Scratch output. |
| `third_party/opus-rs/scratch/test_preemph` | Built binary artifact, 4.3 MB. |
| `third_party/opus-rs/scratch/test_preemph.rs` | Scratch probe. |
| `third_party/opus-rs/scratch_diff.sh` | Scratch helper script. |
| `third_party/opus-rs/tests/bands_energy_roundtrip_trace.rs` | Trace-specific test; useful historically, but merge only if converted into a compact deterministic regression without new trace API surface. |
| `third_party/opus-rs/tests/celt_encoder_allocation_trace.rs` | Allocation trace plumbing test; drop with the trace APIs. |
| `third_party/opus-rs/tests/celt_pvq_shape_trace.rs` | Contains useful assertions but depends on global trace surfaces. Convert selected cases instead of porting as-is. |
| `third_party/opus-rs/tests/celt_stage_probe.rs` | Probe-only stage test; final findings say pre/de-emphasis was not the root cause. |
| `third_party/opus-rs/tests/mdct_stage_probe.rs` | Probe-only stage test; final findings say MDCT was not the root cause. |
| `third_party/opus-rs/tests/quant_bands_energy_trace.rs` | Trace-specific test; drop unless converted into a direct energy predictor regression. |
| `third_party/opus-rs/tests/quant_energy_distortion_trace.rs` | Diagnostic-only distortion trace; drop unless converted into a stable bound that does not need trace scaffolding. |

## Recommendations

1. Do not merge `track-4-codec-quality` wholesale.
2. Create `.worktrees/track-4-codec-quality-salvage` from current `main`/`v0.4.5`.
3. Port the likely production fixes in this order:
   - `third_party/opus-rs/src/pvq.rs`: reverse pulse placement in `cwrsi(...)`.
   - `third_party/opus-rs/src/celt.rs`: `-28.0` energy initialization, octave off-by-one, anti-collapse reservation ordering, encoder resynthesis.
   - `third_party/opus-rs/src/quant_bands.rs`: reviewed coarse energy prediction symmetry changes only.
   - `third_party/opus-rs/src/bands.rs`: reviewed collapse-mask / zero-pulse production hunks only, with extra scrutiny.
4. Add `third_party/opus-rs` as a workspace member only if retained tests need root-level Cargo execution, then regenerate `Cargo.lock` from current `main`.
5. Convert tests into a compact regression set before porting:
   - one PVQ pulse reconstruction test,
   - one high-bitrate CELT loopback SNR test,
   - one low-bitrate CELT budget SNR test,
   - one Opus/CELT roundtrip SNR test,
   - optional direct quant-energy predictor symmetry test.
6. Exclude all global trace APIs from the first salvage branch unless a production fix cannot be verified without them.
7. Preserve at most one final historical note. Prefer a concise new summary based on `reports/codec_improvements_report.md` rather than porting the full 1,662-line research journal into release history.
8. After porting, run `cargo test -p opus-rs` or the equivalent targeted tests plus the existing release checks before merging.

## Commendations

- The branch appears to contain a serious, disciplined debugging campaign rather than random churn.
- The final reports identify concrete production-level candidates, not just vague quality complaints.
- The investigation repeatedly corrected its own assumptions: energy quantization, band normalization, allocation, PVQ shape, recursive partitioning, then resynthesis.
- The claimed production fixes are plausible and specific enough to salvage.
- The raw branch is not mergeable as-is, but it contains valuable work worth preserving.

## Verification

| Command | Result | Notes |
| --- | --- | --- |
| `git -C /home/jeff/projects/jam-audio status --short --branch` | Pass | Main worktree clean |
| `git -C /home/jeff/projects/jam-audio/.worktrees/track-4-codec-quality status --short --branch` | Pass | Source worktree clean |
| `git -C /home/jeff/projects/jam-audio merge-base main track-4-codec-quality` | Pass | Returned expected merge base |
| `git -C /home/jeff/projects/jam-audio diff --name-status main...track-4-codec-quality` | Pass | 61 changed files classified |
| `git -C /home/jeff/projects/jam-audio diff --shortstat main...track-4-codec-quality` | Pass | `61 files changed, 15623 insertions(+), 278 deletions(-)` |
| Source/test/docs spot review | Pass | Classification is a first-pass salvage review, not final algorithm approval |

## Final Outcome

- Integration complete: no
- Old worktree removed: no
- Old branch retained: yes
