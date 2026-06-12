use opus_rs::bands::take_last_pvq_shape_trace_for_test;
use opus_rs::celt::{CeltDecoder, CeltEncoder};
use opus_rs::modes::default_mode;
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
        .max_by(|a, b| a.max_abs_error.partial_cmp(&b.max_abs_error).unwrap())
        .unwrap();
    eprintln!("Worst PVQ shape band: {:?}", worst_band);
    assert!(
        !worst_band.encode_norm.is_empty() && worst_band.encode_norm.len() == worst_band.decode_norm.len()
    );
}
