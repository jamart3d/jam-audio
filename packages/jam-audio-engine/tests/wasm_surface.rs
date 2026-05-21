#![cfg(target_arch = "wasm32")]

use jam_audio_engine::{StreamingPlayer, WasmGaplessPlayer, WindowedStreamingPlayer};
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

const OPUS: &[u8] = include_bytes!("../testdata/opus_sample.opus");

#[wasm_bindgen_test]
fn gapless_player_decodes_one_chunk() {
    let mut player = WasmGaplessPlayer::new(OPUS.to_vec(), None).expect("ctor");
    let result = player.decode_frames(4096);
    assert!(
        !result.is_null(),
        "decode_frames should return PCM on the first call"
    );
}

#[wasm_bindgen_test]
fn streaming_player_progresses_through_finalize() {
    let mut player = StreamingPlayer::new(None, None);
    assert!(player.append_chunk(OPUS).is_ok());
    player.finalize_stream();
    let pcm = player.decode_frames(4096).expect("decodes after finalize");
    assert!(!pcm.is_null(), "expected PCM not null after finalize");
}

#[wasm_bindgen_test]
fn windowed_streaming_player_handles_finalize_only() {
    let mut player = WindowedStreamingPlayer::new(Some(OPUS.len() as u64), 8);
    let _ = player.append_chunk(OPUS);
    player.finalize_stream();
    let _ = player.decode_frames(4096); // smoke
}
