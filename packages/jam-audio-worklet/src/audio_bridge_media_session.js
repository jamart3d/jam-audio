export function createBridgeMediaSessionController({
  getNavigator = () => (typeof navigator !== 'undefined' ? navigator : undefined),
  getWindow = () => (typeof window !== 'undefined' ? window : undefined),
  getStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null),
  getPerformanceNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
  nowMs = () => Date.now(),
  getMediaMetadataCtor = () => (typeof MediaMetadata !== 'undefined' ? MediaMetadata : undefined),
  isPlayRequired = () => false,
  holdActivationOutput = () => {},
  authorizePlay = () => {},
  unlockAudioFromGesture = () => {},
  ensureSilentAudio = () => {},
  getSilentAudioEl = () => null,
  requestMediaSessionResume = () => {},
  getAudioContextState = () => 'none',
  getCurrentPositionAndDurationMs = () => ({ currentPositionMs: 0, durationMs: 0 }),
  onActiveTrackTitleChanged = () => {},
  emitDiagnosticsEvent = () => {},
  runMediaAction = (_action, fn) => fn(),
  getOnPlay = null,
  getOnPause = null,
  getOnStop = null,
  getOnNext = null,
  getOnPrevious = null,
  getOnSeek = null,
  fallbackResume = () => {},
  fallbackPause = () => {},
  fallbackStop = () => {},
  namespace = 'jam-audio',
} = {}) {
  let heartbeatIntervalId;
  let heartbeatLastKnownPositionSec = 0;
  let heartbeatLastKnownDurationSec = 0;
  let heartbeatPositionCapturedAtMs = 0;

  let notificationKeepWhilePaused = false;
  try {
    const storage = getStorage();
    if (storage && typeof storage.getItem === 'function') {
      notificationKeepWhilePaused = storage.getItem('jamdisc_notif_keep_paused') === 'true';
    }
  } catch {}

  let _nextTrackMeta = null;

  function buildArtworkArray(artworkUrl) {
    if (!artworkUrl) return [];
    return [
      { src: artworkUrl, sizes: '96x96', type: 'image/jpeg' },
      { src: artworkUrl, sizes: '192x192', type: 'image/jpeg' },
      { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' },
    ];
  }

  function startHeartbeat() {
    if (heartbeatIntervalId) return;
    const win = getWindow();
    if (!win || typeof win.setInterval !== 'function') return;

    heartbeatIntervalId = win.setInterval(() => {
      const nav = getNavigator();
      if (nav && 'mediaSession' in nav && heartbeatLastKnownDurationSec > 0) {
        try {
          const perfNow = getPerformanceNow();
          const elapsedSec = (perfNow - heartbeatPositionCapturedAtMs) / 1000;
          const position = Math.min(
            heartbeatLastKnownPositionSec + elapsedSec,
            heartbeatLastKnownDurationSec,
          );
          nav.mediaSession.setPositionState({
            duration: heartbeatLastKnownDurationSec,
            playbackRate: 1.0,
            position,
          });
        } catch {}
      }
      emitDiagnosticsEvent({
        type: 'media-session-heartbeat',
        label: 'Media session heartbeat',
        timestampMs: nowMs(),
        severity: 'info',
      });
    }, 5000);
  }

  function stopHeartbeat() {
    if (heartbeatIntervalId) {
      const win = getWindow();
      if (win && typeof win.clearInterval === 'function') {
        win.clearInterval(heartbeatIntervalId);
      }
      heartbeatIntervalId = undefined;
    }
  }

  function updatePositionState(durationSec, playbackRate, positionSec) {
    const nav = getNavigator();
    if (!nav || !('mediaSession' in nav)) return;
    try {
      const duration = Number(durationSec);
      const rate = Number(playbackRate);
      const position = Number(positionSec);
      if (!Number.isFinite(duration) || duration <= 0) return;
      if (!Number.isFinite(rate) || rate <= 0) return;
      if (!Number.isFinite(position) || position < 0) return;
      nav.mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.min(position, duration),
      });
      heartbeatLastKnownPositionSec = position;
      heartbeatLastKnownDurationSec = duration;
      heartbeatPositionCapturedAtMs = getPerformanceNow();
    } catch {}
  }

  function setNotificationKeepWhilePaused(value) {
    notificationKeepWhilePaused = Boolean(value);
    try {
      const storage = getStorage();
      if (!storage) return;
      if (value) {
        storage.setItem('jamdisc_notif_keep_paused', 'true');
      } else {
        storage.removeItem('jamdisc_notif_keep_paused');
      }
    } catch (_) {}
  }

  function getNotificationKeepWhilePaused() {
    return notificationKeepWhilePaused;
  }

  function updatePlaybackState(state, options = {}) {
    const { preserveMediaSession = false } = options;
    if (isPlayRequired()) {
      holdActivationOutput();
      if (state === 'playing') state = 'paused';
    }
    const nav = getNavigator();
    if (nav && 'mediaSession' in nav) {
      if (state === 'loading') return;
      let mapped = 'none';
      if (state === 'playing') mapped = 'playing';
      else if (state === 'paused') mapped = 'paused';

      if (mapped === 'playing' || mapped === 'paused') {
        startHeartbeat();
      } else if (!preserveMediaSession) {
        stopHeartbeat();
      }

      if (!preserveMediaSession) nav.mediaSession.playbackState = mapped;
      const silentAudioEl = getSilentAudioEl();
      if (mapped === 'playing') {
        ensureSilentAudio();
        if (silentAudioEl && silentAudioEl.paused) silentAudioEl.play().catch(() => {});
      } else if (mapped === 'paused') {
        ensureSilentAudio();
        if (notificationKeepWhilePaused) {
          if (silentAudioEl && silentAudioEl.paused) silentAudioEl.play().catch(() => {});
        } else {
          if (silentAudioEl && !silentAudioEl.paused) silentAudioEl.pause();
        }
      } else if (mapped === 'none') {
        if (!preserveMediaSession && silentAudioEl && !silentAudioEl.paused) {
          silentAudioEl.pause();
          silentAudioEl.currentTime = 0;
        }
      }
    }
  }

  function setNextTrackMeta(title, artist, album, artworkUrl) {
    _nextTrackMeta = {
      title: title || '',
      artist: artist || '',
      album: album || '',
      artworkUrl: artworkUrl || '',
    };
  }

  function getNextTrackMeta() {
    return _nextTrackMeta;
  }

  function applyNextTrackMeta() {
    if (_nextTrackMeta !== null) {
      onActiveTrackTitleChanged(_nextTrackMeta.title || '');
      const nav = getNavigator();
      const MediaMetadataCtor = getMediaMetadataCtor();
      if (nav && 'mediaSession' in nav && typeof MediaMetadataCtor === 'function') {
        nav.mediaSession.metadata = new MediaMetadataCtor({
          title: _nextTrackMeta.title,
          artist: _nextTrackMeta.artist,
          album: _nextTrackMeta.album,
          artwork: buildArtworkArray(_nextTrackMeta.artworkUrl),
        });
      }
      _nextTrackMeta = null;
      return true;
    }
    onActiveTrackTitleChanged('');
    return false;
  }

  function registerActionHandlers() {
    const nav = getNavigator();
    if (!nav || !('mediaSession' in nav) || typeof nav.mediaSession.setActionHandler !== 'function') return;

    nav.mediaSession.setActionHandler('play', () => {
      emitDiagnosticsEvent({
        type: 'media-session-play-handler-entered',
        label: 'Media Session play action handler entered',
        timestampMs: nowMs(),
        severity: 'info',
        audioContextState: getAudioContextState(),
      });
      runMediaAction('play', () => {
        const blockedStart = isPlayRequired();
        authorizePlay();
        requestMediaSessionResume();
        const silentAudioEl = getSilentAudioEl();
        if (silentAudioEl && typeof silentAudioEl.play === 'function') {
          silentAudioEl.play().catch(() => {});
        }
        const onPlay = typeof getOnPlay === 'function' ? getOnPlay() : null;
        if (typeof onPlay === 'function') onPlay();
        else {
          console.warn(`[${namespace}] onPlayCallback not registered, falling back to low-level resume()`);
          if (blockedStart) unlockAudioFromGesture();
          else fallbackResume();
        }
      });
    });

    nav.mediaSession.setActionHandler('pause', () => {
      runMediaAction('pause', () => {
        const onPause = typeof getOnPause === 'function' ? getOnPause() : null;
        if (typeof onPause === 'function') onPause();
        else {
          console.warn(`[${namespace}] onPauseCallback not registered, falling back to low-level pause()`);
          fallbackPause();
        }
      });
    });

    nav.mediaSession.setActionHandler('stop', () => {
      runMediaAction('stop', () => {
        const onStop = typeof getOnStop === 'function' ? getOnStop() : null;
        if (typeof onStop === 'function') onStop();
        else fallbackStop();
      });
    });

    nav.mediaSession.setActionHandler('nexttrack', () => {
      runMediaAction('nexttrack', () => {
        const onNext = typeof getOnNext === 'function' ? getOnNext() : null;
        if (typeof onNext === 'function') onNext();
      });
    });

    nav.mediaSession.setActionHandler('previoustrack', () => {
      runMediaAction('previoustrack', () => {
        const onPrevious = typeof getOnPrevious === 'function' ? getOnPrevious() : null;
        if (typeof onPrevious === 'function') onPrevious();
      });
    });

    nav.mediaSession.setActionHandler('seekto', (details) => {
      runMediaAction('seekto', () => {
        const onSeek = typeof getOnSeek === 'function' ? getOnSeek() : null;
        if (typeof onSeek === 'function' && details?.seekTime != null) {
          onSeek(Math.round(details.seekTime * 1000));
        }
      });
    });

    nav.mediaSession.setActionHandler('seekbackward', (details) => {
      runMediaAction('seekbackward', () => {
        const onSeek = typeof getOnSeek === 'function' ? getOnSeek() : null;
        if (typeof onSeek !== 'function') return;
        const { currentPositionMs = 0, durationMs = 0 } = getCurrentPositionAndDurationMs();
        const offsetMs = (details?.seekOffset || 10) * 1000;
        const nextPositionMs = Math.round(currentPositionMs - offsetMs);
        onSeek(Math.min(Math.max(nextPositionMs, 0), durationMs || Infinity));
      });
    });

    nav.mediaSession.setActionHandler('seekforward', (details) => {
      runMediaAction('seekforward', () => {
        const onSeek = typeof getOnSeek === 'function' ? getOnSeek() : null;
        if (typeof onSeek !== 'function') return;
        const { currentPositionMs = 0, durationMs = 0 } = getCurrentPositionAndDurationMs();
        const offsetMs = (details?.seekOffset || 10) * 1000;
        const nextPositionMs = Math.round(currentPositionMs + offsetMs);
        onSeek(Math.min(Math.max(nextPositionMs, 0), durationMs || Infinity));
      });
    });
  }

  function updateMediaSession(title, artist, album, artworkUrl) {
    onActiveTrackTitleChanged(title || '');
    const nav = getNavigator();
    if (!nav || !('mediaSession' in nav)) return;
    const MediaMetadataCtor = getMediaMetadataCtor();
    if (typeof MediaMetadataCtor === 'function') {
      nav.mediaSession.metadata = new MediaMetadataCtor({
        title,
        artist,
        album,
        artwork: buildArtworkArray(artworkUrl),
      });
    }
    registerActionHandlers();
  }

  return {
    startHeartbeat,
    stopHeartbeat,
    updatePositionState,
    updatePlaybackState,
    setNotificationKeepWhilePaused,
    getNotificationKeepWhilePaused,
    setNextTrackMeta,
    getNextTrackMeta,
    applyNextTrackMeta,
    registerActionHandlers,
    updateMediaSession,
  };
}
