//! Deterministic signal generators and fixture helpers for audio conformance tests.

/// Encodes stereo f32 PCM samples (interleaved L/R) into a valid 16-bit PCM WAV byte buffer.
pub fn encode_wav_pcm16(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let channels: u16 = 2;
    let bits_per_sample: u16 = 16;
    let bytes_per_sample = bits_per_sample / 8;
    let block_align = channels * bytes_per_sample;
    let num_frames = samples.len() / (channels as usize);
    let data_size = (num_frames * block_align as usize) as u32;
    let file_size = 36 + data_size;

    let mut wav = Vec::with_capacity(44 + data_size as usize);

    // RIFF header
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&file_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");

    // fmt subchunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // Subchunk1Size (16 for PCM)
    wav.extend_from_slice(&1u16.to_le_bytes()); // AudioFormat (1 for PCM)
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * block_align as u32;
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());

    // data subchunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());

    // PCM sample data
    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let i16_val = (clamped * 32767.0).round() as i16;
        wav.extend_from_slice(&i16_val.to_le_bytes());
    }

    wav
}

/// Generates a deterministic linear ramp WAV signal (stereo interleaved).
///
/// For source frame `i` in `0..frames`:
/// - Left channel: `0.01 + (i as f32 / frames as f32) * 0.95`
/// - Right channel: `-(0.01 + (i as f32 / frames as f32) * 0.95)`
///
/// The ramp values uniquely identify source frame positions after resampling.
pub fn generate_ramp_wav(frames: usize, sample_rate: u32) -> Vec<u8> {
    let mut samples = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        let val = 0.01 + (i as f32 / frames as f32) * 0.95;
        samples.push(val);
        samples.push(-val);
    }
    encode_wav_pcm16(&samples, sample_rate)
}

/// Generates an impulse signal WAV (stereo interleaved) where audio is silent (`0.0`)
/// except at frame `impulse_frame` where L=0.9, R=0.9.
pub fn generate_impulse_wav(frames: usize, impulse_frame: usize, sample_rate: u32) -> Vec<u8> {
    let mut samples = vec![0.0f32; frames * 2];
    if impulse_frame < frames {
        samples[impulse_frame * 2] = 0.9;
        samples[impulse_frame * 2 + 1] = 0.9;
    }
    encode_wav_pcm16(&samples, sample_rate)
}

/// Generates two consecutive WAV files with a deliberately discontinuous seam value.
///
/// - Track 1 ends with a constant positive value (+0.8).
/// - Track 2 starts with a constant negative value (-0.8).
pub fn generate_discontinuous_seam_wavs(
    t1_frames: usize,
    t2_frames: usize,
    sample_rate: u32,
) -> (Vec<u8>, Vec<u8>) {
    let mut s1 = Vec::with_capacity(t1_frames * 2);
    for i in 0..t1_frames {
        let val = 0.2 + 0.6 * (i as f32 / t1_frames.max(1) as f32);
        s1.push(val);
        s1.push(val);
    }

    let mut s2 = Vec::with_capacity(t2_frames * 2);
    for i in 0..t2_frames {
        let val = -0.8 + 0.6 * (i as f32 / t2_frames.max(1) as f32);
        s2.push(val);
        s2.push(val);
    }

    (
        encode_wav_pcm16(&s1, sample_rate),
        encode_wav_pcm16(&s2, sample_rate),
    )
}

/// Returns a list of `(frame_count, wav_bytes)` for partial-block matrix lengths
/// around 1, 512, 1023, 1024, and 1025 source frames.
pub fn generate_partial_block_matrix_wavs(sample_rate: u32) -> Vec<(usize, Vec<u8>)> {
    let lengths = [1, 512, 1023, 1024, 1025];
    lengths
        .into_iter()
        .map(|len| (len, generate_ramp_wav(len, sample_rate)))
        .collect()
}
