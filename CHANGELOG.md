# Changelog

## [Unreleased]

## [0.4.2] - 2026-06-18

### Added
- Added worklet buffering callback support and rising/falling-edge buffering events.
- Added playback worker controller coverage for buffering transitions.

### Changed
- Synced the worklet bridge from Jamdisc, including hidden Media Session anchor lifecycle handling, resume diagnostics, and Android parallel gain ramp behavior.
- Realigned the packaged bridge with Jamdisc's current visibility-resume behavior and paused-notification toggle.

### Fixed
- Recovered browser-suspended `AudioContext` state when the page becomes visible again.
- Fixed cold-start hidden media behavior that could stall playback startup.
- Normalized silent-anchor URL comparisons so readback matches the guarded URL.
- Restored `getAudioContextState` fallback behavior for the running-to-none transition.

### Verified
- Worklet syntax check (`audio_bridge.js`, `audio_processor.js`)
- Worklet playback worker controller test
- Engine cargo check
- Flutter bridge cargo check

## [0.4.1] — 2026-06-13

### Refactored
- Extracted `createWorkletPortState`, `currentPlayerFrom`, `playerHasEnded`, and `playerPositionMs` into `playback_worker_controller_runtime.js` with direct helper test coverage.
- Extracted `startPortLoop` and `nudgeWaitAsyncState` into `playback_worker_controller_refill.js` to isolate ring-buffer refill machinery.
- Extracted `createBridgeSessionState` (session / localStorage persistence) into `audio_bridge_session.js` with direct helper test coverage.
- Extracted `clampVolume` and `sendPreloadCommand` into `audio_bridge_transport.js`; wired both bridge preload paths through the shared helper.

### Performance
- Reduced decoder per-sample push overhead in the native audio hot path.
- Removed modulo from the `AudioWorkletProcessor` hot loop.

### Fixed
- Gated `console_error_panic_hook` registration to `wasm32` targets only so it cannot interfere with native builds.
- Widened `scheduleGaplessFallback` guard to cover no-signal EOS edge cases (Fix B log77).

### Added
- Regression tests for the widened `scheduleGaplessFallback` guard.
- Direct coverage for artwork and position wrapper helpers.
- Direct coverage for range-fetch first-byte timeout path.

### Sync
- Worklet seam-only handoff trigger and arithmetic watchdog fallback ported from jamdisc single-handoff fix.

### Docs
- Annotated Opus decoder unsafe invariants in source comments.

### Verified
- Worklet syntax check (`audio_bridge.js`, `audio_processor.js`)
- Worklet npm test
- Engine cargo check
- Flutter bridge cargo check

## [0.4.0] — 2026-06-11

### Added
- Added native decoded-frame boundary authority to `GaplessPlayer`, including seam generation and last seam position exports for JavaScript handoff coordination.
- Added `AudioWorkletProcessor` regression coverage for seam-boundary diagnostics and double-fire prevention.
- Expanded playback worker controller coverage for structural refill, handoff boundary, stale-duration, false-EOS, and retry behavior.

### Changed
- Reworked worklet gapless handoff authority so decoded-frame boundaries and current duration hints drive transition timing.
- Hardened refill and boundary handoff behavior across tiny windows, hidden-tab throttling, stale duration hints, and streaming-to-gapless transitions.
- Made seam diagnostics authoritative even when duplicate seam emissions are guarded.

### Fixed
- Prevented duplicate seam firing during gapless handoff.
- Recovered hidden or stale false end-of-stream states instead of letting gapless suppression strand playback.
- Used wrapping arithmetic for `seam_generation` increments and added regression coverage for lying-header seam behavior.

### Verified
- Worklet package test
- Worklet playback worker controller test
- Worklet audio processor test
- Engine cargo check
- Flutter bridge cargo check

## [0.3.8] — 2026-06-04

### Added
- Added native unit tests for `SharedCell` covering `new`, `with`, `with_mut`, and `clone` happy-path behavior.

### Performance
- Hoisted `chunk_samples` Vec allocation out of the `decode_chunk_into` loop so capacity is reused across iterations instead of reallocated on every decode.
- Replaced manual silence-fill for-loop in `AudioWorkletProcessor` with `TypedArray.fill()` for faster native execution in the audio hot path.

### Verified
- Engine cargo test (80 tests pass)
- Engine cargo fmt clean
- Worklet npm test

## [0.3.7] — 2026-06-04

### Fixed
- Recovered `SharedCell` mutex guards from a poisoned native `Mutex` instead of panicking, so a thread panic while holding the lock no longer permanently breaks the audio engine.
- Replaced `unwrap()` calls in `seek_to_ms()` and `decode_chunk_into()` with explicit `DecodeError::DecoderState` returns so a missing format reader surfaces as a recoverable error instead of a panic.

### Verified
- Engine cargo test (76 tests pass)
- Engine cargo check

## [0.3.6] — 2026-06-04

### Fixed
- Deferred the Android startup declick ramp until playback starts so cached gapless tracks fade in without a hard-start pop.

### Verified
- Worklet package test
- Engine cargo check
- Flutter bridge cargo check

## [0.3.5] — 2026-06-02

### Fixed
- Avoided redundant worklet `initAudio()` cold-start work.
- Treated Symphonia's unknown-duration frame sentinel as an unknown duration instead of converting it to an invalid large duration.

### Verified
- Engine cargo test
- Worklet package test
- Flutter bridge cargo check

## [0.3.4] — 2026-06-02

### Added
- Added ended-emission diagnostics to explain hold-window, suppressed-gapless, duplicate, and final ended paths
- Added track-handoff target gap fields and direct playback-worker controller coverage for gapless end-of-stream behavior

### Fixed
- Suppressed premature ended emissions when the next gapless track is already loaded
- Recreated the hidden media anchor after unrecoverable media element errors and hardened blob URL replacement
- Deduplicated concurrent `initAudio()` calls and made silent-anchor playback timeouts observable in diagnostics
- Skipped teardown declick scheduling once the `AudioContext` is already closed during rapid reload cleanup
- Restored the shared playback-worker controller core file required by the worklet controller import

### Verified
- Worklet package test
- Playback worker controller test
- Engine cargo check
- Flutter bridge cargo check

## [0.3.3] — 2026-05-27

### Added
- Added worklet diagnostics for AudioContext state changes, visibility changes, track-change durations, playback heartbeats, and teardown/reload behavior
- Saved worklet session metadata to localStorage so startup and playback state can be inspected across sessions

### Changed
- Standardized worklet diagnostic timestamps on wall-clock time
- Added startup declick ramping and initialized declick silence for safer playback startup and handoff transitions

### Fixed
- Reset gapless end-of-stream handoff state more defensively to avoid stale transition state after playback completion
- Improved worklet reload and teardown declick behavior

## [0.3.2] — 2026-05-22

### Fixed
- Deferred the Dart playback-started callback while Android Chrome deeplink playback is buffered but the `AudioContext` is still suspended, so the UI stays in the paused state until the first user gesture actually starts audio
- Added a short gain ramp after gesture resume to avoid the pop that can occur when suspended audio restarts into a non-zero first frame
- Stopped the worklet before stopping the worker during track changes so stale buffered audio cannot bleed into the next session

### Added
- Added a worker-side `transitionStreamToGapless()` path to swap a streaming player into a gapless player without losing playback position continuity

## [0.3.1] — 2026-05-21

### Fixed
- Improved Android Chrome PWA deeplink playback startup by resuming the `AudioContext` on the first user gesture when launch activation does not grant autoplay rights
- Sent an explicit processor stop message before stopping worker playback to keep processor and worker state aligned
- Shortened suspended-context resume fallback waits so deeplink startup can continue buffering while waiting for a user gesture

### Added
- Added deeplink audio startup diagnostics around context resume and worker start state

### Verified
- Worklet package test
- Native engine test suite
- wasm32 engine build
- Flutter bridge cargo check

## [0.3.0] — 2026-05-20

### Added
- Added shared `media_source` primitives for in-memory and sized audio sources
- Added wasm smoke coverage for exported player surfaces

### Changed
- Completed the jam-audio-engine overhaul with a unified generic streaming core
- Swapped decoder resampling to `rubato` polyphase sinc resampling
- Reworked gapless residual buffering to use `PcmRingBuffer`
- Exposed metadata through `wasm_bindgen` getters instead of manual JS object construction

### Fixed
- Destroyed stale raw Opus decoder state during reset to avoid leaks
- Bounded appendable streaming source growth for long-lived playback
- Propagated midstream decode errors from `decode_audio_bytes`
- Compensated seeks for encoder delay to improve sample-accurate playback

### Verified
- Native engine test suite
- wasm32 engine build
- Worklet package test
- Flutter bridge cargo check

## [0.2.10] — 2026-05-13

### Fixed
- Trimmed MP3 encoder delay frames at next-track handoff in `GaplessPlayer` to improve gapless transition timing
- Replaced the hard `handoff_unsafe` abort with a 200ms retry window to reduce unnecessary interrupted handoffs

### Changed
- Improved gapless playback behavior and cleanup in the worklet handoff path
- Refined bounded playback anchoring and related controller logic during transition handling

## [0.2.9] — 2026-05-12

### Fixed
- Exposed `sessionEnded` on the worklet bridge `appendChunk()` result so callers can observe worker end-of-session state consistently

### Added
- Added a `worker-resume-nudge` diagnostics event before resume-time worker nudges to improve playback troubleshooting

## [0.2.8] — 2026-05-12

### Fixed
- Resolved a race condition in the worklet where rapid track skipping could lead to inconsistent worker states
- Ensured AudioContext is resumed before starting bounded (proxy) playback to prevent stalls on first skip after startup

### Added
- Added `bounded-first-byte` diagnostics event to the worklet to track Cloudflare proxy cold-start latency

## [0.2.7] — 2026-05-12

### Fixed
- Corrected the engine MP3 duration scaling test so the synthetic stream uses valid frame headers and passes consistently in CI

### Changed
- Improved worklet handoff safety and track-boundary handling to reduce false gapless transitions
- Added handoff metrics and a safety floor in the playback worker controller for better transition diagnostics

## [0.2.6] — 2026-05-11

### Added
- Added MP3 duration scaling test in the engine to ensure accuracy for VBR/CBR files

### Changed
- Improved worklet `pauseRefill` implementation to better handle background tab survival and prevent unnecessary starvation

### Chore
- Added missing metadata fields (authors, description, repository) to `jam-audio-flutter` Cargo.toml

## [0.2.5] — 2026-05-10

### Added
- Added metadata extraction support for callers that know the external total file size, allowing duration-sensitive formats to use the real file length instead of the currently buffered byte length
- Added a new `extractMetadataWithSize` wasm export for JS workers that can supply the real file size alongside buffered audio data

### Changed
- Refactored engine metadata parsing to share JS object construction and route the existing extraction path through the new size-aware internal helper when appropriate

### Verified
- Targeted validation for the new size-aware metadata path, including engine tests and manifest checks across the publishable packages

## [0.2.4] — 2026-05-09

### Changed
- Made playback buffer policy more adaptive so startup and steady-state headroom can respond better to runtime conditions
- Tuned buffer-management behavior to improve tolerance for degraded scheduling conditions such as background throttling
- Refined playback-worker policy around buffered headroom and transition safety margins

### Fixed
- Added crate-local `LICENSE` files for package builds that require license files beside each publishable crate

### Verified
- Targeted validation for adaptive buffer policy across startup, steady-state playback, seek, stop, transition behavior, and streaming-related flows

## [0.2.3] — 2026-05-09

### Changed
- Replaced purely fixed refill behavior with more adaptive playback-worker refill scheduling
- Improved low-headroom recovery so the worker can restore buffer headroom without blocking playback unnecessarily
- Added refill-path diagnostics to make starvation, low-watermark pressure, and recovery behavior easier to tune

### Verified
- Targeted validation for refill scheduling, recovery behavior, and playback-worker correctness across startup, steady-state playback, seek, stop, and streaming-related flows

## [0.2.2] — 2026-05-09

### Changed
- Throttled `AudioWorkletProcessor` position updates to reduce per-callback messaging overhead in the web playback hot path
- Reduced JS worklet hot-path overhead where safe without changing the current JS worklet plus Rust decoder architecture

### Fixed
- Restored `getWorkerHealthStatus` to the public `jam-audio-worklet` bridge export surface

### Verified
- Targeted validation for worklet and bridge behavior covering playback position updates, seek/reset handling, and stop-state correctness

## [0.2.0] — 2026-05-09

### Changed
- `GaplessPlayer::seek_to_ms` now returns `Result<(), GaplessError>` instead of silently discarding failures
- `unsafe impl Send/Sync` on `SharedWindowedMediaSource` and `SharedAppendableMediaSource` scoped to `wasm32` target; native targets use `Arc<Mutex<>>` for genuine thread safety
- `InMemoryMediaSource` internal buffer changed from `Vec<u8>` to `Arc<[u8]>` to avoid redundant copies in metadata and decode paths
- Residual sample buffers switched from `Vec<f32>` with front-draining to `VecDeque<f32>` across all player cores
- Metadata tag mapping extracted into a shared `apply_tags` helper, eliminating duplicated logic between container and block passes
- Consolidated PWA persistence documentation directly into source code comments and root `README.md`
- Archived completed development plans and design specs into `docs/superpowers/archive/`

### Fixed
- Removed `expect("invalid channels")` panic from opus decode path; invalid channel counts now return a typed error
- Seek failures no longer leave player bookkeeping in an inconsistent state

### Added
- GitHub Actions CI: Rust check (native + wasm32), wasm-pack build, and worklet syntax check
- `SYNC_POLICY.md` formalising `jam-audio` as the canonical provider for shared audio packages
- JSDoc type annotations for the JavaScript `AudioWorklet` bridge to improve IDE support and DX
- Explicitly ignore `.claude/` settings in `.gitignore` to prevent local configuration leaks

## [0.1.0] — 2026-04-01

Initial extraction of the Jam Audio pipeline from the jamdisc monorepo.

- `jam-audio-engine`: Rust audio engine — decoding, metadata, ring buffering, gapless playback
- `jam-audio-flutter`: Flutter bindings via `flutter_rust_bridge`
- `jam-audio-worklet`: JavaScript `AudioWorklet` bridge and processor
