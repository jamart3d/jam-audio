/**
 * Pure latency-policy module for the audio playback worker.
 *
 * Takes actual output sample rate, a requested profile, frame capacity, and
 * channel count; returns validated derived frame counts and profile metadata.
 * No mutable playback state lives here.
 *
 * Profiles:
 *   'interactive' – smallest supported startup/steady buffers.
 *   'balanced'    – moderate startup and steady headroom.
 *   'resilient'   – current music/PWA reliability intent (default), converted
 *                   from raw frames to stable durations.
 *
 * The default profile is 'resilient'. Adding profiles must not silently lower
 * existing headroom for the resilient profile.
 */

/** Minimum supported sample rate (Hz). */
export const MIN_SAMPLE_RATE = 8000;
/** Maximum supported sample rate (Hz). */
export const MAX_SAMPLE_RATE = 192000;
/** Minimum frame capacity required by any profile. */
export const MIN_FRAME_CAPACITY = 4096;

/**
 * Profile definitions expressed as stable durations (seconds).
 * All durations are converted to frames using the actual sample rate at
 * compute time so that threshold semantics are sample-rate-stable.
 */
const PROFILE_DURATIONS = {
  interactive: {
    startupSec: 0.5,
    steadySec: 2.0,
    criticalSec: 0.25,
    refillChunkFrames: 1024,
    refillChunkFramesRecovery: 4096,
  },
  balanced: {
    startupSec: 1.0,
    steadySec: 4.0,
    criticalSec: 0.5,
    refillChunkFrames: 1024,
    refillChunkFramesRecovery: 4096,
  },
  resilient: {
    // Matches existing raw-frame constants converted to durations at 44.1 kHz
    // (the original authoring rate): startup 2.0s, steady 6.0s, critical 1.0s.
    startupSec: 2.0,
    steadySec: 6.0,
    criticalSec: 1.0,
    refillChunkFrames: 1024,
    refillChunkFramesRecovery: 4096,
  },
};

/**
 * Compute buffer policy for a given sample rate, profile, and frame capacity.
 *
 * @param {object} opts
 * @param {number} opts.sampleRate   Actual AudioContext sample rate (Hz).
 * @param {string} [opts.profile]    One of 'interactive'|'balanced'|'resilient'.
 * @param {number} opts.frameCapacity  Ring-buffer frame capacity.
 * @param {number} [opts.channels]   Channel count (informational only; default 2).
 * @returns {{
 *   profile: string,
 *   sampleRate: number,
 *   frameCapacity: number,
 *   channels: number,
 *   playbackStartFrames: number,
 *   steadyStateTargetFrames: number,
 *   criticalThresholdFrames: number,
 *   refillChunkFrames: number,
 *   refillChunkFramesRecovery: number,
 *   startupDurationSec: number,
 *   steadyDurationSec: number,
 *   criticalDurationSec: number,
 * }}
 * @throws {Error} if the profile/capacity combination is impossible or inputs are invalid.
 */
export function computeBufferPolicy({ sampleRate, profile = 'resilient', frameCapacity, channels = 2 }) {
  if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new Error(`Invalid sample rate: ${sampleRate}. Must be ${MIN_SAMPLE_RATE}–${MAX_SAMPLE_RATE} Hz.`);
  }
  if (!Number.isFinite(frameCapacity) || frameCapacity < MIN_FRAME_CAPACITY) {
    throw new Error(`Frame capacity ${frameCapacity} is below the minimum ${MIN_FRAME_CAPACITY}.`);
  }
  const durations = PROFILE_DURATIONS[profile];
  if (!durations) {
    throw new Error(`Unknown latency profile: "${profile}". Valid profiles: ${Object.keys(PROFILE_DURATIONS).join(', ')}.`);
  }

  const playbackStartFrames = Math.ceil(durations.startupSec * sampleRate);
  const steadyStateTargetFrames = Math.ceil(durations.steadySec * sampleRate);
  const criticalThresholdFrames = Math.ceil(durations.criticalSec * sampleRate);

  if (playbackStartFrames > frameCapacity) {
    throw new Error(
      `Profile "${profile}" startup buffer (${playbackStartFrames} frames, ${durations.startupSec}s at ${sampleRate}Hz) ` +
      `exceeds frame capacity (${frameCapacity}). Increase capacity or choose a lower-latency profile.`
    );
  }
  if (steadyStateTargetFrames > frameCapacity) {
    throw new Error(
      `Profile "${profile}" steady buffer (${steadyStateTargetFrames} frames, ${durations.steadySec}s at ${sampleRate}Hz) ` +
      `exceeds frame capacity (${frameCapacity}). Increase capacity or choose a lower-latency profile.`
    );
  }

  return {
    profile,
    sampleRate,
    frameCapacity,
    channels,
    playbackStartFrames,
    steadyStateTargetFrames,
    criticalThresholdFrames,
    refillChunkFrames: durations.refillChunkFrames,
    refillChunkFramesRecovery: durations.refillChunkFramesRecovery,
    startupDurationSec: playbackStartFrames / sampleRate,
    steadyDurationSec: steadyStateTargetFrames / sampleRate,
    criticalDurationSec: criticalThresholdFrames / sampleRate,
  };
}

/**
 * Returns the names of all valid latency profiles.
 * @returns {string[]}
 */
export function validProfiles() {
  return Object.keys(PROFILE_DURATIONS);
}
