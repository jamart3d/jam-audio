pub const DEFAULT_FRAME_CAPACITY: usize = 524_288;
// protocol:begin
pub const SHARED_STATE_SLOTS: usize = 12;
// protocol:end

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RingBufferLayout {
    frame_capacity: usize,
    channels: usize,
}

pub const MIN_FRAME_CAPACITY: usize = 1;
pub const MAX_FRAME_CAPACITY: usize = 100_000_000;
pub const MIN_CHANNELS: usize = 1;
pub const MAX_CHANNELS: usize = 8;

impl RingBufferLayout {
    pub fn new(frame_capacity: usize, channels: usize) -> Result<Self, RingBufferError> {
        if !(MIN_FRAME_CAPACITY..=MAX_FRAME_CAPACITY).contains(&frame_capacity) {
            return Err(RingBufferError::InvalidLayout {
                reason: "frame_capacity out of bounds (must be 1..=100000000)",
            });
        }
        if !(MIN_CHANNELS..=MAX_CHANNELS).contains(&channels) {
            return Err(RingBufferError::InvalidLayout {
                reason: "channels out of bounds (must be 1..=8)",
            });
        }
        let sample_cap =
            frame_capacity
                .checked_mul(channels)
                .ok_or(RingBufferError::InvalidLayout {
                    reason: "frame_capacity * channels overflowed",
                })?;
        let sample_bytes = sample_cap.checked_mul(std::mem::size_of::<f32>()).ok_or(
            RingBufferError::InvalidLayout {
                reason: "sample byte count overflowed",
            },
        )?;
        let state_bytes = SHARED_STATE_SLOTS
            .checked_mul(std::mem::size_of::<u32>())
            .ok_or(RingBufferError::InvalidLayout {
                reason: "state byte count overflowed",
            })?;
        state_bytes
            .checked_add(sample_bytes)
            .ok_or(RingBufferError::InvalidLayout {
                reason: "total shared buffer byte count overflowed",
            })?;

        Ok(Self {
            frame_capacity,
            channels,
        })
    }

    pub fn frame_capacity(self) -> usize {
        self.frame_capacity
    }

    pub fn channels(self) -> usize {
        self.channels
    }

    pub fn sample_capacity(self) -> usize {
        self.frame_capacity
            .checked_mul(self.channels)
            .expect("sample_capacity checked at construction")
    }

    pub fn state_bytes(self) -> usize {
        SHARED_STATE_SLOTS
            .checked_mul(std::mem::size_of::<u32>())
            .expect("state_bytes checked at construction")
    }

    pub fn sample_bytes(self) -> usize {
        self.sample_capacity()
            .checked_mul(std::mem::size_of::<f32>())
            .expect("sample_bytes checked at construction")
    }

    pub fn shared_buffer_bytes(self) -> usize {
        self.state_bytes()
            .checked_add(self.sample_bytes())
            .expect("shared_buffer_bytes checked at construction")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum RingBufferError {
    InvalidLayout { reason: &'static str },
    ChannelMismatch { expected: usize, actual: usize },
}

impl std::fmt::Display for RingBufferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidLayout { reason } => write!(f, "invalid ring buffer layout: {reason}"),
            Self::ChannelMismatch { expected, actual } => {
                write!(f, "channel mismatch: expected {expected}, got {actual}")
            }
        }
    }
}

impl std::error::Error for RingBufferError {}

#[derive(Debug, Clone)]
pub struct PcmRingBuffer {
    layout: RingBufferLayout,
    samples: Vec<f32>,
    read_frame: usize,
    write_frame: usize,
    len_frames: usize,
}

impl PcmRingBuffer {
    pub fn new(frame_capacity: usize, channels: usize) -> Result<Self, RingBufferError> {
        let layout = RingBufferLayout::new(frame_capacity, channels)?;
        // Stage 1 keeps the SharedArrayBuffer contract as a plain interleaved
        // f32 frame ring; JS can layer atomic read/write indices onto the same
        // byte layout in Stage 2 without changing the PCM packing rules.
        let samples = vec![0.0; layout.sample_capacity()];

        Ok(Self {
            layout,
            samples,
            read_frame: 0,
            write_frame: 0,
            len_frames: 0,
        })
    }

    pub fn layout(&self) -> RingBufferLayout {
        self.layout
    }

    pub fn available_frames(&self) -> usize {
        self.len_frames
    }

    pub fn free_frames(&self) -> usize {
        self.layout.frame_capacity() - self.len_frames
    }

    pub fn clear(&mut self) {
        self.read_frame = 0;
        self.write_frame = 0;
        self.len_frames = 0;
        self.samples.fill(0.0);
    }

    pub fn push_interleaved(
        &mut self,
        interleaved_samples: &[f32],
    ) -> Result<usize, RingBufferError> {
        let channels = self.layout.channels();
        if !interleaved_samples.len().is_multiple_of(channels) {
            return Err(RingBufferError::ChannelMismatch {
                expected: channels,
                actual: interleaved_samples.len(),
            });
        }
        let cap = self.layout.frame_capacity();
        let requested_frames = interleaved_samples.len() / channels;
        let writable_frames = requested_frames.min(self.free_frames());
        if writable_frames == 0 {
            return Ok(0);
        }

        let writable_samples = writable_frames * channels;
        let write_sample = self.write_frame * channels;
        let cap_samples = cap * channels;
        let first = (cap_samples - write_sample).min(writable_samples);

        self.samples[write_sample..write_sample + first]
            .copy_from_slice(&interleaved_samples[..first]);
        if first < writable_samples {
            let rest = writable_samples - first;
            self.samples[..rest].copy_from_slice(&interleaved_samples[first..writable_samples]);
        }

        self.write_frame = (self.write_frame + writable_frames) % cap;
        self.len_frames += writable_frames;
        Ok(writable_frames)
    }

    pub fn pop_interleaved(&mut self, frames: usize) -> Vec<f32> {
        let channels = self.layout.channels();
        let cap = self.layout.frame_capacity();
        let readable_frames = frames.min(self.available_frames());
        let readable_samples = readable_frames * channels;
        let mut out = Vec::with_capacity(readable_samples);

        let read_sample = self.read_frame * channels;
        let cap_samples = cap * channels;
        let first = (cap_samples - read_sample).min(readable_samples);
        out.extend_from_slice(&self.samples[read_sample..read_sample + first]);
        if first < readable_samples {
            let rest = readable_samples - first;
            out.extend_from_slice(&self.samples[..rest]);
        }

        self.read_frame = (self.read_frame + readable_frames) % cap;
        self.len_frames -= readable_frames;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_FRAME_CAPACITY, PcmRingBuffer, RingBufferError, RingBufferLayout};

    #[test]
    fn layout_exposes_shared_memory_sizing() {
        let layout = RingBufferLayout::new(DEFAULT_FRAME_CAPACITY, 2).unwrap();

        assert_eq!(layout.sample_capacity(), DEFAULT_FRAME_CAPACITY * 2);
        assert_eq!(layout.state_bytes(), 48);
        assert_eq!(layout.sample_bytes(), DEFAULT_FRAME_CAPACITY * 2 * 4);
        assert_eq!(
            layout.shared_buffer_bytes(),
            48 + (DEFAULT_FRAME_CAPACITY * 2 * 4)
        );
    }

    #[test]
    fn ring_buffer_pushes_and_pops_in_frame_order() {
        let mut buffer = PcmRingBuffer::new(4, 2).unwrap();

        let written = buffer
            .push_interleaved(&[0.1, 1.1, 0.2, 1.2, 0.3, 1.3])
            .expect("aligned stereo samples should write");
        let popped = buffer.pop_interleaved(2);

        assert_eq!(written, 3);
        assert_eq!(popped, vec![0.1, 1.1, 0.2, 1.2]);
        assert_eq!(buffer.available_frames(), 1);
        assert_eq!(buffer.free_frames(), 3);
    }

    #[test]
    fn ring_buffer_wraps_and_reuses_capacity() {
        let mut buffer = PcmRingBuffer::new(3, 2).unwrap();

        buffer
            .push_interleaved(&[0.0, 10.0, 1.0, 11.0, 2.0, 12.0])
            .expect("initial frames should fit");
        assert_eq!(buffer.pop_interleaved(2), vec![0.0, 10.0, 1.0, 11.0]);

        let written = buffer
            .push_interleaved(&[3.0, 13.0, 4.0, 14.0])
            .expect("wrapped frames should fit");

        assert_eq!(written, 2);
        assert_eq!(
            buffer.pop_interleaved(3),
            vec![2.0, 12.0, 3.0, 13.0, 4.0, 14.0]
        );
        assert_eq!(buffer.available_frames(), 0);
    }

    #[test]
    fn ring_buffer_rejects_samples_not_aligned_to_channel_count() {
        let mut buffer = PcmRingBuffer::new(4, 2).unwrap();

        let error = buffer
            .push_interleaved(&[0.0, 1.0, 2.0])
            .expect_err("unaligned sample data should fail");

        assert_eq!(
            error,
            RingBufferError::ChannelMismatch {
                expected: 2,
                actual: 3,
            }
        );
    }

    #[test]
    fn ring_buffer_layout_boundary_tests() {
        // Below min capacity (0)
        assert!(RingBufferLayout::new(0, 2).is_err());
        // At min capacity (1)
        assert!(RingBufferLayout::new(1, 2).is_ok());
        // At max capacity (100_000_000)
        assert!(RingBufferLayout::new(100_000_000, 2).is_ok());
        // Above max capacity (100_000_001)
        assert!(RingBufferLayout::new(100_000_001, 2).is_err());

        // Below min channels (0)
        assert!(RingBufferLayout::new(1024, 0).is_err());
        // At min channels (1)
        assert!(RingBufferLayout::new(1024, 1).is_ok());
        // At max channels (8)
        assert!(RingBufferLayout::new(1024, 8).is_ok());
        // Above max channels (9)
        assert!(RingBufferLayout::new(1024, 9).is_err());

        // Arithmetic overflow
        assert!(RingBufferLayout::new(usize::MAX, 2).is_err());
    }

    #[test]
    fn ring_buffer_wraps_with_block_copy_parity() {
        let mut buffer = PcmRingBuffer::new(8, 2).unwrap();
        // Fill, drain half, wrap-fill.
        let in1: Vec<f32> = (0..16).map(|i| i as f32).collect();
        assert_eq!(buffer.push_interleaved(&in1).unwrap(), 8);
        let out1 = buffer.pop_interleaved(4);
        assert_eq!(out1, (0..8).map(|i| i as f32).collect::<Vec<_>>());

        let in2: Vec<f32> = (100..108).map(|i| i as f32).collect();
        assert_eq!(buffer.push_interleaved(&in2).unwrap(), 4);

        let out2 = buffer.pop_interleaved(8);
        let expected: Vec<f32> = (8..16)
            .map(|i| i as f32)
            .chain((100..108).map(|i| i as f32))
            .collect();
        assert_eq!(out2, expected);
    }
}
