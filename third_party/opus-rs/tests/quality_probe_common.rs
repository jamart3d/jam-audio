pub fn generate_sine_wave(
    total_samples: usize,
    sample_rate: f32,
    freq_hz: f32,
    amplitude: f32,
) -> Vec<f32> {
    let mut samples = vec![0.0f32; total_samples];
    for (i, sample) in samples.iter_mut().enumerate() {
        let t = i as f32 / sample_rate;
        *sample = (2.0 * std::f32::consts::PI * freq_hz * t).sin() * amplitude;
    }
    samples
}

pub fn best_snr_with_delay(
    input: &[f32],
    output: &[f32],
    start_idx: usize,
    end_idx: usize,
    max_delay: usize,
) -> (f32, usize, usize) {
    let mut best_snr = -100.0f32;
    let mut best_delay = 0usize;
    let mut best_count = 0usize;

    for delay in 0..=max_delay {
        let mut signal = 0.0f64;
        let mut noise = 0.0f64;
        let mut count = 0usize;

        for i in start_idx..end_idx {
            if i + delay >= output.len() || i >= input.len() {
                break;
            }

            let s = input[i] as f64;
            let d = output[i + delay] as f64;
            signal += s * s;
            noise += (s - d) * (s - d);
            count += 1;
        }

        if count == 0 {
            continue;
        }

        let snr = 10.0 * (signal / (noise + 1e-12)).log10() as f32;
        if snr > best_snr {
            best_snr = snr;
            best_delay = delay;
            best_count = count;
        }
    }

    (best_snr, best_delay, best_count)
}
