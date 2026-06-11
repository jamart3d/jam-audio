export function createBridgeSessionState({
  storage = null,
  resetProcessorPosition = () => {},
} = {}) {
  let queueTrackIds = [];
  let activeTrackIndex = 0;
  let activeTrackId = null;
  let activeTrackTitle = '';
  let positionMs = 0;
  let decodedPositionMs = 0;

  function saveSessionMetadataToLocalStorage() {
    if (!storage || !activeTrackId) return;
    storage.setItem('jamdisc-session-track-id', activeTrackId);
    storage.setItem('jamdisc-session-track-title', activeTrackTitle || '');
    storage.setItem('jamdisc-session-position-ms', String(positionMs || 0));
    storage.setItem('jamdisc-session-track-index', String(activeTrackIndex));
    storage.setItem('jamdisc-session-has-queue', String(queueTrackIds.length > 0));
    storage.setItem('jamdisc-session-timestamp', String(Date.now()));
  }

  function clearSessionMetadataFromLocalStorage() {
    if (!storage) return;
    storage.removeItem('jamdisc-session-track-id');
    storage.removeItem('jamdisc-session-track-title');
    storage.removeItem('jamdisc-session-position-ms');
    storage.removeItem('jamdisc-session-track-index');
    storage.removeItem('jamdisc-session-has-queue');
    storage.removeItem('jamdisc-session-timestamp');
  }

  function setSessionQueue(trackIds, currentIndex) {
    const oldTrackId = activeTrackId;
    queueTrackIds = trackIds || [];
    activeTrackIndex = currentIndex || 0;

    if (queueTrackIds.length > 0 && activeTrackIndex >= 0 && activeTrackIndex < queueTrackIds.length) {
      activeTrackId = queueTrackIds[activeTrackIndex];
      if (activeTrackId !== oldTrackId) {
        positionMs = 0;
        decodedPositionMs = 0;
        resetProcessorPosition();
      }
      saveSessionMetadataToLocalStorage();
    } else {
      activeTrackId = null;
      clearSessionMetadataFromLocalStorage();
    }
  }

  function getPlaybackSessionSnapshot() {
    return {
      activeTrackIndex,
      activeTrackId,
      positionMs,
      decodedPositionMs,
      queueLength: queueTrackIds.length,
    };
  }

  return {
    saveSessionMetadataToLocalStorage,
    clearSessionMetadataFromLocalStorage,
    setSessionQueue,
    getPlaybackSessionSnapshot,
    setActiveTrackTitle: (value) => { activeTrackTitle = value || ''; },
    setPositionMs: (value) => { positionMs = value || 0; },
    setDecodedPositionMs: (value) => { decodedPositionMs = value || 0; },
  };
}
