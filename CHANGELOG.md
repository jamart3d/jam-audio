# Changelog

## [Unreleased]

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
