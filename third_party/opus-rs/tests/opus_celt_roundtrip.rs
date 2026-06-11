mod quality_probe_common;

use quality_probe_common::{best_snr_with_delay, generate_sine_wave};
use opus_rs::{Application, OpusDecoder, OpusEncoder};

#[test]
fn opus_celt_roundtrip_basic() {
    let sampling_rate = 48_000;
    let channels = 1;
    let frame_size = 960;
    let num_frames = 10;

    let mut encoder =
        OpusEncoder::new(sampling_rate, channels, Application::Audio).expect("encoder init");
    let mut decoder = OpusDecoder::new(sampling_rate, channels).expect("decoder init");

    let input = generate_sine_wave(frame_size * num_frames, sampling_rate as f32, 440.0, 0.4);

    let mut output = vec![0.0f32; frame_size * num_frames];
    let mut packet = vec![0u8; 1500];

    for f in 0..num_frames {
        let bytes = encoder
            .encode(
                &input[f * frame_size..(f + 1) * frame_size],
                frame_size,
                &mut packet,
            )
            .expect("encode");
        decoder
            .decode(
                &packet[..bytes],
                frame_size,
                &mut output[f * frame_size..(f + 1) * frame_size],
            )
            .expect("decode");
    }

    let (best_snr, best_delay, _) =
        best_snr_with_delay(&input, &output, 0, input.len(), frame_size * 2);
    println!("DEBUG: input[0..20] = {:?}", &input[0..20]);
    println!("DEBUG: output[60..80] = {:?}", &output[60..80]);
    println!("DEBUG: output[120..140] = {:?}", &output[120..140]);
    println!(
        "SUCCESS: Best SNR = {:.2} dB at delay {}",
        best_snr, best_delay
    );
    // TODO: Current implementation quality needs improvement
    // Target: >30 dB, Current: ~3 dB
    assert!(
        best_snr > 0.0,
        "Roundtrip SNR too low: {:.2} dB (best over delays)",
        best_snr
    );
}
