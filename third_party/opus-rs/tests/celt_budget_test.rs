use opus_rs::bands::{
    model_zero_pulse_reference_for_test, take_last_partition_roundtrip_trace_for_test,
    take_last_pvq_shape_trace_for_test, take_last_root_band_budget_trace_for_test,
};
use opus_rs::celt::{
    CeltDecoder, CeltEncoder, take_last_decoder_allocation_trace_for_test,
    take_last_encoder_allocation_trace_for_test,
};
use opus_rs::modes::default_mode;
use opus_rs::range_coder::RangeCoder;

fn snr_with_delay(input: &[f32], output: &[f32], delay: usize) -> f32 {
    let len = input.len().min(output.len().saturating_sub(delay));
    if len == 0 {
        return -100.0;
    }
    let mut signal = 0.0f64;
    let mut noise = 0.0f64;
    for i in 0..len {
        let s = input[i] as f64;
        let d = output[i + delay] as f64;
        signal += s * s;
        noise += (s - d) * (s - d);
    }
    10.0 * (signal / (noise + 1e-12)).log10() as f32
}

#[test]
fn celt_loopback_160bytes() {
    let mode = default_mode();
    let channels = 1;
    let frame_size = 960;
    let n_bytes = 160; // ~64kbps at 48kHz 20ms
    let num_frames = 10;

    let mut encoder = CeltEncoder::new(mode, channels);
    let mut decoder = CeltDecoder::new(mode, channels);
    let mut first_trace = None;
    let mut first_decode_trace = None;
    let mut first_shape_trace = None;
    let mut first_partition_trace = None;
    let mut first_root_budget_trace = Vec::new();

    let freq = 440.0;
    let mut all_in = vec![0.0f32; frame_size * num_frames];
    let mut all_out = vec![0.0f32; frame_size * num_frames];

    for i in 0..(frame_size * num_frames) {
        let t = i as f32 / 48000.0;
        all_in[i] = (2.0 * std::f32::consts::PI * freq * t).sin() * 0.4;
    }

    for f in 0..num_frames {
        let pcm_in = &all_in[f * frame_size..(f + 1) * frame_size];

        let mut rc = RangeCoder::new_encoder(n_bytes as u32);
        encoder.encode(pcm_in, frame_size, &mut rc);
        rc.done();
        if first_trace.is_none() {
            first_trace = take_last_encoder_allocation_trace_for_test();
        }

        // Copy the full buffer (maintaining front/end layout for the decoder)
        let compressed: Vec<u8> = rc.buf[..n_bytes].to_vec();

        let pcm_out = &mut all_out[f * frame_size..(f + 1) * frame_size];
        decoder.decode(&compressed, frame_size, pcm_out);
        if first_decode_trace.is_none() {
            first_decode_trace = take_last_decoder_allocation_trace_for_test();
        }
        if first_shape_trace.is_none() {
            first_shape_trace = take_last_pvq_shape_trace_for_test();
        }
        if first_partition_trace.is_none() {
            first_partition_trace = take_last_partition_roundtrip_trace_for_test();
        }
        if first_root_budget_trace.is_empty() {
            first_root_budget_trace = take_last_root_band_budget_trace_for_test();
        }
    }

    let start_idx = 4 * frame_size;
    let end_idx = 9 * frame_size;
    let mut best_snr: f32 = -100.0;
    for delay in 0..(frame_size * 2) {
        let mut s_e = 0.0f64;
        let mut n_e = 0.0f64;
        let mut count = 0;
        for i in start_idx..end_idx {
            if i + delay >= all_out.len() {
                break;
            }
            let s = all_in[i] as f64;
            let d = all_out[i + delay] as f64;
            s_e += s * s;
            n_e += (s - d) * (s - d);
            count += 1;
        }
        if count < frame_size {
            continue;
        }
        let snr = 10.0 * (s_e / (n_e + 1e-12)).log10() as f32;
        if snr > best_snr {
            best_snr = snr;
        }
    }
    eprintln!("Loopback Global Best SNR: {:.2} dB", best_snr);

    for f in 3..8 {
        let start = f * frame_size;
        let end = start + frame_size;
        let snr_0 = snr_with_delay(&all_in[start..end], &all_out[start..end], 0);
        eprintln!("  Frame {} SNR(delay=0): {:.2} dB", f, snr_0);
    }

    let trace = first_trace.expect("expected real encoder allocation trace");
    let decode_trace = first_decode_trace.expect("expected real decoder allocation trace");
    eprintln!("Loopback allocation trace: {:?}", trace);
    eprintln!("Loopback decode allocation trace: {:?}", decode_trace);
    if let Some((band, encode_pulses, decode_pulses)) = trace
        .pulses
        .iter()
        .zip(decode_trace.pulses.iter())
        .enumerate()
        .find(|(_, (enc, dec))| enc != dec)
        .map(|(band, (enc, dec))| (band, *enc, *dec))
    {
        eprintln!(
            "Loopback first allocation pulse divergence: band={} encode_pulses={} decode_pulses={}",
            band, encode_pulses, decode_pulses
        );
    }
    if let Some(shape_trace) = first_shape_trace {
        if let Some(worst_band) = shape_trace.bands.iter().max_by(|a, b| {
            a.max_abs_error_vs_quantized
                .partial_cmp(&b.max_abs_error_vs_quantized)
                .unwrap()
        }) {
            eprintln!("Budget loopback worst PVQ band: {:?}", worst_band);
        }
        if let Some(worst_post_partition_band) = shape_trace.bands.iter().max_by(|a, b| {
            a.post_partition_max_abs_error
                .partial_cmp(&b.post_partition_max_abs_error)
                .unwrap()
        }) {
            eprintln!(
                "Budget loopback worst post-partition band: band={} err={:.6}",
                worst_post_partition_band.band,
                worst_post_partition_band.post_partition_max_abs_error
            );
        }
        if let Some(worst_post_recombine_band) = shape_trace.bands.iter().max_by(|a, b| {
            a.post_recombine_max_abs_error
                .partial_cmp(&b.post_recombine_max_abs_error)
                .unwrap()
        }) {
            eprintln!(
                "Budget loopback worst post-recombine band: band={} err={:.6}",
                worst_post_recombine_band.band,
                worst_post_recombine_band.post_recombine_max_abs_error
            );
        }
    }
    if let Some(partition_trace) = first_partition_trace {
        if let Some(first_root_budget_divergence) = first_root_budget_trace
            .iter()
            .filter(|entry| {
                entry.encode_tell != entry.decode_tell
                    || entry.encode_balance_before_tell_adjust != entry.decode_balance_before_tell_adjust
                    || entry.encode_balance_after_tell_adjust != entry.decode_balance_after_tell_adjust
                    || entry.encode_remaining_bits != entry.decode_remaining_bits
                    || entry.encode_curr_balance != entry.decode_curr_balance
                    || entry.encode_b != entry.decode_b
            })
            .min_by_key(|entry| entry.encode_visit_index)
        {
            eprintln!(
                "Budget loopback first root band budget divergence: {:?}",
                first_root_budget_divergence
            );
        }
        if let Some(first_node_divergence) = partition_trace
            .nodes
            .iter()
            .filter(|entry| {
                entry.encode_qn != entry.decode_qn
                    || entry.encode_remaining_bits_before_qalloc
                        != entry.decode_remaining_bits_before_qalloc
                    || entry.encode_remaining_bits_after_qalloc
                        != entry.decode_remaining_bits_after_qalloc
                    || entry.encode_tell_before_qalloc != entry.decode_tell_before_qalloc
                    || entry.encode_tell_after_qalloc != entry.decode_tell_after_qalloc
                    || entry.encode_itheta != entry.decode_itheta
                    || entry.encode_qalloc != entry.decode_qalloc
                    || entry.encode_mbits != entry.decode_mbits
                    || entry.encode_sbits != entry.decode_sbits
            })
            .min_by_key(|entry| entry.encode_visit_index)
        {
            eprintln!(
                "Budget loopback first partition node divergence: {:?}",
                first_node_divergence
            );
        }
        if let Some(first_budget_divergence) = partition_trace
            .leaves
            .iter()
            .filter(|entry| {
                entry.encode_remaining_bits_on_entry != entry.decode_remaining_bits_on_entry
                    || entry.encode_tell_on_entry != entry.decode_tell_on_entry
                    || entry.encode_curr_bits != entry.decode_curr_bits
                    || entry.encode_q != entry.decode_q
                    || entry.encode_remaining_bits_after_budget
                        != entry.decode_remaining_bits_after_budget
            })
            .min_by_key(|entry| entry.encode_visit_index)
        {
            eprintln!(
                "Budget loopback first leaf budget divergence: {:?}",
                first_budget_divergence
            );
            for node in partition_trace.nodes.iter().filter(|entry| {
                entry.band == first_budget_divergence.band
                    && entry.depth <= first_budget_divergence.depth
                    && (first_budget_divergence.path_bits >> (first_budget_divergence.depth - entry.depth))
                        == entry.path_bits
            }) {
                eprintln!("Budget loopback divergent leaf ancestor node: {:?}", node);
            }
        }
        if let Some(first_recursive_node_mismatch) = partition_trace
            .nodes
            .iter()
            .filter(|entry| {
                entry.left_child_max_abs_error > 0.0
                    || entry.right_child_max_abs_error > 0.0
                    || entry.parent_after_children_max_abs_error > 0.0
            })
            .min_by_key(|entry| entry.encode_visit_index)
        {
            let first_stage = if first_recursive_node_mismatch.left_child_max_abs_error > 0.0 {
                if (first_recursive_node_mismatch.left_return_parent_slice_max_abs_error
                    - first_recursive_node_mismatch.left_child_max_abs_error)
                    .abs()
                    < 1e-6
                {
                    "child_local_visible_in_parent_left_slice"
                } else if first_recursive_node_mismatch.left_return_parent_slice_max_abs_error > 0.0 {
                    "parent_left_slice_after_left_return"
                } else {
                    "child_output_only"
                }
            } else if first_recursive_node_mismatch.right_child_max_abs_error > 0.0 {
                "right_child"
            } else {
                "parent_after_children"
            };
            eprintln!(
                "Budget loopback first recursive node mismatch stage={}: {:?}",
                first_stage, first_recursive_node_mismatch
            );
            if let Some(first_left_descendant) = partition_trace
                .nodes
                .iter()
                .filter(|entry| {
                    entry.depth > first_recursive_node_mismatch.depth
                        && (entry.path_bits
                            >> (entry.depth - first_recursive_node_mismatch.depth - 1))
                            == (first_recursive_node_mismatch.path_bits << 1)
                })
                .min_by_key(|entry| entry.encode_visit_index)
            {
                let deeper_stage = if first_left_descendant.encode_left_child_budget_before_call
                    != first_left_descendant.decode_left_child_budget_before_call
                    || first_left_descendant.encode_left_child_fill_before_call
                        != first_left_descendant.decode_left_child_fill_before_call
                    || (first_left_descendant.encode_left_child_gain_before_call
                        - first_left_descendant.decode_left_child_gain_before_call)
                        .abs()
                        > 1e-6
                {
                    "left_child_call_inputs_diverge"
                } else if first_left_descendant.left_child_max_abs_error > 0.0 {
                    "child_internal_after_equal_call_inputs"
                } else {
                    "not_left_child_internal"
                };
                eprintln!(
                    "Budget loopback first left-child descendant stage={}: {:?}",
                    deeper_stage, first_left_descendant
                );
            }
            if let Some(stable_child) = partition_trace
                .nodes
                .iter()
                .filter(|entry| {
                    entry.encode_left_child_budget_before_call
                        == entry.decode_left_child_budget_before_call
                        && entry.encode_left_child_fill_before_call
                            == entry.decode_left_child_fill_before_call
                        && (entry.encode_left_child_gain_before_call
                            - entry.decode_left_child_gain_before_call)
                            .abs()
                            <= 1e-6
                        && entry.encode_child_remaining_bits_on_entry
                            == entry.decode_child_remaining_bits_on_entry
                        && entry.encode_child_tell_on_entry
                            == entry.decode_child_tell_on_entry
                        && entry.encode_child_fill_on_entry
                            == entry.decode_child_fill_on_entry
                        && entry.encode_child_theta_qalloc
                            == entry.decode_child_theta_qalloc
                        && entry.encode_child_theta_delta
                            == entry.decode_child_theta_delta
                        && entry.encode_child_theta_itheta
                            == entry.decode_child_theta_itheta
                        && entry.left_child_max_abs_error > 0.0
                })
                .min_by_key(|entry| entry.encode_visit_index)
            {
                let child_internal_stage = if stable_child.encode_child_remaining_bits_on_entry
                    != stable_child.decode_child_remaining_bits_on_entry
                    || stable_child.encode_child_tell_on_entry
                        != stable_child.decode_child_tell_on_entry
                    || stable_child.encode_child_fill_on_entry
                        != stable_child.decode_child_fill_on_entry
                {
                    "child_entry_state_diverges"
                } else if stable_child.encode_child_theta_qalloc
                    != stable_child.decode_child_theta_qalloc
                    || stable_child.encode_child_theta_delta
                        != stable_child.decode_child_theta_delta
                    || stable_child.encode_child_theta_itheta
                        != stable_child.decode_child_theta_itheta
                {
                    "child_local_theta_state_diverges"
                } else if stable_child.left_child_max_abs_error > 0.0 {
                    "child_subrecursion_or_leaf_return_diverges"
                } else {
                    "no_child_internal_divergence"
                };
                eprintln!(
                    "Budget loopback first child-internal node stage={}: {:?}",
                    child_internal_stage, stable_child
                );
                let first_returned_subchild_node = partition_trace
                    .nodes
                    .iter()
                    .filter(|entry| {
                        entry.depth == stable_child.depth + 1
                            && (entry.path_bits >> (entry.depth - stable_child.depth))
                                == stable_child.path_bits
                            && (entry.left_child_max_abs_error > 0.0
                                || entry.right_child_max_abs_error > 0.0)
                    })
                    .min_by_key(|entry| entry.encode_visit_index);
                let first_descendant_below_returned_subchild = first_returned_subchild_node
                    .and_then(|returned_subchild| {
                        partition_trace
                            .nodes
                            .iter()
                            .filter(|entry| {
                                entry.depth > returned_subchild.depth
                                    && (entry.path_bits
                                        >> (entry.depth - returned_subchild.depth))
                                        == returned_subchild.path_bits
                            })
                            .min_by_key(|entry| entry.encode_visit_index)
                    });
                let first_leaf_below_returned_subchild = first_returned_subchild_node.and_then(
                    |returned_subchild| {
                        partition_trace
                            .leaves
                            .iter()
                            .filter(|entry| {
                                entry.depth > returned_subchild.depth
                                    && (entry.path_bits
                                        >> (entry.depth - returned_subchild.depth))
                                        == returned_subchild.path_bits
                            })
                            .min_by_key(|entry| entry.encode_visit_index)
                    },
                );
                let first_left_branch_descendant = first_returned_subchild_node.and_then(
                    |returned_subchild| {
                        partition_trace
                            .nodes
                            .iter()
                            .filter(|entry| {
                                entry.depth > returned_subchild.depth
                                    && (entry.path_bits
                                        >> (entry.depth - returned_subchild.depth - 1))
                                        == (returned_subchild.path_bits << 1)
                            })
                            .min_by_key(|entry| entry.encode_visit_index)
                    },
                );
                let first_leaf_below_left_branch = first_returned_subchild_node.and_then(
                    |returned_subchild| {
                        partition_trace
                            .leaves
                            .iter()
                            .filter(|entry| {
                                entry.depth > returned_subchild.depth
                                    && (entry.path_bits
                                        >> (entry.depth - returned_subchild.depth - 1))
                                        == (returned_subchild.path_bits << 1)
                            })
                            .min_by_key(|entry| entry.encode_visit_index)
                    },
                );
                let first_descendant_with_left_call_input_divergence =
                    first_returned_subchild_node.and_then(|returned_subchild| {
                        partition_trace
                            .nodes
                            .iter()
                            .filter(|entry| {
                                entry.depth > returned_subchild.depth
                                    && (entry.path_bits
                                        >> (entry.depth - returned_subchild.depth - 1))
                                        == (returned_subchild.path_bits << 1)
                                    && (entry.encode_subchild_left_budget_before_call
                                        != entry.decode_subchild_left_budget_before_call
                                        || entry.encode_subchild_left_fill_before_call
                                            != entry.decode_subchild_left_fill_before_call
                                        || (entry.encode_subchild_left_gain_before_call
                                            - entry.decode_subchild_left_gain_before_call)
                                            .abs()
                                            > 1e-6)
                            })
                            .min_by_key(|entry| entry.encode_visit_index)
                    });
                let returned_subchild_left_stage = if let Some(entry) = first_returned_subchild_node
                {
                    if entry.encode_subchild_left_budget_before_call
                        != entry.decode_subchild_left_budget_before_call
                        || entry.encode_subchild_left_fill_before_call
                            != entry.decode_subchild_left_fill_before_call
                        || (entry.encode_subchild_left_gain_before_call
                            - entry.decode_subchild_left_gain_before_call)
                            .abs()
                            > 1e-6
                    {
                        "returned_subchild_left_call_inputs_diverge"
                    } else if entry.left_child_max_abs_error > 0.0
                        && (entry.left_return_parent_slice_max_abs_error
                            - entry.left_child_max_abs_error)
                            .abs()
                            < 1e-6
                    {
                        "returned_subchild_left_child_visible_before_parent_writeback"
                    } else if entry.left_return_parent_slice_max_abs_error > 0.0 {
                        "returned_subchild_parent_left_slice_after_left_return_diverges"
                    } else {
                        "returned_subchild_left_return_unresolved"
                    }
                } else {
                    "missing_returned_subchild"
                };
                let deeper_left_descendant_stage =
                    if let Some(entry) = first_descendant_with_left_call_input_divergence {
                        if let Some(parent) = partition_trace.nodes.iter().find(|node| {
                            node.decode_visit_index == entry.decode_parent_node_visit_index
                        }) {
                            if parent.left_child_max_abs_error > 0.0
                                && (parent.left_return_parent_slice_max_abs_error
                                    - parent.left_child_max_abs_error)
                                    .abs()
                                    < 1e-6
                            {
                                "parent_already_returns_bad_left_child"
                            } else {
                                "descendant_left_call_inputs_first_diverge_here"
                            }
                        } else {
                            "descendant_parent_missing_from_trace"
                        }
                    } else {
                        "no_descendant_left_call_input_divergence"
                    };
                let earlier_parent_left_return_node =
                    first_descendant_with_left_call_input_divergence.and_then(|entry| {
                        partition_trace.nodes.iter().find(|node| {
                            node.decode_visit_index == entry.decode_parent_node_visit_index
                        })
                    });
                let earlier_parent_left_return_stage =
                    if let Some(parent) = earlier_parent_left_return_node {
                        if parent.left_child_max_abs_error > 0.0
                            && (parent.left_return_parent_slice_max_abs_error
                                - parent.left_child_max_abs_error)
                                .abs()
                                < 1e-6
                        {
                            "earlier_parent_left_child_visible_before_parent_writeback"
                        } else if parent.left_return_parent_slice_max_abs_error > 0.0 {
                            "earlier_parent_parent_left_slice_after_left_return_diverges"
                        } else {
                            "earlier_parent_left_return_unresolved"
                        }
                    } else {
                        "missing_earlier_parent"
                    };
                let earlier_parent_immediate_left_child =
                    earlier_parent_left_return_node.and_then(|parent| {
                        partition_trace.nodes.iter().find(|entry| {
                            entry.depth == parent.depth + 1
                                && entry.path_bits == (parent.path_bits << 1)
                        })
                    });
                let band19_depth2_left_call_node = earlier_parent_immediate_left_child;
                let band19_depth2_left_child_descendant =
                    band19_depth2_left_call_node.and_then(|parent| {
                        partition_trace.nodes.iter().find(|entry| {
                            entry.depth == parent.depth + 1
                                && entry.path_bits == (parent.path_bits << 1)
                        })
                    });
                let band19_depth2_right_child_descendant =
                    band19_depth2_left_call_node.and_then(|parent| {
                        partition_trace.nodes.iter().find(|entry| {
                            entry.depth == parent.depth + 1
                                && entry.path_bits == ((parent.path_bits << 1) | 1)
                        })
                    });
                let band19_depth2_left_leaf =
                    band19_depth2_left_call_node.and_then(|parent| {
                        partition_trace.leaves.iter().find(|entry| {
                            entry.depth == parent.depth + 1
                                && entry.path_bits == (parent.path_bits << 1)
                        })
                    });
                let band19_depth2_right_leaf =
                    band19_depth2_left_call_node.and_then(|parent| {
                        partition_trace.leaves.iter().find(|entry| {
                            entry.depth == parent.depth + 1
                                && entry.path_bits == ((parent.path_bits << 1) | 1)
                        })
                    });
                let earlier_parent_child_stage =
                    if let Some(child) = earlier_parent_immediate_left_child {
                        if child.encode_left_child_budget_before_call
                            != child.decode_left_child_budget_before_call
                            || child.encode_left_child_fill_before_call
                                != child.decode_left_child_fill_before_call
                            || (child.encode_left_child_gain_before_call
                                - child.decode_left_child_gain_before_call)
                                .abs()
                                > 1e-6
                        {
                            "earlier_parent_child_left_call_inputs_diverge"
                        } else if child.left_child_max_abs_error > 0.0 {
                            "earlier_parent_child_internal_after_equal_call_inputs"
                        } else {
                            "earlier_parent_child_no_left_internal_divergence"
                        }
                    } else {
                        "missing_earlier_parent_child"
                    };
                let band19_depth2_left_call_stage = if let Some(node) = band19_depth2_left_call_node
                {
                    if node.encode_left_call_source_b_after_theta
                        != node.decode_left_call_source_b_after_theta
                        || node.encode_left_call_source_fill_after_theta
                            != node.decode_left_call_source_fill_after_theta
                        || node.encode_left_call_source_recurse_mid_first
                            != node.decode_left_call_source_recurse_mid_first
                    {
                        "left_call_source_state_diverges_before_child_budget_construction"
                    } else if node.encode_left_child_budget_before_call
                        != node.decode_left_child_budget_before_call
                        || node.encode_left_child_fill_before_call
                            != node.decode_left_child_fill_before_call
                        || (node.encode_left_child_gain_before_call
                            - node.decode_left_child_gain_before_call)
                            .abs()
                            > 1e-6
                    {
                        "left_call_budget_construction_diverges_after_equal_source_state"
                    } else {
                        "left_call_inputs_aligned"
                    }
                } else {
                    "missing_band19_depth2_left_call_node"
                };
                let band19_depth2_left_child_stage =
                    if let Some(child) = band19_depth2_left_child_descendant {
                        if child.encode_left_child_budget_before_call
                            != child.decode_left_child_budget_before_call
                            || child.encode_left_child_fill_before_call
                                != child.decode_left_child_fill_before_call
                            || (child.encode_left_child_gain_before_call
                                - child.decode_left_child_gain_before_call)
                                .abs()
                                > 1e-6
                        {
                            "band19_depth2_left_child_call_inputs_diverge"
                        } else if child.left_child_max_abs_error > 0.0
                            && (child.left_return_parent_slice_max_abs_error
                                - child.left_child_max_abs_error)
                                .abs()
                                < 1e-6
                        {
                            "band19_depth2_left_child_visible_before_parent_writeback"
                        } else if child.left_return_parent_slice_max_abs_error > 0.0 {
                            "band19_depth2_left_child_parent_slice_after_return_diverges"
                        } else {
                            "band19_depth2_left_child_unresolved"
                        }
                    } else {
                        "missing_band19_depth2_left_child_descendant"
                    };
                let band19_depth2_right_child_stage =
                    if let Some(child) = band19_depth2_right_child_descendant {
                        if child.right_child_max_abs_error > 0.0 {
                            "band19_depth2_right_child_visible_before_parent_writeback"
                        } else {
                            "band19_depth2_right_child_unresolved"
                        }
                    } else {
                        "missing_band19_depth2_right_child_descendant"
                    };
                let band19_depth2_leaf_stage =
                    if band19_depth2_left_child_descendant.is_none()
                        && band19_depth2_right_child_descendant.is_none()
                    {
                        if let Some(leaf) = band19_depth2_left_leaf.or(band19_depth2_right_leaf) {
                            if leaf.max_abs_error_vs_quantized > 0.0 {
                                "band19_depth2_leaf_return_diverges"
                            } else {
                                "band19_depth2_leaf_aligned"
                            }
                        } else {
                            "missing_band19_depth2_leaf"
                        }
                    } else {
                        "band19_depth2_descendants_exist"
                    };
                eprintln!("Budget loopback stable child node: {:?}", stable_child);
                eprintln!(
                    "Budget loopback first returned-subchild node: {:?}",
                    first_returned_subchild_node
                );
                eprintln!(
                    "Budget loopback first descendant below returned-subchild: {:?}",
                    first_descendant_below_returned_subchild
                );
                eprintln!(
                    "Budget loopback first leaf below returned-subchild: {:?}",
                    first_leaf_below_returned_subchild
                );
                eprintln!(
                    "Budget loopback first left-branch descendant below returned-subchild: {:?}",
                    first_left_branch_descendant
                );
                eprintln!(
                    "Budget loopback first leaf below returned-subchild left branch: {:?}",
                    first_leaf_below_left_branch
                );
                eprintln!(
                    "Budget loopback first deeper left-branch descendant with left-call-input divergence: {:?}",
                    first_descendant_with_left_call_input_divergence
                );
                eprintln!(
                    "Budget loopback earlier parent left-return node: {:?}",
                    earlier_parent_left_return_node
                );
                eprintln!(
                    "Budget loopback earlier parent immediate left child: {:?}",
                    earlier_parent_immediate_left_child
                );
                eprintln!(
                    "Budget loopback Band19 depth2 left-call node: {:?}",
                    band19_depth2_left_call_node
                );
                eprintln!(
                    "Budget loopback Band19 depth2 left child descendant: {:?}",
                    band19_depth2_left_child_descendant
                );
                eprintln!(
                    "Budget loopback Band19 depth2 right child descendant: {:?}",
                    band19_depth2_right_child_descendant
                );
                eprintln!(
                    "Budget loopback Band19 depth2 left leaf: {:?}",
                    band19_depth2_left_leaf
                );
                eprintln!(
                    "Budget loopback Band19 depth2 right leaf: {:?}",
                    band19_depth2_right_leaf
                );
                eprintln!(
                    "Budget loopback returned-subchild left stage={}",
                    returned_subchild_left_stage
                );
                eprintln!(
                    "Budget loopback deeper left-descendant stage={}",
                    deeper_left_descendant_stage
                );
                eprintln!(
                    "Budget loopback earlier parent left-return stage={}",
                    earlier_parent_left_return_stage
                );
                eprintln!(
                    "Budget loopback earlier parent child stage={}",
                    earlier_parent_child_stage
                );
                eprintln!(
                    "Budget loopback Band19 depth2 left-call stage={}",
                    band19_depth2_left_call_stage
                );
                eprintln!(
                    "Budget loopback Band19 depth2 left child stage={}",
                    band19_depth2_left_child_stage
                );
                eprintln!(
                    "Budget loopback Band19 depth2 right child stage={}",
                    band19_depth2_right_child_stage
                );
                eprintln!(
                    "Budget loopback Band19 depth2 leaf stage={}",
                    band19_depth2_leaf_stage
                );
            }
        }
        if let Some(worst_parent_assembly_divergence) =
            partition_trace.nodes.iter().max_by(|a, b| {
                a.parent_after_children_max_abs_error
                    .partial_cmp(&b.parent_after_children_max_abs_error)
                    .unwrap()
            })
        {
            eprintln!(
                "Budget loopback worst parent-assembly node divergence: {:?}",
                worst_parent_assembly_divergence
            );
        }
        if let Some(worst_leaf) = partition_trace.leaves.iter().max_by(|a, b| {
            a.max_abs_error_vs_quantized
                .partial_cmp(&b.max_abs_error_vs_quantized)
                .unwrap()
        }) {
            eprintln!("Budget loopback worst partition leaf: {:?}", worst_leaf);
            if worst_leaf.decode_q == 0 {
                let modeled = model_zero_pulse_reference_for_test(
                    worst_leaf.n,
                    worst_leaf.b_blocks,
                    worst_leaf.fill,
                    worst_leaf.decode_zero_pulse_lowband.as_deref(),
                    1.0,
                    worst_leaf
                        .decode_zero_pulse_seed_on_entry
                        .expect("expected zero-pulse seed"),
                );
                let mut worst_modeled_error = 0.0f32;
                for (expected, actual) in modeled
                    .post_renorm_vector
                    .iter()
                    .zip(worst_leaf.decode_vector.iter())
                {
                    worst_modeled_error = worst_modeled_error.max((expected - actual).abs());
                }
                eprintln!(
                    "Budget loopback zero-pulse modeled replay: mode={} fill_masked={} worst_error={:.6}",
                    modeled.mode, modeled.fill_masked, worst_modeled_error
                );
            }
            if let Some(worst_nonzero_leaf) = partition_trace
                .leaves
                .iter()
                .filter(|leaf| leaf.encode_q > 0 || leaf.decode_q > 0)
                .max_by(|a, b| {
                    a.max_abs_error_vs_quantized
                        .partial_cmp(&b.max_abs_error_vs_quantized)
                        .unwrap()
                })
            {
                eprintln!(
                    "Budget loopback worst nonzero-q partition leaf: {:?}",
                    worst_nonzero_leaf
                );
            }
            if let Some(best_cross_match) = partition_trace
                .leaves
                .iter()
                .filter(|entry| entry.band == worst_leaf.band)
                .map(|entry| {
                    let mut sq_error = 0.0f32;
                    let mut count = 0usize;
                    for (expected, actual) in entry.encode_quantized_vector.iter().zip(worst_leaf.decode_vector.iter()) {
                        let err = expected - actual;
                        sq_error += err * err;
                        count += 1;
                    }
                    let rms_error = if count == 0 {
                        0.0
                    } else {
                        (sq_error / count as f32).sqrt()
                    };
                    (entry, rms_error)
                })
                .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            {
                eprintln!(
                    "Budget loopback best cross-match leaf: path_bits={} depth={} rms_error={:.6}",
                    best_cross_match.0.path_bits,
                    best_cross_match.0.depth,
                    best_cross_match.1
                );
            }
            for node in partition_trace.nodes.iter().filter(|entry| {
                entry.band == worst_leaf.band
                    && entry.depth <= worst_leaf.depth
                    && (worst_leaf.path_bits >> (worst_leaf.depth - entry.depth))
                        == entry.path_bits
            }) {
                eprintln!("Budget loopback ancestor partition node: {:?}", node);
            }
        }
    }

    assert!(
        best_snr >= 1.3,
        "CELT at 160 bytes should achieve at least 1.3 dB SNR: got {:.2} dB",
        best_snr
    );
}

#[test]
fn celt_synthetic_band_roundtrip_check() {
    use opus_rs::bands::quant_band_synthetic_roundtrip_for_test;

    // Band 17, which has consistently shown the worst post-partition error.
    // At lm=3 (960-sample frame), band 17 has 32 coefficients.
    // Use a low-ish budget that triggers splitting (b > cache threshold).
    let result = quant_band_synthetic_roundtrip_for_test(
        17,   // band index
        32,   // N
        1200, // b in 1/8-bits (~150 bits for one band)
        1,    // B blocks
        2,    // lm (lm-1 relative to the band's frame lm=3)
        2,    // spread: SPREAD_NORMAL
        48,   // packet buffer bytes
    );

    eprintln!(
        "Synthetic band 17 roundtrip: max_abs_error={:.6}",
        result.max_abs_error
    );
    eprintln!("  encode_output[..8]: {:?}", &result.encode_output[..8.min(result.encode_output.len())]);
    eprintln!("  decode_output[..8]: {:?}", &result.decode_output[..8.min(result.decode_output.len())]);

    assert!(
        result.max_abs_error < 1e-5,
        "synthetic band 17 roundtrip has unacceptable error: {}",
        result.max_abs_error
    );

    // Sweep over failing budget parameters
    for b in [80, 120, 160, 200, 280, 400] {
        let result = quant_band_synthetic_roundtrip_for_test(17, 32, b, 1, 2, 2, 24);
        eprintln!("band=17 b={} max_abs_error={:.6}", b, result.max_abs_error);
        assert!(result.max_abs_error < 1e-5, "band=17 b={} roundtrip error too large", b);
    }
}

