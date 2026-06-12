use opus_rs::bands::take_last_pvq_shape_trace_for_test;
use opus_rs::celt::{CeltDecoder, CeltEncoder};
use opus_rs::modes::default_mode;
use opus_rs::pvq::{alg_quant, alg_unquant, decode_pulses, encode_pulses, exp_rotation, pvq_search};
use opus_rs::range_coder::RangeCoder;

#[test]
fn celt_pvq_shape_trace_is_populated_for_real_roundtrip() {
    let mode = default_mode();
    let channels = 1;
    let frame_size = mode.mdct.n / 2;
    let mut encoder = CeltEncoder::new(mode, channels);
    let mut decoder = CeltDecoder::new(mode, channels);

    let mut pcm_in = vec![0.0f32; frame_size * channels];
    for (i, sample) in pcm_in.iter_mut().enumerate() {
        *sample = ((i as f32) * 0.1).sin() * 0.4;
    }

    let rc_size: u32 = 2048;
    let mut rc = RangeCoder::new_encoder(rc_size);
    encoder.encode(&pcm_in, frame_size, &mut rc);
    rc.done();

    let compressed = rc.buf[..rc_size as usize].to_vec();
    let mut pcm_out = vec![0.0f32; frame_size * channels];
    let decoded_len = decoder.decode(&compressed, frame_size, &mut pcm_out);
    assert_eq!(decoded_len, frame_size);

    let trace = take_last_pvq_shape_trace_for_test().expect("expected pvq shape trace");
    assert!(!trace.bands.is_empty(), "expected at least one traced band");
    let worst_band = trace
        .bands
        .iter()
        .max_by(|a, b| {
            a.max_abs_error_vs_quantized
                .partial_cmp(&b.max_abs_error_vs_quantized)
                .unwrap()
        })
        .unwrap();
    eprintln!("Worst PVQ shape band: {:?}", worst_band);
    assert!(
        !worst_band.encode_input_norm.is_empty()
            && worst_band.encode_input_norm.len() == worst_band.decode_norm.len()
    );
}

#[test]
fn celt_traced_band_direct_pvq_roundtrip_matches() {
    let mode = default_mode();
    let channels = 1;
    let frame_size = mode.mdct.n / 2;
    let mut encoder = CeltEncoder::new(mode, channels);
    let mut decoder = CeltDecoder::new(mode, channels);

    let mut pcm_in = vec![0.0f32; frame_size * channels];
    for (i, sample) in pcm_in.iter_mut().enumerate() {
        *sample = ((i as f32) * 0.1).sin() * 0.4;
    }

    let rc_size: u32 = 2048;
    let mut rc = RangeCoder::new_encoder(rc_size);
    encoder.encode(&pcm_in, frame_size, &mut rc);
    rc.done();
    let compressed = rc.buf[..rc_size as usize].to_vec();
    let mut pcm_out = vec![0.0f32; frame_size * channels];
    let _ = decoder.decode(&compressed, frame_size, &mut pcm_out);

    let trace = take_last_pvq_shape_trace_for_test().expect("expected pvq shape trace");
    let worst_band = trace
        .bands
        .iter()
        .max_by(|a, b| {
            a.max_abs_error_vs_quantized
                .partial_cmp(&b.max_abs_error_vs_quantized)
                .unwrap()
        })
        .unwrap();

    let mut rc_direct = RangeCoder::new_encoder(1024);
    let mut x_quant = worst_band.encode_input_norm.clone();
    alg_quant(
        &mut x_quant,
        worst_band.len,
        worst_band.pvq_k,
        worst_band.spread,
        worst_band.stride,
        &mut rc_direct,
        1.0,
        true,
    );
    rc_direct.done();

    let mut rc_dec = RangeCoder::new_decoder(&rc_direct.buf[..rc_direct.storage as usize]);
    let mut x_unquant = vec![0.0f32; worst_band.len];
    alg_unquant(
        &mut x_unquant,
        worst_band.len,
        worst_band.pvq_k,
        worst_band.spread,
        worst_band.stride,
        &mut rc_dec,
        1.0,
    );

    let mut worst_direct_error = 0.0f32;
    for (expected, actual) in x_quant.iter().zip(x_unquant.iter()) {
        worst_direct_error = worst_direct_error.max((expected - actual).abs());
    }
    eprintln!(
        "Direct PVQ worst-band replay: band={} k={} spread={} stride={} worst_error={:.6}",
        worst_band.band,
        worst_band.pvq_k,
        worst_band.spread,
        worst_band.stride,
        worst_direct_error
    );
    assert!(worst_direct_error < 1e-5, "direct PVQ replay diverged");
}

#[test]
fn celt_traced_band_pulse_coding_roundtrip_matches() {
    let mode = default_mode();
    let channels = 1;
    let frame_size = mode.mdct.n / 2;
    let mut encoder = CeltEncoder::new(mode, channels);
    let mut decoder = CeltDecoder::new(mode, channels);

    let mut pcm_in = vec![0.0f32; frame_size * channels];
    for (i, sample) in pcm_in.iter_mut().enumerate() {
        *sample = ((i as f32) * 0.1).sin() * 0.4;
    }

    let mut rc = RangeCoder::new_encoder(2048);
    encoder.encode(&pcm_in, frame_size, &mut rc);
    rc.done();
    let compressed = rc.buf[..2048].to_vec();
    let mut pcm_out = vec![0.0f32; frame_size * channels];
    let _ = decoder.decode(&compressed, frame_size, &mut pcm_out);

    let trace = take_last_pvq_shape_trace_for_test().expect("expected pvq shape trace");
    let worst_band = trace
        .bands
        .iter()
        .max_by(|a, b| {
            a.max_abs_error_vs_quantized
                .partial_cmp(&b.max_abs_error_vs_quantized)
                .unwrap()
        })
        .unwrap();

    let mut rotated = worst_band.encode_input_norm.clone();
    exp_rotation(
        &mut rotated,
        worst_band.len,
        1,
        worst_band.stride,
        worst_band.pvq_k,
        worst_band.spread,
    );
    let mut y_enc = vec![0i32; worst_band.len];
    pvq_search(&rotated, &mut y_enc, worst_band.pvq_k, worst_band.len);

    let mut rc_pulses = RangeCoder::new_encoder(1024);
    encode_pulses(&y_enc, worst_band.len as u32, worst_band.pvq_k as u32, &mut rc_pulses);
    rc_pulses.done();
    let mut rc_dec = RangeCoder::new_decoder(&rc_pulses.buf[..rc_pulses.storage as usize]);
    let mut y_dec = vec![0i32; worst_band.len];
    decode_pulses(&mut y_dec, worst_band.len as u32, worst_band.pvq_k as u32, &mut rc_dec);

    eprintln!(
        "Pulse replay: band={} k={} y_enc={:?} y_dec={:?}",
        worst_band.band, worst_band.pvq_k, y_enc, y_dec
    );
    assert_eq!(y_enc, y_dec, "pulse coding diverged");
}
