export function startPortLoop({
  getWorkletPort,
  refillRingBuffer,
  shouldKeepRunning,
}) {
  const port = getWorkletPort();
  if (!port) return false;

  port.onmessage = () => {
    if (!shouldKeepRunning()) return;
    refillRingBuffer();
  };

  return true;
}

export function nudgeWaitAsyncState(sharedState, refillRequestIndex) {
  if (!sharedState) return;
  Atomics.add(sharedState, refillRequestIndex, 1);
  Atomics.notify(sharedState, refillRequestIndex, 1);
}
