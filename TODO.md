# Project TODOs

## Architecture (Future)

- [ ] **Mode B: Worklet And Buffer Optimization**
  - **Goal:** Improve startup, jitter tolerance, buffer management, and bridge overhead without requiring threaded WASM.
  - **Context:** The current JS worklet is already small; refill timing, diagnostics traffic, and static buffer policy are more likely near-term bottlenecks.
  - **Plan:** See `docs/superpowers/plans/future/mode-b-worklet-and-buffer-optimization.md` (local artifact) for the recommended next-step roadmap.
  - **Landed:** Phase 1 worklet-overhead reduction, Phase 2 refill scheduling and recovery, and Phase 3 adaptive buffer-policy tuning have shipped in separate release slices.
  - **Next:** Gather real-world playback observations across long playback sessions, background/screen-off behavior, network variation, bounded streaming, seeks, and gapless transitions before deciding whether Phase 4 diagnostics/bridge cleanup is justified.

- [ ] **Transition to Multithreaded WASM (Mode C)**
  - **Goal:** Evaluate whether a threaded-wasm architecture is justified for zero-copy rendering and broader Rust ownership of the playback path.
  - **Context:** Single-threaded WASM cannot natively map external `SharedArrayBuffer`s, but this should remain secondary until Mode B-style tuning shows the current architecture cannot meet playback goals.
  - **Plan:** See `docs/superpowers/plans/future/multithreaded-wasm-transition.md` (local artifact) for the phased roadmap and go/no-go gates.
  - **Report:** See `reports/architecture/2026-05-09-wasm-threading-constraints.md` (local artifact) for technical background.

## Maintainability

- [ ] **Decide Public Package Distribution**
  - Done as of v0.5.2: scoped npm metadata (`@jamart3d/jam-audio-worklet`, `@jamart3d/jam-audio-engine-wasm`) and the `scripts/verify-release.sh` lockstep-version and pack-content gates.
  - Remaining: registry publication timing and `crates.io` policy.
- [ ] **Continue Worker Controller Modularization**
  - **Done:** Diagnostics helpers extracted to `playback_worker_controller_diagnostics.js`; packaging fix and `scripts/check_pack_imports.mjs` gate shipped in 0.5.3.
  - **Next slices (re-map line counts before planning each):** refill driver loops into `playback_worker_controller_refill.js`; gapless fallback and ended handling; gapless boundary handoff (highest risk, extract without logic edits). Leave `refillRingBuffer` in place unless a clean seam appears.
  - **Spec:** `docs/superpowers/specs/2026-11-15-worker-controller-modularization-design.md` (local artifact).
- [ ] **Continue `audio_bridge.js` Modularization**
  - Still ~2,500 lines after the Media Session extraction; pick the next cohesive chunk (diagnostics or worker command plumbing) and follow the same characterization-first, one-slice-per-commit approach.
- [ ] **Resolve `jamdisc` Worklet Drift Policy**
  - `jamdisc` tracks a snapshot at `apps/jamdisc_web/web/js/worklet/` (refreshed by `dev.sh`/`deploy.sh --pull-canonical`). Decide whether to keep it tracked or gitignore and generate it, per `SYNC_POLICY.md`.
  - Removal candidates in `jamdisc` (needs approval and a check for behavior only the tests cover): legacy `web/js/audio_playback_worker_controller.js` plus `web/js/shared/` and its tests (`audio_playback_worker_controller.test.js`, `audio_playback_worker_controller_pause.test.js`, `readahead_pause_guard.test.js`); stale unreferenced copies `web/js/audio_diagnostics_state.js` and `web/js/range_fetch_controller.js` with their tests.
- [ ] **Validate 0.5.3 Refactors On Device**
  - Staging checks: worker controller loads, gapless boundary, Android Media Session notification (title/artwork, transport actions, screen-off and long pause), blocked-start Play, extended diagnostics slots 5/6.
- [ ] **Review `track-4-codec-quality` (PR #1)**
  - Open, 37 commits ahead of `main`, trial merge is conflict-free; decide whether to continue the CELT/MDCT quality work.
- [ ] **Consolidate Test Data**
  - Consider moving `packages/jam-audio-engine/testdata/opus_sample.opus` to a central `tests/fixtures` directory if more packages need to share audio samples.
- [ ] **Expand JSDoc Coverage**
  - Further improve IDE support by adding JSDoc to the remaining helper functions in `packages/jam-audio-worklet/src/audio_bridge.js`.
