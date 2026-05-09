const READ_INDEX = 0;
const WRITE_INDEX = 1;
const FRAMES_AVAILABLE_INDEX = 2;
const END_OF_STREAM_INDEX = 3;
const STOP_INDEX = 4;

class JamAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = null;
    this.state = null;
    this.frameCapacity = 0;
    this.channels = 2;
    this.totalFramesRendered = 0;

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(data) {
    if (data.type === 'init') {
      this.samples = new Float32Array(data.pcmBuffer);
      this.state = new Int32Array(data.stateBuffer);
      this.frameCapacity = data.frameCapacity;
      this.channels = data.channels ?? 2;
      this.totalFramesRendered = 0;
      return;
    }

    if (data.type === 'reset_position') {
      this.totalFramesRendered = 0;
      return;
    }

    if (data.type === 'stop') {
      this.samples = null;
      this.state = null;
      this.frameCapacity = 0;
      this.channels = 2;
      this.totalFramesRendered = 0;
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

    for (let frame = 0; frame < left.length; frame += 1) {
      const shouldStop = Atomics.load(this.state, STOP_INDEX) === 1;
      const availableFrames = Atomics.load(this.state, FRAMES_AVAILABLE_INDEX);

      if (shouldStop || availableFrames <= 0) {
        left[frame] = 0;
        right[frame] = 0;
        continue;
      }

      const readFrame = Atomics.load(this.state, READ_INDEX);
      const sampleIndex = (readFrame % this.frameCapacity) * this.channels;
      left[frame] = this.samples[sampleIndex] ?? 0;
      right[frame] = this.channels > 1 ? (this.samples[sampleIndex + 1] ?? 0) : left[frame];

      Atomics.store(this.state, READ_INDEX, (readFrame + 1) % this.frameCapacity);
      Atomics.sub(this.state, FRAMES_AVAILABLE_INDEX, 1);
      this.totalFramesRendered += 1;
    }

    this.port.postMessage({ type: 'position', framesRendered: this.totalFramesRendered });

    return true;
  }
}

registerProcessor('jam-audio-processor', JamAudioProcessor);
