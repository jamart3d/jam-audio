# Project TODOs

## Architecture (Future)

- [ ] **Transition to Multithreaded WASM (Mode C)**
  - **Goal:** Enable zero-copy rendering by moving the `AudioWorkletProcessor` into Rust.
  - **Context:** Currently, single-threaded WASM cannot natively map external `SharedArrayBuffer`s, leading to a performance penalty when crossing the JS/Wasm boundary in the hot path.
  - **Plan:** See `docs/superpowers/plans/future/multithreaded-wasm-transition.md` (local artifact) for implementation steps.
  - **Report:** See `reports/architecture/2026-05-09-wasm-threading-constraints.md` (local artifact) for technical background.

## Maintainability

- [ ] **Consolidate Test Data**
  - Consider moving `packages/jam-audio-engine/testdata/opus_sample.opus` to a central `tests/fixtures` directory if more packages need to share audio samples.
- [ ] **Expand JSDoc Coverage**
  - Further improve IDE support by adding JSDoc to the remaining helper functions in `packages/jam-audio-worklet/src/audio_bridge.js`.
