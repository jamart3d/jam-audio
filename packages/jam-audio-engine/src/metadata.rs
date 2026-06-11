use crate::media_source::{InMemoryMediaSource, SizedMediaSource};
use std::sync::Arc;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::{MetadataOptions, StandardTagKey};
use symphonia::core::probe::Hint;
use symphonia::core::units::TimeBase;
use symphonia::default::get_probe;
use wasm_bindgen::prelude::*;

/// Typed metadata for an audio track.
#[wasm_bindgen]
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AudioMetadata {
    /// Track title.
    title: Option<String>,
    /// Primary artist.
    artist: Option<String>,
    /// Album name.
    album: Option<String>,
    /// Track number on the album.
    track_number: Option<u32>,
    /// Total duration in milliseconds.
    duration_ms: Option<f64>,
}

fn duration_ms_from(time_base: Option<TimeBase>, n_frames: Option<u64>) -> f64 {
    match (time_base, n_frames) {
        (Some(tb), Some(n)) if n != u64::MAX => {
            let t = tb.calc_time(n);
            t.seconds as f64 * 1000.0 + t.frac * 1000.0
        }
        _ => 0.0,
    }
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
    extract_metadata_with_size_internal(data, 0)
}

/// Internal shared parser for audio metadata with an optional total file size hint.
/// This is particularly important for MP3 files where duration is calculated from file size.
pub fn extract_metadata_with_size_internal(data: &[u8], total_file_size: u64) -> AudioMetadata {
    let mut result = AudioMetadata::default();

    if data.is_empty() {
        return result;
    }

    let shared_data = Arc::from(data);

    let media_source: Box<dyn MediaSource> = if total_file_size > 0 {
        Box::new(SizedMediaSource::new(shared_data, total_file_size))
    } else {
        Box::new(InMemoryMediaSource::new(shared_data))
    };

    let media_stream = MediaSourceStream::new(media_source, Default::default());
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
    if let Some(track) = probed.format.default_track() {
        result.duration_ms = Some(duration_ms_from(
            track.codec_params.time_base,
            track.codec_params.n_frames,
        ));
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

#[wasm_bindgen]
impl AudioMetadata {
    #[wasm_bindgen(getter)]
    pub fn title(&self) -> Option<String> {
        self.title.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn artist(&self) -> Option<String> {
        self.artist.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn album(&self) -> Option<String> {
        self.album.clone()
    }
    #[wasm_bindgen(getter = trackNumber)]
    pub fn track_number(&self) -> Option<u32> {
        self.track_number
    }
    #[wasm_bindgen(getter = durationMs)]
    pub fn duration_ms(&self) -> Option<f64> {
        self.duration_ms
    }
}

#[wasm_bindgen(js_name = extractMetadata)]
pub fn extract_metadata(data: &[u8]) -> AudioMetadata {
    extract_metadata_internal(data)
}

#[wasm_bindgen(js_name = extractMetadataWithSize)]
pub fn extract_metadata_with_size(data: &[u8], total_file_size: u64) -> AudioMetadata {
    extract_metadata_with_size_internal(data, total_file_size)
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

    #[test]
    fn extract_metadata_with_size_internal_uses_provided_size() {
        let data = std::fs::read("testdata/opus_sample.opus").expect("failed to read sample file");

        // For Opus, duration is usually in the container, so providing a wrong size
        // might not change duration, but we can at least verify it doesn't crash
        // and returns the same metadata if the size is correct or irrelevant.
        let metadata = extract_metadata_with_size_internal(&data, data.len() as u64);
        assert_eq!(metadata.duration_ms, Some(1020.0));
    }

    #[test]
    fn extract_metadata_with_size_internal_calculates_mp3_duration_from_total_size() {
        // Symphonia estimates MP3 duration from multiple valid frame headers.
        // Build a short synthetic CBR stream and then report a much larger total size.
        const FRAME_HEADER: [u8; 4] = [0xFF, 0xFB, 0x90, 0xC0];
        const FRAME_LEN: usize = 417;
        const FRAME_COUNT: usize = 20;

        let mut data = vec![0u8; FRAME_LEN * FRAME_COUNT];
        for frame_idx in 0..FRAME_COUNT {
            let offset = frame_idx * FRAME_LEN;
            data[offset..offset + FRAME_HEADER.len()].copy_from_slice(&FRAME_HEADER);
        }

        // Without a larger file size hint, duration should reflect the buffered bytes only.
        let meta1 = extract_metadata_with_size_internal(&data, 0);
        let dur1 = meta1.duration_ms.unwrap_or(0.0);

        // With 1MB total_file_size, duration should be scaled (~65s)
        let meta2 = extract_metadata_with_size_internal(&data, 1024 * 1024);
        let dur2 = meta2.duration_ms.unwrap_or(0.0);

        assert!(
            dur2 > dur1 * 100.0,
            "Duration should scale with total_file_size. dur1: {}, dur2: {}",
            dur1,
            dur2
        );
        // 1MB @ 128kbps = 1024*1024*8 / 128000 = 65.536s
        assert!(
            dur2 > 60000.0 && dur2 < 70000.0,
            "Duration {}ms should be approx 65s",
            dur2
        );
    }

    #[test]
    fn duration_ms_from_returns_zero_for_unknown_sentinel() {
        let tb = TimeBase {
            numer: 1,
            denom: 48000,
        };
        assert_eq!(duration_ms_from(Some(tb), Some(u64::MAX)), 0.0);
    }

    #[test]
    fn duration_ms_from_returns_zero_for_no_frames() {
        let tb = TimeBase {
            numer: 1,
            denom: 48000,
        };
        assert_eq!(duration_ms_from(Some(tb), None), 0.0);
    }

    #[test]
    fn extract_artwork_public_wrapper_returns_none_for_empty_input() {
        assert_eq!(extract_artwork(&[]), None);
    }
}
