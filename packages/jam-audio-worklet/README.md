# jam_audio_worklet

Generic JS bridge and worklet package for the Jam Audio Pipeline.

## Features

- Configurable `AudioWorklet` bridge.
- `SharedArrayBuffer` based low-latency audio delivery.
- Generic `AudioWorkletProcessor`.

## Usage

```js
import { createJamAudioBridge } from 'jam_audio_worklet';

const bridge = createJamAudioBridge({
  wasmModuleLoader: async () => {
    // return wasm exports
  },
  processorModuleUrl: 'path/to/audio_processor.js',
});
```

## Protocol

Uses a stable `SharedArrayBuffer` layout:
- Slot 0: READ_INDEX
- Slot 1: WRITE_INDEX
- Slot 2: FRAMES_AVAILABLE_INDEX
- Slot 3: END_OF_STREAM_INDEX
- Slot 4: STOP_INDEX
