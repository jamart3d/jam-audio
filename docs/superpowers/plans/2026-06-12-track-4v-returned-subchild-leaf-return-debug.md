# Track 4V Returned-Subchild / Leaf-Return Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate whether the next live defect inside the child-internal recursive path comes from the first returned subchild or from the first leaf-return state beneath that child, and land one bounded `bands.rs` fix only if the trace proves a local return-path bug.

**Architecture:** This pass stays inside `third_party/opus-rs/src/bands.rs` and the two CELT trace tests. The key move is to extend recursive node/leaf tracing just enough to separate three deeper outcomes under the already-proven stable child node: first returned left subchild, first returned right subchild, or first leaf-return state beneath that child. No allocation, theta, PVQ, or zero-pulse algorithm changes are allowed unless the trace proves a local return-path defect.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Pin the First Returned-Subchild or Leaf-Return Boundary Under the Stable Child Node

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a selector for the first stable child-internal node**

Reuse the Track 4U criteria directly in both tests so the first stable child-internal node is selected by:

```rust
entry.encode_left_child_budget_before_call == entry.decode_left_child_budget_before_call
    && entry.encode_left_child_fill_before_call == entry.decode_left_child_fill_before_call
    && (entry.encode_left_child_gain_before_call - entry.decode_left_child_gain_before_call).abs() <= 1e-6
    && entry.encode_child_remaining_bits_on_entry == entry.decode_child_remaining_bits_on_entry
    && entry.encode_child_tell_on_entry == entry.decode_child_tell_on_entry
    && entry.encode_child_fill_on_entry == entry.decode_child_fill_on_entry
    && entry.encode_child_theta_qalloc == entry.decode_child_theta_qalloc
    && entry.encode_child_theta_delta == entry.decode_child_theta_delta
    && entry.encode_child_theta_itheta == entry.decode_child_theta_itheta
    && entry.left_child_max_abs_error > 0.0
```

The test should continue to print this node explicitly before looking deeper.

- [ ] **Step 2: Add descendant selection beneath that stable child node**

Under that stable child node, identify:

```rust
let first_descendant_below_child = trace
    .nodes
    .iter()
    .filter(|entry| {
        entry.depth > stable_child.depth
            && (entry.path_bits >> (entry.depth - stable_child.depth - 1))
                == (stable_child.path_bits << 1)
    })
    .min_by_key(|entry| entry.encode_visit_index);
```

and the first traced leaf beneath the same subtree:

```rust
let first_leaf_below_child = trace
    .leaves
    .iter()
    .filter(|entry| {
        entry.depth > stable_child.depth
            && (entry.path_bits >> (entry.depth - stable_child.depth - 1))
                == (stable_child.path_bits << 1)
    })
    .min_by_key(|entry| entry.encode_visit_index);
```

These selectors should not yet decide the bug. They only identify the next returned-subchild and leaf-return candidates.

- [ ] **Step 3: Run the focused trace and verify both deeper selectors populate**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with output naming:

- the stable child-internal node
- the first descendant below that node
- the first leaf below that node

### Task 2: Add Return-Path Stage Fields for the Stable Child’s Descendants

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Test: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Extend recursive node tracing with returned-subchild ordering fields**

Add bounded scalar fields to `PartitionNodeRoundtripTrace` and its encode snapshot so the trace can identify which returned subchild is being observed:

```rust
pub encode_child_left_descendant_visit_index: usize,
pub decode_child_left_descendant_visit_index: usize,
pub encode_child_right_descendant_visit_index: usize,
pub decode_child_right_descendant_visit_index: usize,
```

These should be populated only for traced recursive descendants under the current stable child subtree.

- [ ] **Step 2: Extend partition leaf tracing with parent-child ancestry hints**

Add bounded ancestry fields to `PartitionLeafRoundtripTrace` so a traced leaf can be tied back to the stable child node:

```rust
pub encode_parent_node_visit_index: usize,
pub decode_parent_node_visit_index: usize,
```

Use the nearest recursive parent node already being traced in `quant_partition(...)`.

- [ ] **Step 3: Record the return-path ancestry without changing codec math**

Inside `third_party/opus-rs/src/bands.rs`, record these fields only from existing recursion structure:

- when descending into the child’s left recursive call
- when descending into the child’s right recursive call
- when recording a leaf snapshot

Do not change:

- recursion order
- split budgets
- theta math
- PVQ coding
- zero-pulse handling
- parent recombine

- [ ] **Step 4: Run the focused trace and verify the new ancestry fields populate**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with the first descendant and first leaf beneath the stable child carrying non-default ancestry fields.

### Task 3: Prove Whether the Next Live Defect Is Returned-Subchild or Leaf-Return

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a deeper return-path classification**

In both tests, classify the next deeper boundary under the stable child as:

```rust
let return_path_stage = if let Some(descendant) = first_descendant_below_child {
    if descendant.left_child_max_abs_error > 0.0 || descendant.right_child_max_abs_error > 0.0 {
        "returned_subchild_diverges"
    } else if let Some(leaf) = first_leaf_below_child {
        if leaf.max_abs_error_vs_quantized > 0.0 {
            "leaf_return_diverges"
        } else {
            "no_deeper_return_divergence"
        }
    } else {
        "no_deeper_return_divergence"
    }
} else if let Some(leaf) = first_leaf_below_child {
    if leaf.max_abs_error_vs_quantized > 0.0 {
        "leaf_return_diverges"
    } else {
        "no_deeper_return_divergence"
    }
} else {
    "no_deeper_return_divergence"
};
```

Print the exact descendant or leaf payload alongside the stage.

- [ ] **Step 2: Run the focused trace and capture the first true return-path boundary**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with one concrete outcome:

- returned subchild already diverges
- returned subchild stays aligned, but the first leaf-return diverges

- [ ] **Step 3: Only land one bounded `bands.rs` fix if the trace proves a local return-path bug**

Only make a production edit if the trace proves a local `bands.rs` return-path defect at one of these exact surfaces:

```rust
record_partition_node_left_return(...)
record_partition_node_post_children(...)
record_partition_leaf_snapshot(...)
ctx.trace_path_bits
ctx.trace_depth
```

or the immediate recursive return-site state threaded into those hooks.

Do not touch:

- `celt.rs`
- `rate.rs`
- `pvq.rs`
- theta math
- zero-pulse reconstruction
- top-level assembly

- [ ] **Step 4: Re-run the focused trace after the bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected:

- if a local return-path fix was real: PASS with the first deeper boundary moved below the current returned-subchild or leaf-return seam
- if no fix was justified: PASS with the next exact seam explicitly proven

### Task 4: Re-run the Real 160-Byte Gate and Record the Next Boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Run the real CELT loopback gate**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:

- if a bounded return-path fix was real, SNR should improve beyond `0.72 dB`
- otherwise the test may still fail, but the next deeper seam must now be explicit

- [ ] **Step 2: Update the findings report with exact Track 4V evidence**

Append a Track 4V section that records:

- the stable child node under equal call inputs, equal child entry state, and equal child theta state
- the first returned subchild beneath that node
- the first leaf beneath that node
- whether the next defect is:
  - returned subchild divergence
  - leaf-return divergence
- whether a bounded `bands.rs` fix was justified
- the next narrower target if the bug survives

## Success Condition

- the current “child_subrecursion_or_leaf_return_diverges” bucket is reduced to one narrower return-path seam
- either one bounded `bands.rs` fix is landed and verified, or the next deeper returned-subchild / leaf-return boundary is proven without guessing
- no unrelated codec subsystems are touched
