use crate::decoder::{DecodeError, StreamingDecoder};

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
    residual: Vec<f32>,
    scratch: Vec<f32>,
    total_frames_decoded: u64,
    target_sample_rate: u32,
    ended: bool,
}

impl GaplessPlayer {
    pub fn new(bytes: Vec<u8>, target_sample_rate: u32) -> Result<Self, GaplessError> {
        let active = StreamingDecoder::new(bytes, target_sample_rate)
            .map_err(|e| GaplessError::Corrupted(e.to_string()))?;
        Ok(Self {
            active,
            next: None,
            residual: Vec::new(),
            scratch: Vec::with_capacity(2048),
            total_frames_decoded: 0,
            target_sample_rate,
            ended: false,
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

        if self.ended && self.residual.is_empty() {
            return Ok(());
        }

        let target_samples = n * 2;
        if out.capacity() < target_samples {
            out.reserve(target_samples - out.len());
        }

        // Drain residual first
        if !self.residual.is_empty() {
            let take = target_samples.min(self.residual.len());
            out.extend_from_slice(&self.residual[..take]);
            self.residual.drain(..take);
        }

        while out.len() < target_samples && !self.ended {
            let remaining_frames = (target_samples - out.len()) / 2;

            self.scratch.clear();
            match self.active.decode_chunk_into(remaining_frames, &mut self.scratch) {
                Ok(true) => {
                    let need = target_samples - out.len();
                    if self.scratch.len() <= need {
                        out.extend_from_slice(&self.scratch);
                    } else {
                        out.extend_from_slice(&self.scratch[..need]);
                        self.residual.extend_from_slice(&self.scratch[need..]);
                    }
                }
                Ok(false) => {
                    if let Some(next) = self.next.take() {
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

    pub fn seek_to_ms(&mut self, ms: f64) {
        let _ = self.active.seek_to_ms(ms);
        self.residual.clear();
        self.total_frames_decoded = (ms * self.target_sample_rate as f64 / 1000.0) as u64;
        self.ended = false;
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
        assert_eq!(total_samples, expected_frames * 2);
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
        player.seek_to_ms(500.0);
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
}
