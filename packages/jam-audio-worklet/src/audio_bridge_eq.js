export const PRESETS = {
  flat:         [0,   0,   0,  0,  0],
  bass_boost:   [6,   3,   0,  0,  0],
  treble_boost: [0,   0,   0,  3,  6],
  voice:        [-3, -2,   4,  3,  1],
  warm:         [4,   2,  -1, -2, -3],
  acoustic:     [2,   1,   0,  2,  3],
};

const BAND_FREQUENCIES = [80, 250, 1000, 4000, 12000];
const BAND_TYPES = ['lowshelf', 'peaking', 'peaking', 'peaking', 'highshelf'];
const PEAKING_Q = 1.4;

export function createEqChain(audioContext) {
  if (typeof audioContext.createBiquadFilter !== 'function') {
    return BAND_FREQUENCIES.map(() => ({
      type: '',
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: { value: 0 },
      connect: () => {},
      disconnect: () => {},
    }));
  }
  return BAND_FREQUENCIES.map((freq, i) => {
    const filter = audioContext.createBiquadFilter();
    filter.type = BAND_TYPES[i];
    filter.frequency.value = freq;
    if (BAND_TYPES[i] === 'peaking') filter.Q.value = PEAKING_Q;
    filter.gain.value = 0;
    return filter;
  });
}

// Wires the internal chain (eq[0]→…→eq[4]→gainNode). Call once at init.
export function wireEqChain(eqFilterNodes, gainNode) {
  for (let i = 0; i < eqFilterNodes.length - 1; i++) {
    eqFilterNodes[i].connect(eqFilterNodes[i + 1]);
  }
  eqFilterNodes[eqFilterNodes.length - 1].connect(gainNode);
}

// Connects processorNode into an already-wired chain (or directly to gainNode if chain is null).
// Call at init AND after every rebindWorkletNode.
export function connectProcessorToChain(processorNode, eqFilterNodes, gainNode) {
  if (eqFilterNodes && eqFilterNodes.length > 0) {
    processorNode.connect(eqFilterNodes[0]);
  } else {
    processorNode.connect(gainNode);
  }
}

export function clampGain(gainDb) {
  return Math.max(-12, Math.min(12, gainDb));
}

export function applyBand(eqFilterNodes, bandIndex, gainDb) {
  if (eqFilterNodes && bandIndex >= 0 && bandIndex < eqFilterNodes.length) {
    eqFilterNodes[bandIndex].gain.value = gainDb;
  }
}

export function applyBands(eqFilterNodes, gains) {
  if (!eqFilterNodes) return;
  gains.forEach((db, i) => applyBand(eqFilterNodes, i, db));
}
