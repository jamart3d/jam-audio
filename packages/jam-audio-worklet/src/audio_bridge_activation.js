/** Startup activation: explicit Play authorizes only the current blocked request. */
export function createActivationController({
  getContext,
  playAnchor = () => {},
  isSessionCurrent,
  publishStarted,
  emit = () => {},
  holdOutput = () => {},
  releaseOutput = () => {},
  isBlockedSample = (ctx) => ctx?.state === 'suspended',
}) {
  let intent = false;
  let pending = false;
  let generation = 0;
  let latch = null;
  let startPublished = false;
  let requiresPlay = false;
  let playAuthorized = false;
  let grantNext = false;
  // True only inside the dispatch of an approval given on a held request (cleared by
  // the microtask that follows it): a play-intent re-declaration in that same
  // dispatch means a replacement request follows and retargets the approval to it.
  let approvalRetargetable = false;

  function isPlayRequired() { return requiresPlay && !playAuthorized; }
  function refresh() { if (isPlayRequired()) holdOutput(); }
  function cancel(reason) {
    const changed = intent || pending;
    const wasHeld = requiresPlay;
    intent = false;
    pending = false;
    requiresPlay = false;
    playAuthorized = false;
    grantNext = false;
    approvalRetargetable = false;
    generation += 1;
    if (wasHeld) releaseOutput(false);
    if (changed) emit('activation-cancelled', { reason });
  }
  function setPlaybackIntent(shouldPlay) {
    if (shouldPlay) {
      if (!intent) {
        intent = true;
        pending = !startPublished;
        playAuthorized = false;
        generation += 1;
      } else if (approvalRetargetable) {
        // Re-declared in the dispatch of an approval for a held request: the
        // request that follows is the Play target. Hold this one; the grant
        // armed by authorizePlay() goes to the replacement's beginRequest().
        approvalRetargetable = false;
        playAuthorized = false;
      }
      refresh();
    } else {
      cancel('intent-false');
    }
  }
  function beginRequest() {
    const inheritedHold = requiresPlay;
    const granted = grantNext && inheritedHold;
    grantNext = false;
    approvalRetargetable = false;
    intent = true;
    pending = true;
    generation += 1;
    latch = null;
    startPublished = false;
    requiresPlay = inheritedHold;
    playAuthorized = granted;
    refresh();
  }
  function noteBlocked() {
    if (!intent || !pending || playAuthorized) return;
    requiresPlay = true;
    refresh();
  }
  function observeContext(ctx) { if (isBlockedSample(ctx)) noteBlocked(); }
  function reassess() { if (latch) observeContext(getContext()); }
  function authorizePlay() {
    if (requiresPlay) grantNext = true;
    if (!intent || !pending) return;
    approvalRetargetable = requiresPlay;
    playAuthorized = true;
    const capturedGeneration = generation;
    queueMicrotask(() => {
      approvalRetargetable = false;
      if (capturedGeneration === generation) reconcile();
    });
  }
  function invalidate(reason) { cancel(reason); }
  function observeResume(ctx, attempt, capturedGeneration) {
    if (!attempt || typeof attempt.then !== 'function') return;
    attempt.then(
      () => {
        if (capturedGeneration !== generation || ctx !== getContext()) return;
        refresh();
        reconcile();
      },
      (error) => emit('unlock-resume-rejected', { message: error?.message ?? String(error) }),
    );
  }
  function unlockAudioFromGesture() {
    const ctx = getContext();
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    const capturedGeneration = generation;
    let attempt = null;
    try { attempt = ctx.resume(); }
    catch (error) { emit('unlock-resume-threw', { message: error?.message ?? String(error) }); }
    try { playAnchor(); }
    catch (error) { emit('unlock-anchor-threw', { message: error?.message ?? String(error) }); }
    observeResume(ctx, attempt, capturedGeneration);
  }
  function noteWorkerReady({ sessionGeneration, context }) {
    observeContext(context);
    latch = { sessionGeneration, context, activationGeneration: generation };
  }
  function clearPendingStart() { latch = null; }
  function onContextStateChange(ctx) {
    if (ctx !== getContext()) return;
    refresh();
    reconcile();
  }
  function reconcile() {
    if (approvalRetargetable) return false;
    if (!latch || !intent || !pending || isPlayRequired()) return false;
    if (latch.activationGeneration !== generation) return false;
    const ctx = getContext();
    if (!ctx || latch.context !== ctx || ctx.state !== 'running') return false;
    if (!isSessionCurrent(latch.sessionGeneration)) return false;
    const wasHeld = requiresPlay;
    latch = null;
    pending = false;
    startPublished = true;
    requiresPlay = false;
    playAuthorized = false;
    grantNext = false;
    approvalRetargetable = false;
    if (wasHeld) releaseOutput(true);
    publishStarted();
    return true;
  }
  return {
    setPlaybackIntent, beginRequest, invalidate, unlockAudioFromGesture,
    refresh, noteWorkerReady, clearPendingStart, onContextStateChange, reconcile,
    noteBlocked, observeContext, reassess, authorizePlay, isPlayRequired,
    hasIntent: () => intent,
    hasPendingStart: () => latch !== null,
    generation: () => generation,
    isCurrentGeneration: (value) => value === generation,
    isArmed: () => false,
  };
}
