use std::io::{Cursor, Read, Seek, SeekFrom};
use std::sync::Arc;

use symphonia::core::io::MediaSource;

pub(crate) struct InMemoryMediaSource {
    inner: Cursor<Arc<[u8]>>,
}

impl InMemoryMediaSource {
    pub(crate) fn new(bytes: Arc<[u8]>) -> Self {
        Self {
            inner: Cursor::new(bytes),
        }
    }

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

pub(crate) struct SizedMediaSource {
    inner: Cursor<Arc<[u8]>>,
    total_file_size: u64,
}

impl SizedMediaSource {
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
