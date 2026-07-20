# Testdata Fixture Provenance

This directory contains test audio fixtures for testing format probing, codec metadata parsing, pre-skip, encoder delay, and trailing padding.

## Fixtures

### `opus_sample.opus`
- **Description**: Short Opus audio file encoded in an Ogg container. Used for verifying Opus header probing, pre-skip metadata, and streaming/full-file Ogg/Opus playback.
- **Source**: Pre-existing test fixture in `jam-audio-engine`.
- **Properties**: 48,000 Hz sample rate, Opus codec.

### `mp3_with_delay.mp3`
- **Description**: 1-second 44.1 kHz stereo MP3 file encoded with LAME metadata. Used for characterization of MP3 encoder delay (`delay`) and trailing padding (`padding`).
- **Generation Command**:
  ```bash
  ffmpeg -y -f lavfi -i "sine=frequency=1000:duration=1:sample_rate=44100" -ac 2 -c:a libmp3lame -b:a 192k packages/jam-audio-engine/testdata/mp3_with_delay.mp3
  ```
- **Provenance**: Generated using FFmpeg 6.1.1 (libmp3lame encoder). Symphonia reads `codec_params.delay` (1105 samples) and `codec_params.padding` (383 samples) from the LAME header tag.
