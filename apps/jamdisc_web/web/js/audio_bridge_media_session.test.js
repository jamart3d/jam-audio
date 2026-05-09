import assert from 'node:assert/strict';
import { createJamAudioBridge } from './worklet/audio_bridge.js';

async function runTest() {
  console.log('Running test: emits media-session-heartbeat on interval when playing');
  
  // Store originals
  const originalWindow = global.window;
  const originalPerformance = global.performance;
  const originalNavigator = global.navigator;
  const originalDocument = global.document;
  const originalURL = global.URL;
  const originalBlob = global.Blob;
  const originalAudio = global.Audio;

  // Setup mock for window and navigator
  let nextIntervalId = 1;
  let intervals = [];
  
  global.window = {
    _jamdiscDeclickDurationMs: 15,
    setInterval: (cb, ms) => {
      const id = nextIntervalId++;
      intervals.push({ id, cb, ms });
      return id;
    },
    clearInterval: (id) => {
      intervals = intervals.filter((i) => i.id !== id);
    }
  };

  global.performance = { now: () => Date.now() };

  global.navigator = {
    mediaSession: {
      playbackState: 'none'
    }
  };

  global.document = {
    body: {
      appendChild: () => {}
    }
  };

  global.URL = {
    createObjectURL: () => 'blob:mock',
    revokeObjectURL: () => {}
  };

  global.Blob = class {
    constructor() {}
  };

  global.Audio = class {
    constructor() {
      this.style = {};
      this.play = async () => {};
      this.pause = () => {};
    }
    addEventListener() {}
  };

  let bridge;
  try {
    let diagnosticsEvents = [];
    
    bridge = createJamAudioBridge({
      wasmModuleLoader: async () => {},
      processorModuleUrl: '',
      playbackWorkerModuleUrl: ''
    });
    
    bridge.setOnDiagnosticsEvent((eventStr) => {
      diagnosticsEvents.push(JSON.parse(eventStr));
    });
    
    // Call updatePlaybackState to 'playing'
    bridge.updatePlaybackState('playing');
    
    // Expect setInterval to be called
    assert.equal(intervals.length > 0, true, 'setInterval should be called for heartbeat');
    
    const heartbeatInterval = intervals.find(i => i.ms === 5000);
    assert.ok(heartbeatInterval, 'Should have a 5s interval for heartbeat');
    
    // Advance time/trigger interval callback
    heartbeatInterval.cb();
    
    const heartbeatEvents = diagnosticsEvents.filter(e => e.type === 'media-session-heartbeat');
    assert.equal(heartbeatEvents.length, 1, 'Should have emitted one media-session-heartbeat event');
    
    bridge.updatePlaybackState('none');
    assert.equal(intervals.find(i => i.id === heartbeatInterval.id), undefined, 'Interval should be cleared when state is none');

    console.log('Test passed.');
  } finally {
    // Clean up
    if (bridge) {
      bridge.stop();
    }
    global.window = originalWindow;
    global.performance = originalPerformance;
    global.navigator = originalNavigator;
    global.document = originalDocument;
    global.URL = originalURL;
    global.Blob = originalBlob;
    global.Audio = originalAudio;
  }
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
