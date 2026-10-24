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

test('repeated refresh never installs a document activation listener', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.controller.refresh();
  env.controller.refresh();
  assert.deepEqual(env.listeners, []);
});

test('trusted and untrusted document clicks do not unlock', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.click(false);
  assert.equal(env.ctx.resumeCalls, 0);
  env.click(true);
  assert.equal(env.ctx.resumeCalls, 0);
});

test('rejected explicit Play retries without a document listener', async () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.controller.authorizePlay();
  env.controller.unlockAudioFromGesture();
  env.ctx.outcomes[0].reject(new Error('nope'));
  await flush();
  assert.equal(env.listeners.length, 0);
  env.controller.authorizePlay();
  env.controller.unlockAudioFromGesture();
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

test('worker-ready then running publishes exactly once', async () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.controller.reconcile();
  assert.equal(env.published, 0, 'suspended: nothing published');
  env.controller.authorizePlay();
  env.ctx.state = 'running';
  env.controller.onContextStateChange(env.ctx);
  env.controller.onContextStateChange(env.ctx);
  await flush();
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
  env.controller.authorizePlay();
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
  env.controller.authorizePlay();
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

test('beginRequest sets intent and generation without installing a listener', () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  const g = env.controller.generation();
  env.controller.beginRequest();
  assert.equal(env.controller.hasIntent(), true);
  assert.equal(env.controller.isCurrentGeneration(g), false);
  assert.equal(env.listeners.length, 0);
});

test('Pause then Play after a completed start does not leave a pending startup armed', async () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.controller.authorizePlay();
  env.ctx.state = 'running';
  env.controller.onContextStateChange(env.ctx);
  await flush();
  assert.equal(env.published, 1);
  env.controller.setPlaybackIntent(false);
  env.controller.setPlaybackIntent(true);
  env.ctx.state = 'suspended';
  env.controller.onContextStateChange(env.ctx);
  assert.equal(env.listeners.length, 0);
  env.click();
  assert.equal(env.ctx.resumeCalls, 0);
});

test('Dart-first sequence still works: intent, then request, then worker-ready, then unlock', async () => {
  const env = makeEnv();
  env.controller.setPlaybackIntent(true);
  assert.equal(env.listeners.length, 0, 'no document activation listener');
  env.controller.beginRequest();
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.controller.authorizePlay();
  env.controller.unlockAudioFromGesture();
  assert.equal(env.ctx.resumeCalls, 1);
  env.ctx.state = 'running';
  env.controller.onContextStateChange(env.ctx);
  await flush();
  assert.equal(env.published, 1);
  assert.equal(env.listeners.length, 0);
});

test('Dart-first replacement after completed start installs no listener', async () => {
  const env = makeEnv();
  env.controller.beginRequest();
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.controller.authorizePlay();
  env.ctx.state = 'running';
  env.controller.reconcile();
  await flush();
  assert.equal(env.published, 1);
  env.controller.setPlaybackIntent(false);
  env.ctx.state = 'suspended';
  env.controller.setPlaybackIntent(true);
  env.controller.beginRequest();
  assert.equal(env.listeners.length, 0);
});

test('blocked startup ignores native running until explicit Play', async () => {
  const env = makeEnv();
  env.controller.beginRequest();
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.ctx.state = 'running';
  env.controller.onContextStateChange(env.ctx);
  assert.equal(env.published, 0);
  env.controller.authorizePlay();
  assert.equal(env.published, 0, 'no publication inside dispatch');
  await flush();
  assert.equal(env.published, 1);
});

test('trusted and synthetic clicks never request an unlock', () => {
  const env = makeEnv();
  env.controller.beginRequest();
  env.controller.refresh();
  env.click(false);
  env.click(true);
  assert.equal(env.listeners.length, 0);
  assert.equal(env.ctx.resumeCalls, 0);
});

test('automatic replacement inherits the hold and needs its own Play', async () => {
  const env = makeEnv();
  env.controller.beginRequest();
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.controller.beginRequest();
  env.currentSession = 2;
  env.ctx.state = 'running';
  env.controller.noteWorkerReady({ sessionGeneration: 2, context: env.ctx });
  env.controller.reconcile();
  await flush();
  assert.equal(env.published, 0);
  env.controller.authorizePlay();
  await flush();
  assert.equal(env.published, 1);
});

test('Play before worker-ready authorizes only the accepted request', async () => {
  const env = makeEnv();
  env.controller.beginRequest();
  env.controller.authorizePlay();
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  env.ctx.state = 'running';
  env.controller.onContextStateChange(env.ctx);
  await flush();
  assert.equal(env.published, 1);
});

test('Play approval for a pending request does not carry to its automatic replacement', async () => {
  const env = makeEnv();
  env.controller.beginRequest();
  env.controller.authorizePlay();
  env.controller.beginRequest();
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  assert.equal(env.controller.isPlayRequired(), true, 'stale approval must not exempt the replacement');
  env.ctx.state = 'running';
  env.controller.reconcile();
  await flush();
  assert.equal(env.published, 0);
});

test('D7: Play before any request exists grants nothing; a second Play authorizes output', async () => {
  const env = makeEnv();
  env.controller.authorizePlay(); // restored session: unlock before any bridge request exists
  env.controller.beginRequest(); // the first Play's request; context still suspended
  env.controller.noteWorkerReady({ sessionGeneration: 1, context: env.ctx });
  assert.equal(env.controller.isPlayRequired(), true, 'first Play left no blanket exemption: held');
  env.ctx.state = 'running';
  env.controller.reconcile();
  await flush();
  assert.equal(env.published, 0, 'first Play left no blanket exemption: still held');
  env.controller.authorizePlay(); // second Play
  env.ctx.state = 'running'; // the second Play's gesture resumes the context
  assert.equal(env.published, 0, 'no publication inside dispatch');
  await flush();
  assert.equal(env.published, 1);
});

function makeHoldController(ctx, extra = {}) {
  const log = { holds: 0, releases: [], published: 0, session: 1 };
  const controller = createActivationController({
    getContext: () => ctx,
    getEventTarget: () => null,
    isSessionCurrent: (g) => g === log.session,
    publishStarted: () => { log.published += 1; },
    holdOutput: () => { log.holds += 1; },
    releaseOutput: (published) => { log.releases.push(published); },
    ...extra,
  });
  return { controller, log };
}

for (const reason of ['pause', 'stop', 'worker-error', 'startup-error', 'context-reset', 'teardown', 'playback-error']) {
  test(`${reason} cancel releases a held output exactly once`, () => {
    const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
    const { controller, log } = makeHoldController(ctx);
    controller.beginRequest();
    controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
    assert.equal(controller.isPlayRequired(), true);
    controller.invalidate(reason);
    controller.invalidate(reason);
    assert.deepEqual(log.releases, [false]);
    assert.equal(controller.isPlayRequired(), false);
  });
}

test('publication releases a held output with published=true; no hold, no release', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  controller.authorizePlay();
  ctx.state = 'running';
  await flush();
  assert.deepEqual(log.releases, [true]);
  assert.equal(log.published, 1);
  const running = { state: 'running', resume: () => Promise.resolve() };
  const calm = makeHoldController(running);
  calm.controller.beginRequest();
  calm.controller.noteWorkerReady({ sessionGeneration: 1, context: running });
  calm.controller.reconcile();
  await flush();
  assert.deepEqual(calm.log.releases, []);
  assert.equal(calm.log.published, 1, 'normal autoplay needs no Play');
});

test('a context that runs before worker-ready is never held', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  ctx.state = 'running';
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  controller.reconcile();
  await flush();
  assert.equal(controller.isPlayRequired(), false);
  assert.equal(log.published, 1);
});

test('an interrupted context is not a hold and still publishes when running', () => {
  const ctx = { state: 'interrupted', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  assert.equal(controller.isPlayRequired(), false);
  ctx.state = 'running';
  controller.onContextStateChange(ctx);
  assert.equal(log.published, 1);
});

test('worker-ready before the resume attempt is judged by reassess after it', () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  let attempted = false;
  const { controller } = makeHoldController(ctx, { isBlockedSample: (c) => c.state === 'suspended' && attempted });
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  assert.equal(controller.isPlayRequired(), false, 'no verdict before the attempt');
  attempted = true;
  controller.reassess();
  assert.equal(controller.isPlayRequired(), true);
});

test('gesture grant: Play on a held request also authorizes the replacement it creates; consumed once', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  controller.authorizePlay();
  controller.beginRequest();
  log.session = 2;
  assert.equal(controller.isPlayRequired(), false, 'replacement is authorized by the gesture');
  ctx.state = 'running';
  controller.noteWorkerReady({ sessionGeneration: 2, context: ctx });
  controller.reconcile();
  await flush();
  assert.equal(log.published, 1);
  controller.beginRequest();
  log.session = 3;
  ctx.state = 'suspended';
  controller.noteWorkerReady({ sessionGeneration: 3, context: ctx });
  assert.equal(controller.isPlayRequired(), true, 'grant was consumed; next replacement needs its own Play');
});

test('beginRequest consumes the grant: an automatic replacement after the gesture replacement needs Play', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  controller.authorizePlay();
  controller.setPlaybackIntent(true); // gesture on a held request: approval retargeted, grant armed
  controller.beginRequest(); // the gesture's replacement consumes the grant
  log.session = 2;
  assert.equal(controller.isPlayRequired(), false, 'gesture replacement is authorized');
  controller.beginRequest(); // an automatic replacement of that request
  log.session = 3;
  assert.equal(controller.isPlayRequired(), true, 'grant consumed by the first beginRequest');
  controller.noteWorkerReady({ sessionGeneration: 3, context: ctx });
  ctx.state = 'running';
  controller.onContextStateChange(ctx);
  controller.reconcile();
  await flush();
  assert.equal(log.published, 0, 'nothing publishes without a new Play');
  assert.equal(controller.isPlayRequired(), true);
});

test('same-dispatch intent re-declaration retargets the approval to the replacement; old request never publishes', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  controller.authorizePlay();
  controller.setPlaybackIntent(true); // playQueue gesture prefix re-declares in the same dispatch
  assert.equal(controller.isPlayRequired(), true, 'old request is held again');
  ctx.state = 'running';
  controller.onContextStateChange(ctx);
  await flush();
  assert.equal(log.published, 0, 'old request never publishes');
  await flush();
  controller.beginRequest(); // replacement consumes the armed grant
  log.session = 2;
  assert.equal(controller.isPlayRequired(), false);
  controller.noteWorkerReady({ sessionGeneration: 2, context: ctx });
  controller.reconcile();
  await flush();
  assert.equal(log.published, 1, 'exactly one start, for the replacement');
});

test('intent re-declaration in a later task does not retarget the approval', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  controller.authorizePlay();
  await flush(); // the approval dispatch ended
  controller.setPlaybackIntent(true);
  assert.equal(controller.isPlayRequired(), false, 'approval stays on the held request');
  ctx.state = 'running';
  controller.onContextStateChange(ctx);
  await flush();
  assert.equal(log.published, 1);
});

test('plain Play on a held request (intent, then unlock) still publishes once', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  controller.setPlaybackIntent(true);
  controller.authorizePlay();
  ctx.state = 'running';
  await flush();
  assert.equal(log.published, 1);
});

test('re-declaration after an approval that found no held request retargets nothing', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.authorizePlay(); // Play before worker-ready: nothing held yet, nothing retargetable
  controller.setPlaybackIntent(true);
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  assert.equal(controller.isPlayRequired(), false, 'the approved request is not held at worker-ready');
  ctx.state = 'running';
  controller.onContextStateChange(ctx);
  await flush();
  assert.equal(log.published, 1);
});

test('same-dispatch approval defers synchronous running-state reconcile until retarget closes', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });

  // Plain Play outcome:
  controller.authorizePlay();
  // Synchronous statechange while retargetable:
  ctx.state = 'running';
  controller.onContextStateChange(ctx);
  assert.equal(log.published, 0, 'approval still retargetable: running state cannot publish synchronously');
  await flush();
  assert.equal(log.published, 1, 'plain Play microtask closes retarget window and publishes latch A once');

  // Replacement retarget outcome:
  const ctx2 = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller: controller2, log: log2 } = makeHoldController(ctx2);
  controller2.beginRequest();
  controller2.noteWorkerReady({ sessionGeneration: 1, context: ctx2 });
  controller2.authorizePlay();
  ctx2.state = 'running';
  controller2.onContextStateChange(ctx2);
  assert.equal(log2.published, 0, 'cannot publish old A while retargetable');
  controller2.setPlaybackIntent(true); // retarget in same dispatch
  await flush();
  assert.equal(log2.published, 0, 'replacement retarget never publishes old A');
});

test('beginRequest consumes grant for first request when automatic replacement supersedes selected replacement', async () => {
  const ctx = { state: 'suspended', resume: () => new Promise(() => {}) };
  const { controller, log } = makeHoldController(ctx);
  controller.beginRequest();
  controller.noteWorkerReady({ sessionGeneration: 1, context: ctx });
  controller.authorizePlay();
  controller.setPlaybackIntent(true); // retarget to replacement, one-shot grant armed

  // Automatic C supersedes selected B and reaches beginRequest first:
  controller.beginRequest(); // Request C
  log.session = 2;
  assert.equal(controller.isPlayRequired(), false, 'C consumes the one-shot grant');

  // Selected B reaches beginRequest second:
  controller.beginRequest(); // Request B
  log.session = 3;
  assert.equal(controller.isPlayRequired(), true, 'subsequent request stays held, preserving accepted risk');
});
