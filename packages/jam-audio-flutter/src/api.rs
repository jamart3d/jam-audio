#![allow(unexpected_cfgs)]
use jam_audio_engine::{extract_metadata_internal, extract_artwork_internal};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AudioMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub duration_ms: Option<f64>,
}

impl From<jam_audio_engine::AudioMetadata> for AudioMetadata {
    fn from(other: jam_audio_engine::AudioMetadata) -> Self {
        Self {
            title: other.title,
            artist: other.artist,
            album: other.album,
            track_number: other.track_number,
            duration_ms: other.duration_ms,
        }
    }
}

/// Extracts metadata from audio data using the internal shared parser.
/// This function is intended to be called via flutter_rust_bridge.
pub fn extract_metadata(data: Vec<u8>) -> AudioMetadata {
    extract_metadata_internal(&data).into()
}

/// Extracts artwork from audio data.
/// This function is intended to be called via flutter_rust_bridge.
#[allow(unexpected_cfgs)]
#[flutter_rust_bridge::frb(sync)]
pub fn extract_artwork(data: Vec<u8>) -> Option<Vec<u8>> {
    extract_artwork_internal(&data)
}
