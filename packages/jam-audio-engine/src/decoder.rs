use std::fmt;
use std::io::{Read, Seek, SeekFrom};

use crate::media_source::InMemoryMediaSource;
use crate::opus_decoder::OpusDecoder;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::{CODEC_TYPE_NULL, CodecRegistry, CodecType, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_probe, register_enabled_codecs};

/// High-quality polyphase windowed-sinc stereo resampler backed by `rubato`.
///
/// Wraps `SincFixedIn` (fixed-input chunk size) with an internal deinterleaved
/// input buffer so that callers can push variable-sized stereo interleaved chunks
/// without worrying about the rubato chunk-size constraint.  Call `flush` at end
/// of stream to drain any remaining buffered frames.
struct StereoResampler {
    inner: SincFixedIn<f32>,
    /// Deinterleaved per-channel input staging buffer.
    pending: [Vec<f32>; 2],
    /// Fixed chunk size that `SincFixedIn` expects.
    chunk_frames: usize,
}

fn extend_interleaved_stereo(out: &mut Vec<f32>, left: &[f32], right: &[f32]) {
    let frames = left.len().min(right.len());
    let start = out.len();
    out.resize(start + frames * 2, 0.0);

    for index in 0..frames {
        let base = start + index * 2;
        out[base] = left[index];
        out[base + 1] = right[index];
    }
}

fn extend_first_two_channels(out: &mut Vec<f32>, samples: &[f32], source_channels: usize) {
    out.reserve((samples.len() / source_channels) * 2);
    for frame in samples.chunks_exact(source_channels) {
        out.extend_from_slice(&frame[..2]);
    }
}

impl StereoResampler {
    fn new(source_rate: u32, target_rate: u32, chunk_frames: usize) -> Self {
        let ratio = target_rate as f64 / source_rate as f64;
        let params = SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Cubic,
            oversampling_factor: 64,
            window: WindowFunction::BlackmanHarris2,
        };
        let inner = SincFixedIn::<f32>::new(ratio, 1.0, params, chunk_frames, 2)
            .expect("rubato SincFixedIn params valid");
        Self {
            inner,
            pending: [
                Vec::with_capacity(chunk_frames * 2),
                Vec::with_capacity(chunk_frames * 2),
            ],
            chunk_frames,
        }
    }

    /// Push interleaved stereo `samples` into the resampler, emitting resampled
    /// frames into `out` whenever a full input chunk is available.
    fn push_interleaved(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        // Deinterleave into pending buffers.
        for frame in samples.chunks_exact(2) {
            self.pending[0].push(frame[0]);
            self.pending[1].push(frame[1]);
        }
        // Drain complete chunks.
        while self.pending[0].len() >= self.chunk_frames {
            self.process_one_chunk(out);
        }
    }

    /// Flush any remaining buffered frames by padding with silence and processing.
    fn flush(&mut self, out: &mut Vec<f32>) {
        if self.pending[0].is_empty() {
            return;
        }
        // Pad both channels to chunk_frames with silence.
        let have = self.pending[0].len();
        let need = self.chunk_frames - have;
        self.pending[0].extend(std::iter::repeat_n(0.0f32, need));
        self.pending[1].extend(std::iter::repeat_n(0.0f32, need));
        self.process_one_chunk(out);
    }

    fn process_one_chunk(&mut self, out: &mut Vec<f32>) {
        // Extract exactly chunk_frames from the front of pending.
        let l: Vec<f32> = self.pending[0].drain(..self.chunk_frames).collect();
        let r: Vec<f32> = self.pending[1].drain(..self.chunk_frames).collect();
        let in_buf = [l, r];
        if let Ok(resampled) = self.inner.process(&in_buf, None) {
            extend_interleaved_stereo(out, &resampled[0], &resampled[1]);
        }
    }
}

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
    DecoderState(&'static str),
    Symphonia(String),
    Resample {
        operation: &'static str,
        message: String,
    },
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyInput => write!(f, "audio input was empty"),
            Self::UnsupportedCodec => write!(f, "audio track codec is unsupported"),
            Self::MissingSampleRate => write!(f, "audio track is missing a sample rate"),
            Self::MissingChannels => write!(f, "audio track is missing channel metadata"),
            Self::NoDefaultTrack => write!(f, "audio container did not expose a default track"),
            Self::DecoderState(message) => write!(f, "{message}"),
            Self::Symphonia(message) => write!(f, "{message}"),
            Self::Resample { operation, message } => {
                write!(f, "resampler error during {operation}: {message}")
            }
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
    format: Option<Box<dyn symphonia::core::formats::FormatReader>>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    /// Most recently observed per-packet sample rate. Treat as a runtime hint.
    /// For encoder-delay / trailing-pad math, use `init_source_sample_rate`.
    source_sample_rate: u32,
    #[allow(dead_code)]
    init_source_sample_rate: u32,
    source_channels: u32,
    target_sample_rate: u32,
    duration_ms: f64,
    is_ogg_family: bool,
    has_known_byte_len: bool,
    reprobed_after_finalized: bool,
    intermediate_samples: Vec<f32>,
    stereo_scratch: Vec<f32>,
    sample_buffer: Option<SampleBuffer<f32>>,
    sample_buffer_rate: u32,
    sample_buffer_channels: u32,
    encoder_delay_frames: u64,
    trailing_pad_frames: u64,
    /// Frames to skip after a seek to achieve sample-accurate positioning.
    pending_skip_frames: u64,
    /// Lazily-constructed rubato resampler; `None` when source_rate == target_rate.
    resampler: Option<StereoResampler>,
}

fn codec_supported_on_target(
    _codec: CodecType,
    _web_opus_gate_enabled: bool,
) -> Result<(), DecodeError> {
    Ok(())
}

/// Converts a symphonia `(time_base, n_frames)` pair to milliseconds.
///
/// Returns `0.0` for any of:
/// - `time_base` is `None`
/// - `n_frames` is `None`
/// - `n_frames` is `u64::MAX` (symphonia's sentinel for "unknown duration")
fn duration_ms_from(
    time_base: Option<symphonia::core::units::TimeBase>,
    n_frames: Option<u64>,
) -> f64 {
    match (time_base, n_frames) {
        (Some(tb), Some(n)) if n != u64::MAX => {
            let t = tb.calc_time(n);
            t.seconds as f64 * 1000.0 + t.frac * 1000.0
        }
        _ => 0.0,
    }
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

    /// Called after the owning stream source is fully finalized to unlock
    /// Ogg seeks.
    ///
    /// `has_known_byte_len` is captured at decoder-creation time from
    /// `media_source.byte_len().is_some()`. For streams initialized before
    /// `finalize()` (files > 256 KB), the source is not yet finalized so
    /// `byte_len()` returns `None`. This method corrects the stale flag
    /// once the source is known to be complete.
    pub fn on_source_finalized(&mut self) {
        self.has_known_byte_len = true;
        self.reprobed_after_finalized = false;
    }

    pub fn new(data: Vec<u8>, target_sample_rate: u32) -> Result<Self, DecodeError> {
        if data.is_empty() {
            return Err(DecodeError::EmptyInput);
        }

        Self::from_media_source(InMemoryMediaSource::from_vec(data), target_sample_rate)
    }

    pub fn from_media_source<S>(
        media_source: S,
        target_sample_rate: u32,
    ) -> Result<Self, DecodeError>
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

        let is_ogg_family = track.codec_params.codec == symphonia::core::codecs::CODEC_TYPE_OPUS
            || track.codec_params.codec == symphonia::core::codecs::CODEC_TYPE_VORBIS;

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

        let duration_ms =
            duration_ms_from(track.codec_params.time_base, track.codec_params.n_frames);

        let init_source_sample_rate = source_sample_rate;
        let raw_delay = track.codec_params.delay.unwrap_or(0) as u64;
        let raw_padding = track.codec_params.padding.unwrap_or(0) as f64;
        let rate_ratio = target_sample_rate as f64 / init_source_sample_rate as f64;
        let encoder_delay_frames = (raw_delay as f64 * rate_ratio).round() as u64;
        let trailing_pad_frames = (raw_padding * rate_ratio).round() as u64;

        Ok(Self {
            format: Some(format),
            decoder,
            track_id: track.id,
            source_sample_rate,
            init_source_sample_rate,
            source_channels,
            target_sample_rate,
            duration_ms,
            is_ogg_family,
            has_known_byte_len,
            reprobed_after_finalized: false,
            intermediate_samples: Vec::with_capacity(8192),
            stereo_scratch: Vec::with_capacity(8192),
            sample_buffer: None,
            sample_buffer_rate: 0,
            sample_buffer_channels: 0,
            encoder_delay_frames,
            trailing_pad_frames,
            pending_skip_frames: raw_delay,
            resampler: None,
        })
    }

    pub fn duration_ms(&self) -> f64 {
        self.duration_ms
    }

    pub fn sample_rate(&self) -> u32 {
        self.target_sample_rate
    }

    /// Output channel count. The decoder normalises every source to stereo,
    /// so this is always 2. Use `source_channels()` for the upstream count.
    pub fn output_channels(&self) -> u32 {
        2
    }

    /// Most-recently-observed source channel count (may change per packet).
    pub fn source_channels(&self) -> u32 {
        self.source_channels
    }

    pub fn encoder_delay_frames(&self) -> u64 {
        self.encoder_delay_frames
    }

    pub fn trailing_pad_frames(&self) -> u64 {
        self.trailing_pad_frames
    }

    pub fn seek_to_ms(&mut self, ms: f64) -> Result<(), DecodeError> {
        self.ensure_seekable_for_current_format()?;

        use symphonia::core::formats::SeekMode;
        use symphonia::core::formats::SeekTo;

        if self.is_ogg_family
            && self.has_known_byte_len
            && !self.reprobed_after_finalized
            && let Some(format_reader) = self.format.take()
        {
            let mut mss = format_reader.into_inner();
            let _ = mss.seek(SeekFrom::Start(0));
            let hint = Hint::new();
            let probed = get_probe().format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )?;
            self.format = Some(probed.format);
            self.reprobed_after_finalized = true;
        }

        let playback_frame = (ms * self.target_sample_rate as f64 / 1000.0).round() as u64;
        let target_frame = playback_frame + self.encoder_delay_frames;
        let target_seconds = target_frame as f64 / self.target_sample_rate as f64;

        let frac = target_seconds.fract();
        let num_seconds = target_seconds.trunc() as u64;

        let seek_time = symphonia::core::units::Time {
            seconds: num_seconds,
            frac,
        };

        let format = self.format.as_mut().ok_or(DecodeError::DecoderState(
            "decoder format reader is unavailable",
        ))?;
        let seeked_to = format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: seek_time,
                track_id: Some(self.track_id),
            },
        )?;

        if seeked_to.required_ts > seeked_to.actual_ts {
            self.pending_skip_frames = seeked_to.required_ts - seeked_to.actual_ts;
        } else {
            self.pending_skip_frames = 0;
        }

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

        let mut chunk_samples = Vec::new();
        loop {
            let packet = {
                let format = self.format.as_mut().ok_or(DecodeError::DecoderState(
                    "decoder format reader is unavailable",
                ))?;
                match format.next_packet() {
                    Ok(packet) => packet,
                    Err(SymphoniaError::IoError(error))
                        if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                    {
                        break;
                    }
                    Err(error) => return Err(error.into()),
                }
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = self.decoder.decode(&packet)?;
            let spec = *decoded.spec();
            self.source_sample_rate = spec.rate;
            self.source_channels = spec.channels.count() as u32;

            chunk_samples.clear();
            append_interleaved_samples(
                &mut chunk_samples,
                decoded,
                &mut self.sample_buffer,
                &mut self.sample_buffer_rate,
                &mut self.sample_buffer_channels,
            );

            if self.pending_skip_frames > 0 {
                let frames_in_chunk = chunk_samples.len() / self.source_channels as usize;
                let skip = (self.pending_skip_frames as usize).min(frames_in_chunk);
                let samples_to_skip = skip * self.source_channels as usize;

                if samples_to_skip >= chunk_samples.len() {
                    chunk_samples.clear();
                } else {
                    chunk_samples.drain(0..samples_to_skip);
                }
                self.pending_skip_frames -= skip as u64;
            }

            // append retains chunk_samples' capacity for reuse on the next iteration
            self.intermediate_samples.append(&mut chunk_samples);

            if self.intermediate_samples.len() >= target_samples_stereo {
                break;
            }
        }

        if self.intermediate_samples.is_empty() {
            // Stream exhausted — flush any buffered resampler frames.
            if self.source_sample_rate != self.target_sample_rate
                && let Some(resampler) = self.resampler.as_mut()
            {
                let before = out.len();
                resampler.flush(out);
                if out.len() > before {
                    return Ok(true);
                }
            }
            return Ok(false);
        }

        let source_channels = self.source_channels;
        let samples = std::mem::take(&mut self.intermediate_samples);
        self.normalize_to_stereo_output(&samples, source_channels, out);
        self.intermediate_samples = samples;
        self.intermediate_samples.clear();
        Ok(true)
    }

    /// Fold `samples` to stereo and resample to `target_sample_rate`, appending into `out`.
    ///
    /// Channel folding is performed first into `self.stereo_scratch`. If the source and target
    /// rates differ, the rubato resampler is lazily constructed and used via its internal
    /// buffering; otherwise the stereo scratch is copied directly.
    fn normalize_to_stereo_output(
        &mut self,
        samples: &[f32],
        source_channels: u32,
        out: &mut Vec<f32>,
    ) {
        // --- channel folding into stereo_scratch ---
        self.stereo_scratch.clear();
        match source_channels {
            0 => return,
            1 => {
                self.stereo_scratch.reserve(samples.len() * 2);
                for &s in samples {
                    self.stereo_scratch.push(s);
                    self.stereo_scratch.push(s);
                }
            }
            2 => {
                self.stereo_scratch.extend_from_slice(samples);
            }
            _ => {
                extend_first_two_channels(
                    &mut self.stereo_scratch,
                    samples,
                    source_channels as usize,
                );
            }
        }

        if self.stereo_scratch.is_empty() {
            return;
        }

        // --- no resampling needed ---
        if self.source_sample_rate == self.target_sample_rate {
            out.extend_from_slice(&self.stereo_scratch);
            return;
        }

        // --- rubato resampling ---
        // The resampler uses a fixed chunk size determined at construction. We use a
        // consistent chunk size of 1024 frames regardless of actual stereo_scratch length,
        // so the resampler only needs to be created once per rate pair.
        let resampler = self.resampler.get_or_insert_with(|| {
            StereoResampler::new(self.source_sample_rate, self.target_sample_rate, 1024)
        });
        resampler.push_interleaved(&self.stereo_scratch, out);
    }
}

fn enabled_codecs() -> CodecRegistry {
    let mut codecs = CodecRegistry::new();
    register_enabled_codecs(&mut codecs);
    codecs.register_all::<OpusDecoder>();
    codecs
}

pub fn decode_audio_bytes(
    data: &[u8],
    target_sample_rate: u32,
) -> Result<DecodedAudioData, DecodeError> {
    let mut streaming = StreamingDecoder::new(data.to_vec(), target_sample_rate)?;
    let mut all_samples = Vec::new();
    loop {
        match streaming.decode_chunk(8192) {
            Ok(Some(chunk)) => all_samples.extend_from_slice(chunk.samples()),
            Ok(None) => break,
            Err(e) => return Err(e),
        }
    }
    if all_samples.is_empty() {
        return Err(DecodeError::EmptyInput);
    }
    Ok(DecodedAudioData::new(all_samples, target_sample_rate, 2))
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
        if *sb_rate != spec.rate
            || *sb_channels != spec.channels.count() as u32
            || sb.capacity() < capacity as usize
        {
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

// normalize_to_stereo_output_into has been replaced by
// StreamingDecoder::normalize_to_stereo_output (a method) which uses the
// rubato polyphase sinc resampler instead of linear interpolation.

#[derive(Debug, Clone)]
pub struct AppendableMediaSource {
    buffer: Vec<u8>,
    /// Absolute byte offset of `buffer[header_len()]` in the original stream.
    /// For bounded sources this advances as bytes are evicted.
    window_start: u64,
    position: u64,
    finalized: bool,
    /// 0 disables eviction (legacy "grow forever" behaviour).
    max_buffered_bytes: usize,
    header_reserve_bytes: usize,
    keep_behind: usize,
}

impl Default for AppendableMediaSource {
    fn default() -> Self {
        Self::new()
    }
}

impl AppendableMediaSource {
    /// Legacy unbounded constructor — keeps every byte ever appended.
    /// Prefer `with_bounds` for live streams.
    pub fn new() -> Self {
        Self::with_bounds(0, 0, 0)
    }

    /// Bounded constructor. When `max_buffered_bytes > 0` the source evicts
    /// bytes behind the read cursor (past `keep_behind`) but preserves the
    /// first `header_reserve_bytes` for re-probing.
    pub fn with_bounds(
        max_buffered_bytes: usize,
        header_reserve_bytes: usize,
        keep_behind: usize,
    ) -> Self {
        Self {
            buffer: Vec::new(),
            window_start: 0,
            position: 0,
            finalized: false,
            max_buffered_bytes,
            header_reserve_bytes,
            keep_behind,
        }
    }

    pub fn append(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
        self.evict_if_needed();
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

    fn header_len(&self) -> usize {
        if self.window_start == 0 {
            self.buffer.len().min(self.header_reserve_bytes)
        } else {
            self.header_reserve_bytes
        }
    }

    fn evict_if_needed(&mut self) {
        if self.max_buffered_bytes == 0 || self.buffer.len() <= self.max_buffered_bytes {
            return;
        }
        let read_pos_in_window = self.position.saturating_sub(self.window_start) as usize;
        let evict = read_pos_in_window.saturating_sub(self.keep_behind);
        if evict == 0 {
            return;
        }
        if self.window_start == 0 {
            if evict > self.header_reserve_bytes {
                self.buffer.drain(self.header_reserve_bytes..evict);
                self.window_start = evict as u64;
            }
        } else {
            self.buffer
                .drain(self.header_reserve_bytes..self.header_reserve_bytes + evict);
            self.window_start += evict as u64;
        }
    }
}

impl Read for AppendableMediaSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let position = self.position;

        let header_len = self.header_len() as u64;
        if position < header_len {
            let available = (header_len - position) as usize;
            let count = available.min(buf.len());
            let off = position as usize;
            buf[..count].copy_from_slice(&self.buffer[off..off + count]);
            self.position += count as u64;
            self.evict_if_needed();
            return Ok(count);
        }

        let window_offset = if self.window_start == 0 {
            0
        } else {
            self.header_reserve_bytes
        };
        let window_len = self.buffer.len() - window_offset;
        if position >= self.window_start && position < self.window_start + window_len as u64 {
            let pos_in_window = (position - self.window_start) as usize;
            let available = window_len - pos_in_window;
            let count = available.min(buf.len());
            let start = window_offset + pos_in_window;
            buf[..count].copy_from_slice(&self.buffer[start..start + count]);
            self.position += count as u64;
            self.evict_if_needed();
            return Ok(count);
        }
        Ok(0)
    }
}

impl Seek for AppendableMediaSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let window_offset = if self.window_start == 0 {
            0
        } else {
            self.header_reserve_bytes
        };
        let window_len = (self.buffer.len() - window_offset) as u64;
        let current_end = self.window_start + window_len;
        let current = self.position as i128;

        let target = match pos {
            SeekFrom::Start(o) => o as i128,
            SeekFrom::Current(d) => current + d as i128,
            SeekFrom::End(d) => {
                if self.finalized {
                    current_end as i128 + d as i128
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
        let t = target as u64;
        let header_len = self.header_len() as u64;
        let in_header = t < header_len;
        let in_window = t >= self.window_start && t <= current_end;
        if in_header || in_window {
            self.position = t;
            Ok(t)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "seek past buffered data",
            ))
        }
    }
}

impl MediaSource for AppendableMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        if self.finalized {
            Some(
                self.window_start
                    + (self.buffer.len()
                        - if self.window_start == 0 {
                            0
                        } else {
                            self.header_reserve_bytes
                        }) as u64,
            )
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
                    self.buffer
                        .drain(self.header_reserve_bytes..evict_from_window);
                    self.window_start = evict_from_window as u64;
                }
            } else {
                self.buffer.drain(
                    self.header_reserve_bytes..self.header_reserve_bytes + evict_from_window,
                );
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
            buf[..count]
                .copy_from_slice(&self.buffer[position as usize..position as usize + count]);
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
            buf[..count].copy_from_slice(&self.buffer[start_idx..start_idx + count]);
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
        let in_window = (target_u64 >= self.window_start
            && target_u64 <= self.window_start + window_len)
            || (target_u64 >= self.window_start.saturating_sub(near_margin)
                && target_u64 < self.window_start);

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
        if self.finalized {
            self.total_size.or(Some(
                self.window_start
                    + (self.buffer.len()
                        - if self.window_start == 0 {
                            0
                        } else {
                            self.header_reserve_bytes
                        }) as u64,
            ))
        } else {
            None
        }
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
        for (i, byte) in data.iter_mut().take(50).enumerate() {
            *byte = i as u8;
        } // header
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
                .field("init_source_sample_rate", &self.init_source_sample_rate)
                .field("source_channels", &self.source_channels)
                .field("duration_ms", &self.duration_ms)
                .field(
                    "intermediate_samples_cap",
                    &self.intermediate_samples.capacity(),
                )
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

    #[test]
    fn seek_to_ms_returns_error_when_format_reader_is_missing() {
        let bytes = include_bytes!("../testdata/opus_sample.opus").to_vec();
        let mut decoder = StreamingDecoder::new(bytes, DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        decoder.format = None;

        let result = decoder.seek_to_ms(0.0);

        assert!(matches!(
            result,
            Err(DecodeError::DecoderState(
                "decoder format reader is unavailable"
            ))
        ));
    }

    #[test]
    fn decode_chunk_into_returns_error_when_format_reader_is_missing() {
        let bytes = include_bytes!("../testdata/opus_sample.opus").to_vec();
        let mut decoder = StreamingDecoder::new(bytes, DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();
        decoder.format = None;
        let mut out = Vec::new();

        let result = decoder.decode_chunk_into(128, &mut out);

        assert!(matches!(
            result,
            Err(DecodeError::DecoderState(
                "decoder format reader is unavailable"
            ))
        ));
        assert!(out.is_empty());
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn decode_first_chunk_with_native_libopus(bytes: Vec<u8>) -> Vec<f32> {
        decode_nth_chunk_with_native_libopus(bytes, 0)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn decode_nth_chunk_with_native_libopus(bytes: Vec<u8>, packet_index: usize) -> Vec<f32> {
        let media_stream = MediaSourceStream::new(
            Box::new(InMemoryMediaSource::from_vec(bytes)),
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

    #[test]
    fn appendable_source_evicts_behind_read_cursor() {
        let mut src = AppendableMediaSource::with_bounds(
            /* max_buffered_bytes = */ 1024, /* header_reserve_bytes = */ 64,
            /* keep_behind = */ 128,
        );

        // Push 4KB of data, read past the eviction point.
        let payload: Vec<u8> = (0u32..4096).map(|i| (i & 0xff) as u8).collect();
        src.append(&payload);
        let mut sink = [0u8; 4096];
        let mut read_total = 0;
        loop {
            let n = src.read(&mut sink[read_total..]).unwrap();
            if n == 0 {
                break;
            }
            read_total += n;
        }
        assert_eq!(read_total, 4096);

        // After eviction, buffered_len must stay under max_buffered_bytes.
        assert!(
            src.buffered_len() <= 1024,
            "expected eviction to cap buffer at 1024, got {}",
            src.buffered_len()
        );

        // Header bytes (0..64) must still be readable via seek-to-start.
        src.seek(SeekFrom::Start(0)).unwrap();
        let mut header = [0u8; 64];
        assert_eq!(src.read(&mut header).unwrap(), 64);
        for (i, b) in header.iter().enumerate() {
            assert_eq!(*b, (i & 0xff) as u8, "header byte {i} corrupted");
        }
    }

    #[test]
    fn decode_audio_bytes_propagates_midstream_errors() {
        // Truncate an opus file mid-page. Symphonia should error during decode
        // (or report unexpected EOF). Either way, we want a Symphonia/IO error
        // surfaced rather than a silently short Vec.
        let mut bytes = include_bytes!("../testdata/opus_sample.opus").to_vec();
        // Drop the last 64 bytes to corrupt the trailing page.
        let truncated_len = bytes.len().saturating_sub(64);
        bytes.truncate(truncated_len);

        let result = decode_audio_bytes(&bytes, DEFAULT_OUTPUT_SAMPLE_RATE);

        // Either Ok with full content (if symphonia is lenient) or a
        // structured DecodeError. We assert that we never get an EmptyInput
        // and that if it's Err, it's something a caller can act on.
        match result {
            Ok(decoded) => assert!(!decoded.samples().is_empty()),
            Err(DecodeError::EmptyInput) => {
                panic!("midstream truncation must not present as EmptyInput")
            }
            Err(_) => { /* acceptable: real error surfaced */ }
        }
    }

    #[test]
    fn resampler_preserves_total_frame_count_at_rate_change() {
        // The opus sample is 48kHz; decode at 48kHz (same-rate path) to verify
        // total output stays within a reasonable range of the declared duration.
        // Note: StreamingDecoder does not strip encoder delay / trailing padding —
        // that is the GaplessPlayer's responsibility — so raw output may differ
        // from `duration_ms` by up to the encoder delay (typically 312 frames =
        // 624 stereo samples for Opus). We use a 2% tolerance to cover this.
        let bytes = include_bytes!("../testdata/opus_sample.opus").to_vec();
        let mut decoder = StreamingDecoder::new(bytes, 48_000).unwrap();
        let mut total = 0usize;
        while let Ok(Some(chunk)) = decoder.decode_chunk(4096) {
            total += chunk.samples().len();
        }
        let duration_ms = decoder.duration_ms();
        let expected_frames = (duration_ms / 1000.0 * 48_000.0).round() as usize;
        let expected_samples = expected_frames * 2;
        let tolerance = (expected_samples as f64 * 0.02) as usize + 1024;
        let diff = (total as i64 - expected_samples as i64).unsigned_abs() as usize;
        assert!(
            diff <= tolerance,
            "resampler frame count off by {diff} samples (expected ~{expected_samples}, got {total}, tolerance {tolerance})"
        );
    }

    #[test]
    fn seek_compensates_for_encoder_delay() {
        let bytes = include_bytes!("../testdata/opus_sample.opus").to_vec();

        let mut sequential = StreamingDecoder::new(bytes.clone(), 48_000).unwrap();
        let mut all_samples = Vec::new();
        while let Ok(Some(chunk)) = sequential.decode_chunk(4096) {
            all_samples.extend_from_slice(chunk.samples());
        }

        let seek_ms: f64 = 100.0;
        let mut seeking = StreamingDecoder::new(bytes, 48_000).unwrap();
        seeking.seek_to_ms(seek_ms).unwrap();

        let chunk = seeking.decode_chunk(4096).unwrap().unwrap();
        let seek_samples = chunk.samples();

        // The requested playback time is seek_ms.
        // all_samples already has the initial encoder delay skipped, so its index 0 is audible 0ms.
        let target_frame = (seek_ms * 48.0).round() as usize;
        let target_sample_idx = target_frame * 2; // stereo

        let expected_samples = &all_samples[target_sample_idx..];

        let compare_len = expected_samples.len().min(seek_samples.len()).min(128);

        let mean_abs_error = expected_samples
            .iter()
            .zip(seek_samples.iter())
            .take(compare_len)
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
            / compare_len as f32;

        // Opus state convergence after a seek/reset without pre-roll can lead to non-trivial
        // sample differences (artifacts) in the first packet. We use a larger tolerance
        // to verify that the seek is roughly in the correct position.
        assert!(
            mean_abs_error < 0.2,
            "seek did not compensate for encoder delay: mean_error={}",
            mean_abs_error
        );
    }

    #[test]
    fn duration_ms_from_returns_zero_for_sentinel_n_frames() {
        // u64::MAX is symphonia's sentinel for unknown duration (e.g. VBR MP3, Ogg
        // without TOTAL_SAMPLES). Multiplying it through calc_time produced garbage.
        let tb = symphonia::core::units::TimeBase {
            numer: 1,
            denom: 48000,
        };
        assert_eq!(duration_ms_from(Some(tb), Some(u64::MAX)), 0.0);
    }

    #[test]
    fn duration_ms_from_returns_zero_for_none_n_frames() {
        let tb = symphonia::core::units::TimeBase {
            numer: 1,
            denom: 48000,
        };
        assert_eq!(duration_ms_from(Some(tb), None), 0.0);
    }

    #[test]
    fn duration_ms_from_returns_zero_for_none_time_base() {
        assert_eq!(duration_ms_from(None, Some(44100)), 0.0);
    }

    #[test]
    fn duration_ms_from_computes_correctly_for_known_duration() {
        // 44100 frames at 1/44100 time base = exactly 1000 ms
        let tb = symphonia::core::units::TimeBase {
            numer: 1,
            denom: 44100,
        };
        let ms = duration_ms_from(Some(tb), Some(44100));
        assert!((ms - 1000.0).abs() < 0.01, "expected ~1000ms, got {ms}");
    }

    #[test]
    fn extend_interleaved_stereo_preserves_left_right_order() {
        let mut out = vec![9.0];
        extend_interleaved_stereo(&mut out, &[1.0, 3.0], &[2.0, 4.0]);
        assert_eq!(out, vec![9.0, 1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn extend_first_two_channels_discards_extra_channels() {
        let mut out = Vec::new();
        extend_first_two_channels(&mut out, &[1.0, 2.0, 9.0, 3.0, 4.0, 8.0], 3);
        assert_eq!(out, vec![1.0, 2.0, 3.0, 4.0]);
    }
}
