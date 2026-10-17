import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivationController } from './audio_bridge_activation.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeEnv({ state = 'suspended', withContext = true } = {}) {
  const env = {
    ctx: withContext ? { state, resumeCalls: 0, outcomes: [] } : null,
    listeners: [],
    anchorPlays: 0,
    published: 0,
    currentSession: 1,
    unhandled: [],
  };
  if (env.ctx) {
    env.ctx.resume = () => {
      env.ctx.resumeCalls += 1;
      const d = deferred();
      env.ctx.outcomes.push(d);
      return d.promise;
    };
  }
  env.target = {
    addEventListener(type, fn, capture) {
      if (!env.listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) {
        env.listeners.push({ type, fn, capture });
      }
    },
    removeEventListener(type, fn, capture) {
      env.listeners = env.listeners.filter(
        (l) => !(l.type === type && l.fn === fn && l.capture === capture),
      );
    },
  };
  env.click = (isTrusted = true) => {
    for (const l of [...env.listeners]) if (l.type === 'click') l.fn({ type: 'click', isTrusted });
  };
  env.controller = createActivationController({
    getContext: () => env.ctx,
    getEventTarget: () => env.target,
    playAnchor: () => { env.anchorPlays += 1; },
    isSessionCurrent: (g) => g === env.currentSession,
    publishStarted: () => { env.published += 1; },
  });
  return env;
}

const flush = () => new Promise((r) => setImmediate(r));

test('unlockAudioFromGesture calls context.resume synchronously, before microtasks flush', () => {
  const env = makeEnv();
  env.controller.unlockAudioFromGesture();
  assert.equal(env.ctx.resumeCalls, 1);
  assert.equal(env.anchorPlays, 1);
});

test('unlockAudioFromGesture is a safe no-op with no context', () => {
  const env = makeEnv({ withContext: false });
  assert.doesNotThrow(() => env.controller.unlockAudioFromGesture());
  assert.equal(env.anchorPlays, 0);
});

test('unlockAudioFromGesture is a complete no-op on a running context', () => {
  const env = makeEnv({ state: 'running' });
  env.controller.unlockAudioFromGesture();
  assert.equal(env.ctx.resumeCalls, 0);
  assert.equal(env.anchorPlays, 0);
});

test('unlockAudioFromGesture observes a rejected resume without unhandled rejection', async () => {
  const env = makeEnv();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    env.controller.unlockAudioFromGesture();
    env.ctx.outcomes[0].reject(new Error('not allowed'));
    await flush();
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('click fallback is not armed without a pending startup intent', () => {
  const env = makeEnv();
  env.controller.refresh();
  assert.equal(env.listeners.length, 0);
  env.click();
  assert.equal(env.ctx.resumeCalls, 0);
});

test('click fallback arms once for intent on a suspended context, even with repeated refresh', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.controller.refresh();
  env.controller.refresh();
  assert.deepEqual(env.listeners.map((l) => [l.type, l.capture]), [['click', true]]);
});

test('click fallback ignores untrusted clicks and requests unlock on trusted ones', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.click(false);
  assert.equal(env.ctx.resumeCalls, 0);
  env.click(true);
  assert.equal(env.ctx.resumeCalls, 1);
});

test('rejected first attempt keeps the listener; a second click retries', async () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.click();
  env.ctx.outcomes[0].reject(new Error('nope'));
  await flush();
  assert.equal(env.listeners.length, 1);
  env.click();
  assert.equal(env.ctx.resumeCalls, 2);
});

test('listener is removed once the context is confirmed running', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.ctx.state = 'running';
  env.controller.onContextStateChange(env.ctx);
  assert.equal(env.listeners.length, 0);
});

test('setPlaybackIntent(false) disarms and invalidates the generation', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  const g = env.controller.generation();
  env.controller.setPlaybackIntent(false);
  assert.equal(env.listeners.length, 0);
  assert.equal(env.controller.isCurrentGeneration(g), false);
});

test('worker-ready then running publishes exactly once', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.controller.reconcile();
  assert.equal(env.published, 0, 'suspended: nothing published');
  env.ctx.state = 'running';
  env.controller.onContextStateChange(env.ctx);
  env.controller.onContextStateChange(env.ctx);
  env.controller.reconcile();
  assert.equal(env.published, 1);
});

test('running before worker-ready publishes nothing until the current worker-ready', () => {
  const env = makeEnv({ state: 'running' });
  env.controller.setPlaybackIntent(true);
  env.controller.onContextStateChange(env.ctx);
  assert.equal(env.published, 0);
  env.controller.noteWorkerReady({ sessionGeneration: 99, context: env.ctx });
  env.controller.reconcile();
  assert.equal(env.published, 0, 'stale session worker-ready ignored');
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.controller.reconcile();
  assert.equal(env.published, 1);
});

test('a latch from a cancelled generation never publishes after re-Play', async () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.controller.unlockAudioFromGesture();
  env.controller.setPlaybackIntent(false);
  env.controller.setPlaybackIntent(true);
  env.ctx.state = 'running';
  env.ctx.outcomes[0].resolve();
  await flush();
  env.controller.onContextStateChange(env.ctx);
  assert.equal(env.published, 0);
});

test('late resume settlement after invalidation does not publish', async () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.controller.unlockAudioFromGesture();
  env.controller.invalidate('stop');
  env.ctx.state = 'running';
  env.ctx.outcomes[0].resolve();
  await flush();
  assert.equal(env.published, 0);
});

test('stale context identity never publishes', () => {
  const env = makeEnv({ state: 'running' });
  env.controller.setPlaybackIntent(true);
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.ctx = { state: 'running', resume: () => Promise.resolve() };
  env.controller.reconcile();
  assert.equal(env.published, 0);
});

test('beginRequest sets intent and keeps listener armed for the replacement request', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  const g = env.controller.generation();
  env.controller.beginRequest();
  assert.equal(env.controller.hasIntent(), true);
  assert.equal(env.controller.isCurrentGeneration(g), false);
  assert.equal(env.listeners.length, 1);
});

test('Pause then Play after a completed start does not leave a pending startup armed', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.ctx.state = 'running';
  env.controller.onContextStateChange(env.ctx);
  assert.equal(env.published, 1);
  env.controller.setPlaybackIntent(false);
  env.controller.setPlaybackIntent(true);
  env.ctx.state = 'suspended';
  env.controller.onContextStateChange(env.ctx);
  assert.equal(env.listeners.length, 0);
  env.click();
  assert.equal(env.ctx.resumeCalls, 0);
});

test('Dart-first sequence still works: intent, then request, then worker-ready, then unlock', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  assert.equal(env.listeners.length, 1, 'armed before the request on a fresh startup');
  env.controller.beginRequest();
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.click();
  assert.equal(env.ctx.resumeCalls, 1);
  env.ctx.state = 'running';
  env.controller.onContextStateChange(env.ctx);
  assert.equal(env.published, 1);
  assert.equal(env.listeners.length, 0);
});

test('Dart-first after a prior completed start is armed by the request itself', () => {
  const env = makeEnv();
  env.controller.beginRequest();
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.ctx.state = 'running';
  env.controller.reconcile();
  assert.equal(env.published, 1);
  env.controller.setPlaybackIntent(false);
  env.ctx.state = 'suspended';
  env.controller.setPlaybackIntent(true);
  env.controller.beginRequest();
  assert.equal(env.listeners.length, 1);
});
