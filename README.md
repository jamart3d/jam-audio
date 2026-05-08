# Jam Audio Pipeline

Standalone extraction of the Jamdisc audio engine and web worklet bridge.

## Architecture

The pipeline is split into three main packages to ensure a clean separation between the core DSP logic, the Flutter bridge, and the browser-native AudioWorklet glue.

- `jam-audio-engine`: The core Rust audio engine. Handles decoding, metadata extraction, ring buffering, and gapless playback.
- `jam-audio-flutter`: Flutter-specific bindings for the engine using `flutter_rust_bridge`.
- `jam-audio-worklet`: Generic JavaScript `AudioWorklet` bridge and processor for low-latency web playback.

## Requirements

### Cross-Origin Isolation

This pipeline relies on `SharedArrayBuffer` for low-latency communication between the main thread and the `AudioWorklet` thread. For `SharedArrayBuffer` to be available, the hosting site **must** be cross-origin isolated.

The following headers must be sent by the server:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`)

### Rust Build

Building the Rust engine for Wasm requires `wasm-pack`:
```bash
cd packages/jam-audio-engine
# Use the build script or wasm-pack directly
wasm-pack build --target web --release
```

## Roadmap

- Update `build.sh` to sync artifacts directly to the `jamdisc` sibling repo
- Review remaining `expect` calls in `ring_buffer.rs` for typed error conversion
- Git tag releases as the changelog grows

## Repository Governance

This repository is the canonical source of truth for shared audio packages.
See [SYNC_POLICY.md](SYNC_POLICY.md) for the provider-consumer model and contribution rules.

## License

MIT
