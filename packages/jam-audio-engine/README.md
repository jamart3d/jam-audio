# jam-audio-engine

The core Rust audio engine for the Jam Audio Pipeline.

Cargo package name: `jam-audio-engine`
Rust crate/import name: `jam_audio_engine`

## Features

- **Multi-format Decoding**: Powered by `symphonia` (MP3, FLAC, OGG).
- **Opus Support**: Bit-accurate Ogg/Opus decoding via `unopus` and a patched `opus-rs`.
- **Gapless Playback**: High-precision sample-accurate transitions.
- **Wasm Optimized**: Designed to run in the browser via `wasm-bindgen`.
- **Low Latency**: Uses a `SharedArrayBuffer` compatible ring buffer for real-time delivery.

## Dependencies

- `symphonia`
- `wasm-bindgen`
- `opus-rs` (patched)
