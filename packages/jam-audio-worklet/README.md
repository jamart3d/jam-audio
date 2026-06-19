# jam_audio_worklet

Generic JS bridge and worklet package for the Jam Audio Pipeline.

## Features

- Configurable `AudioWorklet` bridge.
- `SharedArrayBuffer` based low-latency audio delivery.
- Generic `AudioWorkletProcessor`.
- Media Session heartbeat support for Android PWA persistence.
- Diagnostics snapshots and lifecycle events for startup, buffering, handoff, visibility, AudioContext, and teardown/reload inspection.
- Session queue metadata persistence in `localStorage` for cross-session playback state inspection.

## Usage

```js
import { createJamAudioBridge } from 'jam_audio_worklet';

const bridge = createJamAudioBridge({
  wasmModuleLoader: async () => {
    // return wasm exports
  },
  processorModuleUrl: 'path/to/audio_processor.js',
  playbackWorkerModuleUrl: 'path/to/audio_playback_worker.js',
});
```

## Large Files

For large FLAC files, prefer URL-backed bounded playback via `playTrackBounded(url, totalSize)`.
The full-byte `playTrack(audioBytes)` path transfers and retains the complete compressed file in
memory before playback starts, so its practical ceiling is browser and Wasm memory rather than a
package-defined FLAC size limit.

Bounded playback keeps a sliding decode window instead of retaining the entire file. The current
worker policy uses a 64 MB window, pauses fetch after roughly 8 MB of read-ahead, and resumes below
roughly 2 MB. These values limit retained/fetched-ahead bytes, not the total playable file size.
See [LARGE_FLAC_LIMITS.md](LARGE_FLAC_LIMITS.md) for the investigation notes.

## Diagnostics

The bridge exposes diagnostics callbacks for applications that need runtime playback visibility:

```js
bridge.setOnDiagnosticsSnapshot((snapshotJson) => {
  const snapshot = JSON.parse(snapshotJson);
  console.log(snapshot.audioContextState, snapshot.bufferFillPercent);
});

bridge.setOnDiagnosticsEvent((eventJson) => {
  const event = JSON.parse(eventJson);
  console.log(event.type, event.timestampMs);
});

bridge.setDiagnosticsMode('normal'); // off | minimal | normal | extended
bridge.setDiagnosticsSnapshotEnabled(true);
```

Diagnostics include buffer fill, decode/refill timing, worker state, AudioContext state, visibility changes, Media Session heartbeat events, track handoff timing, and teardown/reload events. `extended` mode also includes ring buffer indices and worklet heartbeat counters.

## Session Metadata

When `setSessionQueue(trackIds, currentIndex)` is used, the bridge stores lightweight session metadata in `localStorage`:

- `jamdisc-session-track-id`
- `jamdisc-session-track-title`
- `jamdisc-session-position-ms`
- `jamdisc-session-track-index`
- `jamdisc-session-has-queue`
- `jamdisc-session-timestamp`

## Protocol

Uses a stable `SharedArrayBuffer` layout:
- Slot 0: READ_INDEX
- Slot 1: WRITE_INDEX
- Slot 2: FRAMES_AVAILABLE_INDEX
- Slot 3: END_OF_STREAM_INDEX
- Slot 4: STOP_INDEX
