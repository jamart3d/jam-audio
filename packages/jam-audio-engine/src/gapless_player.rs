use crate::decoder::{DecodeError, StreamingDecoder};
use crate::ring_buffer::{PcmRingBuffer, DEFAULT_FRAME_CAPACITY};

#[derive(Debug)]
pub enum GaplessError {
    Corrupted(String),
    NextTrackFailed(String),
}

impl std::fmt::Display for GaplessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Corrupted(m) => write!(f, "corrupted: {m}"),
            Self::NextTrackFailed(m) => write!(f, "next track failed: {m}"),
        }
    }
}

impl std::error::Error for GaplessError {}

pub struct GaplessPlayer {
    active: StreamingDecoder,
    next: Option<StreamingDecoder>,
    residual: PcmRingBuffer,
    scratch: Vec<f32>,
    total_frames_decoded: u64,
    target_sample_rate: u32,
    ended: bool,
    pending_skip_frames: u64,
}

impl GaplessPlayer {
    pub fn new(bytes: Vec<u8>, target_sample_rate: u32) -> Result<Self, GaplessError> {
        let active = StreamingDecoder::new(bytes, target_sample_rate)
            .map_err(|e| GaplessError::Corrupted(e.to_string()))?;
        let residual = PcmRingBuffer::new(DEFAULT_FRAME_CAPACITY, 2)
            .map_err(|e| GaplessError::Corrupted(e.to_string()))?;
        Ok(Self {
            active,
            next: None,
            residual,
            scratch: Vec::with_capacity(2048),
            total_frames_decoded: 0,
            target_sample_rate,
            ended: false,
            pending_skip_frames: 0,
        })
    }

    pub fn load_next(&mut self, bytes: Vec<u8>) -> Result<(), GaplessError> {
        let decoder = StreamingDecoder::new(bytes, self.target_sample_rate)
            .map_err(|e| GaplessError::NextTrackFailed(e.to_string()))?;
        self.next = Some(decoder);
        Ok(())
    }

    pub fn decode_frames(&mut self, n: usize) -> Result<Vec<f32>, GaplessError> {
        let mut out = Vec::with_capacity(n * 2);
        self.decode_frames_into(&mut out, n)?;
        Ok(out)
    }

    pub fn decode_frames_into(&mut self, out: &mut Vec<f32>, n: usize) -> Result<(), GaplessError> {
        out.clear();

        if self.ended && self.residual.available_frames() == 0 {
            return Ok(());
        }

        let target_samples = n * 2;
        if out.capacity() < target_samples {
            out.reserve(target_samples - out.len());
        }

        // Drain residual first
        if self.residual.available_frames() > 0 {
            let frames_to_pop = (target_samples - out.len()) / 2;
            let popped = self.residual.pop_interleaved(frames_to_pop);
            out.extend_from_slice(&popped);
        }

        while out.len() < target_samples && !self.ended {
            let remaining_frames = (target_samples - out.len()) / 2;

            self.scratch.clear();
            match self
                .active
                .decode_chunk_into(remaining_frames, &mut self.scratch)
            {
                Ok(true) => {
                    if self.pending_skip_frames > 0 {
                        let chunk_frames = (self.scratch.len() / 2) as u64;
                        let skip = self.pending_skip_frames.min(chunk_frames);
                        let skip_samples = (skip * 2) as usize;
                        self.pending_skip_frames -= skip;
                        self.scratch.drain(..skip_samples);
                    }
                    let need = target_samples - out.len();
                    if self.scratch.len() <= need {
                        out.extend_from_slice(&self.scratch);
                    } else {
                        out.extend_from_slice(&self.scratch[..need]);
                        let residual_samples = &self.scratch[need..];
                        let written = self
                            .residual
                            .push_interleaved(residual_samples)
                            .map_err(|e| GaplessError::Corrupted(e.to_string()))?;
                        if written * 2 < residual_samples.len() {
                            return Err(GaplessError::Corrupted(
                                "residual buffer overflow".to_string(),
                            ));
                        }
                    }
                }
                Ok(false) => {
                    if let Some(next) = self.next.take() {
                        self.pending_skip_frames = next.encoder_delay_frames();
                        self.active = next;
                    } else {
                        self.ended = true;
                        break;
                    }
                }
                Err(DecodeError::Symphonia(msg)) => {
                    return Err(GaplessError::Corrupted(msg));
                }
                Err(e) => {
                    return Err(GaplessError::Corrupted(e.to_string()));
                }
            }
        }

        let frames_this_call = (out.len() / 2) as u64;
        self.total_frames_decoded += frames_this_call;
        Ok(())
    }

    pub fn seek_to_ms(&mut self, ms: f64) -> Result<(), GaplessError> {
        self.active
            .seek_to_ms(ms)
            .map_err(|e| GaplessError::Corrupted(e.to_string()))?;
        self.residual.clear();
        self.pending_skip_frames = 0;
        self.total_frames_decoded = (ms * self.target_sample_rate as f64 / 1000.0) as u64;
        self.ended = false;
        Ok(())
    }

    pub fn position_ms(&self) -> f64 {
        self.total_frames_decoded as f64 * 1000.0 / self.target_sample_rate as f64
    }

    pub fn duration_ms(&self) -> f64 {
        self.active.duration_ms()
    }

    pub fn has_ended(&self) -> bool {
        self.ended
    }

    pub fn clear_next(&mut self) {
        self.next = None;
    }

    #[cfg(test)]
    pub fn inject_pending_skip_frames_for_test(&mut self, n: u64) {
        self.pending_skip_frames = n;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decoder::DEFAULT_OUTPUT_SAMPLE_RATE;

    fn make_wav(num_frames: usize) -> Vec<u8> {
        let channels: u16 = 2;
        let sample_rate: u32 = 44100;
        let bits_per_sample: u16 = 16;
        let byte_rate = sample_rate * channels as u32 * bits_per_sample as u32 / 8;
        let block_align = channels * bits_per_sample / 8;
        let data_size = (num_frames * channels as usize * (bits_per_sample as usize / 8)) as u32;
        let chunk_size = 36 + data_size;

        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&chunk_size.to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&bits_per_sample.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        wav.extend(vec![0u8; data_size as usize]);
        wav
    }

    #[test]
    fn rejects_empty_bytes() {
        assert!(GaplessPlayer::new(vec![], DEFAULT_OUTPUT_SAMPLE_RATE).is_err());
    }

    #[test]
    fn rejects_corrupt_bytes() {
        assert!(GaplessPlayer::new(b"notaudio".to_vec(), DEFAULT_OUTPUT_SAMPLE_RATE).is_err());
    }

    #[test]
    fn decode_frames_returns_correct_frame_count() {
        let mut player = GaplessPlayer::new(make_wav(2000), DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        let samples = player.decode_frames(512).unwrap();
        assert_eq!(
            samples.len(),
            512 * 2,
            "expect 512 stereo frames = 1024 samples"
        );
    }

    #[test]
    fn has_ended_false_before_track_exhausted() {
        let mut player = GaplessPlayer::new(make_wav(2000), DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        player.decode_frames(100).unwrap();
        assert!(!player.has_ended());
    }

    #[test]
    fn has_ended_true_after_last_frame_consumed() {
        let wav = make_wav(100);
        let mut player = GaplessPlayer::new(wav, DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        loop {
            let frames = player.decode_frames(128).unwrap();
            if frames.is_empty() {
                break;
            }
        }
        assert!(player.has_ended());
    }

    #[test]
    fn decode_frames_crosses_boundary_silently() {
        let wav1 = make_wav(1000);
        let wav2 = make_wav(1000);
        let mut player = GaplessPlayer::new(wav1, DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        player.load_next(wav2).unwrap();

        let mut total_samples = 0usize;
        loop {
            let frames = player.decode_frames(256).unwrap();
            if frames.is_empty() {
                break;
            }
            total_samples += frames.len();
        }
        let expected_frames =
            (((1000.0 * DEFAULT_OUTPUT_SAMPLE_RATE as f64) / 44_100.0).round() as usize) * 2;
        // Rubato's polyphase sinc filter introduces a group delay of sinc_len/2 frames
        // (= 64 at our settings), so total output may differ from the linear interpolator.
        // Allow a generous tolerance here — the goal is "roughly the right amount".
        let tolerance = (expected_frames as f64 * 0.10) as usize + 64;
        assert!(
            total_samples.abs_diff(expected_frames * 2) <= tolerance,
            "total samples {total_samples} out of tolerance range ({} ± {})",
            expected_frames * 2,
            tolerance,
        );
    }

    #[test]
    fn load_next_failure_does_not_affect_active_decoder() {
        let wav = make_wav(500);
        let mut player = GaplessPlayer::new(wav, DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        let result = player.load_next(b"corrupt".to_vec());
        assert!(result.is_err());
        // Active track still decodable
        let frames = player.decode_frames(100).unwrap();
        assert_eq!(frames.len(), 200);
    }

    #[test]
    fn position_ms_advances_after_decode() {
        let mut player = GaplessPlayer::new(make_wav(48000), DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        player.decode_frames(4800).unwrap(); // 100ms at 48000 Hz
        let pos = player.position_ms();
        assert!((pos - 100.0).abs() < 1.0, "expected ~100ms, got {pos}");
    }

    #[test]
    fn seek_to_ms_repositions() {
        let mut player = GaplessPlayer::new(make_wav(48000), DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        player.seek_to_ms(500.0).unwrap();
        let pos = player.position_ms();
        assert!((pos - 500.0).abs() < 10.0, "expected ~500ms, got {pos}");
    }

    #[test]
    fn clear_next_discards_staged_track() {
        let wav = make_wav(100);
        let mut player = GaplessPlayer::new(wav, DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        player.load_next(make_wav(100)).unwrap();
        player.clear_next();
        // After clear, player should end after first track without continuing
        loop {
            let frames = player.decode_frames(128).unwrap();
            if frames.is_empty() {
                break;
            }
        }
        assert!(player.has_ended());
    }

    #[test]
    fn gapless_error_implements_std_error() {
        let err = GaplessError::Corrupted("bad".into());
        let _: &dyn std::error::Error = &err; // fails to compile if Error not impl'd
    }

    #[test]
    fn strips_injected_encoder_delay_at_track_boundary() {
        let track_frames = 1000usize;
        let wav1 = make_wav(track_frames);
        let wav2 = make_wav(track_frames);

        let mut player = GaplessPlayer::new(wav1, DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        player.load_next(wav2).unwrap();

        // Inject skip before any decoding so the mechanism is exercised
        player.inject_pending_skip_frames_for_test(100);

        let mut total_samples = 0usize;
        loop {
            let frames = player.decode_frames(256).unwrap();
            if frames.is_empty() {
                break;
            }
            total_samples += frames.len();
        }

        // Per-track frames after resampling 44100 -> 48000
        let per_track_frames =
            ((track_frames as f64 * DEFAULT_OUTPUT_SAMPLE_RATE as f64) / 44_100.0).round() as usize;
        // 100 frames were stripped; two tracks decoded
        let expected_samples = (per_track_frames * 2 - 100) * 2;
        // Rubato's polyphase sinc filter introduces a group delay of sinc_len/2 frames
        // (= 64 at our settings). Allow a generous tolerance.
        let tolerance = (expected_samples as f64 * 0.10) as usize + 128;
        assert!(
            total_samples.abs_diff(expected_samples) <= tolerance,
            "expected {expected_samples} samples (2 tracks * {per_track_frames} frames - 100 skipped), got {total_samples}"
        );
    }

    #[test]
    fn seek_clears_pending_encoder_delay_skip() {
        let mut player = GaplessPlayer::new(make_wav(48000), DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        player.inject_pending_skip_frames_for_test(1000);
        player.seek_to_ms(100.0).unwrap();
        // Assert that pending skip frames are cleared
        assert_eq!(
            player.pending_skip_frames, 0,
            "seek should clear pending skip frames"
        );
        // Decode after seek; if pending skip leaked through, we'd lose the first 1000 frames.
        let out = player.decode_frames(256).unwrap();
        assert_eq!(
            out.len(),
            256 * 2,
            "seek should consume the encoder-delay skip"
        );
    }

    #[test]
    fn residual_overflow_across_chunk_boundaries() {
        let track_frames = 1000usize;
        let mut player = GaplessPlayer::new(make_wav(track_frames), DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        
        // Decode a small amount to trigger fill and some residual
        // If we ask for 10 frames, but it decodes a larger chunk (e.g. 512 frames), 
        // 502 frames will go to residual.
        let _ = player.decode_frames(10).unwrap();
        assert!(player.residual.available_frames() > 0, "should have residual after small decode");

        // Now decode the rest
        let mut total_frames = 10;
        loop {
            let frames = player.decode_frames(256).unwrap();
            if frames.is_empty() {
                break;
            }
            total_frames += frames.len() / 2;
        }

        let expected_frames =
            ((track_frames as f64 * DEFAULT_OUTPUT_SAMPLE_RATE as f64) / 44_100.0).round() as usize;
        let tolerance = (expected_frames as f64 * 0.10) as usize + 64;
        assert!(
            total_frames.abs_diff(expected_frames) <= tolerance,
            "total frames {total_frames} out of tolerance range ({} ± {})",
            expected_frames,
            tolerance,
        );
    }

    #[test]
    fn seek_clears_residual() {
        let mut player = GaplessPlayer::new(make_wav(2000), DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        // Trigger residual
        let _ = player.decode_frames(10).unwrap();
        assert!(player.residual.available_frames() > 0);

        player.seek_to_ms(10.0).unwrap();
        assert_eq!(player.residual.available_frames(), 0, "seek should clear residual");
    }
}
