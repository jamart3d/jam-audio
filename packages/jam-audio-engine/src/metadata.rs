use wasm_bindgen::prelude::*;
use js_sys::{Object, Reflect};
use std::io::{Cursor, Read, Seek, SeekFrom};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::{MetadataOptions, StandardTagKey};
use symphonia::core::probe::Hint;
use symphonia::default::get_probe;

/// Typed metadata for an audio track.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AudioMetadata {
    /// Track title.
    pub title: Option<String>,
    /// Primary artist.
    pub artist: Option<String>,
    /// Album name.
    pub album: Option<String>,
    /// Track number on the album.
    pub track_number: Option<u32>,
    /// Total duration in milliseconds.
    pub duration_ms: Option<f64>,
}

fn apply_tags(result: &mut AudioMetadata, tags: &[symphonia::core::meta::Tag], overwrite: bool) {
    for tag in tags {
        match tag.std_key {
            Some(StandardTagKey::TrackTitle) => result.title = Some(tag.value.to_string()),
            Some(StandardTagKey::Artist) => result.artist = Some(tag.value.to_string()),
            Some(StandardTagKey::Album) => result.album = Some(tag.value.to_string()),
            Some(StandardTagKey::TrackNumber) if overwrite || result.track_number.is_none() => {
                result.track_number = tag.value.to_string().parse::<u32>().ok();
            }
            _ => {}
        }
    }
}

/// Internal shared parser for audio metadata.
pub fn extract_metadata_internal(data: &[u8]) -> AudioMetadata {
    let mut result = AudioMetadata::default();

    if data.is_empty() {
        return result;
    }

    let shared_data = Arc::from(data);
    let media_source = InMemoryMediaSource::new(shared_data);
    let media_stream = MediaSourceStream::new(Box::new(media_source), Default::default());
    let hint = Hint::new();

    let mut probed = match get_probe().format(
        &hint,
        media_stream,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) {
        Ok(p) => p,
        Err(_) => return result,
    };

    // Check default track for duration
    if let Some(track) = probed.format.default_track()
        && let Some(time) = track
            .codec_params
            .time_base
            .and_then(|tb| track.codec_params.n_frames.map(|n| tb.calc_time(n)))
    {
        result.duration_ms = Some((time.seconds as f64 * 1000.0) + (time.frac * 1000.0));
    }

    // Try container metadata first
    if let Some(metadata) = probed.format.metadata().current() {
        apply_tags(&mut result, metadata.tags(), true);
    }

    // Try metadata block
    if (result.title.is_none() || result.artist.is_none())
        && let Some(metadata) = probed.metadata.get().as_ref().and_then(|m| m.current())
    {
        apply_tags(&mut result, metadata.tags(), false);
    }

    result
}

#[wasm_bindgen(js_name = extractMetadata)]
pub fn extract_metadata(data: &[u8]) -> JsValue {
    let metadata = extract_metadata_internal(data);
    let obj = Object::new();

    if let Some(title) = metadata.title {
        let _ = Reflect::set(&obj, &JsValue::from_str("title"), &JsValue::from_str(&title));
    }
    if let Some(artist) = metadata.artist {
        let _ = Reflect::set(&obj, &JsValue::from_str("artist"), &JsValue::from_str(&artist));
    }
    if let Some(album) = metadata.album {
        let _ = Reflect::set(&obj, &JsValue::from_str("album"), &JsValue::from_str(&album));
    }
    if let Some(track_number) = metadata.track_number {
        let _ = Reflect::set(&obj, &JsValue::from_str("trackNumber"), &JsValue::from_f64(track_number as f64));
    }
    if let Some(duration_ms) = metadata.duration_ms {
        let _ = Reflect::set(&obj, &JsValue::from_str("durationMs"), &JsValue::from_f64(duration_ms));
    }

    obj.into()
}

use std::sync::Arc;

struct InMemoryMediaSource {
    inner: Cursor<Arc<[u8]>>,
}

impl InMemoryMediaSource {
    fn new(bytes: Arc<[u8]>) -> Self {
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

pub fn extract_artwork_internal(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() {
        return None;
    }

    let shared_data = Arc::from(data);
    let media_source = InMemoryMediaSource::new(shared_data);
    let media_stream = MediaSourceStream::new(Box::new(media_source), Default::default());
    let hint = Hint::new();

    let mut probed = match get_probe().format(
        &hint,
        media_stream,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) {
        Ok(p) => p,
        Err(_) => return None,
    };

    // Try format metadata first
    if let Some(metadata) = probed.format.metadata().current()
        && let Some(visual) = metadata.visuals().iter().next()
    {
        return Some(visual.data.to_vec());
    }

    // Try global metadata block
    if let Some(metadata) = probed.metadata.get().as_ref().and_then(|m| m.current())
        && let Some(visual) = metadata.visuals().iter().next()
    {
        return Some(visual.data.to_vec());
    }

    None
}

#[wasm_bindgen(js_name = extractArtwork)]
pub fn extract_artwork(data: &[u8]) -> Option<Vec<u8>> {
    extract_artwork_internal(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_metadata_internal_returns_empty_for_empty_input() {
        let metadata = extract_metadata_internal(&[]);
        assert_eq!(metadata, AudioMetadata::default());
    }

    #[test]
    fn extract_metadata_internal_returns_empty_for_invalid_input() {
        let metadata = extract_metadata_internal(&[1, 2, 3, 4]);
        assert_eq!(metadata, AudioMetadata::default());
    }

    #[test]
    fn extract_metadata_internal_parses_sample_file() {
        let data = std::fs::read("testdata/opus_sample.opus").expect("failed to read sample file");
        let metadata = extract_metadata_internal(&data);
        
        assert_eq!(metadata.duration_ms, Some(1020.0));
        assert!(metadata.title.is_none());
        assert!(metadata.artist.is_none());
    }
}
