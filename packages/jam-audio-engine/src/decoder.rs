use std::fmt;
use std::io::{Cursor, Read, Seek, SeekFrom};

use crate::opus_decoder::OpusDecoder;
use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::{CODEC_TYPE_NULL, CodecRegistry, CodecType, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_probe, register_enabled_codecs};

pub const DEFAULT_OUTPUT_SAMPLE_RATE: u32 = 48_000;

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedAudioData {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u32,
}

impl DecodedAudioData {
    pub fn new(samples: Vec<f32>, sample_rate: u32, channels: u32) -> Self {
        Self {
            samples,
            sample_rate,
            channels,
        }
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    pub fn into_samples(self) -> Vec<f32> {
        self.samples
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> u32 {
        self.channels
    }

    pub fn frames(&self) -> usize {
        let channels = self.channels.max(1) as usize;
        self.samples.len() / channels
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    EmptyInput,
    UnsupportedCodec,
    MissingSampleRate,
    MissingChannels,
    NoDefaultTrack,
    Symphonia(String),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyInput => write!(f, "audio input was empty"),
            Self::UnsupportedCodec => write!(f, "audio track codec is unsupported"),
            Self::MissingSampleRate => write!(f, "audio track is missing a sample rate"),
            Self::MissingChannels => write!(f, "audio track is missing channel metadata"),
            Self::NoDefaultTrack => write!(f, "audio container did not expose a default track"),
            Self::Symphonia(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for DecodeError {}

impl From<SymphoniaError> for DecodeError {
    fn from(value: SymphoniaError) -> Self {
        Self::Symphonia(value.to_string())
    }
}

pub struct StreamingDecoder {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    source_sample_rate: u32,
    source_channels: u32,
    target_sample_rate: u32,
    duration_ms: f64,
    is_ogg_family: bool,
    has_known_byte_len: bool,
    intermediate_samples: Vec<f32>,
    stereo_scratch: Vec<f32>,
    sample_buffer: Option<SampleBuffer<f32>>,
    sample_buffer_rate: u32,
    sample_buffer_channels: u32,
}

fn codec_supported_on_target(
    _codec: CodecType,
    _web_opus_gate_enabled: bool,
) -> Result<(), DecodeError> {
    Ok(())
}

impl StreamingDecoder {
    fn ensure_seekable_for_current_format(&self) -> Result<(), DecodeError> {
        if self.is_ogg_family && !self.has_known_byte_len {
            return Err(DecodeError::Symphonia(
                "seek unavailable for incomplete ogg stream".to_string(),
            ));
        }

        Ok(())
    }

    pub fn new(data: Vec<u8>, target_sample_rate: u32) -> Result<Self, DecodeError> {
        if data.is_empty() {
            return Err(DecodeError::EmptyInput);
        }

        Self::from_media_source(InMemoryMediaSource::new(data), target_sample_rate)
    }

    pub fn from_media_source<S>(media_source: S, target_sample_rate: u32) -> Result<Self, DecodeError>
    where
        S: MediaSource + 'static,
    {
        let has_known_byte_len = media_source.byte_len().is_some();
        let media_stream = MediaSourceStream::new(Box::new(media_source), Default::default());
        let hint = Hint::new();
        let probed = get_probe().format(
            &hint,
            media_stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )?;

        let format = probed.format;
        let track = format
            .default_track()
            .ok_or(DecodeError::NoDefaultTrack)?
            .clone();
        if track.codec_params.codec == CODEC_TYPE_NULL {
            return Err(DecodeError::UnsupportedCodec);
        }
        codec_supported_on_target(track.codec_params.codec, cfg!(target_arch = "wasm32"))?;

        let is_ogg_family = track.codec_params.codec == symphonia::core::codecs::CODEC_TYPE_OPUS || track.codec_params.codec == symphonia::core::codecs::CODEC_TYPE_VORBIS;

        let decoder = enabled_codecs().make(&track.codec_params, &DecoderOptions::default())?;
        let source_sample_rate = track
            .codec_params
            .sample_rate
            .ok_or(DecodeError::MissingSampleRate)?;
        let source_channels = track
            .codec_params
            .channels
            .map(|layout| layout.count() as u32)
            .ok_or(DecodeError::MissingChannels)?;

        let duration_ms = if let Some(tb) = track.codec_params.time_base {
            if let Some(ts) = track.codec_params.n_frames {
                let time = tb.calc_time(ts);
                (time.seconds as f64 * 1000.0) + (time.frac * 1000.0)
            } else {
                0.0
            }
        } else {
            0.0
        };

        Ok(Self {
            format,
            decoder,
            track_id: track.id,
            source_sample_rate,
            source_channels,
            target_sample_rate,
            duration_ms,
            is_ogg_family,
            has_known_byte_len,
            intermediate_samples: Vec::with_capacity(8192),
            stereo_scratch: Vec::with_capacity(8192),
            sample_buffer: None,
            sample_buffer_rate: 0,
            sample_buffer_channels: 0,
        })
    }

    pub fn duration_ms(&self) -> f64 {
        self.duration_ms
    }

    pub fn sample_rate(&self) -> u32 {
        self.target_sample_rate
    }

    pub fn channels(&self) -> u32 {
        2
    }

    pub fn seek_to_ms(&mut self, ms: f64) -> Result<(), DecodeError> {
        self.ensure_seekable_for_current_format()?;

        use symphonia::core::formats::SeekMode;
        use symphonia::core::formats::SeekTo;

        let seconds = ms / 1000.0;
        let frac = seconds.fract();
        let num_seconds = seconds.trunc() as u64;

        let seek_time = symphonia::core::units::Time {
            seconds: num_seconds,
            frac,
        };

        self.format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: seek_time,
                track_id: Some(self.track_id),
            },
        )?;

        // Ensure we avoid glitchy audio after a seek by resetting the decoder
        self.decoder.reset();

        Ok(())
    }

    pub fn decode_chunk(
        &mut self,
        target_frames: usize,
    ) -> Result<Option<DecodedAudioData>, DecodeError> {
        let mut samples = Vec::with_capacity(target_frames * 2);
        if self.decode_chunk_into(target_frames, &mut samples)? {
            Ok(Some(DecodedAudioData::new(
                samples,
                self.target_sample_rate,
                2,
            )))
        } else {
            Ok(None)
        }
    }

    pub fn decode_chunk_into(
        &mut self,
        target_frames: usize,
        out: &mut Vec<f32>,
    ) -> Result<bool, DecodeError> {
        self.intermediate_samples.clear();
        let target_samples_stereo = target_frames * 2;

        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(error) => return Err(error.into()),
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = self.decoder.decode(&packet)?;
            let spec = *decoded.spec();
            self.source_sample_rate = spec.rate;
            self.source_channels = spec.channels.count() as u32;

            append_interleaved_samples(
                &mut self.intermediate_samples,
                decoded,
                &mut self.sample_buffer,
                &mut self.sample_buffer_rate,
                &mut self.sample_buffer_channels,
            );

            if self.intermediate_samples.len() >= target_samples_stereo {
                break;
            }
        }

        if self.intermediate_samples.is_empty() {
            return Ok(false);
        }

        normalize_to_stereo_output_into(
            &self.intermediate_samples,
            self.source_sample_rate,
            self.source_channels,
            self.target_sample_rate,
            &mut self.stereo_scratch,
            out,
        );
        Ok(true)
    }
}

fn enabled_codecs() -> CodecRegistry {
    let mut codecs = CodecRegistry::new();
    register_enabled_codecs(&mut codecs);
    codecs.register_all::<OpusDecoder>();
    codecs
}

// Keep the old decode_audio_bytes around for backward compat if needed, or remove it.
pub fn decode_audio_bytes(
    data: &[u8],
    target_sample_rate: u32,
) -> Result<DecodedAudioData, DecodeError> {
    let mut streaming = StreamingDecoder::new(data.to_vec(), target_sample_rate)?;
    let mut all_samples = Vec::new();
    while let Ok(Some(chunk)) = streaming.decode_chunk(8192) {
        all_samples.extend_from_slice(chunk.samples());
    }
    if all_samples.is_empty() {
        return Err(DecodeError::EmptyInput);
    }
    Ok(DecodedAudioData::new(
        all_samples,
        target_sample_rate,
        2,
    ))
}

fn append_interleaved_samples(
    samples: &mut Vec<f32>,
    decoded: AudioBufferRef<'_>,
    sample_buffer_opt: &mut Option<SampleBuffer<f32>>,
    sb_rate: &mut u32,
    sb_channels: &mut u32,
) {
    let spec = *decoded.spec();
    let capacity = decoded.capacity() as u64;

    if let Some(sb) = sample_buffer_opt {
        if *sb_rate != spec.rate || *sb_channels != spec.channels.count() as u32 || sb.capacity() < capacity as usize {
            *sample_buffer_opt = Some(SampleBuffer::<f32>::new(capacity, spec));
            *sb_rate = spec.rate;
            *sb_channels = spec.channels.count() as u32;
        }
    } else {
        *sample_buffer_opt = Some(SampleBuffer::<f32>::new(capacity, spec));
        *sb_rate = spec.rate;
        *sb_channels = spec.channels.count() as u32;
    }

    if let Some(sb) = sample_buffer_opt {
        sb.copy_interleaved_ref(decoded);
        samples.extend_from_slice(sb.samples());
    }
}

fn normalize_to_stereo_output_into(
    samples: &[f32],
    source_sample_rate: u32,
    source_channels: u32,
    target_sample_rate: u32,
    stereo_scratch: &mut Vec<f32>,
    out: &mut Vec<f32>,
) {
    stereo_scratch.clear();
    match source_channels {
        0 => return,
        1 => {
            stereo_scratch.reserve(samples.len() * 2);
            for &sample in samples {
                stereo_scratch.push(sample);
                stereo_scratch.push(sample);
            }
        }
        2 => {
            stereo_scratch.extend_from_slice(samples);
        }
        _ => {
            stereo_scratch.reserve((samples.len() / source_channels as usize) * 2);
            for frame in samples.chunks_exact(source_channels as usize) {
                stereo_scratch.push(frame[0]);
                stereo_scratch.push(frame[1]);
            }
        }
    };

    if stereo_scratch.is_empty() {
        return;
    }

    if source_sample_rate == target_sample_rate {
        out.extend_from_slice(stereo_scratch);
        return;
    }

    let source_frames = stereo_scratch.len() / 2;
    let target_frames = ((source_frames as f64 * target_sample_rate as f64) / source_sample_rate as f64)
        .round()
        .max(1.0) as usize;
    let source_to_target_ratio = source_sample_rate as f64 / target_sample_rate as f64;

    let start_idx = out.len();
    out.resize(start_idx + target_frames * 2, 0.0);
    let target_slice = &mut out[start_idx..];

    for target_frame in 0..target_frames {
        let source_position = target_frame as f64 * source_to_target_ratio;
        let start_frame = source_position.floor() as usize;
        let end_frame = (start_frame + 1).min(source_frames.saturating_sub(1));
        let blend = (source_position - start_frame as f64) as f32;

        for channel in 0..2 {
            let start_sample = stereo_scratch[start_frame * 2 + channel];
            let end_sample = stereo_scratch[end_frame * 2 + channel];
            target_slice[target_frame * 2 + channel] =
                start_sample + ((end_sample - start_sample) * blend);
        }
    }
}

#[derive(Debug, Clone)]
pub struct AppendableMediaSource {
    buffer: Vec<u8>,
    position: u64,
    finalized: bool,
}

impl Default for AppendableMediaSource {
    fn default() -> Self {
        Self::new()
    }
}

impl AppendableMediaSource {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            position: 0,
            finalized: false,
        }
    }

    pub fn append(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    pub fn finalize(&mut self) {
        self.finalized = true;
    }

    pub fn buffered_len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_finalized(&self) -> bool {
        self.finalized
    }
}

impl Read for AppendableMediaSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let position = self.position as usize;
        if position >= self.buffer.len() {
            return Ok(0);
        }

        let available = self.buffer.len() - position;
        let count = available.min(buf.len());
        buf[..count].copy_from_slice(&self.buffer[position..position + count]);
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for AppendableMediaSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let len = self.buffer.len() as i128;
        let current = self.position as i128;
        let target = match pos {
            SeekFrom::Start(offset) => {
                if offset as i128 > len {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "seek past buffered data",
                    ));
                }
                offset as i128
            }
            SeekFrom::Current(delta) => current + delta as i128,
            SeekFrom::End(delta) => {
                if self.finalized {
                    len + delta as i128
                } else {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "cannot seek from end of incomplete stream",
                    ));
                }
            }
        };

        if target < 0 || target > len {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "seek past buffered data",
            ));
        }

        self.position = target as u64;
        Ok(self.position)
    }
}

impl MediaSource for AppendableMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        if self.finalized {
            Some(self.buffer.len() as u64)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone)]
pub struct WindowedMediaSource {
    buffer: Vec<u8>,
    pub window_start: u64,
    position: u64,
    pub total_size: Option<u64>,
    max_window_bytes: usize,
    finalized: bool,
    pending_seek: Option<u64>,
    header_reserve_bytes: usize,
    keep_behind: usize,
}

impl WindowedMediaSource {
    pub fn new(max_window_bytes: usize, header_reserve_bytes: usize, keep_behind: usize) -> Self {
        Self {
            buffer: Vec::new(),
            window_start: 0,
            position: 0,
            total_size: None,
            max_window_bytes,
            finalized: false,
            pending_seek: None,
            header_reserve_bytes,
            keep_behind,
        }
    }

    pub fn set_total_size(&mut self, total_size: Option<u64>) {
        self.total_size = total_size;
    }

    pub fn append(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
        self.evict_if_needed();
    }

    pub fn finalize(&mut self) {
        self.finalized = true;
    }

    pub fn has_pending_seek(&self) -> bool {
        self.pending_seek.is_some()
    }

    pub fn pending_seek_offset(&self) -> Option<u64> {
        self.pending_seek
    }

    pub fn clear_pending_seek(&mut self) {
        self.pending_seek = None;
    }

    pub fn is_finalized(&self) -> bool {
        self.finalized
    }

    pub fn window_start(&self) -> u64 {
        self.window_start
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }

    fn evict_if_needed(&mut self) {
        if self.buffer.len() <= self.max_window_bytes {
            return;
        }

        let read_pos_in_window = self.position.saturating_sub(self.window_start) as usize;
        let keep_behind = self.keep_behind;
        let evict_from_window = read_pos_in_window.saturating_sub(keep_behind);

        if evict_from_window > 0 {
            if self.window_start == 0 {
                if evict_from_window > self.header_reserve_bytes {
                    self.buffer.drain(self.header_reserve_bytes..evict_from_window);
                    self.window_start = evict_from_window as u64;
                }
            } else {
                self.buffer.drain(self.header_reserve_bytes .. self.header_reserve_bytes + evict_from_window);
                self.window_start += evict_from_window as u64;
            }
        }
    }
}

impl Read for WindowedMediaSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let position = self.position;

        let header_len = if self.window_start == 0 {
            self.buffer.len().min(self.header_reserve_bytes)
        } else {
            self.header_reserve_bytes
        };

        if position < header_len as u64 {
            let available = header_len - position as usize;
            let count = available.min(buf.len());
            buf[..count].copy_from_slice(&self.buffer[position as usize .. position as usize + count]);
            self.position += count as u64;
            return Ok(count);
        }

        let window_offset_in_buffer = if self.window_start == 0 {
            0
        } else {
            self.header_reserve_bytes
        };

        let window_len = self.buffer.len() - window_offset_in_buffer;
        
        if position >= self.window_start && position < self.window_start + window_len as u64 {
            let pos_in_window = (position - self.window_start) as usize;
            let available = window_len - pos_in_window;
            let count = available.min(buf.len());
            let start_idx = window_offset_in_buffer + pos_in_window;
            buf[..count].copy_from_slice(&self.buffer[start_idx .. start_idx + count]);
            self.position += count as u64;
            return Ok(count);
        }

        Ok(0)
    }
}

impl Seek for WindowedMediaSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let current = self.position as i128;
        
        let window_len = if self.window_start == 0 {
            self.buffer.len() as u64
        } else {
            (self.buffer.len() - self.header_reserve_bytes) as u64
        };
        let current_end = self.window_start + window_len;

        let target = match pos {
            SeekFrom::Start(offset) => offset as i128,
            SeekFrom::Current(delta) => current + delta as i128,
            SeekFrom::End(delta) => {
                if self.finalized || self.total_size.is_some() {
                    let end_pos = if let Some(ts) = self.total_size {
                        ts
                    } else {
                        current_end
                    };
                    end_pos as i128 + delta as i128
                } else {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "cannot seek from end of incomplete stream",
                    ));
                }
            }
        };

        if target < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "seek before start",
            ));
        }

        let target_u64 = target as u64;

        let header_len = if self.window_start == 0 {
            self.buffer.len().min(self.header_reserve_bytes) as u64
        } else {
            self.header_reserve_bytes as u64
        };

        let in_header = target_u64 < header_len;

        let window_len = if self.window_start == 0 {
            self.buffer.len() as u64
        } else {
            (self.buffer.len() - self.header_reserve_bytes) as u64
        };

        let near_margin = 16 * 1024;
        let in_window = (target_u64 >= self.window_start && target_u64 <= self.window_start + window_len)
            || (target_u64 >= self.window_start.saturating_sub(near_margin) && target_u64 < self.window_start);

        if in_header || in_window {
            self.position = target_u64;
            Ok(self.position)
        } else {
            self.pending_seek = Some(target_u64);
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "outside window",
            ))
        }
    }
}

impl MediaSource for WindowedMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        None
    }
}

struct InMemoryMediaSource {
    inner: Cursor<Vec<u8>>,
}

impl InMemoryMediaSource {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            inner: Cursor::new(bytes),
        }
    }
}

impl Read for InMemoryMediaSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Seek for InMemoryMediaSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for InMemoryMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.inner.get_ref().len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Seek;
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{CodecRegistry, DecoderOptions};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use symphonia::default::{get_probe, register_enabled_codecs};

    #[test]
    fn windowed_append_read() {
        let mut src = WindowedMediaSource::new(1024, 0, 1024 * 1024);
        src.append(&[1, 2, 3, 4]);
        let mut buf = [0u8; 2];
        assert_eq!(src.read(&mut buf).unwrap(), 2);
        assert_eq!(&buf, &[1, 2]);
        assert_eq!(src.read(&mut buf).unwrap(), 2);
        assert_eq!(&buf, &[3, 4]);
        assert_eq!(src.read(&mut buf).unwrap(), 0);
    }

    #[test]
    fn windowed_eviction() {
        let mut src = WindowedMediaSource::new(200, 50, 1024 * 1024);
        let pad = vec![0u8; 1024 * 1024];
        src.append(&pad);
        src.seek(SeekFrom::Start(1024 * 1024)).unwrap();
        let data = vec![1u8; 500];
        src.append(&data);
        src.seek(SeekFrom::Start(1024 * 1024 + 100)).unwrap();
        src.append(&[2u8; 100]);
        assert_eq!(src.window_start, 100);
    }

    #[test]
    fn windowed_header_survives() {
        let mut src = WindowedMediaSource::new(200, 50, 1024 * 1024);
        let mut data = vec![0u8; 1024 * 1024 + 500];
        for i in 0..50 { data[i] = i as u8; } // header
        src.append(&data);
        src.seek(SeekFrom::Start(1024 * 1024 + 200)).unwrap();
        src.append(&[0u8; 10]); // trigger eviction
        assert_eq!(src.window_start, 200);
        src.seek(SeekFrom::Start(10)).unwrap();
        let mut buf = [0u8; 10];
        assert_eq!(src.read(&mut buf).unwrap(), 10);
        assert_eq!(&buf[..], &(10..20).collect::<Vec<u8>>());
    }

    #[test]
    fn windowed_seek_outside_sets_pending() {
        let mut src = WindowedMediaSource::new(1024, 50, 1024 * 1024);
        src.append(&[0u8; 100]);
        assert!(src.seek(SeekFrom::Start(200)).is_err());
        assert_eq!(src.pending_seek_offset(), Some(200));
    }

    #[test]
    fn test_near_window_seek_margin() {
        let mut src = WindowedMediaSource::new(1024 * 1024, 50, 16 * 1024);
        let data = vec![0u8; 100 * 1024];
        src.append(&data);
        
        // Manually move window_start to simulate eviction
        src.window_start = 20 * 1024;
        
        // Seek to 19KB (just outside 20KB window)
        // near_margin is 16KB, so 19KB is within margin (20KB - 16KB = 4KB)
        assert!(src.seek(SeekFrom::Start(19 * 1024)).is_ok());
        assert_eq!(src.position, 19 * 1024);
        
        // Seek to 3KB (outside margin)
        assert!(src.seek(SeekFrom::Start(3 * 1024)).is_err());
    }

    impl fmt::Debug for StreamingDecoder {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("StreamingDecoder")
                .field("track_id", &self.track_id)
                .field("source_sample_rate", &self.source_sample_rate)
                .field("source_channels", &self.source_channels)
                .field("duration_ms", &self.duration_ms)
                .field("intermediate_samples_cap", &self.intermediate_samples.capacity())
                .field("stereo_scratch_cap", &self.stereo_scratch.capacity())
                .finish()
        }
    }

    #[test]
    fn append_then_read_back_sequentially() {
        let mut source = AppendableMediaSource::new();
        source.append(&[1, 2, 3, 4]);

        let mut buf = [0u8; 2];
        assert_eq!(source.read(&mut buf).unwrap(), 2);
        assert_eq!(buf, [1, 2]);

        assert_eq!(source.read(&mut buf).unwrap(), 2);
        assert_eq!(buf, [3, 4]);

        assert_eq!(source.read(&mut buf).unwrap(), 0);
    }

    #[test]
    fn append_more_then_continue_reading() {
        let mut source = AppendableMediaSource::new();
        source.append(&(0u8..100).collect::<Vec<_>>());

        let mut buf = [0u8; 80];
        assert_eq!(source.read(&mut buf).unwrap(), 80);
        assert_eq!(buf[0], 0);
        assert_eq!(buf[79], 79);

        source.append(&(100u8..200).collect::<Vec<_>>());

        let mut rest = [0u8; 120];
        assert_eq!(source.read(&mut rest).unwrap(), 120);
        assert_eq!(rest[0], 80);
        assert_eq!(rest[119], 199);
    }

    #[test]
    fn seek_within_buffered_succeeds() {
        let mut source = AppendableMediaSource::new();
        source.append(&(0u8..200).collect::<Vec<_>>());

        assert_eq!(source.seek(SeekFrom::Start(100)).unwrap(), 100);

        let mut buf = [0u8; 50];
        assert_eq!(source.read(&mut buf).unwrap(), 50);
        assert_eq!(buf[0], 100);
        assert_eq!(buf[49], 149);
    }

    #[test]
    fn seek_past_buffered_errors() {
        let mut source = AppendableMediaSource::new();
        source.append(&(0u8..100).collect::<Vec<_>>());

        assert!(source.seek(SeekFrom::Start(150)).is_err());
    }

    #[test]
    fn byte_len_changes_on_finalize() {
        let mut source = AppendableMediaSource::new();
        source.append(&(0u8..10).collect::<Vec<_>>());

        assert_eq!(source.byte_len(), None);
        source.finalize();
        assert_eq!(source.byte_len(), Some(10));
        assert!(source.is_finalized());
    }

    #[test]
    fn finalize_allows_seek_end() {
        let mut source = AppendableMediaSource::new();
        source.append(&(0u8..100).collect::<Vec<_>>());
        source.finalize();

        assert_eq!(source.seek(SeekFrom::End(-10)).unwrap(), 90);
    }

    #[test]
    fn empty_vec_returns_empty_input_error() {
        let result = StreamingDecoder::new(vec![], DEFAULT_OUTPUT_SAMPLE_RATE);
        assert!(
            matches!(result, Err(DecodeError::EmptyInput)),
            "expected EmptyInput, got {:?}",
            result
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn decode_first_chunk_with_native_libopus(bytes: Vec<u8>) -> Vec<f32> {
        decode_nth_chunk_with_native_libopus(bytes, 0)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn decode_nth_chunk_with_native_libopus(bytes: Vec<u8>, packet_index: usize) -> Vec<f32> {
        let media_stream = MediaSourceStream::new(
            Box::new(InMemoryMediaSource::new(bytes)),
            Default::default(),
        );
        let probed = get_probe()
            .format(
                &Hint::new(),
                media_stream,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .unwrap();

        let mut format = probed.format;
        let track = format.default_track().unwrap().clone();
        let mut codecs = CodecRegistry::new();
        register_enabled_codecs(&mut codecs);
        codecs.register_all::<symphonia_adapter_libopus::OpusDecoder>();
        let mut decoder = codecs
            .make(&track.codec_params, &DecoderOptions::default())
            .unwrap();

        let mut seen_packets = 0usize;
        loop {
            let packet = format.next_packet().unwrap();
            if packet.track_id() != track.id {
                continue;
            }
            if seen_packets < packet_index {
                decoder.decode(&packet).unwrap();
                seen_packets += 1;
                continue;
            }
            println!(
                "[NATIVE] packet len={} data={:?}",
                packet.data.len(),
                &packet.data[..packet.data.len().min(16)]
            );

            let decoded = decoder.decode(&packet).unwrap();
            let capacity = decoded.capacity() as u64;
            let spec = *decoded.spec();
            let mut converted = SampleBuffer::<f32>::new(capacity, spec);
            converted.copy_interleaved_ref(decoded);
            return converted.samples().to_vec();
        }
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn opus_first_packet_matches_native_libopus_closely() {
        let bytes = include_bytes!("../testdata/opus_sample.opus").to_vec();
        let native = decode_first_chunk_with_native_libopus(bytes.clone());

        let mut streaming = StreamingDecoder::new(bytes, DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        let ours = streaming
            .decode_chunk(4096)
            .unwrap()
            .unwrap()
            .into_samples();

        let compare_len = native.len().min(ours.len()).min(2048);
        let mean_abs_error = native
            .iter()
            .zip(ours.iter())
            .take(compare_len)
            .map(|(left, right)| (left - right).abs())
            .sum::<f32>()
            / compare_len as f32;

        println!("native_vs_wrapped_error={mean_abs_error}");
        println!("first_native={:?}", &native[..native.len().min(12)]);
        println!("first_wrapped={:?}", &ours[..ours.len().min(12)]);

        assert!(
            mean_abs_error < 0.0001,
            "wrapper diverges from native: error={mean_abs_error}"
        );
    }

    #[test]
    fn codec_supported_on_target_allows_non_opus_when_gate_enabled() {
        let result = codec_supported_on_target(CODEC_TYPE_NULL, true);

        assert_eq!(result, Ok(()));
    }

    #[test]
    fn decoder_respects_custom_sample_rate() {
        let bytes = include_bytes!("../testdata/opus_sample.opus").to_vec();
        let target_rate = 44100;
        let streaming = StreamingDecoder::new(bytes, target_rate).unwrap();
        assert_eq!(streaming.sample_rate(), target_rate);
    }
}
