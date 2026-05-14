const READ_INDEX = 0;
const _WRITE_INDEX = 1;
const FRAMES_AVAILABLE_INDEX = 2;
const _END_OF_STREAM_INDEX = 3;
const STOP_INDEX = 4;

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
      this.samples = new Float32Array(data.pcmBuffer);
      this.state = new Int32Array(data.stateBuffer);
      this.frameCapacity = data.frameCapacity;
      this.channels = data.channels ?? 2;
      this.totalFramesRendered = 0;
      this.framesSinceLastPositionUpdate = 0;
      return;
    }

    if (data.type === 'reset_position') {
      this.totalFramesRendered = 0;
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
    const initialAvailableFrames = Atomics.load(this.state, FRAMES_AVAILABLE_INDEX);

    if (shouldStop || initialAvailableFrames <= 0) {
      left.fill(0);
      right.fill(0);
      return true;
    }

    const framesToProcess = Math.min(left.length, initialAvailableFrames);
    let readFrame = Atomics.load(this.state, READ_INDEX);

    for (let frame = 0; frame < framesToProcess; frame += 1) {
      const sampleIndex = (readFrame % this.frameCapacity) * this.channels;
      left[frame] = this.samples[sampleIndex] ?? 0;
      right[frame] = this.channels > 1 ? (this.samples[sampleIndex + 1] ?? 0) : left[frame];

      readFrame = (readFrame + 1) % this.frameCapacity;
    }

    // Fill the remainder of the output buffer with silence if we ran out of frames (underrun)
    for (let frame = framesToProcess; frame < left.length; frame += 1) {
      left[frame] = 0;
      right[frame] = 0;
    }

    if (framesToProcess > 0) {
      // Single batch update for shared state indices and counters.
      Atomics.store(this.state, READ_INDEX, readFrame);
      Atomics.sub(this.state, FRAMES_AVAILABLE_INDEX, framesToProcess);

      this.totalFramesRendered += framesToProcess;
      this.framesSinceLastPositionUpdate += framesToProcess;
      if (this.framesSinceLastPositionUpdate >= this.positionUpdateIntervalFrames) {
        this.port.postMessage({ type: 'position', framesRendered: this.totalFramesRendered });
        this.framesSinceLastPositionUpdate = 0;
      }
    }

    return true;
  }
}

registerProcessor('jam-audio-processor', JamAudioProcessor);
