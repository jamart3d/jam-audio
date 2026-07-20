// protocol:begin
const PROTOCOL_VERSION = 2;
const PROTOCOL_SLOTS = 12;
const READ_INDEX = 0;
const WRITE_INDEX = 1;
const FRAMES_AVAILABLE_INDEX = 2;
const END_OF_STREAM_INDEX = 3;
const STOP_INDEX = 4;
const TOTAL_FRAMES_RENDERED_INDEX = 5;
const HEARTBEAT_COUNT_INDEX = 6;
const REFILL_REQUEST_INDEX = 7;
const TARGET_FRAMES_INDEX = 8;
const UNDERRUN_EPISODES_INDEX = 9;
const SILENT_FRAMES_INDEX = 10;
const EPOCH_INDEX = 11;
// protocol:end
const LOW_WATER_FRACTION = 0.5; // low-water mark = floor(target * LOW_WATER_FRACTION)


class JamAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = null;
    this.state = null;
    this.frameCapacity = 0;
    this.channels = 2;
    this.totalFramesRendered = 0;
    this.framesSinceLastPositionUpdate = 0;
    this.positionUpdateIntervalFrames = 4096; // ~85ms at 48kHz

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(data) {
    if (data.type === 'init') {
      const stateLen = data.stateBuffer.byteLength / Int32Array.BYTES_PER_ELEMENT;
      if (data.protocolVersion !== PROTOCOL_VERSION || data.protocolSlots !== PROTOCOL_SLOTS || stateLen !== PROTOCOL_SLOTS) {
        throw new Error(`Protocol mismatch in processor. Expected version ${PROTOCOL_VERSION} with ${PROTOCOL_SLOTS} slots, but received version ${data.protocolVersion} with ${data.protocolSlots} slots (stateBuffer length: ${stateLen}).`);
      }
      this.samples = new Float32Array(data.pcmBuffer);
      this.state = new Int32Array(data.stateBuffer);
      this.frameCapacity = data.frameCapacity;
      this.channels = data.channels ?? 2;
      this.totalFramesRendered = 0;
      this.framesSinceLastPositionUpdate = 0;
      return;
    }

    if (data.type === 'set-refill-port') {
      this.refillPort = data.port;
      return;
    }

    if (data.type === 'reset_position') {
      this.totalFramesRendered = 0;
      this.framesSinceLastPositionUpdate = 0;
      return;
    }

    if (data.type === 'set_position') {
      const positionMs = Number.isFinite(data.positionMs) ? data.positionMs : 0;
      this.totalFramesRendered = Math.max(
        0,
        Math.round((positionMs / 1000) * sampleRate),
      );
      this.framesSinceLastPositionUpdate = 0;
      return;
    }

    if (data.type === 'stop') {
      this.samples = null;
      this.state = null;
      this.frameCapacity = 0;
      this.channels = 2;
      this.totalFramesRendered = 0;
      this.framesSinceLastPositionUpdate = 0;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }

    const left = output[0];
    const right = output[1] ?? output[0];

    if (!this.samples || !this.state || this.frameCapacity === 0) {
      left.fill(0);
      right.fill(0);
      return true;
    }

    // Hoist common loads outside the hot loop to reduce atomic overhead.
    const shouldStop = Atomics.load(this.state, STOP_INDEX) === 1;
    const isEOS = Atomics.load(this.state, END_OF_STREAM_INDEX) === 1;
    const currentEpoch = Atomics.load(this.state, EPOCH_INDEX);

    if (shouldStop) {
      this.isUnderrunning = false;
      left.fill(0);
      right.fill(0);
      return true;
    }

    const initialAvailableFrames = Atomics.load(this.state, FRAMES_AVAILABLE_INDEX);

    if (initialAvailableFrames <= 0) {
      if (!isEOS) {
        if (!this.isUnderrunning) {
          this.isUnderrunning = true;
          Atomics.add(this.state, 9, 1); // UNDERRUN_EPISODES_INDEX
        }
        Atomics.add(this.state, 10, left.length); // SILENT_FRAMES_INDEX
      } else {
        this.isUnderrunning = false;
      }
      left.fill(0);
      right.fill(0);
      return true;
    }

    const framesToProcess = Math.min(left.length, initialAvailableFrames);
    let readFrame = Atomics.load(this.state, READ_INDEX);

    if (this.channels === 1) {
      for (let frame = 0; frame < framesToProcess; frame += 1) {
        const val = this.samples[readFrame] ?? 0;
        left[frame] = val;
        right[frame] = val;

        readFrame += 1;
        if (readFrame === this.frameCapacity) {
          readFrame = 0;
        }
      }
    } else {
      const isStereoOutput = left !== right;
      if (isStereoOutput) {
        for (let frame = 0; frame < framesToProcess; frame += 1) {
          const sampleIndex = readFrame * this.channels;
          left[frame] = this.samples[sampleIndex] ?? 0;
          right[frame] = this.samples[sampleIndex + 1] ?? 0;

          readFrame += 1;
          if (readFrame === this.frameCapacity) {
            readFrame = 0;
          }
        }
      } else {
        for (let frame = 0; frame < framesToProcess; frame += 1) {
          const sampleIndex = readFrame * this.channels;
          left[frame] = this.samples[sampleIndex] ?? 0;

          readFrame += 1;
          if (readFrame === this.frameCapacity) {
            readFrame = 0;
          }
        }
      }
    }

    // Fill the remainder of the output buffer with silence if we ran out of frames (underrun)
    left.fill(0, framesToProcess);
    right.fill(0, framesToProcess);

    if (framesToProcess < left.length && !isEOS) {
       if (!this.isUnderrunning) {
          this.isUnderrunning = true;
          Atomics.add(this.state, 9, 1);
       }
       Atomics.add(this.state, 10, left.length - framesToProcess);
    } else if (framesToProcess === left.length) {
       this.isUnderrunning = false;
    }

    if (framesToProcess > 0) {
      if (Atomics.load(this.state, EPOCH_INDEX) !== currentEpoch) {
          return true; // Abort commit: worker reset the indices.
      }
      
      // Single batch update for shared state indices and counters.
      Atomics.store(this.state, READ_INDEX, readFrame);
      
      let prevFrames;
      let nextFrames;
      do {
         prevFrames = Atomics.load(this.state, FRAMES_AVAILABLE_INDEX);
         nextFrames = Math.max(0, prevFrames - framesToProcess);
      } while (Atomics.compareExchange(this.state, FRAMES_AVAILABLE_INDEX, prevFrames, nextFrames) !== prevFrames);
      
      const framesAfterSub = nextFrames;

      // Low-water signal: wake the worker if buffer is hungry.
      // Two atomic ops only — no allocation, no postMessage in the hot path.
      if (this.state.length > REFILL_REQUEST_INDEX &&
          Atomics.load(this.state, STOP_INDEX) !== 1) {
        const target = this.state.length > TARGET_FRAMES_INDEX
          ? (Atomics.load(this.state, TARGET_FRAMES_INDEX) || 264600)
          : 264600;
        const lowWater = Math.floor(target * LOW_WATER_FRACTION);
        if (framesAfterSub < lowWater) {
          Atomics.add(this.state, REFILL_REQUEST_INDEX, 1);
          Atomics.notify(this.state, REFILL_REQUEST_INDEX, 1);
        }
      }

      this.totalFramesRendered += framesToProcess;
      this.framesSinceLastPositionUpdate += framesToProcess;
      if (this.framesSinceLastPositionUpdate >= this.positionUpdateIntervalFrames) {
        this.port.postMessage({ type: 'position', framesRendered: this.totalFramesRendered });
        this.framesSinceLastPositionUpdate = 0;
      }
    }

    if (this.state.length > 5) {
      Atomics.store(this.state, 5, this.totalFramesRendered);
    }
    if (this.state.length > 6) {
      this.heartbeatCount = (this.heartbeatCount || 0) + 1;
      Atomics.store(this.state, 6, this.heartbeatCount);
    }

    return true;
  }
}

registerProcessor('jam-audio-processor', JamAudioProcessor);
