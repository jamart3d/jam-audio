# jam_audio_flutter

Flutter/Dart bridge for audio **metadata and artwork extraction** — not a
playback bridge.

## Overview

This package exposes exactly two synchronous functions to Dart via
`flutter_rust_bridge` (FRB): `extract_metadata` and `extract_artwork`, both
backed by `jam_audio_engine`'s shared Symphonia-based parser. It does not
decode PCM, drive playback, or manage audio output, focus, sessions, or
background behavior — none of that exists in this package today.

Playback in the Jam Audio Pipeline is a separate, web-only concern owned by
`jam-audio-worklet` (a JavaScript `AudioWorklet` bridge), not by this crate.
There is currently no native (Android/iOS) audio playback implementation
anywhere in the pipeline.

## Build target

This package is built with `wasm-pack --target web` for `apps/jamdisc_web`
only. It is not currently built or consumed by any native Flutter target;
`apps/jamdisc_mobile` exists in the sibling Jamdisc repository but does not
reference this package.

## Responsibilities

- Exposing `extract_metadata(data: Vec<u8>)` and `extract_artwork(data: Vec<u8>)`
  to Dart, both taking in-memory byte buffers (no file/path access).
- Managing FRB-generated bindings for those two functions.

## Non-responsibilities

- Audio decoding, playback, or output of any kind.
- Native Android/iOS integration (audio focus, `AVAudioSession`, background
  playback, lock-screen controls, routing, interruptions).
- Any Dart-facing plugin structure — none exists; there is no `pubspec.yaml`
  in this package.

See `docs/superpowers/plans/2026-07-19-flutter-mobile-boundary.md` in the
`jam-audio` repository for the architecture decision record behind this scope.
