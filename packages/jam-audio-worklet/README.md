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

Uses a versioned `SharedArrayBuffer` layout (Version 2, 12 slots):
- Slot 0: `READ_INDEX`
- Slot 1: `WRITE_INDEX`
- Slot 2: `FRAMES_AVAILABLE_INDEX`
- Slot 3: `END_OF_STREAM_INDEX`
- Slot 4: `STOP_INDEX`
- Slot 5: `TOTAL_FRAMES_RENDERED_INDEX`
- Slot 6: `HEARTBEAT_COUNT_INDEX`
- Slot 7: `REFILL_REQUEST_INDEX` (futex)
- Slot 8: `TARGET_FRAMES_INDEX`
- Slot 9: `UNDERRUN_EPISODES_INDEX` (atomic underrun episode counter)
- Slot 10: `SILENT_FRAMES_INDEX` (atomic cumulative silent frames rendered counter)
- Slot 11: `EPOCH_INDEX` (atomic epoch tracker to prevent out-of-sync writes on seek/reset)

During initialization, the controller (`audio_playback_worker_controller.js`) and processor (`audio_processor.js`) validate that the initialization payload matches the expected `protocolVersion` (2) and `protocolSlots` (12). Any mismatch throws a structured error to prevent silent data corruption or undefined state.
