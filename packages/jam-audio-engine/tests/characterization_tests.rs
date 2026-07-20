// Characterization tests (Red TDD baseline for Plan 1).
// These tests assert exact signal/frame semantics and demonstrate the pre-fix defect state.

use jam_audio_engine::test_helpers::*;
use jam_audio_engine::{DecodeError, GaplessPlayer, StreamingDecoder};

// 1. Seek state isolation:
// Decode enough 44.1 kHz input to leave pending resampler data, seek, and prove
// post-seek output differs from a fresh decoder at the same position.
#[test]
fn characterization_seek_state_isolation() {
    let wav = generate_ramp_wav(4000, 44100);
    let target_rate = 48000;

    // Decoder A: decode a partial chunk (500 frames) to leave pending data in resampler, then seek to 0 ms.
    let mut decoder_a = StreamingDecoder::new(wav.clone(), target_rate).expect("decoder A init");
    let mut scratch_a = Vec::new();
    let _ = decoder_a.decode_chunk_into(500, &mut scratch_a);
    decoder_a.seek_to_ms(0.0).expect("seek A to 0ms");

    scratch_a.clear();
    let _ = decoder_a.decode_chunk_into(500, &mut scratch_a);

    // Decoder B: fresh decoder seeked to 0 ms without prior decode history.
    let mut decoder_b = StreamingDecoder::new(wav, target_rate).expect("decoder B init");
    decoder_b.seek_to_ms(0.0).expect("seek B to 0ms");
    let mut scratch_b = Vec::new();
    let _ = decoder_b.decode_chunk_into(500, &mut scratch_b);

    // Assert exact post-seek output parity with a fresh decoder.
    // RED EXPECTATION: Fails because decoder A retains pre-seek resampler pending state.
    assert_eq!(
        scratch_a, scratch_b,
        "Post-seek output of decoder A must match fresh decoder B exactly, but resampler state leaked"
    );
}

// 2. Resampler EOF accounting:
// Prove flush returns output attributable to zero padding for partial-block lengths.
#[test]
fn characterization_resampler_eof_accounting() {
    let source_rate = 44100;
    let target_rate = 48000;
    let matrix = generate_partial_block_matrix_wavs(source_rate);

    for (source_frames, wav) in matrix {
        let mut decoder = StreamingDecoder::new(wav, target_rate).expect("decoder init");
        let mut total_decoded_frames = 0;
        let mut scratch = Vec::new();

        while decoder
            .decode_chunk_into(1024, &mut scratch)
            .unwrap_or(false)
        {
            total_decoded_frames += scratch.len() / 2;
            scratch.clear();
        }

        // Target audible frame count without synthetic padding
        let expected_target_frames =
            (source_frames as f64 * target_rate as f64 / source_rate as f64).round() as usize;

        // RED EXPECTATION: Fails because resampler flush emits synthetic zero-padded frames.
        assert_eq!(
            total_decoded_frames, expected_target_frames,
            "Resampler flush produced synthetic EOF padding for partial-block length {}",
            source_frames
        );
    }
}

// 3. Gapless second-track delay:
// Compare two-track decode against two independently decoded audible streams and expose duplicated trimming at second track start.
#[test]
fn characterization_gapless_second_track_delay() {
    // Generate two tracks using MP3 with encoder delay metadata
    let mp3_bytes = include_bytes!("../testdata/mp3_with_delay.mp3").to_vec();
    let target_rate = 48000;

    // Track 2 decoded standalone
    let mut standalone_t2 =
        StreamingDecoder::new(mp3_bytes.clone(), target_rate).expect("standalone t2 init");
    let mut standalone_t2_start = Vec::new();
    let _ = standalone_t2.decode_chunk_into(200, &mut standalone_t2_start);

    // Two-track gapless player
    let mut player = GaplessPlayer::new(mp3_bytes.clone(), target_rate).expect("player init");
    player
        .load_next(mp3_bytes.clone())
        .expect("load next track");

    let mut gapless_t2_samples = Vec::new();
    let mut seam_captured = false;

    loop {
        let mut chunk = Vec::new();
        player
            .decode_frames_into(&mut chunk, 1024)
            .expect("decode frames");
        if chunk.is_empty() {
            break;
        }

        if player.seam_generation() == 1 {
            if !seam_captured {
                seam_captured = true;
                let t1_target_samples =
                    (player.last_seam_position_ms() * target_rate as f64 / 1000.0).round() as usize
                        * 2;
                let pos_target_samples =
                    (player.position_ms() * target_rate as f64 / 1000.0).round() as usize * 2;
                let t2_decoded_so_far = pos_target_samples.saturating_sub(t1_target_samples);
                let t2_in_this_chunk = t2_decoded_so_far.min(chunk.len());
                let t2_start_idx = chunk.len() - t2_in_this_chunk;
                gapless_t2_samples.extend_from_slice(&chunk[t2_start_idx..]);
            } else {
                gapless_t2_samples.extend_from_slice(&chunk);
            }

            if gapless_t2_samples.len() >= standalone_t2_start.len() {
                gapless_t2_samples.truncate(standalone_t2_start.len());
                break;
            }
        }
    }

    assert_eq!(
        gapless_t2_samples, standalone_t2_start,
        "Gapless second track start must match standalone decoded track 2 start, but double-trimming occurred"
    );
}

// 4. Trailing padding:
// Prove encoded trailing padding reaches output when authoritative padding metadata exists.
#[test]
fn characterization_trailing_padding() {
    let mp3_bytes = include_bytes!("../testdata/mp3_with_delay.mp3").to_vec();
    let target_rate = 44100; // Same as source rate to isolate padding from resampler

    let mut decoder = StreamingDecoder::new(mp3_bytes, target_rate).expect("decoder init");
    let mut total_decoded_frames = 0;
    let mut scratch = Vec::new();

    while decoder
        .decode_chunk_into(1024, &mut scratch)
        .unwrap_or(false)
    {
        total_decoded_frames += scratch.len() / 2;
        scratch.clear();
    }

    // mp3_with_delay.mp3 has 46080 total raw samples (44100 Hz * ~1.044s)
    // LAME metadata: delay = 1105, padding = 875.
    // Expected audible frames = 46080 - 1105 - 875 = 44100.
    let raw_delay = 1105;
    let raw_padding = 875;
    let total_pcm_container_frames = 46080;
    let expected_audible_frames = total_pcm_container_frames - raw_delay - raw_padding;

    assert_eq!(
        total_decoded_frames, expected_audible_frames,
        "Decoded frames must exclude trailing padding metadata ({}), but got {}",
        raw_padding, total_decoded_frames
    );
}

// 5. Resampler error behavior:
// Exercise invalid output rate/construction and processing error so neither panic nor silent success occurs.
#[test]
fn characterization_resampler_error_behavior() {
    let wav = generate_ramp_wav(1000, 44100);

    // Attempting to construct decoder with invalid target sample rate (0 Hz)
    let res = StreamingDecoder::new(wav, 0);

    // RED EXPECTATION: Fails because StereoResampler::new panics with expect() instead of returning DecodeError::Resample.
    match res {
        Err(DecodeError::Resample { operation, message }) => {
            assert_eq!(operation, "new");
            assert!(!message.is_empty());
        }
        Err(other) => {
            panic!(
                "Expected DecodeError::Resample for invalid target rate 0, but got: {:?}",
                other
            );
        }
        Ok(_) => {
            panic!(
                "Expected DecodeError::Resample for invalid target rate 0, but decoder succeeded"
            );
        }
    }
}
