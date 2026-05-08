# Changelog

## [Unreleased]

## [0.2.0] — 2026-05-08

### Changed
- `GaplessPlayer::seek_to_ms` now returns `Result<(), GaplessError>` instead of silently discarding failures
- `unsafe impl Send/Sync` on `SharedWindowedMediaSource` and `SharedAppendableMediaSource` scoped to `wasm32` target; native targets use `Arc<Mutex<>>` for genuine thread safety
- `InMemoryMediaSource` internal buffer changed from `Vec<u8>` to `Arc<[u8]>` to avoid redundant copies in metadata and decode paths
- Residual sample buffers switched from `Vec<f32>` with front-draining to `VecDeque<f32>` across all player cores
- Metadata tag mapping extracted into a shared `apply_tags` helper, eliminating duplicated logic between container and block passes

### Fixed
- Removed `expect("invalid channels")` panic from opus decode path; invalid channel counts now return a typed error
- Seek failures no longer leave player bookkeeping in an inconsistent state

### Added
- GitHub Actions CI: Rust check (native + wasm32), wasm-pack build, and worklet syntax check
- `SYNC_POLICY.md` formalising `jam-audio` as the canonical provider for shared audio packages

## [0.1.0] — 2026-04-01

Initial extraction of the Jam Audio pipeline from the jamdisc monorepo.

- `jam-audio-engine`: Rust audio engine — decoding, metadata, ring buffering, gapless playback
- `jam-audio-flutter`: Flutter bindings via `flutter_rust_bridge`
- `jam-audio-worklet`: JavaScript `AudioWorklet` bridge and processor
