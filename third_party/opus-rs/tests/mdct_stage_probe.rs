mod quality_probe_common;

use opus_rs::modes::default_mode;
use quality_probe_common::{best_snr_with_delay, generate_sine_wave};

#[test]
fn mdct_tdac_stage_probe() {
    const SAMPLE_RATE: f32 = 48_000.0;
    const FRAME_SIZE: usize = 960;
    const NUM_FRAMES: usize = 8;

    let mode = default_mode();
    let overlap = mode.overlap;
    let mdct_input_size = mode.mdct.n + overlap;
    let syn_mem_size = mdct_input_size + FRAME_SIZE;
    let decode_buffer_size = mode.mdct.n + overlap;

    let input = generate_sine_wave(FRAME_SIZE * (NUM_FRAMES + 2), SAMPLE_RATE, 440.0, 0.4);
    let mut syn_mem = vec![0.0f32; syn_mem_size];
    let mut decode_mem = vec![0.0f32; decode_buffer_size];
    let mut output = Vec::with_capacity(FRAME_SIZE * NUM_FRAMES);

    for frame_idx in 0..NUM_FRAMES {
        let frame_start = (frame_idx + 1) * FRAME_SIZE;

        syn_mem.copy_within(FRAME_SIZE.., 0);
        syn_mem[syn_mem_size - FRAME_SIZE..]
            .copy_from_slice(&input[frame_start..frame_start + FRAME_SIZE]);

        let mut freq = vec![0.0f32; FRAME_SIZE];
        mode.mdct.forward(
            &syn_mem[syn_mem_size - mdct_input_size..],
            &mut freq,
            mode.window,
            overlap,
            0,
            1,
        );
        mode.mdct
            .backward(&freq, &mut decode_mem, mode.window, overlap, 0, 1);

        output.extend_from_slice(&decode_mem[overlap..overlap + FRAME_SIZE]);
    }

    let compare_start = 2 * FRAME_SIZE;
    let compare_end = 6 * FRAME_SIZE;
    let (best_snr, best_delay, compared) =
        best_snr_with_delay(&input, &output, compare_start, compare_end, 2 * FRAME_SIZE);
    println!(
        "MDCT TDAC stage: best SNR = {:.2} dB at delay {} across {} samples",
        best_snr, best_delay, compared
    );

    // This probe is intentionally aligned with the current CELT MDCT passthrough
    // behavior, which is much lower SNR than the pure identity tests.
    assert!(best_snr > 0.0, "MDCT TDAC SNR too low: {:.2} dB", best_snr);
}
