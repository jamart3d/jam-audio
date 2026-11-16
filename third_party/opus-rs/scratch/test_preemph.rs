fn main() {
    let frame_size = 960;
    let freq = 440.0;
    let mut pcm = vec![0.0f32; frame_size];
    for i in 0..frame_size {
        let t = i as f32 / 48000.0;
        pcm[i] = (2.0 * std::f32::consts::PI * freq * t).sin() * 0.4;
    }

    let mut m = 0.0f32;
    let coef = 0.8500061f32;
    let mut preemphasized = vec![0.0f32; frame_size];
    for i in 0..frame_size {
        let x = pcm[i] * 32768.0;
        let val = x - m;
        preemphasized[i] = val;
        m = x * coef;
    }

    let pcm_rms = (pcm.iter().map(|&x| x * x).sum::<f32>() / frame_size as f32).sqrt();
    let pre_rms = (preemphasized.iter().map(|&x| x * x).sum::<f32>() / frame_size as f32).sqrt();
    println!("pcm RMS: {}", pcm_rms);
    println!("preemphasized RMS: {}", pre_rms);
    println!("preemphasized gain: {}", pre_rms / (pcm_rms * 32768.0));

    // Deemphasize
    let mut m_dec = 0.0f32;
    let mut deemphasized = vec![0.0f32; frame_size];
    for i in 0..frame_size {
        let x = preemphasized[i];
        let val = x + m_dec;
        deemphasized[i] = val / 32768.0;
        m_dec = val * coef;
    }

    let de_rms = (deemphasized.iter().map(|&x| x * x).sum::<f32>() / frame_size as f32).sqrt();
    println!("deemphasized RMS: {}", de_rms);
    println!("deemphasized gain relative to input: {}", de_rms / pcm_rms);
}
