use opus_rs::bands::{amp2log2, compute_band_energies};
use opus_rs::modes::default_mode;
use opus_rs::quant_bands::trace_quant_energy_distortion_for_test;

#[test]
fn quant_energy_distortion_trace_reports_worst_band() {
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
        let t = i as f32 / 48_000.0;
        *coeff = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.4
            + (2.0 * std::f32::consts::PI * 880.0 * t).sin() * 0.08;
    }

    let mut band_e = vec![0.0f32; nb_ebands * channels];
    compute_band_energies(mode, &coeffs, &mut band_e, nb_ebands, channels, lm);

    let mut band_log_e = vec![0.0f32; nb_ebands * channels];
    amp2log2(mode, 0, nb_ebands, &band_e, &mut band_log_e, channels);

    let trace = trace_quant_energy_distortion_for_test(
        mode,
        0,
        nb_ebands,
        &band_log_e,
        channels,
        lm,
        160,
    );

    let worst = trace
        .finalise
        .iter()
        .max_by(|a, b| a.abs_error.partial_cmp(&b.abs_error).unwrap())
        .unwrap();
    eprintln!("Worst finalised band distortion: {:?}", worst);
    assert!(worst.abs_error.is_finite(), "worst distortion was not finite");
}
