# Jam Audio Pipeline

A high-performance audio pipeline for gapless, low-latency playback in Flutter and web applications. Built in Rust and compiled to WebAssembly, it handles the full decode-to-output path — from compressed audio bytes to a low-jitter `AudioWorklet` stream — without relying on platform media APIs.

### Why it exists

Browser and Flutter media APIs offer convenience but limited control. For music applications that need gapless track transitions, precise seek behavior, and consistent decode quality across platforms, native APIs fall short. This pipeline gives full ownership of the decode and playback loop, with predictable latency and no codec surprises.

### What it provides

- **Gapless playback** — seamless transitions between tracks with no audible gap
- **Streaming decode** — audio is decoded incrementally as it arrives, not buffered in full
- **Wasm-first engine** — the Rust core compiles to a single `.wasm` artifact consumed directly by the browser
- **Flutter bridge** — the same engine exposed to Flutter via `flutter_rust_bridge` for mobile and desktop
- **Low-latency worklet** — a dedicated `AudioWorklet` processor keeps the audio thread isolated from the main thread
- **PWA Persistence** — integrated heartbeat and anchor diagnostic mechanism to maintain Media Session notifications on mobile platforms (Android)
- **Runtime diagnostics** — bridge snapshots and lifecycle events expose AudioContext state, playback health, handoff timing, and visibility changes for production troubleshooting

## Architecture

The pipeline is split into three main packages to ensure a clean separation between the core DSP logic, the Flutter bridge, and the browser-native AudioWorklet glue.

- `jam-audio-engine`: The core Rust audio engine. Handles decoding, metadata extraction, ring buffering, and gapless playback.
- `jam-audio-flutter`: Flutter/Dart bindings for audio metadata and artwork extraction only, using `flutter_rust_bridge`. Not a playback bridge; built for the web target only.
- `jam-audio-worklet`: Generic JavaScript `AudioWorklet` bridge and processor for low-latency web playback. Includes the canonical Media Session heartbeat implementation in `src/audio_bridge.js` to ensure PWA persistence on mobile platforms, plus diagnostics callbacks for playback health and lifecycle inspection.

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
- Continue Mode B playback tuning before reconsidering threaded-wasm Mode C work

## Release Process

For version bumps, changelog updates, verification, tagging, and push steps, see [RELEASING.md](RELEASING.md).

## Repository Governance

This repository is the canonical source of truth for shared audio packages.
See [SYNC_POLICY.md](SYNC_POLICY.md) for the provider-consumer model and contribution rules.

## License

MIT
