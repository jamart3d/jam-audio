pub const DEFAULT_FRAME_CAPACITY: usize = 524_288;
pub const SHARED_STATE_SLOTS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RingBufferLayout {
    frame_capacity: usize,
    channels: usize,
}

impl RingBufferLayout {
    pub fn new(frame_capacity: usize, channels: usize) -> Result<Self, RingBufferError> {
        if frame_capacity == 0 {
            return Err(RingBufferError::InvalidLayout {
                reason: "frame_capacity must be positive",
            });
        }
        if channels == 0 {
            return Err(RingBufferError::InvalidLayout {
                reason: "channels must be positive",
            });
        }

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
        self.frame_capacity * self.channels
    }

    pub fn state_bytes(self) -> usize {
        SHARED_STATE_SLOTS * std::mem::size_of::<u32>()
    }

    pub fn sample_bytes(self) -> usize {
        self.sample_capacity() * std::mem::size_of::<f32>()
    }

    pub fn shared_buffer_bytes(self) -> usize {
        self.state_bytes() + self.sample_bytes()
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
        #[allow(clippy::manual_is_multiple_of)]
        if interleaved_samples.len() % self.layout.channels() != 0 {
            return Err(RingBufferError::ChannelMismatch {
                expected: self.layout.channels(),
                actual: interleaved_samples.len(),
            });
        }

        let requested_frames = interleaved_samples.len() / self.layout.channels();
        let writable_frames = requested_frames.min(self.free_frames());
        let writable_samples = writable_frames * self.layout.channels();

        for (sample_index, &sample) in interleaved_samples.iter().enumerate().take(writable_samples) {
            let frame_offset = sample_index / self.layout.channels();
            let channel_offset = sample_index % self.layout.channels();
            let destination_frame = (self.write_frame + frame_offset) % self.layout.frame_capacity();
            let destination_index = destination_frame * self.layout.channels() + channel_offset;
            self.samples[destination_index] = sample;
        }

        self.write_frame = (self.write_frame + writable_frames) % self.layout.frame_capacity();
        self.len_frames += writable_frames;

        Ok(writable_frames)
    }

    pub fn pop_interleaved(&mut self, frames: usize) -> Vec<f32> {
        let readable_frames = frames.min(self.available_frames());
        let readable_samples = readable_frames * self.layout.channels();
        let mut output = Vec::with_capacity(readable_samples);

        for sample_index in 0..readable_samples {
            let frame_offset = sample_index / self.layout.channels();
            let channel_offset = sample_index % self.layout.channels();
            let source_frame = (self.read_frame + frame_offset) % self.layout.frame_capacity();
            let source_index = source_frame * self.layout.channels() + channel_offset;
            output.push(self.samples[source_index]);
        }

        self.read_frame = (self.read_frame + readable_frames) % self.layout.frame_capacity();
        self.len_frames -= readable_frames;

        output
    }
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_FRAME_CAPACITY, PcmRingBuffer, RingBufferError, RingBufferLayout};

    #[test]
    fn layout_exposes_shared_memory_sizing() {
        let layout = RingBufferLayout::new(DEFAULT_FRAME_CAPACITY, 2).unwrap();

        assert_eq!(layout.sample_capacity(), DEFAULT_FRAME_CAPACITY * 2);
        assert_eq!(layout.state_bytes(), 20);
        assert_eq!(layout.sample_bytes(), DEFAULT_FRAME_CAPACITY * 2 * 4);
        assert_eq!(
            layout.shared_buffer_bytes(),
            20 + (DEFAULT_FRAME_CAPACITY * 2 * 4)
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
    fn ring_buffer_layout_rejects_zero_capacity() {
        assert!(RingBufferLayout::new(0, 2).is_err());
    }

    #[test]
    fn ring_buffer_layout_rejects_zero_channels() {
        assert!(RingBufferLayout::new(1024, 0).is_err());
    }

    #[test]
    fn ring_buffer_layout_accepts_valid_params() {
        let layout = RingBufferLayout::new(1024, 2).unwrap();
        assert_eq!(layout.frame_capacity(), 1024);
        assert_eq!(layout.channels(), 2);
    }
}
