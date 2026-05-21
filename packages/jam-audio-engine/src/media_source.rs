//! In-memory media source implementations for Symphonia.
//!
//! This module provides in-memory implementations of the `MediaSource` trait
//! required by Symphonia to decode audio. It allows reading and seeking directly
//! from in-memory byte arrays (`Arc<[u8]>`), enabling playback of fully or
//! partially buffered audio data.

use std::io::{Cursor, Read, Seek, SeekFrom};
use std::sync::Arc;

use symphonia::core::io::MediaSource;

/// An in-memory media source backed by an `Arc<[u8]>`.
///
/// It implements `Read`, `Seek`, and `MediaSource` to allow Symphonia to seamlessly
/// interact with audio data stored entirely in memory. It optionally supports overriding
/// the reported file size and `SeekFrom::End` behavior, which is useful when only a partial
/// download is available but the full file size is known.
pub(crate) struct InMemoryMediaSource {
    inner: Cursor<Arc<[u8]>>,
}

impl InMemoryMediaSource {
    /// Creates a new `InMemoryMediaSource` using the provided byte array.
    /// The media size is exactly the length of the array.
    pub(crate) fn new(bytes: Arc<[u8]>) -> Self {
        Self {
            inner: Cursor::new(bytes),
        }
    }

    /// Creates a new `InMemoryMediaSource` directly from a `Vec<u8>`.
    pub(crate) fn from_vec(bytes: Vec<u8>) -> Self {
        Self::new(Arc::from(bytes))
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

/// An in-memory media source backed by an `Arc<[u8]>` with an explicit total file size.
///
/// This is necessary to spoof the file size for partially downloaded files
/// during metadata extraction. When seeking from the end (e.g., to read ID3v1 tags),
/// the offset will be calculated relative to this `total_file_size` rather than
/// the length of the currently buffered bytes.
pub(crate) struct SizedMediaSource {
    inner: Cursor<Arc<[u8]>>,
    total_file_size: u64,
}

impl SizedMediaSource {
    /// Creates a new `SizedMediaSource` using the provided byte array and explicit total size.
    pub(crate) fn new(bytes: Arc<[u8]>, total_file_size: u64) -> Self {
        Self {
            inner: Cursor::new(bytes),
            total_file_size,
        }
    }
}

impl Read for SizedMediaSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Seek for SizedMediaSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        match pos {
            SeekFrom::End(n) => {
                let target = if n >= 0 {
                    self.total_file_size.saturating_add(n as u64)
                } else {
                    self.total_file_size.saturating_sub(n.unsigned_abs())
                };
                self.inner.seek(SeekFrom::Start(target))
            }
            _ => self.inner.seek(pos),
        }
    }
}

impl MediaSource for SizedMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.total_file_size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_in_memory_media_source_seek() {
        let data: Arc<[u8]> = Arc::from(vec![1, 2, 3, 4, 5]);
        let mut source = InMemoryMediaSource::new(data);

        // Seek from start
        assert_eq!(source.seek(SeekFrom::Start(2)).unwrap(), 2);
        // Seek from current
        assert_eq!(source.seek(SeekFrom::Current(2)).unwrap(), 4);
        // Seek from end
        assert_eq!(source.seek(SeekFrom::End(-1)).unwrap(), 4);
        assert_eq!(source.seek(SeekFrom::End(-5)).unwrap(), 0);
    }

    #[test]
    fn test_sized_media_source_seek_end() {
        // We have 5 bytes buffered, but the file size is spoofed as 100.
        let data: Arc<[u8]> = Arc::from(vec![1, 2, 3, 4, 5]);
        let mut source = SizedMediaSource::new(data, 100);

        // Seeking from End(-10) should result in absolute position 90.
        // The underlying cursor will just accept 90 as the position.
        assert_eq!(source.seek(SeekFrom::End(-10)).unwrap(), 90);
        
        // Seeking from End(-150) should saturate to 0.
        assert_eq!(source.seek(SeekFrom::End(-150)).unwrap(), 0);
        
        // Seeking from End(10) should saturate_add to 110.
        assert_eq!(source.seek(SeekFrom::End(10)).unwrap(), 110);
        
        // Seek from start should still work normally
        assert_eq!(source.seek(SeekFrom::Start(50)).unwrap(), 50);

        // Length should be reported as 100
        assert_eq!(source.byte_len().unwrap(), 100);
    }
}
