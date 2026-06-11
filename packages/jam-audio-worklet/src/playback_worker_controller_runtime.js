export function createWorkletPortState({ initialPort = null, onWorkletPortReady = null } = {}) {
  let currentPort = initialPort;

  if (currentPort && typeof onWorkletPortReady === 'function') {
    onWorkletPortReady(currentPort);
  }

  return {
    getWorkletPort() {
      return currentPort;
    },
    setWorkletPort(port) {
      currentPort = port;
      if (typeof onWorkletPortReady === 'function') {
        onWorkletPortReady(currentPort);
      }
    },
  };
}

export function currentPlayerFrom({ windowedPlayer = null, streamingPlayer = null, player = null }) {
  return windowedPlayer ?? streamingPlayer ?? player;
}

export function playerHasEnded(candidatePlayer) {
  return typeof candidatePlayer?.hasEnded === 'function' && candidatePlayer.hasEnded();
}

export function playerPositionMs(candidatePlayer) {
  return typeof candidatePlayer?.positionMs === 'function'
    ? candidatePlayer.positionMs()
    : 0;
}
