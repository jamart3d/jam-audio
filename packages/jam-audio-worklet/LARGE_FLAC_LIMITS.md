# Large FLAC Size Limits

## Summary

No package-defined FLAC file-size limit was found. Large-file behavior depends on which playback
entry point is used:

- `playTrack(audioBytes)` requires the complete compressed file to be transferred into the worker
  and retained before playback. For large FLAC files, the practical limit is browser/Wasm memory and
  message-transfer cost.
- `playTrackBounded(url, totalSize)` streams through a sliding byte window and is the preferred path
  for large FLAC files.

## Relevant Constraints

- Full-byte playback sends `audioBytes` to the worker and constructs a gapless player from those
  bytes.
- Bounded playback creates a `WindowedStreamingPlayer` with `maxWindowMb = 64`.
- The bounded fetch controller pauses network fetch above `READ_AHEAD_BYTES = 8 * 1024 * 1024` and
  resumes below `RESUME_THRESHOLD_BYTES = 2 * 1024 * 1024`.
- The PCM ring buffer defaults to `524_288` frames. This is rolling playback headroom, not a total
  file-size or duration cap.
- The engine streaming probe threshold is `256 * 1024` bytes. This controls when probing begins, not
  maximum playable file size.

## Recommendation

Use `playTrackBounded(url, totalSize)` for large FLAC files whenever the source can be addressed by
URL. Reserve `playTrack(audioBytes)` for small or already-local files where loading the entire
compressed asset into memory is acceptable.
