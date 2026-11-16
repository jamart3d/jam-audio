import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeMediaSessionController } from './audio_bridge_media_session.js';

function createFakeEnvironment({ now = 1000 } = {}) {
  let currentTime = now;
  let intervalIdCounter = 1;
  const intervals = new Map();

  const fakeNavigator = {
    mediaSession: {
      playbackState: 'none',
      metadata: null,
      positionState: null,
      actionHandlers: new Map(),
      setPositionState(state) {
        this.positionState = { ...state };
      },
      setActionHandler(action, handler) {
        this.actionHandlers.set(action, handler);
      },
    },
  };

  const fakeWindow = {
    setInterval(callback, ms) {
      const id = intervalIdCounter++;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  };

  const diagnosticsEvents = [];

  return {
    navigator: fakeNavigator,
    window: fakeWindow,
    intervals,
    getPerformanceNow: () => currentTime,
    nowMs: () => Math.round(currentTime),
    advanceTime: (ms) => {
      currentTime += ms;
    },
    triggerIntervals: () => {
      for (const { callback } of intervals.values()) {
        callback();
      }
    },
    emitDiagnosticsEvent: (event) => {
      diagnosticsEvents.push(event);
    },
    diagnosticsEvents,
  };
}

test('Slice A: updatePositionState validation rejects invalid parameters', () => {
  const env = createFakeEnvironment();
  const controller = createBridgeMediaSessionController({
    getNavigator: () => env.navigator,
    getWindow: () => env.window,
    getPerformanceNow: env.getPerformanceNow,
    nowMs: env.nowMs,
    emitDiagnosticsEvent: env.emitDiagnosticsEvent,
  });

  // Invalid duration
  controller.updatePositionState(0, 1.0, 0);
  assert.equal(env.navigator.mediaSession.positionState, null);
  controller.updatePositionState(-10, 1.0, 0);
  assert.equal(env.navigator.mediaSession.positionState, null);
  controller.updatePositionState(NaN, 1.0, 0);
  assert.equal(env.navigator.mediaSession.positionState, null);

  // Invalid playbackRate
  controller.updatePositionState(100, 0, 10);
  assert.equal(env.navigator.mediaSession.positionState, null);
  controller.updatePositionState(100, -1, 10);
  assert.equal(env.navigator.mediaSession.positionState, null);
  controller.updatePositionState(100, Infinity, 10);
  assert.equal(env.navigator.mediaSession.positionState, null);

  // Invalid position
  controller.updatePositionState(100, 1.0, -5);
  assert.equal(env.navigator.mediaSession.positionState, null);
  controller.updatePositionState(100, 1.0, NaN);
  assert.equal(env.navigator.mediaSession.positionState, null);
});

test('Slice A: updatePositionState clamps position to duration and records heartbeat baseline', () => {
  const env = createFakeEnvironment({ now: 1000 });
  const controller = createBridgeMediaSessionController({
    getNavigator: () => env.navigator,
    getWindow: () => env.window,
    getPerformanceNow: env.getPerformanceNow,
    nowMs: env.nowMs,
    emitDiagnosticsEvent: env.emitDiagnosticsEvent,
  });

  // Clamps position when position > duration
  controller.updatePositionState(60, 1.0, 75);
  assert.deepEqual(env.navigator.mediaSession.positionState, {
    duration: 60,
    playbackRate: 1.0,
    position: 60,
  });

  // Valid non-clamped position
  controller.updatePositionState(120, 1.25, 30);
  assert.deepEqual(env.navigator.mediaSession.positionState, {
    duration: 120,
    playbackRate: 1.25,
    position: 30,
  });
});

test('Slice A: heartbeat interval advances setPositionState and emits diagnostics', () => {
  const env = createFakeEnvironment({ now: 10_000 });
  const controller = createBridgeMediaSessionController({
    getNavigator: () => env.navigator,
    getWindow: () => env.window,
    getPerformanceNow: env.getPerformanceNow,
    nowMs: env.nowMs,
    emitDiagnosticsEvent: env.emitDiagnosticsEvent,
  });

  controller.updatePositionState(200, 1.0, 50);
  controller.startHeartbeat();

  assert.equal(env.intervals.size, 1);
  const intervalId = Array.from(env.intervals.keys())[0];

  // Starting again is idempotent
  controller.startHeartbeat();
  assert.equal(env.intervals.size, 1);

  // Advance time by 5 seconds (5000ms)
  env.advanceTime(5000);
  env.triggerIntervals();

  assert.deepEqual(env.navigator.mediaSession.positionState, {
    duration: 200,
    playbackRate: 1.0,
    position: 55, // 50 + 5s
  });

  assert.equal(env.diagnosticsEvents.length, 1);
  assert.equal(env.diagnosticsEvents[0].type, 'media-session-heartbeat');

  // Advance past duration -> position clamps to duration
  env.advanceTime(200_000);
  env.triggerIntervals();
  assert.equal(env.navigator.mediaSession.positionState.position, 200);

  // stopHeartbeat clears the interval
  controller.stopHeartbeat();
  assert.equal(env.intervals.size, 0);

  // Subsequent stopHeartbeat is safe no-op
  controller.stopHeartbeat();
  assert.equal(env.intervals.size, 0);
});

test('Slice B: updatePlaybackState clamped to paused and calls holdActivationOutput when play required', () => {
  const env = createFakeEnvironment();
  let holdCalled = false;
  let isPlayReq = true;
  const silentAudioEl = {
    paused: true,
    currentTime: 0,
    async play() { this.paused = false; },
    pause() { this.paused = true; },
  };

  const controller = createBridgeMediaSessionController({
    getNavigator: () => env.navigator,
    getWindow: () => env.window,
    isPlayRequired: () => isPlayReq,
    holdActivationOutput: () => { holdCalled = true; },
    getSilentAudioEl: () => silentAudioEl,
  });

  controller.updatePlaybackState('playing');
  assert.equal(holdCalled, true);
  assert.equal(env.navigator.mediaSession.playbackState, 'paused');
  // Since keepWhilePaused is false by default, paused state leaves silent audio paused
  assert.equal(silentAudioEl.paused, true);
});

test('Slice B: updatePlaybackState ignores loading state and handles playing/paused/none transitions', () => {
  const env = createFakeEnvironment();
  let silentAudioEnsured = false;
  const silentAudioEl = {
    paused: true,
    currentTime: 10,
    async play() { this.paused = false; },
    pause() { this.paused = true; },
  };

  const controller = createBridgeMediaSessionController({
    getNavigator: () => env.navigator,
    getWindow: () => env.window,
    isPlayRequired: () => false,
    ensureSilentAudio: () => { silentAudioEnsured = true; },
    getSilentAudioEl: () => silentAudioEl,
  });

  // 'loading' returns early without modifying playbackState
  env.navigator.mediaSession.playbackState = 'none';
  controller.updatePlaybackState('loading');
  assert.equal(env.navigator.mediaSession.playbackState, 'none');
  assert.equal(silentAudioEnsured, false);

  // 'playing' starts heartbeat and plays silent anchor
  controller.updatePlaybackState('playing');
  assert.equal(env.navigator.mediaSession.playbackState, 'playing');
  assert.equal(silentAudioEnsured, true);
  assert.equal(silentAudioEl.paused, false);
  assert.equal(env.intervals.size, 1);

  // 'paused' with keepWhilePaused=false pauses silent anchor
  controller.updatePlaybackState('paused');
  assert.equal(env.navigator.mediaSession.playbackState, 'paused');
  assert.equal(silentAudioEl.paused, true);
  assert.equal(env.intervals.size, 1); // heartbeat remains active during pause

  // 'none' without preserveMediaSession stops heartbeat and resets anchor
  silentAudioEl.paused = false;
  silentAudioEl.currentTime = 42;
  controller.updatePlaybackState('none');
  assert.equal(env.navigator.mediaSession.playbackState, 'none');
  assert.equal(silentAudioEl.paused, true);
  assert.equal(silentAudioEl.currentTime, 0);
  assert.equal(env.intervals.size, 0);

  // 'none' with preserveMediaSession preserves playbackState and does not stop heartbeat
  controller.updatePlaybackState('playing');
  silentAudioEl.paused = false;
  silentAudioEl.currentTime = 15;
  assert.equal(env.intervals.size, 1);
  controller.updatePlaybackState('none', { preserveMediaSession: true });
  assert.equal(env.navigator.mediaSession.playbackState, 'playing'); // preserved
  assert.equal(silentAudioEl.currentTime, 15); // not reset
  assert.equal(env.intervals.size, 1); // heartbeat preserved
});

test('Slice B: setNotificationKeepWhilePaused toggles behavior and handles throwing storage', () => {
  const env = createFakeEnvironment();
  const fakeStore = new Map();
  const mockStorage = {
    getItem(k) { return fakeStore.get(k) ?? null; },
    setItem(k, v) { fakeStore.set(k, String(v)); },
    removeItem(k) { fakeStore.delete(k); },
  };

  const silentAudioEl = {
    paused: true,
    currentTime: 0,
    async play() { this.paused = false; },
    pause() { this.paused = true; },
  };

  const controller = createBridgeMediaSessionController({
    getNavigator: () => env.navigator,
    getWindow: () => env.window,
    getStorage: () => mockStorage,
    isPlayRequired: () => false,
    getSilentAudioEl: () => silentAudioEl,
  });

  assert.equal(controller.getNotificationKeepWhilePaused(), false);

  controller.setNotificationKeepWhilePaused(true);
  assert.equal(controller.getNotificationKeepWhilePaused(), true);
  assert.equal(mockStorage.getItem('jamdisc_notif_keep_paused'), 'true');

  // In paused state with keepWhilePaused=true, silent audio plays
  silentAudioEl.paused = true;
  controller.updatePlaybackState('paused');
  assert.equal(silentAudioEl.paused, false);

  controller.setNotificationKeepWhilePaused(false);
  assert.equal(controller.getNotificationKeepWhilePaused(), false);
  assert.equal(mockStorage.getItem('jamdisc_notif_keep_paused'), null);

  // Survives throwing storage without unhandled exception
  const throwingStorage = {
    getItem() { throw new Error('SecurityError: denied'); },
    setItem() { throw new Error('SecurityError: denied'); },
    removeItem() { throw new Error('SecurityError: denied'); },
  };

  const safeController = createBridgeMediaSessionController({
    getStorage: () => throwingStorage,
  });
  assert.equal(safeController.getNotificationKeepWhilePaused(), false);
  assert.doesNotThrow(() => {
    safeController.setNotificationKeepWhilePaused(true);
  });
  assert.equal(safeController.getNotificationKeepWhilePaused(), true);
  assert.doesNotThrow(() => {
    safeController.setNotificationKeepWhilePaused(false);
  });
  assert.equal(safeController.getNotificationKeepWhilePaused(), false);
});

test('Slice C: updateMediaSession builds MediaMetadata with 3 artwork sizes or none and calls onActiveTrackTitleChanged', () => {
  const env = createFakeEnvironment();
  let trackTitle = null;

  class FakeMediaMetadata {
    constructor(init) {
      Object.assign(this, init);
    }
  }

  const controller = createBridgeMediaSessionController({
    getNavigator: () => env.navigator,
    getWindow: () => env.window,
    getMediaMetadataCtor: () => FakeMediaMetadata,
    onActiveTrackTitleChanged: (title) => { trackTitle = title; },
  });

  // With artwork
  controller.updateMediaSession('Song A', 'Artist A', 'Album A', 'https://example.com/art.jpg');
  assert.equal(trackTitle, 'Song A');
  assert.deepEqual(env.navigator.mediaSession.metadata, new FakeMediaMetadata({
    title: 'Song A',
    artist: 'Artist A',
    album: 'Album A',
    artwork: [
      { src: 'https://example.com/art.jpg', sizes: '96x96', type: 'image/jpeg' },
      { src: 'https://example.com/art.jpg', sizes: '192x192', type: 'image/jpeg' },
      { src: 'https://example.com/art.jpg', sizes: '512x512', type: 'image/jpeg' },
    ],
  }));

  // Without artwork
  controller.updateMediaSession('Song B', 'Artist B', 'Album B', '');
  assert.equal(trackTitle, 'Song B');
  assert.deepEqual(env.navigator.mediaSession.metadata, new FakeMediaMetadata({
    title: 'Song B',
    artist: 'Artist B',
    album: 'Album B',
    artwork: [],
  }));
});

test('Slice C: setNextTrackMeta and applyNextTrackMeta swaps metadata and clears pending state', () => {
  const env = createFakeEnvironment();
  let trackTitle = null;

  class FakeMediaMetadata {
    constructor(init) {
      Object.assign(this, init);
    }
  }

  const controller = createBridgeMediaSessionController({
    getNavigator: () => env.navigator,
    getWindow: () => env.window,
    getMediaMetadataCtor: () => FakeMediaMetadata,
    onActiveTrackTitleChanged: (title) => { trackTitle = title; },
  });

  assert.equal(controller.getNextTrackMeta(), null);

  controller.setNextTrackMeta('Next Title', 'Next Artist', 'Next Album', 'https://example.com/next.jpg');
  assert.deepEqual(controller.getNextTrackMeta(), {
    title: 'Next Title',
    artist: 'Next Artist',
    album: 'Next Album',
    artworkUrl: 'https://example.com/next.jpg',
  });

  const applied = controller.applyNextTrackMeta();
  assert.equal(applied, true);
  assert.equal(trackTitle, 'Next Title');
  assert.equal(controller.getNextTrackMeta(), null);
  assert.equal(env.navigator.mediaSession.metadata.title, 'Next Title');
  assert.equal(env.navigator.mediaSession.metadata.artwork.length, 3);

  // Calling applyNextTrackMeta with no pending metadata resets title and returns false
  const secondApplied = controller.applyNextTrackMeta();
  assert.equal(secondApplied, false);
  assert.equal(trackTitle, '');
});

test('Slice D: action handlers are registered and dispatched correctly', () => {
  const env = createFakeEnvironment();
  const mediaActions = [];
  let playAuthorized = false;
  let resumeRequested = false;
  let unlockCalled = false;
  let fallbackResumeCalled = false;
  let onPlayCalled = false;
  let onPauseCalled = false;
  let onStopCalled = false;
  let onNextCalled = false;
  let onPreviousCalled = false;
  let seekPositions = [];

  const silentAudioEl = {
    paused: true,
    async play() { this.paused = false; },
  };

  let playRequired = false;

  const controller = createBridgeMediaSessionController({
    getNavigator: () => env.navigator,
    getWindow: () => env.window,
    isPlayRequired: () => playRequired,
    authorizePlay: () => { playAuthorized = true; },
    requestMediaSessionResume: () => { resumeRequested = true; },
    unlockAudioFromGesture: () => { unlockCalled = true; },
    fallbackResume: () => { fallbackResumeCalled = true; },
    getSilentAudioEl: () => silentAudioEl,
    getAudioContextState: () => 'running',
    emitDiagnosticsEvent: env.emitDiagnosticsEvent,
    nowMs: env.nowMs,
    runMediaAction: (action, fn) => {
      mediaActions.push(action);
      fn();
    },
    getCurrentPositionAndDurationMs: () => ({ currentPositionMs: 50_000, durationMs: 120_000 }),
    getOnPlay: () => (onPlayCalled !== null ? () => { onPlayCalled = true; } : null),
    getOnPause: () => () => { onPauseCalled = true; },
    getOnStop: () => () => { onStopCalled = true; },
    getOnNext: () => () => { onNextCalled = true; },
    getOnPrevious: () => () => { onPreviousCalled = true; },
    getOnSeek: () => (pos) => { seekPositions.push(pos); },
  });

  controller.updateMediaSession('Test Track', 'Test Artist', 'Test Album', '');

  const handlers = env.navigator.mediaSession.actionHandlers;
  const expectedActions = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekto', 'seekbackward', 'seekforward'];
  for (const action of expectedActions) {
    assert.ok(handlers.has(action), `Action ${action} must be registered`);
  }

  // Play handler with onPlay callback
  handlers.get('play')();
  assert.equal(playAuthorized, true);
  assert.equal(resumeRequested, true);
  assert.equal(silentAudioEl.paused, false);
  assert.equal(onPlayCalled, true);
  assert.equal(env.diagnosticsEvents.some((e) => e.type === 'media-session-play-handler-entered'), true);

  // Pause
  handlers.get('pause')();
  assert.equal(onPauseCalled, true);

  // Stop
  handlers.get('stop')();
  assert.equal(onStopCalled, true);

  // Next and Previous
  handlers.get('nexttrack')();
  assert.equal(onNextCalled, true);
  handlers.get('previoustrack')();
  assert.equal(onPreviousCalled, true);

  // Seekto
  handlers.get('seekto')({ seekTime: 32.5 });
  assert.deepEqual(seekPositions, [32500]);

  // Seekbackward (default 10s: 50,000 - 10,000 = 40,000)
  handlers.get('seekbackward')({});
  assert.equal(seekPositions[1], 40000);

  // Seekforward (details.seekOffset 15s: 50,000 + 15,000 = 65,000)
  handlers.get('seekforward')({ seekOffset: 15 });
  assert.equal(seekPositions[2], 65000);

  // Play handler fallback branches (when onPlay is null)
  onPlayCalled = null;
  playRequired = true;
  handlers.get('play')();
  assert.equal(unlockCalled, true);

  playRequired = false;
  handlers.get('play')();
  assert.equal(fallbackResumeCalled, true);
});
