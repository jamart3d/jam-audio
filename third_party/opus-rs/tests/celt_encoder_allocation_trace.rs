use opus_rs::celt::{CeltEncoder, take_last_encoder_allocation_trace_for_test};
use opus_rs::modes::default_mode;
use opus_rs::range_coder::RangeCoder;

#[test]
fn celt_encoder_records_allocation_trace_for_single_frame() {
    let mode = default_mode();
    let mut encoder = CeltEncoder::new(mode, 1);
    let frame_size = 960;
    let mut pcm = vec![0.0f32; frame_size];
    for (i, sample) in pcm.iter_mut().enumerate() {
        let t = i as f32 / 48_000.0;
        *sample = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.4;
    }

    let mut rc = RangeCoder::new_encoder(160);
    encoder.encode(&pcm, frame_size, &mut rc);
    rc.done();

    let trace =
        take_last_encoder_allocation_trace_for_test().expect("expected encoder allocation trace");
    eprintln!("Real encoder allocation trace: {:?}", trace);
    assert!(trace.coded_bands > 0, "coded_bands should be positive");
    assert_eq!(trace.ebits.len(), mode.nb_ebands);
}
