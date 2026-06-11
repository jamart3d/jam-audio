export function clampVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
}

export async function sendPreloadCommand(sendPlaybackWorkerCommand, onPreloadErrorCallback, type, payload) {
  try {
    await sendPlaybackWorkerCommand(type, payload);
  } catch (error) {
    if (typeof onPreloadErrorCallback === 'function') {
      onPreloadErrorCallback(error instanceof Error ? error.message : String(error));
    }
  }
}
