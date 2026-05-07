# jam_audio_flutter

Flutter bridge for the Jam Audio Pipeline.

## Overview

This package provides the `flutter_rust_bridge` (FRB) bindings for the `jam_audio_engine` Rust crate from the `jam-audio-engine` Cargo package. It acts as the glue between Flutter's Dart code and the high-performance Rust audio engine.

## Responsibilities

- Exposing the `jam_audio_engine` API to Dart.
- Managing FRB-generated bindings.
- Providing a clean Flutter-native interface for audio operations.
