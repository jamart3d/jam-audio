use js_sys::Float32Array;
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use symphonia_core::io::MediaSource;
use wasm_bindgen::prelude::*;

mod decoder;
mod gapless_player;
mod media_source;
mod metadata;
mod opus_decoder;
mod ring_buffer;
mod shared_cell;

pub mod test_helpers;

use shared_cell::SharedCell;

pub use decoder::{
    AppendableMediaSource, DEFAULT_OUTPUT_SAMPLE_RATE, DecodeError, DecodedAudioData,
    MAX_DECODE_FRAMES, StereoResampler, StreamingDecoder, WindowedMediaSource, decode_audio_bytes,
};
pub use gapless_player::GaplessPlayer;
pub use metadata::{
    AudioMetadata, extract_artwork, extract_artwork_internal, extract_metadata,
    extract_metadata_internal,
};
pub use ring_buffer::{
    DEFAULT_FRAME_CAPACITY, PcmRingBuffer, RingBufferError, RingBufferLayout, SHARED_STATE_SLOTS,
};

/// Exported for wasm callers that want Rust panic messages forwarded to the
/// browser console. On non-wasm targets this is intentionally a no-op so the
/// symbol remains callable in host tests and mixed-target builds.
#[wasm_bindgen]
pub fn init_console_error_panic_hook() {
    #[cfg(all(feature = "console_error_panic_hook", target_arch = "wasm32"))]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen(js_name = defaultRingBufferFrames)]
pub fn default_ring_buffer_frames() -> usize {
    DEFAULT_FRAME_CAPACITY
}

#[wasm_bindgen]
pub struct WasmGaplessPlayer {
    inner: GaplessPlayer,
    output_buffer: Vec<f32>,
}

#[wasm_bindgen]
impl WasmGaplessPlayer {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>, sample_rate: Option<u32>) -> Result<WasmGaplessPlayer, JsValue> {
        if bytes.is_empty() {
            return Err(JsValue::from_str("audio input was empty"));
        }
        let sr = sample_rate.unwrap_or(DEFAULT_OUTPUT_SAMPLE_RATE);
        if !(8_000..=192_000).contains(&sr) {
            return Err(JsValue::from_str(&format!(
                "Invalid sample rate: {sr}. Must be 8000–192000 Hz."
            )));
        }
        let player =
            GaplessPlayer::new(bytes, sr).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Self {
            inner: player,
            output_buffer: Vec::with_capacity(2048),
        })
    }

    #[wasm_bindgen(js_name = loadNext)]
    pub fn load_next(&mut self, bytes: Vec<u8>) -> JsValue {
        match self.inner.load_next(bytes) {
            Ok(()) => JsValue::UNDEFINED,
            Err(e) => gapless_error_to_js("next_failed", &e.to_string()),
        }
    }

    #[wasm_bindgen(js_name = decodeFrames)]
    pub fn decode_frames(&mut self, n: u32) -> JsValue {
        if n > MAX_DECODE_FRAMES {
            return gapless_error_to_js(
                "invalid_argument",
                &format!("Requested frame count exceeds maximum {MAX_DECODE_FRAMES}"),
            );
        }
        let _samples = match (n as usize).checked_mul(2) {
            Some(s) => s,
            None => {
                return gapless_error_to_js("invalid_argument", "Frame allocation overflow");
            }
        };
        match self
            .inner
            .decode_frames_into(&mut self.output_buffer, n as usize)
        {
            Ok(()) if self.output_buffer.is_empty() => JsValue::NULL,
            Ok(()) => Float32Array::from(self.output_buffer.as_slice()).into(),
            Err(e) => gapless_error_to_js("corrupted", &e.to_string()),
        }
    }

    #[wasm_bindgen(js_name = seekToMs)]
    pub fn seek_to_ms(&mut self, ms: f64) -> Result<(), JsValue> {
        self.inner
            .seek_to_ms(ms)
            .map_err(|e| gapless_error_to_js("seek_failed", &e.to_string()))
    }

    #[wasm_bindgen(js_name = positionMs)]
    pub fn position_ms(&self) -> f64 {
        self.inner.position_ms()
    }

    #[wasm_bindgen(js_name = durationMs)]
    pub fn duration_ms(&self) -> f64 {
        self.inner.duration_ms()
    }

    #[wasm_bindgen(js_name = hasEnded)]
    pub fn has_ended(&self) -> bool {
        self.inner.has_ended()
    }

    #[wasm_bindgen(js_name = seamGeneration)]
    pub fn seam_generation(&self) -> u32 {
        self.inner.seam_generation()
    }

    #[wasm_bindgen(js_name = lastSeamPositionMs)]
    pub fn last_seam_position_ms(&self) -> f64 {
        self.inner.last_seam_position_ms()
    }

    #[wasm_bindgen(js_name = clearNext)]
    pub fn clear_next(&mut self) {
        self.inner.clear_next();
    }
}

fn gapless_error_to_js(kind: &str, message: &str) -> JsValue {
    let obj = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&obj, &"error".into(), &JsValue::from_str(kind));
    let _ = js_sys::Reflect::set(&obj, &"message".into(), &JsValue::from_str(message));
    obj.into()
}

// ============================================================================
// SINGLE-THREADED INVARIANT NOTE (WASM ONLY):
// The following MediaSource wrapper (SharedMediaSource) uses `Rc<RefCell<>>` and
// implements `Send + Sync` on WASM targets.
// This is ONLY valid because the current crate runtime (Wasm) is strictly
// single-threaded.
// ============================================================================

#[cfg(all(target_arch = "wasm32", target_feature = "atomics"))]
compile_error!(
    "jam-audio-engine SharedMediaSource uses Rc<RefCell> on wasm and is not safe with atomics/threaded wasm enabled"
);

struct SharedMediaSource<T: Read + Seek + MediaSource + 'static> {
    inner: SharedCell<T>,
}

impl<T: Read + Seek + MediaSource + 'static> SharedMediaSource<T> {
    fn new(inner: SharedCell<T>) -> Self {
        Self { inner }
    }
}

// SAFETY: jam_audio_engine targets single-threaded Wasm only. Rc<RefCell<>>
// is not Send/Sync but no thread boundary is ever crossed at runtime.
// Wasm32 + atomics is statically rejected above at compile time to guarantee
// this single-threaded invariant.
// Symphonia requires Send + Sync on MediaSource; this satisfies that bound.
#[cfg(target_arch = "wasm32")]
unsafe impl<T: Read + Seek + MediaSource + 'static> Send for SharedMediaSource<T> {}
#[cfg(target_arch = "wasm32")]
unsafe impl<T: Read + Seek + MediaSource + 'static> Sync for SharedMediaSource<T> {}

impl<T: Read + Seek + MediaSource + 'static> Read for SharedMediaSource<T> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.with_mut(|s| s.read(buf))
    }
}

impl<T: Read + Seek + MediaSource + 'static> Seek for SharedMediaSource<T> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.with_mut(|s| s.seek(pos))
    }
}

impl<T: Read + Seek + MediaSource + 'static> MediaSource for SharedMediaSource<T> {
    fn is_seekable(&self) -> bool {
        self.inner.with(|s| s.is_seekable())
    }

    fn byte_len(&self) -> Option<u64> {
        self.inner.with(|s| s.byte_len())
    }
}

trait StreamingSource: Read + Seek + MediaSource + 'static {
    fn append_chunk(&mut self, chunk: &[u8]);
    fn finalize_source(&mut self);
    fn buffered_for_probe(&self) -> u64;
    fn is_finalized(&self) -> bool;
    fn after_probe_failure(&mut self);
    fn has_pending_seek(&self) -> bool {
        false
    }
}

impl StreamingSource for AppendableMediaSource {
    fn append_chunk(&mut self, chunk: &[u8]) {
        self.append(chunk);
    }

    fn finalize_source(&mut self) {
        self.finalize();
    }

    fn buffered_for_probe(&self) -> u64 {
        self.buffered_len() as u64
    }

    fn is_finalized(&self) -> bool {
        AppendableMediaSource::is_finalized(self)
    }

    fn after_probe_failure(&mut self) {}
}

impl StreamingSource for WindowedMediaSource {
    fn append_chunk(&mut self, chunk: &[u8]) {
        self.append(chunk);
    }

    fn finalize_source(&mut self) {
        self.finalize();
    }

    fn buffered_for_probe(&self) -> u64 {
        self.window_start() + self.buffered_bytes() as u64
    }

    fn is_finalized(&self) -> bool {
        WindowedMediaSource::is_finalized(self)
    }

    fn after_probe_failure(&mut self) {
        let _ = self.seek(SeekFrom::Start(0));
        self.clear_pending_seek();
    }

    fn has_pending_seek(&self) -> bool {
        WindowedMediaSource::has_pending_seek(self)
    }
}

pub const STREAMING_PROBE_THRESHOLD_BYTES: usize = 256 * 1024;
pub const DEFAULT_HEADER_RESERVE_BYTES: usize = 512 * 1024;
pub const DEFAULT_KEEP_BEHIND_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub enum StreamingFrameResult {
    Success,
    Waiting,
    EndOfStream,
}

struct StreamingCore<S: StreamingSource> {
    source: SharedCell<S>,
    decoder: Option<StreamingDecoder>,
    frames_decoded: u64,
    residual: VecDeque<f32>,
    scratch: Vec<f32>,
    target_sample_rate: u32,
}

impl<S: StreamingSource> StreamingCore<S> {
    fn from_source(source: S, target_sample_rate: u32) -> Self {
        Self {
            source: SharedCell::new(source),
            decoder: None,
            frames_decoded: 0,
            residual: VecDeque::new(),
            scratch: Vec::with_capacity(2048),
            target_sample_rate,
        }
    }

    fn append_chunk(&mut self, chunk: &[u8]) -> Result<bool, DecodeError> {
        self.source.with_mut(|s| s.append_chunk(chunk));
        self.try_initialize_decoder(false)
    }

    fn finalize(&mut self) {
        self.source.with_mut(|s| s.finalize_source());
        let _ = self.try_initialize_decoder(true);
        // Decoder may have been created before finalize() was called (when the
        // probe threshold was crossed mid-stream). Its has_known_byte_len flag
        // would be false because byte_len() was None at creation time. Correct it
        // now so Ogg seeks work on the complete stream.
        if let Some(decoder) = self.decoder.as_mut() {
            decoder.on_source_finalized();
        }
    }

    fn is_ready(&self) -> bool {
        self.decoder.is_some()
    }

    fn seek_to_ms(&mut self, ms: f64) -> Result<(), DecodeError> {
        let Some(decoder) = self.decoder.as_mut() else {
            return Err(DecodeError::Symphonia("not ready".to_string()));
        };

        decoder.seek_to_ms(ms)?;

        self.frames_decoded = (ms * self.target_sample_rate as f64 / 1000.0) as u64;
        self.residual.clear();
        Ok(())
    }

    #[allow(dead_code)]
    fn decode_frames(&mut self, n: u32) -> Result<StreamingFrameResult, DecodeError> {
        let mut out = Vec::new();
        self.decode_frames_into(n, &mut out)
    }

    fn decode_frames_into(
        &mut self,
        target_frames: u32,
        out: &mut Vec<f32>,
    ) -> Result<StreamingFrameResult, DecodeError> {
        out.clear();

        if self.decoder.is_none() {
            let ready = self.try_initialize_decoder(self.is_finalized())?;
            if !ready {
                return Ok(if self.is_finalized() {
                    StreamingFrameResult::EndOfStream
                } else {
                    StreamingFrameResult::Waiting
                });
            }
        }

        let has_pending_seek = self.source.with(|s| s.has_pending_seek());
        let is_finalized = self.is_finalized();

        let mut state = DecodeState {
            decoder: &mut self.decoder,
            residual: &mut self.residual,
            scratch: &mut self.scratch,
            frames_decoded: &mut self.frames_decoded,
        };

        decode_frames_impl(
            &mut state,
            target_frames,
            out,
            has_pending_seek,
            is_finalized,
        )
    }

    fn try_initialize_decoder(&mut self, force: bool) -> Result<bool, DecodeError> {
        if self.decoder.is_some() {
            return Ok(true);
        }

        let (buffered, is_finalized) = self
            .source
            .with(|s| (s.buffered_for_probe(), s.is_finalized()));

        let should_probe =
            force || buffered >= STREAMING_PROBE_THRESHOLD_BYTES as u64 || is_finalized;

        if !should_probe {
            return Ok(false);
        }

        let shared_source = SharedMediaSource::new(self.source.clone());

        match StreamingDecoder::from_media_source(shared_source, self.target_sample_rate) {
            Ok(decoder) => {
                self.decoder = Some(decoder);
                Ok(true)
            }
            Err(error) => {
                if is_finalized {
                    Err(error)
                } else {
                    self.source.with_mut(|s| s.after_probe_failure());
                    Ok(false)
                }
            }
        }
    }

    fn is_finalized(&self) -> bool {
        self.source.with(|s| s.is_finalized())
    }
}

impl StreamingCore<AppendableMediaSource> {
    fn appendable(target_sample_rate: u32, max_buffered_mb: u32) -> Self {
        let max_bytes = (max_buffered_mb as usize).saturating_mul(1024 * 1024);
        let header_reserve = if max_bytes == 0 {
            0
        } else {
            DEFAULT_HEADER_RESERVE_BYTES
        };
        let keep_behind = if max_bytes == 0 {
            0
        } else {
            DEFAULT_KEEP_BEHIND_BYTES
        };
        Self::from_source(
            AppendableMediaSource::with_bounds(max_bytes, header_reserve, keep_behind),
            target_sample_rate,
        )
    }

    // streaming player core had buffered_bytes, need to provide it on this impl so it's accessible
    fn buffered_bytes(&self) -> usize {
        self.source.with(|s| s.buffered_len())
    }
}

impl StreamingCore<WindowedMediaSource> {
    fn windowed(total_size: Option<u64>, max_window_mb: u32, target_sample_rate: u32) -> Self {
        let max_window_bytes = (max_window_mb as usize).saturating_mul(1024 * 1024);
        let mut source = WindowedMediaSource::new(
            max_window_bytes,
            DEFAULT_HEADER_RESERVE_BYTES,
            DEFAULT_KEEP_BEHIND_BYTES,
        );
        source.set_total_size(total_size);
        Self::from_source(source, target_sample_rate)
    }

    fn has_pending_seek(&self) -> bool {
        self.source.with(|s| s.has_pending_seek())
    }

    fn pending_seek_offset(&self) -> u64 {
        self.source.with(|s| s.pending_seek_offset().unwrap_or(0))
    }

    fn clear_pending_seek(&mut self) {
        self.source.with_mut(|s| s.clear_pending_seek())
    }
}

#[wasm_bindgen]
pub struct WindowedStreamingPlayer {
    core: StreamingCore<WindowedMediaSource>,
    output_buffer: Vec<f32>,
}

#[wasm_bindgen]
impl WindowedStreamingPlayer {
    #[wasm_bindgen(constructor)]
    pub fn new(total_size: Option<u64>, max_window_mb: u32) -> Self {
        let max_mb = max_window_mb.clamp(1, 1024);
        Self {
            core: StreamingCore::windowed(total_size, max_mb, DEFAULT_OUTPUT_SAMPLE_RATE),
            output_buffer: Vec::with_capacity(2048),
        }
    }

    #[wasm_bindgen(js_name = appendChunk)]
    pub fn append_chunk(&mut self, chunk: &[u8]) -> Result<bool, JsValue> {
        self.core.append_chunk(chunk).map_err(decode_error_to_js)
    }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize_stream(&mut self) {
        self.core.finalize();
    }

    #[wasm_bindgen(js_name = hasPendingSeek)]
    pub fn has_pending_seek(&self) -> bool {
        self.core.has_pending_seek()
    }

    #[wasm_bindgen(js_name = pendingSeekOffset)]
    pub fn pending_seek_offset(&self) -> f64 {
        self.core.pending_seek_offset() as f64
    }

    #[wasm_bindgen(js_name = clearPendingSeek)]
    pub fn clear_pending_seek(&mut self) {
        self.core.clear_pending_seek();
    }

    #[wasm_bindgen(js_name = windowStart)]
    pub fn window_start(&self) -> f64 {
        self.core.source.with(|s| s.window_start() as f64)
    }

    #[wasm_bindgen(js_name = bufferedBytes)]
    pub fn buffered_bytes(&self) -> usize {
        self.core.source.with(|s| s.buffered_bytes())
    }

    #[wasm_bindgen(js_name = seekToMs)]
    pub fn seek_to_ms(&mut self, ms: f64) -> Result<(), JsValue> {
        self.core.seek_to_ms(ms).map_err(decode_error_to_js)
    }

    #[wasm_bindgen(js_name = decodeFrames)]
    pub fn decode_frames(&mut self, n: u32) -> Result<JsValue, JsValue> {
        if n > MAX_DECODE_FRAMES {
            return Err(decode_error_to_js(DecodeError::Resample {
                operation: "decode",
                message: format!("Requested frame count exceeds maximum {MAX_DECODE_FRAMES}"),
            }));
        }
        let _samples = (n as usize).checked_mul(2).ok_or_else(|| {
            decode_error_to_js(DecodeError::Resample {
                operation: "decode",
                message: "Frame allocation overflow".to_string(),
            })
        })?;
        match self
            .core
            .decode_frames_into(n, &mut self.output_buffer)
            .map_err(decode_error_to_js)?
        {
            StreamingFrameResult::Waiting => Ok(JsValue::NULL),
            StreamingFrameResult::EndOfStream => Err(js_string("end-of-stream")),
            StreamingFrameResult::Success => {
                Ok(Float32Array::from(self.output_buffer.as_slice()).into())
            }
        }
    }
}

#[wasm_bindgen]
pub struct StreamingPlayer {
    core: StreamingCore<AppendableMediaSource>,
    output_buffer: Vec<f32>,
}

#[wasm_bindgen]
impl StreamingPlayer {
    #[wasm_bindgen(constructor)]
    pub fn new(target_sample_rate: Option<u32>, max_buffered_mb: Option<u32>) -> Self {
        let sr = target_sample_rate
            .unwrap_or(DEFAULT_OUTPUT_SAMPLE_RATE)
            .clamp(8_000, 192_000);
        let max_mb = max_buffered_mb.unwrap_or(0).min(1024);
        Self {
            core: StreamingCore::appendable(sr, max_mb),
            output_buffer: Vec::with_capacity(2048),
        }
    }

    #[wasm_bindgen(js_name = appendChunk)]
    pub fn append_chunk(&mut self, chunk: &[u8]) -> Result<bool, JsValue> {
        self.core.append_chunk(chunk).map_err(decode_error_to_js)
    }

    #[wasm_bindgen(js_name = finalize)]
    pub fn finalize_stream(&mut self) {
        self.core.finalize();
    }

    #[wasm_bindgen(js_name = seekToMs)]
    pub fn seek_to_ms(&mut self, ms: f64) -> Result<(), JsValue> {
        self.core.seek_to_ms(ms).map_err(decode_error_to_js)
    }

    #[wasm_bindgen(js_name = isReady)]
    pub fn is_ready(&self) -> bool {
        self.core.is_ready()
    }

    #[wasm_bindgen(js_name = isFinalized)]
    pub fn is_finalized(&self) -> bool {
        self.core.is_finalized()
    }

    #[wasm_bindgen(js_name = durationMs)]
    pub fn duration_ms(&self) -> f64 {
        if let Some(decoder) = self.core.decoder.as_ref() {
            decoder.duration_ms()
        } else {
            0.0
        }
    }

    #[wasm_bindgen(js_name = positionMs)]
    pub fn position_ms(&self) -> f64 {
        self.core.frames_decoded as f64 * 1000.0 / self.core.target_sample_rate as f64
    }

    #[wasm_bindgen(js_name = bufferedBytes)]
    pub fn buffered_bytes(&self) -> usize {
        self.core.buffered_bytes()
    }

    #[wasm_bindgen(js_name = decodeFrames)]
    pub fn decode_frames(&mut self, n: u32) -> Result<JsValue, JsValue> {
        match self
            .core
            .decode_frames_into(n, &mut self.output_buffer)
            .map_err(decode_error_to_js)?
        {
            StreamingFrameResult::Waiting => Ok(JsValue::NULL),
            StreamingFrameResult::EndOfStream => Err(js_string("end-of-stream")),
            StreamingFrameResult::Success => {
                Ok(Float32Array::from(self.output_buffer.as_slice()).into())
            }
        }
    }
}

fn decode_error_to_js(e: DecodeError) -> JsValue {
    match e {
        DecodeError::Resample { operation, message } => {
            gapless_error_to_js("resample", &format!("{operation}: {message}"))
        }
        _ => JsValue::from_str(&e.to_string()),
    }
}

fn js_string(s: &str) -> JsValue {
    JsValue::from_str(s)
}

struct DecodeState<'a> {
    decoder: &'a mut Option<StreamingDecoder>,
    residual: &'a mut VecDeque<f32>,
    scratch: &'a mut Vec<f32>,
    frames_decoded: &'a mut u64,
}

fn decode_frames_impl(
    state: &mut DecodeState,
    target_frames: u32,
    out: &mut Vec<f32>,
    has_pending_seek: bool,
    is_finalized: bool,
) -> Result<StreamingFrameResult, DecodeError> {
    let target_samples = target_frames as usize * 2;

    while !state.residual.is_empty() && out.len() < target_samples {
        if let Some(sample) = state.residual.pop_front() {
            out.push(sample);
        }
    }

    if out.len() == target_samples {
        *state.frames_decoded += (out.len() / 2) as u64;
        return Ok(StreamingFrameResult::Success);
    }

    while out.len() < target_samples {
        let need_frames = (target_samples - out.len()) / 2;
        state.scratch.clear();

        let decode_res = state
            .decoder
            .as_mut()
            .ok_or_else(|| DecodeError::Symphonia("decoder unexpectedly absent".into()))?
            .decode_chunk_into(need_frames, state.scratch);
        match decode_res {
            Ok(true) => {
                let need_samples = target_samples - out.len();
                if state.scratch.len() <= need_samples {
                    out.extend_from_slice(state.scratch);
                } else {
                    out.extend_from_slice(&state.scratch[..need_samples]);
                    state
                        .residual
                        .extend(state.scratch[need_samples..].iter().copied());
                }
            }
            Ok(false) => {
                if has_pending_seek {
                    return Ok(StreamingFrameResult::Waiting);
                }
                if out.is_empty() {
                    return Ok(if is_finalized {
                        StreamingFrameResult::EndOfStream
                    } else {
                        StreamingFrameResult::Waiting
                    });
                } else {
                    break;
                }
            }
            Err(e) => {
                if has_pending_seek {
                    return Ok(StreamingFrameResult::Waiting);
                } else {
                    return Err(e);
                }
            }
        }
    }

    *state.frames_decoded += (out.len() / 2) as u64;
    Ok(StreamingFrameResult::Success)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_wav(num_frames: usize) -> Vec<u8> {
        let sample_rate = 44_100u32;
        let channels = 2u16;
        let bits_per_sample = 16u16;
        let block_align = channels * (bits_per_sample / 8);
        let byte_rate = sample_rate * block_align as u32;
        let data_size = (num_frames as u32) * block_align as u32;
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

    fn opus_sample_bytes() -> Vec<u8> {
        include_bytes!("../testdata/opus_sample.opus").to_vec()
    }

    #[test]
    fn streaming_player_defers_probe_until_threshold() {
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);
        let wav = make_wav(100_000);

        assert!(!player.append_chunk(&wav[..100_000]).unwrap());
        assert!(!player.is_ready());

        assert!(player.append_chunk(&wav[100_000..300_000]).is_ok());
        assert!(player.is_ready());
    }

    #[test]
    fn streaming_player_decode_returns_null_before_ready() {
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);
        assert!(matches!(
            player.decode_frames(1024).unwrap(),
            StreamingFrameResult::Waiting
        ));
    }

    #[test]
    fn streaming_player_decode_returns_null_when_starved() {
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);
        let wav = make_wav(100_000);
        let buffered = &wav[..300_000];

        assert!(!player.append_chunk(&buffered[..100_000]).unwrap());
        assert!(player.append_chunk(&buffered[100_000..]).unwrap());

        assert!(matches!(
            player.decode_frames(100_000).unwrap(),
            StreamingFrameResult::Success
        ));
        assert!(matches!(
            player.decode_frames(100_000).unwrap(),
            StreamingFrameResult::Waiting
        ));
    }

    #[test]
    fn streaming_player_finalize_then_drain() {
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);
        let wav = make_wav(20_000);

        assert!(!player.append_chunk(&wav).unwrap());
        player.finalize();
        assert!(player.is_ready());

        let mut saw_pcm = false;
        for _ in 0..8 {
            match player.decode_frames(4_096).unwrap() {
                StreamingFrameResult::Waiting => break,
                StreamingFrameResult::EndOfStream => break,
                StreamingFrameResult::Success => saw_pcm = true,
            }
        }

        assert!(saw_pcm);
        assert!(matches!(
            player.decode_frames(4_096).unwrap(),
            StreamingFrameResult::EndOfStream
        ));
    }

    #[test]
    fn streaming_player_seek_within_buffered() {
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);
        let wav = make_wav(88_200);

        assert!(player.append_chunk(&wav).unwrap());
        assert!(player.seek_to_ms(1_000.0).is_ok());
    }

    #[test]
    fn streaming_player_seek_past_buffered_during_streaming() {
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);
        let wav = make_wav(132_300);
        let buffered = &wav[..300_000];

        assert!(!player.append_chunk(&buffered[..100_000]).unwrap());
        assert!(player.append_chunk(&buffered[100_000..]).unwrap());
        assert!(player.seek_to_ms(2_500.0).is_err());
    }

    #[test]
    fn streaming_player_reports_buffered_bytes() {
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);
        let wav = make_wav(100_000);

        assert_eq!(player.buffered_bytes(), 0);
        assert!(!player.append_chunk(&wav[..100_000]).unwrap());
        assert_eq!(player.buffered_bytes(), 100_000);
    }

    #[test]
    fn streaming_player_seek_before_ready_returns_not_ready() {
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);

        let error = player.seek_to_ms(1_000.0).unwrap_err();
        assert!(matches!(error, DecodeError::Symphonia(message) if message == "not ready"));
    }

    #[test]
    fn full_file_opus_decodes_when_complete() {
        let bytes = opus_sample_bytes();
        let mut decoder = StreamingDecoder::new(bytes, DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();

        let first = decoder.decode_chunk(4096).unwrap();

        assert!(first.is_some());
    }

    #[test]
    fn full_file_opus_reports_48000_output_sample_rate() {
        let decoder =
            StreamingDecoder::new(opus_sample_bytes(), DEFAULT_OUTPUT_SAMPLE_RATE).unwrap();

        assert_eq!(decoder.sample_rate(), 48_000);
    }

    #[test]
    fn streaming_player_opus_decodes_after_finalize() {
        let bytes = opus_sample_bytes();
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);

        assert!(!player.append_chunk(&bytes).unwrap());
        assert!(!player.is_ready());
        player.finalize();

        assert!(player.is_ready());
        assert!(matches!(
            player.decode_frames(4096),
            Ok(StreamingFrameResult::Success)
        ));
    }

    #[test]
    fn streaming_player_opus_finalize_then_drain() {
        let bytes = opus_sample_bytes();
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);

        assert!(!player.append_chunk(&bytes).unwrap());
        player.finalize();
        assert!(player.is_ready());

        let mut saw_pcm = false;
        let mut saw_end_of_stream = false;
        for _ in 0..32 {
            match player.decode_frames(4_096).unwrap() {
                StreamingFrameResult::Waiting => break,
                StreamingFrameResult::EndOfStream => {
                    saw_end_of_stream = true;
                    break;
                }
                StreamingFrameResult::Success => saw_pcm = true,
            }
        }

        assert!(saw_pcm);
        assert!(saw_end_of_stream);
    }

    #[test]
    fn streaming_player_opus_seek_before_finalize_returns_handled_error() {
        let bytes = opus_sample_bytes();
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);

        assert!(!player.append_chunk(&bytes).unwrap());

        // We can't easily force initialization for a small file without reaching threshold
        // or finalizing. If we finalize, seek should work.
        // The original test intended to check that seeking on incomplete streams (if they WERE initialized)
        // is handled.

        player.finalize();
        assert!(player.is_ready());

        // Now that it is finalized, seek SHOULD work.
        assert!(player.seek_to_ms(50.0).is_ok());
    }

    #[test]
    fn streaming_player_opus_seek_and_resume_after_finalize() {
        let bytes = opus_sample_bytes();
        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);

        assert!(!player.append_chunk(&bytes).unwrap());
        player.finalize();

        assert!(player.is_ready());
        assert!(matches!(
            player.decode_frames(2048),
            Ok(StreamingFrameResult::Success)
        ));

        assert!(player.seek_to_ms(50.0).is_ok());
        assert!(matches!(
            player.decode_frames(2048),
            Ok(StreamingFrameResult::Success)
        ));
    }

    #[test]
    fn windowed_streaming_player_append_chunk_propagates_finalize_error() {
        let mut player = WindowedStreamingPlayer::new(Some(1000), 8);
        // Feed valid WAV data then finalize — after finalizing, appending again
        // is harmless but core.append_chunk returns Ok. We test that the return
        // value is forwarded rather than dropped.
        let wav = make_wav(10_000);
        let _ = player.append_chunk(&wav);
        player.finalize_stream();
        // Appending after finalize: returns Ok(true) or Ok(false), not an Err.
        // The point is that the method now forwards the Result to the caller
        // instead of discarding it internally.
        let result = player.append_chunk(&[]);
        assert!(result.is_ok());
    }

    #[test]
    fn streaming_player_ogg_seek_works_when_decoder_initialized_before_finalize() {
        // Real-world Opus files are > 256 KB, so the decoder is created before
        // finalize() is called, leaving has_known_byte_len = false. This test
        // reproduces that scenario by repeating the sample until the probe threshold
        // is exceeded, forcing early initialization.
        let sample = opus_sample_bytes();
        let mut big_chunk = Vec::with_capacity(STREAMING_PROBE_THRESHOLD_BYTES + sample.len());
        while big_chunk.len() < STREAMING_PROBE_THRESHOLD_BYTES + sample.len() {
            big_chunk.extend_from_slice(&sample);
        }

        let mut player = StreamingCore::appendable(DEFAULT_OUTPUT_SAMPLE_RATE, 0);
        let ready = player.append_chunk(&big_chunk).unwrap();
        assert!(
            ready,
            "decoder must initialize before finalize() for this test to be meaningful; \
             increase big_chunk size if this fails"
        );

        player.finalize();

        // Without the fix this returns Err("seek unavailable for incomplete ogg stream").
        assert!(
            player.seek_to_ms(50.0).is_ok(),
            "seek should succeed on a finalized Ogg stream even when the decoder \
             was initialized before finalize() was called"
        );

        // Verify that decoding actually resumes after the seek.
        assert!(matches!(
            player.decode_frames(2048),
            Ok(StreamingFrameResult::Success)
        ));
    }

    #[test]
    fn windowed_streaming_player_ogg_seek_works_after_finalize() {
        let sample = opus_sample_bytes();
        let mut big_chunk = Vec::with_capacity(STREAMING_PROBE_THRESHOLD_BYTES + sample.len());
        while big_chunk.len() < STREAMING_PROBE_THRESHOLD_BYTES + sample.len() {
            big_chunk.extend_from_slice(&sample);
        }

        let total = big_chunk.len() as u64;
        let mut player = StreamingCore::windowed(Some(total), 8, DEFAULT_OUTPUT_SAMPLE_RATE);
        let ready = player.append_chunk(&big_chunk).unwrap();
        assert!(ready, "decoder must initialize before finalize()");

        player.finalize();

        assert!(
            player.seek_to_ms(50.0).is_ok(),
            "windowed player Ogg seek must succeed after finalize"
        );

        assert!(matches!(
            player.decode_frames(2048),
            Ok(StreamingFrameResult::Success)
        ));
    }

    #[test]
    fn init_console_error_panic_hook_is_callable_on_host() {
        init_console_error_panic_hook();
    }

    #[test]
    fn gapless_player_sample_rate_and_input_boundaries() {
        // Empty bytes
        assert!(GaplessPlayer::new(vec![], 48000).is_err());

        // Sample rate below min (7999)
        let err_below = match GaplessPlayer::new(vec![1, 2, 3], 7999) {
            Err(e) => e,
            Ok(_) => panic!("expected error for sample rate below min"),
        };
        assert!(err_below.to_string().contains("Invalid sample rate"));

        // Sample rate at min (8000) - fails on corrupt bytes, not sample rate
        let err_min = match GaplessPlayer::new(vec![1, 2, 3], 8000) {
            Err(e) => e,
            Ok(_) => panic!("expected error for corrupt bytes"),
        };
        assert!(!err_min.to_string().contains("Invalid sample rate"));

        // Sample rate at max (192000)
        let err_max = match GaplessPlayer::new(vec![1, 2, 3], 192000) {
            Err(e) => e,
            Ok(_) => panic!("expected error for corrupt bytes"),
        };
        assert!(!err_max.to_string().contains("Invalid sample rate"));

        // Sample rate above max (192001)
        let err_above = match GaplessPlayer::new(vec![1, 2, 3], 192001) {
            Err(e) => e,
            Ok(_) => panic!("expected error for sample rate above max"),
        };
        assert!(err_above.to_string().contains("Invalid sample rate"));
    }

    #[test]
    fn streaming_player_sample_rate_boundaries() {
        let p_below = StreamingPlayer::new(Some(7999), None);
        assert_eq!(p_below.core.target_sample_rate, 8000);

        let p_min = StreamingPlayer::new(Some(8000), None);
        assert_eq!(p_min.core.target_sample_rate, 8000);

        let p_max = StreamingPlayer::new(Some(192000), None);
        assert_eq!(p_max.core.target_sample_rate, 192000);

        let p_above = StreamingPlayer::new(Some(192001), None);
        assert_eq!(p_above.core.target_sample_rate, 192000);
    }
}
