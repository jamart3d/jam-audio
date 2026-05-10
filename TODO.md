# Project TODOs

## Architecture (Future)

- [ ] **Mode B: Worklet And Buffer Optimization**
  - **Goal:** Improve startup, jitter tolerance, buffer management, and bridge overhead without requiring threaded WASM.
  - **Context:** The current JS worklet is already small; refill timing, diagnostics traffic, and static buffer policy are more likely near-term bottlenecks.
  - **Plan:** See `docs/superpowers/plans/future/mode-b-worklet-and-buffer-optimization.md` (local artifact) for the recommended next-step roadmap.

- [ ] **Transition to Multithreaded WASM (Mode C)**
  - **Goal:** Evaluate whether a threaded-wasm architecture is justified for zero-copy rendering and broader Rust ownership of the playback path.
  - **Context:** Single-threaded WASM cannot natively map external `SharedArrayBuffer`s, but this should remain secondary until Mode B-style tuning shows the current architecture cannot meet playback goals.
  - **Plan:** See `docs/superpowers/plans/future/multithreaded-wasm-transition.md` (local artifact) for the phased roadmap and go/no-go gates.
  - **Report:** See `reports/architecture/2026-05-09-wasm-threading-constraints.md` (local artifact) for technical background.

## Maintainability

- [ ] **Consolidate Test Data**
  - Consider moving `packages/jam-audio-engine/testdata/opus_sample.opus` to a central `tests/fixtures` directory if more packages need to share audio samples.
- [ ] **Expand JSDoc Coverage**
  - Further improve IDE support by adding JSDoc to the remaining helper functions in `packages/jam-audio-worklet/src/audio_bridge.js`.
