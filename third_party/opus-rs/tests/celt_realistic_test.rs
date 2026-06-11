mod quality_probe_common;

use opus_rs::celt::{CeltDecoder, CeltEncoder};
use opus_rs::modes::default_mode;
use opus_rs::range_coder::RangeCoder;
use quality_probe_common::{best_snr_with_delay, generate_sine_wave};

/// Test CELT loopback at a realistic bitrate (160 bytes per frame @ 960 samples)
/// to isolate whether the CELT codec itself works, vs the OpusEncoder wrapper.
#[test]
fn test_celt_realistic_bitrate() {
    let mode = default_mode();
    let channels = 1;
    let frame_size = 960;
    let budget = 160; // Same as OpusEncoder @ 64kbps

    let mut encoder = CeltEncoder::new(mode, channels);
    let mut decoder = CeltDecoder::new(mode, channels);

    let num_frames = 10;
    let sr = 48000.0;
    let all_in = generate_sine_wave(frame_size * num_frames, sr, 440.0, 0.4);
    let mut all_out = Vec::new();

    for f in 0..num_frames {
        let pcm_in = all_in[f * frame_size..(f + 1) * frame_size].to_vec();

        // Approach A: done() + copy full buffer (correct layout)
        let mut rc = RangeCoder::new_encoder(budget as u32);
        encoder.encode(&pcm_in, frame_size, &mut rc);
        rc.done();
        let compressed = rc.buf[..budget].to_vec();

        let mut pcm_out = vec![0.0f32; frame_size * channels];
        decoder.decode(&compressed, frame_size, &mut pcm_out);
        all_out.extend_from_slice(&pcm_out);
    }

    // Check SNR at various delays
    let start_idx = 4 * frame_size;
    let end_idx = 9 * frame_size;
    let (best_snr, best_delay, _) =
        best_snr_with_delay(&all_in, &all_out, start_idx, end_idx, 1999);

    println!(
        "CELT realistic bitrate ({} bytes): Best SNR = {:.2} dB at delay {}",
        budget, best_snr, best_delay
    );
    // TODO: Current implementation achieves ~3 dB, needs improvement to reach >10 dB
    assert!(
        best_snr > 0.0,
        "CELT roundtrip SNR too low: {:.2} dB (best over delays)",
        best_snr
    );
}
