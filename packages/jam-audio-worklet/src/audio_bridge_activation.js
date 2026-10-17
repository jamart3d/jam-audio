/**
 * Startup audio-activation controller.
 *
 * Owns three small pieces of state that must stay consistent:
 *  - the app's accepted startup play intent and an activation generation that
 *    every cancellation increments (Pause/Stop/replace/error/reset/teardown);
 *  - a single trusted `click` fallback listener, armed only while a startup
 *    intent is pending and the AudioContext is suspended;
 *  - the worker-ready latch (session, activation generation, context) that a
 *    started/unmute publication must match.
 *
 * `unlockAudioFromGesture()` is deliberately synchronous: browsers grant the
 * AudioContext.resume() activation only inside the originating event stack.
 * `publishStarted` runs only from `reconcile()`, which is never called from
 * the click handler, unlock or setPlaybackIntent, so publication always
 * follows event dispatch.
 */
export function createActivationController({
  getContext,
  getEventTarget,
  playAnchor = () => {},
  isSessionCurrent,
  publishStarted,
  emit = () => {},
}) {
  let intent = false;
  let pending = false;
  let generation = 0;
  let armedTarget = null;
  let latch = null;
  // True once the current request's start was published. A later Pause -> Play
  // is a resume, not a startup, so it must not re-arm the click fallback.
  let startPublished = false;

  function onClick(event) {
    if (!event || event.isTrusted !== true) return;
    unlockAudioFromGesture();
  }

  function arm() {
    if (armedTarget) return;
    const target = getEventTarget();
    if (!target) return;
    target.addEventListener('click', onClick, true);
    armedTarget = target;
  }

  function disarm() {
    if (!armedTarget) return;
    armedTarget.removeEventListener('click', onClick, true);
    armedTarget = null;
  }

  function refresh() {
    const ctx = getContext();
    if (intent && pending && ctx && ctx.state === 'suspended') {
      arm();
    } else {
      disarm();
    }
  }

  function cancel(reason) {
    const changed = intent || pending;
    intent = false;
    pending = false;
    generation += 1;
    disarm();
    if (changed) emit('activation-cancelled', { reason });
  }

  function setPlaybackIntent(shouldPlay) {
    if (shouldPlay) {
      if (!intent) {
        intent = true;
        pending = !startPublished;
        generation += 1;
      }
      refresh();
    } else {
      cancel('intent-false');
    }
  }

  // An accepted playTrack*() request: intent true, new generation, any earlier
  // worker-ready latch discarded.
  function beginRequest() {
    intent = true;
    pending = true;
    generation += 1;
    latch = null;
    startPublished = false;
    refresh();
  }

  function invalidate(reason) {
    cancel(reason);
  }

  function observeResume(ctx, attempt, capturedGeneration) {
    if (!attempt || typeof attempt.then !== 'function') return;
    attempt.then(
      () => {
        if (capturedGeneration !== generation) return;
        if (ctx !== getContext()) return;
        refresh();
        reconcile();
      },
      (error) => {
        emit('unlock-resume-rejected', { message: error?.message ?? String(error) });
      },
    );
  }

  function unlockAudioFromGesture() {
    const ctx = getContext();
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    const capturedGeneration = generation;
    let attempt = null;
    try {
      attempt = ctx.resume();
    } catch (error) {
      emit('unlock-resume-threw', { message: error?.message ?? String(error) });
    }
    try {
      playAnchor();
    } catch (error) {
      emit('unlock-anchor-threw', { message: error?.message ?? String(error) });
    }
    observeResume(ctx, attempt, capturedGeneration);
  }

  function noteWorkerReady({ sessionGeneration, context }) {
    latch = { sessionGeneration, context, activationGeneration: generation };
  }

  function clearPendingStart() {
    latch = null;
  }

  function onContextStateChange(ctx) {
    if (ctx !== getContext()) return;
    refresh();
    reconcile();
  }

  function reconcile() {
    if (!latch || !intent || !pending) return false;
    if (latch.activationGeneration !== generation) return false;
    const ctx = getContext();
    if (!ctx || latch.context !== ctx || ctx.state !== 'running') return false;
    if (!isSessionCurrent(latch.sessionGeneration)) return false;
    latch = null;
    pending = false;
    startPublished = true;
    disarm();
    publishStarted();
    return true;
  }

  return {
    setPlaybackIntent,
    beginRequest,
    invalidate,
    unlockAudioFromGesture,
    refresh,
    noteWorkerReady,
    clearPendingStart,
    onContextStateChange,
    reconcile,
    hasIntent: () => intent,
    hasPendingStart: () => latch !== null,
    generation: () => generation,
    isCurrentGeneration: (g) => g === generation,
    isArmed: () => armedTarget !== null,
  };
}
