// Reproduction attempts for: Play does nothing after pause + background; output gain stuck at 0.
// Harness copied from audio_bridge_activation_integration.test.js (makeHarness is not exported there).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createJamAudioBridge } from './audio_bridge.js';

const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeHarness({ boundedAnchor = false, userAgent = 'node-test' } = {}) {
  const h = {
    contexts: [],
    gains: [],
    workers: [],
    audios: [],
    docAdds: [],
    docListeners: [],
    winListeners: [],
    started: 0,
    suspended: 0,
    unhandled: [],
  };

  class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.destination = {};
      this.listeners = [];
      this.resumeCalls = 0;
      this.outcomes = [];
      this.rampTargets = [];
      this.audioWorklet = { addModule: async () => {} };
      h.contexts.push(this);
    }
    addEventListener(type, fn) { this.listeners.push({ type, fn }); }
    setState(state) {
      this.state = state;
      for (const l of this.listeners) if (l.type === 'statechange') l.fn({ type: 'statechange' });
    }
    resume() {
      this.resumeCalls += 1;
      const d = deferred();
      this.outcomes.push(d);
      return d.promise;
    }
    // Browser behaviour: statechange fires, then the promise settles.
    allowResume(index = this.outcomes.length - 1) {
      this.setState('running');
      this.outcomes[index].resolve();
    }
    rejectResume(index = this.outcomes.length - 1) {
      this.outcomes[index].reject(new Error('The play() request was not allowed'));
    }
    createGain() {
      const ctx = this;
      const gain = {
        value: 1,
        cancelScheduledValues() {},
        setValueAtTime(v) { gain.value = v; },
        linearRampToValueAtTime(v) { gain.value = v; ctx.rampTargets.push(v); },
      };
      h.gains.push(gain);
      return { gain, connect() {}, disconnect() {} };
    }
    createBiquadFilter() {
      return { type: '', frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, connect() {} };
    }
    async close() { this.state = 'closed'; }
  }

  class FakeAudioWorkletNode {
    constructor() { this.port = { postMessage() {}, onmessage: null }; }
    connect() {}
    disconnect() {}
  }

  class FakeWorker {
    constructor() {
      this.listeners = [];
      this.sessions = [];
      this.commands = [];
      h.workers.push(this);
    }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    emit(data) { for (const fn of this.listeners) fn({ data }); }
    postMessage(msg) {
      this.commands.push(msg);
      if (typeof msg.requestId !== 'number' || msg.requestId < 0) return;
      if (Number.isInteger(msg.sessionGeneration)) this.sessions.push(msg.sessionGeneration);
      Promise.resolve().then(() => this.emit({ type: 'response', requestId: msg.requestId, payload: {} }));
    }
    readyForCurrentSession() {
      this.emit({ type: 'playback-started', sessionGeneration: this.sessions.at(-1) });
    }
  }

  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.paused = true;
      this.playCalls = 0;
      this.style = {};
      this.listeners = [];
      this._muted = false;
      this.unmutedTrackSources = [];
      h.audios.push(this);
    }
    get muted() { return this._muted; }
    set muted(value) {
      this._muted = value;
      if (!value && this.src !== 'audio/silent.wav') this.unmutedTrackSources.push(this.src);
    }
    addEventListener(type, fn) { this.listeners.push({ type, fn }); }
    removeEventListener(type, fn) {
      this.listeners = this.listeners.filter((entry) => entry.type !== type || entry.fn !== fn);
    }
    fire(type) {
      for (const entry of [...this.listeners]) if (entry.type === type) entry.fn({ type });
    }
    play() { this.paused = false; this.playCalls += 1; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
  }

  const document = {
    visibilityState: 'visible',
    body: { appendChild() {} },
    addEventListener(type, fn, capture) {
      h.docAdds.push({ type, capture: capture === true || capture?.capture === true });
      const cap = capture === true || capture?.capture === true;
      if (!h.docListeners.some((l) => l.type === type && l.fn === fn && l.capture === cap)) {
        h.docListeners.push({ type, fn, capture: cap });
      }
    },
    removeEventListener(type, fn, capture) {
      const cap = capture === true || capture?.capture === true;
      h.docListeners = h.docListeners.filter(
        (l) => !(l.type === type && l.fn === fn && l.capture === cap),
      );
    },
  };
  const win = {
    crossOriginIsolated: true,
    location: { href: 'https://example.test/' },
    setInterval: () => 0,
    clearInterval() {},
    addEventListener(type, fn) { h.winListeners.push({ type, fn }); },
  };
  const globals = {
    window: win,
    document,
    navigator: { userAgent },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    Worker: FakeWorker,
    Audio: FakeAudio,
  };
  const saved = {};
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  const onUnhandled = (e) => h.unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);

  h.restore = () => {
    process.off('unhandledRejection', onUnhandled);
    for (const k of Object.keys(globals)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  };

  h.bridge = createJamAudioBridge({
    wasmModuleLoader: async () => ({}),
    processorModuleUrl: 'processor.js',
    playbackWorkerModuleUrl: 'worker.js',
    namespace: '',
    enableBoundedUrlAnchorExperiment: boundedAnchor,
  });
  h.bridge.setOnPlaybackStarted(() => { h.started += 1; });
  h.bridge.setOnPlaybackSuspended(() => { h.suspended += 1; });

  h.ctx = () => h.contexts.at(-1);
  h.worker = () => h.workers.at(-1);
  h.clicks = (trusted = true) => {
    for (const l of [...h.docListeners]) if (l.type === 'click') l.fn({ type: 'click', isTrusted: trusted });
  };
  h.fire = (type) => {
    for (const l of [...h.docListeners]) if (l.type === type) l.fn({ type, isTrusted: true });
  };
  h.clickListeners = () => h.docListeners.filter((l) => l.type === 'click').length;
  // Accepted startup: intent first, then acquisition, then worker readiness.
  h.startPlay = async ({ ready = true } = {}) => {
    h.bridge.setPlaybackIntent(true);
    const p = h.bridge.playTrack(new Uint8Array([1, 2, 3]));
    await p;
    await flush();
    if (ready) {
      h.worker().readyForCurrentSession();
      await flush();
    }
  };
  return h;
}

async function withHarness(t, fn, options = {}) {
  const h = makeHarness(options);
  try {
    await fn(h);
    await flush();
    assert.deepEqual(h.unhandled, [], 'no unhandled rejection');
  } finally {
    h.restore();
  }
}

const lastGain = (h) => h.gains.at(-1).value;
const positiveRamps = (h) => h.ctx().rampTargets.filter((v) => v > 0);

// A start held for explicit Play, then paused (cancel releases the hold) while the
// context keeps running (keep-warm). The start was never published.
async function heldStartThenKeepWarmPause(h) {
  await h.startPlay();
  assert.equal(h.started, 0, 'precondition: start held for Play');
  h.ctx().setState('running');
  await flush();
  await h.bridge.pause();
  assert.equal(h.ctx().state, 'running', 'precondition: keep-warm context still running');
  assert.equal(h.started, 0, 'precondition: nothing published yet');
}

// Suspect 1+2+3: keep-warm resume() zeroes the gain, then is interrupted because
// Play became required (context went suspended and the worker became ready for a
// start that is still pending). After Play is satisfied with the context running,
// the gain must ramp back to currentVolume and the start must be published.
test('keep-warm resume interrupted by a Play requirement ramps gain back after explicit Play', (t) => withHarness(t, async (h) => {
  await heldStartThenKeepWarmPause(h);
  h.bridge.setPlaybackIntent(true);
  const resuming = h.bridge.resume();
  // Interrupt while resume awaits transportUnmute: backgrounding suspends the
  // context and the worker reports ready for the pending start.
  h.ctx().setState('suspended');
  h.worker().readyForCurrentSession();
  await resuming;
  await flush();
  assert.equal(lastGain(h), 0, 'precondition: gain was zeroed by the interrupted resume/hold');
  assert.equal(h.started, 0, 'precondition: start still held');
  const interrupted = await h.bridge.getWorkerHealthStatus();
  assert.equal(interrupted.resumeUnmuteSent, true, 'precondition: keep-warm resume got as far as transportUnmute');
  assert.equal(interrupted.transportMuted, false, 'precondition: transport unmuted while gain is 0');

  // Play requirement satisfied with the context running.
  h.ctx().setState('running');
  h.bridge.unlockAudioFromGesture();
  await flush();
  await h.bridge.resume();
  await flush();

  assert.equal(h.started, 1, 'publishStarted must fire once Play is satisfied');
  assert.equal(lastGain(h), 1, 'gain must be restored to currentVolume, not left at 0');
  assert.ok(positiveRamps(h).length >= 1, 'a ramp to currentVolume must have been scheduled');
}));

// Suspect 4: unlockAudioFromGesture() on an already-running context with nothing
// pending (the start was already published) must not leave the output at gain 0
// after a keep-warm pause/resume.
test('Play on an already running context with no pending start still restores gain after keep-warm resume', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.unlockAudioFromGesture();
  h.ctx().allowResume();
  await flush();
  assert.equal(h.started, 1, 'precondition: first start published');
  await h.bridge.pause();
  assert.equal(h.ctx().state, 'running');
  const startedBefore = h.started;

  h.bridge.setPlaybackIntent(true);
  h.bridge.unlockAudioFromGesture();
  await flush();
  await h.bridge.resume();
  await flush();

  assert.equal(lastGain(h), 1, 'gain must be at currentVolume after Play on a running context');
  assert.ok(h.started >= startedBefore, 'started callback must not regress');
  const health = await h.bridge.getWorkerHealthStatus();
  assert.equal(health.gainNodeValue, 1);
  assert.equal(health.transportMuted, false);
}));
