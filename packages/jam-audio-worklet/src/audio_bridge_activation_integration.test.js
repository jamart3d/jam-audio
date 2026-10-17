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

function makeHarness() {
  const h = {
    contexts: [],
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
      h.workers.push(this);
    }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    emit(data) { for (const fn of this.listeners) fn({ data }); }
    postMessage(msg) {
      if (typeof msg.requestId !== 'number' || msg.requestId < 0) return;
      if (Number.isInteger(msg.sessionGeneration)) this.sessions.push(msg.sessionGeneration);
      Promise.resolve().then(() => this.emit({ type: 'response', requestId: msg.requestId, payload: {} }));
    }
    readyForCurrentSession() {
      this.emit({ type: 'playback-started', sessionGeneration: this.sessions.at(-1) });
    }
  }

  class FakeAudio {
    constructor() {
      this.paused = true;
      this.playCalls = 0;
      this.style = {};
      h.audios.push(this);
    }
    addEventListener() {}
    removeEventListener() {}
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
    navigator: { userAgent: 'node-test' },
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

async function withHarness(t, fn) {
  const h = makeHarness();
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

test('click fallback registration is single across eager init and startup', (t) => withHarness(t, async (h) => {
  await h.bridge.initAudio();
  await h.startPlay({ ready: false });
  await h.bridge.initAudio();
  assert.equal(h.clickListeners(), 1);
  assert.equal(h.docAdds.filter((a) => a.type === 'click').length, 1);
}));

test('trusted click unlocks; untrusted click does not; started publishes once after running', async (t) => withHarness(t, async (h) => {
  await h.startPlay();
  assert.equal(h.started, 0);
  assert.ok(h.suspended >= 1, 'suspended callback reports buffered readiness');
  const before = h.ctx().resumeCalls;
  h.clicks(false);
  assert.equal(h.ctx().resumeCalls, before);
  h.clicks(true);
  assert.equal(h.ctx().resumeCalls, before + 1);
  assert.equal(h.started, 0, 'nothing published during dispatch');
  h.ctx().allowResume();
  await flush();
  assert.equal(h.started, 1);
  assert.equal(h.clickListeners(), 0);
}));

test('rejected first attempt keeps listener; second click succeeds', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.clicks();
  h.ctx().rejectResume();
  await flush();
  assert.equal(h.clickListeners(), 1);
  assert.equal(h.started, 0);
  const before = h.ctx().resumeCalls;
  h.clicks();
  assert.equal(h.ctx().resumeCalls, before + 1);
  h.ctx().allowResume();
  await flush();
  assert.equal(h.started, 1);
}));

test('duplicate click delivery publishes started once', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.clicks();
  h.clicks();
  h.ctx().allowResume(h.ctx().outcomes.length - 2);
  h.ctx().outcomes.at(-1).resolve();
  await flush();
  h.clicks();
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
  h.clicks();
  const pausing = h.bridge.pause();
  h.ctx().allowResume();
  await pausing;
  await flush();
  assert.equal(h.started, 0);
  assert.deepEqual(h.ctx().rampTargets.filter((v) => v > 0), []);
}));

test('Stop while resume is pending cannot publish started', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  h.clicks();
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
  h.clicks();
  const resetting = h.bridge.forceAudioContextReset();
  old.allowResume();
  await resetting;
  await flush();
  assert.equal(h.started, 0);
  assert.equal(h.clickListeners(), 0);
}));

test('page teardown removes the click fallback and blocks late start', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  assert.equal(h.clickListeners(), 1);
  for (const l of h.winListeners.filter((x) => x.type === 'pagehide')) l.fn({ type: 'pagehide' });
  assert.equal(h.clickListeners(), 0);
  h.ctx().allowResume();
  await flush();
  assert.equal(h.started, 0);
}));

test('combined Play, Pause, Stop dispatch with a queued resume settlement cannot start or unmute', (t) => withHarness(t, async (h) => {
  await h.startPlay();
  // One gesture: capture fallback (Play) then Flutter Pause then Stop handlers.
  h.clicks();
  const pausing = h.bridge.pause();
  const stopping = h.bridge.stop();
  h.ctx().allowResume();
  await Promise.all([pausing, stopping]);
  await flush();
  assert.equal(h.started, 0);
  assert.deepEqual(h.ctx().rampTargets.filter((v) => v > 0), []);
}));

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
