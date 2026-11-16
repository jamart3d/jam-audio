use opus_rs::bands::{
    amp2log2, compute_band_energies, denormalise_bands, log2amp, normalise_bands,
    trace_band_roundtrip_for_test,
};
use opus_rs::modes::default_mode;

fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (x - y).abs())
        .fold(0.0f32, f32::max)
}

#[test]
fn bands_roundtrip_recovers_coefficients_before_quantization() {
    let mode = default_mode();
    let channels = 1;
    let frame_size = 960;
    let nb_ebands = mode.nb_ebands;
    let mut lm = 0;
    while (mode.short_mdct_size << lm) != frame_size {
        lm += 1;
    }

    let mut coeffs = vec![0.0f32; frame_size];
    for (i, coeff) in coeffs.iter_mut().enumerate() {
        *coeff = ((i as f32) * 0.013).sin() * 0.35 + ((i as f32) * 0.021).cos() * 0.1;
    }

    let mut band_e = vec![0.0f32; nb_ebands * channels];
    compute_band_energies(mode, &coeffs, &mut band_e, nb_ebands, channels, lm);

    let mut normalised = vec![0.0f32; frame_size * channels];
    normalise_bands(
        mode,
        &coeffs,
        &mut normalised,
        &band_e,
        nb_ebands,
        channels,
        1 << lm,
    );

    let mut band_log_e = vec![0.0f32; nb_ebands * channels];
    amp2log2(mode, 0, nb_ebands, &band_e, &mut band_log_e, channels);

    let mut band_amp = vec![0.0f32; nb_ebands * channels];
    log2amp(mode, nb_ebands, &mut band_amp, &band_log_e, channels);

    let mut reconstructed = vec![0.0f32; frame_size * channels];
    denormalise_bands(
        mode,
        &normalised,
        &mut reconstructed,
        &band_amp,
        0,
        nb_ebands,
        channels,
        1 << lm,
    );

    let band_end = (mode.e_bands[mode.nb_ebands] as usize) << lm;
    let diff = max_abs_diff(&coeffs[..band_end], &reconstructed[..band_end]);
    let trace = trace_band_roundtrip_for_test(mode, &coeffs, channels, lm);
    let worst = trace
        .iter()
        .max_by(|a, b| a.max_coeff_error.partial_cmp(&b.max_coeff_error).unwrap())
        .unwrap();
    eprintln!("Worst band trace: {:?}", worst);
    assert!(diff < 1e-3, "band roundtrip diff too large: {}", diff);
}
