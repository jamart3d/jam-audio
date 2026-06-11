mod quality_probe_common;

use opus_rs::modes::default_mode;
use quality_probe_common::{best_snr_with_delay, generate_sine_wave};

#[test]
fn celt_preemphasis_roundtrip_probe() {
    const SAMPLE_RATE: f32 = 48_000.0;
    const FRAME_SIZE: usize = 960;
    const NUM_FRAMES: usize = 10;
    const VERY_SMALL: f32 = 1e-30;
    const SIG_SAT: f32 = 536_870_911.0;

    let mode = default_mode();
    let coef = mode.preemph[0];
    let input = generate_sine_wave(FRAME_SIZE * NUM_FRAMES, SAMPLE_RATE, 440.0, 0.4);
    let mut output = vec![0.0f32; input.len()];

    let mut enc_mem = 0.0f32;
    let mut dec_mem = 0.0f32;

    for frame in 0..NUM_FRAMES {
        let start = frame * FRAME_SIZE;
        let end = start + FRAME_SIZE;
        let pcm_in = &input[start..end];
        let pcm_out = &mut output[start..end];

        let mut emphasized = vec![0.0f32; FRAME_SIZE];
        for i in 0..FRAME_SIZE {
            let x = pcm_in[i] * 32768.0;
            let val = x - enc_mem;
            emphasized[i] = val;
            enc_mem = x * coef;
        }

        for i in 0..FRAME_SIZE {
            let x = emphasized[i];
            let val = (x + VERY_SMALL + dec_mem).clamp(-SIG_SAT, SIG_SAT);
            pcm_out[i] = val * (1.0 / 32768.0);
            dec_mem = val * coef;
        }
    }

    let (best_snr, best_delay, compared) =
        best_snr_with_delay(&input, &output, 2 * FRAME_SIZE, 9 * FRAME_SIZE, FRAME_SIZE);
    println!(
        "CELT pre/de-emphasis roundtrip: best SNR = {:.2} dB at delay {} across {} samples",
        best_snr, best_delay, compared
    );

    assert!(
        best_snr > 80.0,
        "pre/de-emphasis SNR unexpectedly low: {:.2} dB",
        best_snr
    );
}
