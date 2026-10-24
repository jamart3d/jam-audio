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

test('unlockAudioFromGesture calls context.resume synchronously, before microtasks flush', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  const before = h.ctx().resumeCalls;
  h.bridge.unlockAudioFromGesture();
  assert.equal(h.ctx().resumeCalls, before + 1);
}));

test('unlockAudioFromGesture with no context is a no-op and builds no context', (t) => withHarness(t, async (h) => {
  assert.doesNotThrow(() => h.bridge.unlockAudioFromGesture());
  assert.equal(h.contexts.length, 0);
}));

test('only one AudioContext exists across unlocks and startup', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.unlockAudioFromGesture();
  h.bridge.unlockAudioFromGesture();
  assert.equal(h.contexts.length, 1);
}));

test('unlock on a running context requests no resume and leaves the anchor alone', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  h.ctx().setState('running');
  const resumes = h.ctx().resumeCalls;
  const anchorPlays = h.audios[0].playCalls;
  h.bridge.unlockAudioFromGesture();
  assert.equal(h.ctx().resumeCalls, resumes);
  assert.equal(h.audios[0].playCalls, anchorPlays);
}));

test('unlock attempts the hidden anchor in the same gesture', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  h.audios[0].paused = true;
  const plays = h.audios[0].playCalls;
  h.bridge.unlockAudioFromGesture();
  assert.equal(h.audios[0].playCalls, plays + 1);
}));

test('initAudio resolves while the first resume never settles (regression pin)', (t) => withHarness(t, async (h) => {
  const outcome = await Promise.race([
    h.bridge.initAudio().then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('hung'), 1500)),
  ]);
  assert.equal(outcome, 'resolved');
  assert.equal(h.ctx().resumeCalls, 1);
}));

test('eager initAudio with no play intent arms no click listener and a click does nothing', (t) => withHarness(t, async (h) => {
  await h.bridge.initAudio();
  assert.equal(h.clickListeners(), 0);
  const calls = h.ctx().resumeCalls;
  h.clicks();
  assert.equal(h.ctx().resumeCalls, calls);
}));

test('touchstart and keydown no longer register or unlock', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  assert.equal(h.docListeners.some((l) => l.type === 'touchstart' || l.type === 'keydown'), false);
  assert.equal(h.docAdds.some((a) => a.type === 'touchstart' || a.type === 'keydown'), false);
  const calls = h.ctx().resumeCalls;
  h.fire('touchstart');
  h.fire('keydown');
  assert.equal(h.ctx().resumeCalls, calls);
}));

test('eager init and startup never install a document click fallback', (t) => withHarness(t, async (h) => {
  await h.bridge.initAudio();
  await h.startPlay({ ready: false });
  await h.bridge.initAudio();
  assert.equal(h.clickListeners(), 0);
  assert.equal(h.docAdds.filter((a) => a.type === 'click').length, 0);
}));

test('document clicks do nothing; explicit Play starts once after running', async (t) => withHarness(t, async (h) => {
  await h.startPlay();
  assert.equal(h.started, 0);
  assert.ok(h.suspended >= 1, 'suspended callback reports buffered readiness');
  const before = h.ctx().resumeCalls;
  h.clicks(false);
  assert.equal(h.ctx().resumeCalls, before);
  h.clicks(true);
  assert.equal(h.ctx().resumeCalls, before);
  h.bridge.unlockAudioFromGesture();
  assert.equal(h.ctx().resumeCalls, before + 1);
  assert.equal(h.started, 0, 'nothing published during dispatch');
  h.ctx().allowResume();
  await flush();
  assert.equal(h.started, 1);
  assert.equal(h.clickListeners(), 0);
}));

test('rejected explicit Play retries without a document listener', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.unlockAudioFromGesture();
  h.ctx().rejectResume();
  await flush();
  assert.equal(h.clickListeners(), 0);
  assert.equal(h.started, 0);
  const before = h.ctx().resumeCalls;
  h.bridge.unlockAudioFromGesture();
  assert.equal(h.ctx().resumeCalls, before + 1);
  h.ctx().allowResume();
  await flush();
  assert.equal(h.started, 1);
}));

test('duplicate explicit Play delivery publishes started once', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.unlockAudioFromGesture();
  h.bridge.unlockAudioFromGesture();
  h.ctx().allowResume(h.ctx().outcomes.length - 2);
  h.ctx().outcomes.at(-1).resolve();
  await flush();
  h.bridge.unlockAudioFromGesture();
  await flush();
  assert.equal(h.started, 1);
}));

test('context running before worker-ready publishes nothing, then once on the current worker-ready', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  h.ctx().setState('running');
  await flush();
  assert.equal(h.started, 0);
  h.worker().emit({ type: 'playback-started', sessionGeneration: h.worker().sessions.at(-1) + 50 });
  await flush();
  assert.equal(h.started, 0, 'stale session worker-ready ignored');
  h.worker().readyForCurrentSession();
  await flush();
  assert.equal(h.started, 1);
  h.worker().readyForCurrentSession();
  await flush();
  assert.equal(h.started, 1, 'a repeated ready for a finished request does not republish');
}));

test('Pause while resume is pending: late settlement unlocks but cannot unmute or publish', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.unlockAudioFromGesture();
  const pausing = h.bridge.pause();
  h.ctx().allowResume();
  await pausing;
  await flush();
  assert.equal(h.started, 0);
  assert.deepEqual(h.ctx().rampTargets.filter((v) => v > 0), []);
}));

test('Stop while resume is pending cannot publish started', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.unlockAudioFromGesture();
  const stopping = h.bridge.stop();
  h.ctx().allowResume();
  await stopping;
  await flush();
  assert.equal(h.started, 0);
  assert.equal(h.clickListeners(), 0);
}));

test('Pause before the context exists cancels a late worker-ready start', (t) => withHarness(t, async (h) => {
  h.bridge.setPlaybackIntent(true);
  const p = h.bridge.playTrack(new Uint8Array([1]));
  await h.bridge.pause();
  await p;
  await flush();
  h.ctx().setState('running');
  h.worker().readyForCurrentSession();
  await flush();
  assert.equal(h.started, 0);
}));

test('superseded request: first session ready cannot start, second can', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  const firstSession = h.worker().sessions.at(-1);
  await h.bridge.playTrack(new Uint8Array([2]));
  await flush();
  h.ctx().setState('running');
  h.worker().emit({ type: 'playback-started', sessionGeneration: firstSession });
  await flush();
  assert.equal(h.started, 0);
  h.worker().readyForCurrentSession();
  await flush();
  assert.equal(h.started, 1);
}));

test('context reset invalidates: settlement on the old context cannot publish and listener is removed', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  const old = h.ctx();
  h.bridge.unlockAudioFromGesture();
  const resetting = h.bridge.forceAudioContextReset();
  old.allowResume();
  await resetting;
  await flush();
  assert.equal(h.started, 0);
  assert.equal(h.clickListeners(), 0);
}));

test('page teardown has no click fallback and blocks late start', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  assert.equal(h.clickListeners(), 0);
  for (const l of h.winListeners.filter((x) => x.type === 'pagehide')) l.fn({ type: 'pagehide' });
  assert.equal(h.clickListeners(), 0);
  h.ctx().allowResume();
  await flush();
  assert.equal(h.started, 0);
}));

test('combined Play, Pause, Stop dispatch with a queued resume settlement cannot start or unmute', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  // One dispatch: explicit Play followed by Pause and Stop handlers.
  h.bridge.unlockAudioFromGesture();
  const pausing = h.bridge.pause();
  const stopping = h.bridge.stop();
  h.ctx().allowResume();
  await Promise.all([pausing, stopping]);
  await flush();
  assert.equal(h.started, 0);
  assert.deepEqual(h.ctx().rampTargets.filter((v) => v > 0), []);
}));

// Pinned: a Pause between worker-ready and publish followed by Play stays dead (F8). Dart gates pause() on playing, so this window is unreachable from the app.
test('re-Play after a cancelled generation does not revive the stale worker-ready latch', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.setPlaybackIntent(false);
  h.bridge.setPlaybackIntent(true);
  h.bridge.unlockAudioFromGesture();
  h.ctx().allowResume();
  await flush();
  assert.equal(h.started, 0);
}));

test('ordinary resume() on a suspended context calls context.resume synchronously', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  await h.bridge.pause();
  const before = h.ctx().resumeCalls;
  const pending = h.bridge.resume();
  assert.equal(h.ctx().resumeCalls, before + 1, 'resume requested before the first await');
  await pending;
}));

test('keep-warm pause/resume on a running context never touches context.resume', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  h.ctx().setState('running');
  const before = h.ctx().resumeCalls;
  await h.bridge.pause();
  await h.bridge.resume();
  assert.equal(h.ctx().resumeCalls, before);
}));

test('getVisualizerAudioTap still resolves after startup', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  assert.ok(h.bridge.getVisualizerAudioTap());
}));

test('immediately-running autoplay still publishes started and ramps up once', (t) => withHarness(t, async (h) => {
  await h.bridge.initAudio();
  h.ctx().setState('running');
  h.bridge.setPlaybackIntent(true);
  await h.bridge.playTrack(new Uint8Array([1]));
  await flush();
  h.worker().readyForCurrentSession();
  await flush();
  assert.equal(h.started, 1);
  assert.equal(h.suspended, 0);
}));

test('statechange to running publishes started once while the resume promise never settles', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  const before = h.ctx().resumeCalls;
  h.bridge.unlockAudioFromGesture();
  assert.equal(h.ctx().resumeCalls, before + 1);
  assert.equal(h.started, 0);
  // Browser flips the state but the resume() promise never settles.
  h.ctx().setState('running');
  await flush();
  assert.equal(h.started, 1, 'published from the statechange wiring alone');
  assert.equal(h.clickListeners(), 0);
  h.ctx().setState('running');
  await flush();
  assert.equal(h.started, 1, 'repeated statechange does not republish');
}));

test('statechange to running does not publish after intent is cancelled', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.setPlaybackIntent(false);
  h.ctx().setState('running');
  await flush();
  assert.equal(h.started, 0);
}));

test('statechange on a stale context after reset does not publish', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  const oldCtx = h.ctx();
  await h.bridge.forceAudioContextReset();
  oldCtx.setState('running');
  await flush();
  assert.equal(h.started, 0);
}));

test('resume() on a still-suspended context does not tell the OS media widget it is playing', (t) => withHarness(t, async (h) => {
  globalThis.navigator.mediaSession = { playbackState: 'none' };
  try {
    await h.startPlay();
    await h.bridge.pause();
    assert.equal(globalThis.navigator.mediaSession.playbackState, 'paused');
    await h.bridge.resume();
    assert.equal(h.ctx().state, 'suspended');
    assert.notEqual(globalThis.navigator.mediaSession.playbackState, 'playing');
  } finally {
    delete globalThis.navigator.mediaSession;
  }
}));

test('resume() on a running context still marks the media widget playing', (t) => withHarness(t, async (h) => {
  globalThis.navigator.mediaSession = { playbackState: 'none' };
  try {
    await h.startPlay({ ready: false });
    h.ctx().setState('running');
    await h.bridge.pause();
    await h.bridge.resume();
    assert.equal(globalThis.navigator.mediaSession.playbackState, 'playing');
  } finally {
    delete globalThis.navigator.mediaSession;
  }
}));

test('Pause then Play after a completed start does not re-arm the click fallback on a later suspend', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.unlockAudioFromGesture();
  h.ctx().allowResume();
  await flush();
  assert.equal(h.started, 1);
  await h.bridge.pause();
  h.bridge.setPlaybackIntent(true);
  h.ctx().setState('suspended');
  await flush();
  assert.equal(h.clickListeners(), 0);
  const before = h.ctx().resumeCalls;
  h.clicks(true);
  assert.equal(h.ctx().resumeCalls, before, 'an unrelated click must not resume audio');
}));

test('held startup stays silent after an unrelated click and native running', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  const before = h.ctx().resumeCalls;
  h.clicks(false);
  h.clicks(true);
  assert.equal(h.ctx().resumeCalls, before);
  h.ctx().setState('running');
  await flush();
  assert.equal(h.started, 0);
  assert.ok(h.gains.every((gain) => gain.value === 0));
  assert.deepEqual(h.ctx().rampTargets.filter((value) => value > 0), []);
}));

test('held volume preference is applied only after explicit Play', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.setVolume(0.37);
  assert.ok(h.gains.every((gain) => gain.value === 0));
  h.ctx().setState('running');
  h.bridge.setVolume(0.63);
  await flush();
  assert.equal(h.started, 0);
  assert.ok(h.gains.every((gain) => gain.value === 0));
  h.bridge.unlockAudioFromGesture();
  await flush();
  assert.equal(h.started, 1);
  assert.deepEqual(h.ctx().rampTargets.filter((value) => value > 0), [0.63]);
}));

test('held lifecycle health and anchor events do not request resume', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  const before = h.ctx().resumeCalls;
  h.fire('visibilitychange');
  await h.bridge.ensureMediaAlive();
  h.audios[0].fire('play');
  await h.bridge.resume();
  await flush();
  assert.equal(h.ctx().resumeCalls, before);
  assert.equal(h.started, 0);
  assert.ok(h.gains.every((gain) => gain.value === 0));
  assert.deepEqual(h.ctx().rampTargets.filter((value) => value > 0), []);
}));

test('explicit Play on an already running held context publishes after dispatch', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.ctx().setState('running');
  await flush();
  assert.equal(h.started, 0);
  const before = h.ctx().resumeCalls;
  h.bridge.unlockAudioFromGesture();
  assert.equal(h.started, 0);
  await flush();
  assert.equal(h.started, 1);
  assert.equal(h.ctx().resumeCalls, before);
}));

test('held replacement on running context still needs new Play', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.ctx().setState('running');
  const before = h.suspended;
  await h.bridge.playTrack(new Uint8Array([2]));
  h.worker().readyForCurrentSession();
  await flush();
  assert.equal(h.started, 0);
  assert.ok(h.suspended > before);
  assert.ok(h.gains.every((gain) => gain.value === 0));
  h.bridge.unlockAudioFromGesture();
  await flush();
  assert.equal(h.started, 1);
}));

test('held experimental track anchor stays muted until authorized start', (t) => withHarness(t, async (h) => {
  await h.bridge.playTrackBounded('https://example.test/a.mp3', 1024);
  h.worker().readyForCurrentSession();
  await flush();
  const anchor = h.audios[0];
  assert.equal(anchor.src, 'https://example.test/a.mp3');
  assert.equal(anchor.muted, true);
  h.ctx().setState('running');
  anchor.fire('play');
  await h.bridge.ensureMediaAlive();
  await flush();
  assert.equal(anchor.muted, true);
  assert.equal(h.started, 0);
  h.bridge.unlockAudioFromGesture();
  await flush();
  assert.equal(h.started, 1);
  assert.equal(anchor.muted, false);
}, { boundedAnchor: true }));

test('Stop during queued Play cannot publish or unmute an old anchor', (t) => withHarness(t, async (h) => {
  await h.bridge.playTrackBounded('https://example.test/a.mp3', 1024);
  h.worker().readyForCurrentSession();
  await flush();
  const anchor = h.audios[0];
  anchor.unmutedTrackSources.length = 0;
  h.bridge.unlockAudioFromGesture();
  const stopped = h.bridge.stop();
  h.ctx().setState('running');
  for (const outcome of h.ctx().outcomes) outcome.resolve();
  await stopped;
  await flush();
  assert.equal(h.started, 0);
  assert.deepEqual(h.ctx().rampTargets.filter((value) => value > 0), []);
  assert.deepEqual(anchor.unmutedTrackSources, []);
}, { boundedAnchor: true }));

for (const [platform, userAgent] of [
  ['desktop', 'node-test'],
  ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/138.0.0.0 Mobile Safari/537.36'],
]) {
  test(`${platform} old resume cannot raise output after replacement becomes held`, async () => {
    const h = makeHarness({ userAgent });
    try {
      await h.startPlay({ ready: false });
      h.ctx().setState('running');
      h.worker().readyForCurrentSession();
      await flush();
      assert.equal(h.started, 1);
      await h.bridge.pause();
      const anchor = h.audios[0];
      const originalPlay = anchor.play;
      const gate = deferred();
      let entered = false;
      anchor.play = () => { entered = true; return gate.promise; };
      const oldResume = h.bridge.resume();
      await flush();
      assert.equal(entered, true, 'old resume is awaiting hidden-anchor play');
      anchor.play = originalPlay;
      await h.bridge.playTrack(new Uint8Array([9]));
      h.ctx().setState('suspended');
      h.worker().readyForCurrentSession();
      await flush();
      h.ctx().setState('running');
      await flush();
      assert.equal(h.started, 1, 'replacement is still held');
      h.ctx().rampTargets.length = 0;
      const unmuteCount = () => h.worker().commands.filter((msg) =>
        (msg.command ?? msg.type) === 'transportUnmute').length;
      const before = unmuteCount();
      gate.resolve();
      await oldResume;
      await flush();
      assert.equal(unmuteCount(), before, 'old continuation sends no further unmute');
      assert.deepEqual(h.ctx().rampTargets.filter((value) => value > 0), []);
      assert.ok(h.gains.every((gain) => gain.value === 0));
      assert.equal(h.started, 1);
      h.bridge.unlockAudioFromGesture();
      await flush();
      assert.equal(h.started, 2, 'only new explicit Play starts replacement');
      assert.deepEqual(h.unhandled, []);
    } finally {
      h.restore();
    }
  });
}

test('default silent anchor is never muted by a hold', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  assert.equal(h.audios[0].muted, false);
  assert.equal(h.started, 0);
}));

test('a context that runs after a pending init resume is not held', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  assert.equal(h.ctx().state, 'suspended', 'init resume still pending');
  h.ctx().setState('running');
  h.worker().readyForCurrentSession();
  await flush();
  assert.equal(h.started, 1, 'normal autoplay needs no Play');
  assert.equal(h.suspended, 0);
}));

test('worker-ready before the init resume attempt is not held once the context runs', (t) => withHarness(t, async (h) => {
  // Kills the mutation "isBlockedSample ignores resumeAttemptedFor". A real worker only emits
  // worker-ready after initAudio, so a fresh bridge cannot reach this state. A hard context
  // reset leaves the playback worker alive while the next request builds a new context, so
  // stall that second initAudio between context creation and its resume attempt.
  await h.startPlay({ ready: false });
  await h.bridge.forceAudioContextReset();
  const gate = deferred();
  const push = h.contexts.push.bind(h.contexts);
  h.contexts.push = (ctx) => { ctx.audioWorklet.addModule = () => gate.promise; return push(ctx); };
  h.bridge.setPlaybackIntent(true);
  const playing = h.bridge.playTrack(new Uint8Array([4, 5, 6])); // session generation 2
  await flush();
  assert.equal(h.contexts.length, 2, 'replacement context exists');
  assert.equal(h.ctx().resumeCalls, 0, 'init resume attempt not yet issued');
  assert.equal(h.ctx().state, 'suspended');
  h.worker().emit({ type: 'playback-started', sessionGeneration: 2 }); // worker-ready, pre-attempt
  await flush();
  assert.equal(h.started, 0, 'nothing publishes while the context is suspended');
  h.ctx().setState('running'); // the browser allows autoplay before the app attempts a resume
  await flush();
  assert.equal(h.ctx().resumeCalls, 0, 'still before the init resume attempt');
  assert.equal(h.started, 1, 'an un-attempted suspended sample latched no hold');
  gate.resolve();
  await playing;
  await flush();
  assert.equal(h.started, 1, 'started exactly once');
}));

test('an interrupted context is not held at worker-ready', (t) => withHarness(t, async (h) => {
  await h.startPlay({ ready: false });
  h.ctx().setState('interrupted');
  h.worker().readyForCurrentSession();
  await flush();
  h.bridge.setVolume(0.5);
  assert.ok(h.gains.some((gain) => gain.value === 0.5), 'volume applies; no hold');
  h.ctx().setState('running');
  await flush();
  assert.equal(h.started, 1);
}));

test('pause while held releases the hold so volume applies again', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.bridge.setVolume(0.2);
  assert.ok(h.gains.every((gain) => gain.value === 0));
  await h.bridge.pause();
  h.bridge.setVolume(0.4);
  assert.ok(h.gains.some((gain) => gain.value === 0.4));
}));

test('stop after a held actual-track start restores silence before any unmute', (t) => withHarness(t, async (h) => {
  await h.bridge.playTrackBounded('https://example.test/a.mp3', 1024);
  h.worker().readyForCurrentSession();
  await flush();
  const anchor = h.audios[0];
  assert.equal(anchor.muted, true);
  await h.bridge.stop();
  await flush();
  assert.deepEqual(anchor.unmutedTrackSources, []);
  assert.equal(anchor.muted, false);
  assert.equal(anchor.src, 'audio/silent.wav');
}, { boundedAnchor: true }));

test('gesture replacement while held starts once with the awaits startPlayback makes before playTrack', (t) => withHarness(t, async (h) => {
  await h.startPlay();                                  // held
  // playQueue's gesture prefix (Dart order): declare intent, unlock, re-declare.
  h.bridge.setPlaybackIntent(true);
  h.bridge.unlockAudioFromGesture();
  h.bridge.setPlaybackIntent(true);
  h.ctx().setState('running');                          // the gesture's native resume succeeds
  await flush();
  // startPlayback awaits initAudio and setVolume before bridge playTrack creates the request.
  await h.bridge.initAudio();
  h.bridge.setVolume(0.5);
  await flush();
  assert.equal(h.started, 0, 'the old held request must not publish before its replacement exists');
  assert.ok(h.gains.every((gain) => gain.value === 0), 'no output for the old request');
  assert.deepEqual(h.ctx().rampTargets.filter((value) => value > 0), [], 'no positive ramp for the old request');
  await h.bridge.playTrack(new Uint8Array([2]));
  h.worker().readyForCurrentSession();
  await flush();
  assert.equal(h.started, 1, 'track tap/Next/Previous counted as Play: exactly one start, no second Play');
  assert.deepEqual(h.ctx().rampTargets.filter((value) => value > 0), [0.5], 'one startup ramp to the stored volume');
}));

test('plain Play on a held request without a replacement still starts that request once', (t) => withHarness(t, async (h) => {
  await h.startPlay();                                  // held
  h.bridge.setPlaybackIntent(true);                     // real Dart order for Play: intent, then unlock
  h.bridge.unlockAudioFromGesture();
  h.ctx().setState('running');
  await flush();
  await h.bridge.initAudio();
  await flush();
  assert.equal(h.started, 1);
  assert.deepEqual(h.unhandled, []);
}));

test('a play-intent re-declaration after the approval dispatch does not retarget the approval', (t) => withHarness(t, async (h) => {
  await h.startPlay();                                  // held
  h.bridge.setPlaybackIntent(true);
  h.bridge.unlockAudioFromGesture();
  await Promise.resolve();                              // the dispatch ended
  await Promise.resolve();
  h.bridge.setPlaybackIntent(true);                     // later task: unrelated declaration
  h.ctx().setState('running');
  await flush();
  assert.equal(h.started, 1, 'the approved request still starts');
}));

test('automatic replacement while held needs Play', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  await h.bridge.playTrack(new Uint8Array([2]));
  h.ctx().setState('running');
  h.worker().readyForCurrentSession();
  await flush();
  assert.equal(h.started, 0);
  h.bridge.unlockAudioFromGesture();
  await flush();
  assert.equal(h.started, 1);
}));

test('Media Session Play retargets a pending replacement before synchronous resume statechange', (t) => withHarness(t, async (h) => {
  await h.startPlay(); // Request A is held
  assert.equal(h.started, 0);

  // Configure AudioContext resume() to synchronously fire statechange to 'running'
  const ctx = h.ctx();
  const origResume = ctx.resume.bind(ctx);
  ctx.resume = () => {
    ctx.setState('running');
    return origResume();
  };

  const handlers = {};
  globalThis.MediaMetadata = class {
    constructor(init = {}) { Object.assign(this, init); }
  };
  globalThis.navigator.mediaSession = {
    playbackState: 'none',
    setActionHandler: (name, fn) => { handlers[name] = fn; },
    setPositionState: () => {},
  };

  try {
    // Set up provider callback mirroring pending replacement window
    h.bridge.setOnPlay(() => {
      h.bridge.setPlaybackIntent(true);
      h.bridge.unlockAudioFromGesture(); // synchronously transitions ctx to running
      h.bridge.setPlaybackIntent(true); // final retarget in same dispatch
    });

    // Media Session Play arrives during pending replacement window
    h.bridge.updateMediaSession('title', 'artist', 'album', '');
    handlers.play();

    await flush();
    assert.equal(h.started, 0, 'Request A publishes zero starts during the retarget window');
    assert.deepEqual(ctx.rampTargets.filter((v) => v > 0), [], 'Request A receives no positive ramp');

    // Release the barrier: replacement B begins request and becomes ready
    await h.bridge.playTrack(new Uint8Array([2]));
    h.worker().readyForCurrentSession();
    await flush();
    assert.equal(h.started, 1, 'Replacement B starts exactly once');
    assert.deepEqual(ctx.rampTargets.filter((v) => v > 0), [1], 'Replacement B receives positive ramp');
  } finally {
    delete globalThis.navigator.mediaSession;
    delete globalThis.MediaMetadata;
  }
}));
