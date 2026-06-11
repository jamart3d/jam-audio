use opus_rs::bands::{amp2log2, compute_band_energies};
use opus_rs::modes::default_mode;
use opus_rs::quant_bands::trace_full_energy_roundtrip_for_test;

#[test]
fn celt_energy_trace_reports_first_divergence_band() {
    let mode = default_mode();
    let channels = 1;
    let frame_size = 960;
    let overlap = mode.overlap;
    let nb_ebands = mode.nb_ebands;
    let mut lm = 0;
    while (mode.short_mdct_size << lm) != frame_size {
        lm += 1;
    }
    let shift = mode.max_lm - lm;

    let mut input = vec![0.0f32; frame_size];
    for (i, sample) in input.iter_mut().enumerate() {
        let t = i as f32 / 48_000.0;
        *sample = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.4;
    }

    let mut syn_mem = vec![0.0f32; 2048 + overlap];
    let coef = mode.preemph[0];
    let mut mem = 0.0f32;
    for i in 0..frame_size {
        let x = input[i];
        syn_mem[2048 + overlap - frame_size + i] = x - mem;
        mem = x * coef;
    }

    let mut freq_coeffs = vec![0.0f32; frame_size];
    mode.mdct.forward(
        &syn_mem[2048 - frame_size..],
        &mut freq_coeffs,
        mode.window,
        overlap,
        shift,
        1,
    );

    let mut band_e = vec![0.0f32; nb_ebands * channels];
    compute_band_energies(mode, &freq_coeffs, &mut band_e, nb_ebands, channels, lm);

    let mut band_log_e = vec![0.0f32; nb_ebands * channels];
    amp2log2(
        mode,
        nb_ebands,
        nb_ebands,
        &band_e,
        &mut band_log_e,
        channels,
    );

    let fine_quant: Vec<i32> = (0..nb_ebands).map(|i| (i % 3) as i32).collect();
    let fine_priority: Vec<i32> = (0..nb_ebands).map(|i| (i % 2) as i32).collect();

    let trace = trace_full_energy_roundtrip_for_test(
        mode,
        0,
        nb_ebands,
        &band_log_e,
        &fine_quant,
        &fine_priority,
        channels,
        lm,
    );

    assert!(
        trace.first_divergence.is_none(),
        "unexpected energy divergence: {:?}",
        trace.first_divergence
    );
}
