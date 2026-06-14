# Track 4X Returned-Subchild Left-Return Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the first exact defect on the returned-subchild left-return seam inside `quant_partition(...)`, and land one bounded `bands.rs` fix only if the trace proves a local left-return bug.

**Architecture:** This pass stays inside `third_party/opus-rs/src/bands.rs` and the two CELT trace tests. Track 4W proved the next live boundary is `returned_subchild_left_return_diverges`. The next move is to split that seam into three narrower surfaces: left-child call input to the returned-subchild’s own left branch, the left child’s returned vector itself, and the parent-left slice immediately after that left return.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Pin the Returned-Subchild Left-Return Node and Its Immediate Left Branch

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Select the first returned-subchild node already proven by Track 4W**

In both tests, keep the Track 4W stable-child selector, then keep the Track 4W returned-subchild selector:

```rust
let first_returned_subchild_node = trace
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
```

Then assert the selected node is the one being classified, not a broader descendant.

- [ ] **Step 2: Add a selector for the first deeper left-branch descendant under that returned-subchild**

Under the returned-subchild node, select the first node in its left subtree:

```rust
let first_left_branch_descendant = trace
    .nodes
    .iter()
    .filter(|entry| {
        entry.depth > returned_subchild.depth
            && (entry.path_bits >> (entry.depth - returned_subchild.depth - 1))
                == (returned_subchild.path_bits << 1)
    })
    .min_by_key(|entry| entry.encode_visit_index);
```

Also keep the leaf selector under that same left subtree:

```rust
let first_leaf_below_left_branch = trace
    .leaves
    .iter()
    .filter(|entry| {
        entry.depth > returned_subchild.depth
            && (entry.path_bits >> (entry.depth - returned_subchild.depth - 1))
                == (returned_subchild.path_bits << 1)
    })
    .min_by_key(|entry| entry.encode_visit_index);
```

These selectors only identify the next left-return seam; they do not diagnose it yet.

- [ ] **Step 3: Run the focused trace and verify the returned-subchild left seam selectors populate**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with output naming:

- the stable child node
- the first returned-subchild node
- the first deeper left-branch descendant, if any
- the first leaf below that returned-subchild left branch

### Task 2: Add Returned-Subchild Left-Return Scalar Tracing in `bands.rs`

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Test: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Extend `PartitionNodeRoundtripTrace` with returned-subchild left-return scalars**

Add bounded scalar fields to the node trace for the returned-subchild’s own left-return seam:

```rust
pub encode_subchild_left_budget_before_call: i32,
pub decode_subchild_left_budget_before_call: i32,
pub encode_subchild_left_fill_before_call: u32,
pub decode_subchild_left_fill_before_call: u32,
pub encode_subchild_left_gain_before_call: f32,
pub decode_subchild_left_gain_before_call: f32,
```

Only add the left-branch call-input scalars needed to distinguish:

- mismatch before the returned-subchild’s left recursive call
- mismatch only after the left child returns

- [ ] **Step 2: Record the returned-subchild’s own left-call inputs**

At the exact recursive left-call site inside the returned-subchild node, record:

```rust
budget
fill
gain
```

using the existing trace pairing model. This must be the left child of the returned-subchild node, not the earlier stable child.

- [ ] **Step 3: Reuse existing vectors; do not add new bulk vector fields**

Use the existing fields already present on `PartitionNodeRoundtripTrace`:

```rust
encode_left_child_after_return
decode_left_child_after_return
encode_parent_left_slice_after_left_return
decode_parent_left_slice_after_left_return
left_child_max_abs_error
left_return_parent_slice_max_abs_error
```

Do not add new vector captures in this pass. The goal is to separate call-input mismatch from post-return mismatch with minimal new state.

- [ ] **Step 4: Run the focused trace and verify the returned-subchild left-call scalars populate**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with the returned-subchild node carrying non-default left-call input scalars for both encode and decode traces.

### Task 3: Split the Returned-Subchild Left-Return Seam Into Call Inputs, Returned Left Child, or Parent-Left Slice

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a returned-subchild left-return stage classification**

In both tests, classify the returned-subchild left seam as:

```rust
let returned_subchild_left_stage =
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
        && (entry.left_return_parent_slice_max_abs_error - entry.left_child_max_abs_error).abs()
            < 1e-6
    {
        "returned_subchild_left_child_visible_before_parent_writeback"
    } else if entry.left_return_parent_slice_max_abs_error > 0.0 {
        "returned_subchild_parent_left_slice_after_left_return_diverges"
    } else {
        "returned_subchild_left_return_unresolved"
    };
```

Print the exact scalar values and the existing left-return vector errors next to the stage.

- [ ] **Step 2: Run the focused trace and capture the first true left-return substage**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with one concrete outcome:

- returned-subchild left-call inputs already differ
- returned left child itself is already divergent before any parent-left-slice writeback
- parent-left slice diverges beyond the child-return error

- [ ] **Step 3: Only land one bounded `bands.rs` fix if the trace proves a local left-return bug**

Only make a production edit if the trace proves a local bug at one of these exact surfaces:

```rust
record_partition_node_left_call_inputs(...)
record_partition_node_left_return(...)
ctx.trace_path_bits
ctx.trace_depth
```

or the immediate left-call-site state threaded into those hooks.

Do not touch:

- `celt.rs`
- `rate.rs`
- `pvq.rs`
- zero-pulse reconstruction
- right-child logic
- top-level parent assembly
- broad recursion-order changes

- [ ] **Step 4: Re-run the focused trace after the bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected:

- if a local left-return fix was real: PASS with the first mismatch moved below the returned-subchild left seam
- if no fix was justified: PASS with the next exact left-return substage explicitly proven

### Task 4: Re-run the Real 160-Byte Gate and Record the Narrower Boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Run the real 160-byte CELT gate**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:

- if a bounded returned-subchild left-return fix was real, SNR should improve beyond `0.72 dB`
- otherwise the test may still fail, but the exact left-return substage must now be explicit

- [ ] **Step 2: Update the findings report with exact Track 4X evidence**

Append a Track 4X section that records:

- the stable child node
- the returned-subchild node below it
- the first deeper left-branch descendant, if any
- the first leaf below that left branch
- whether the first left-return substage is:
  - returned-subchild left-call inputs
  - returned left child before parent writeback
  - parent-left slice after left return
- whether a bounded `bands.rs` fix was justified
- the next narrower target if the bug survives

## Success Condition

Track 4X is successful when:

1. the focused trace proves the first exact substage on the returned-subchild left-return seam;
2. any production edit is limited to one bounded, trace-proven `bands.rs` surface;
3. the real `celt_loopback_160bytes` gate is rerun; and
4. the findings report names the next surviving seam if the codec bug remains.

## Commit Plan

- Commit 1: `test: trace returned-subchild left-return seam`
- Commit 2: `fix: correct returned-subchild left-return seam` *(only if a bounded production fix is justified)*
- Commit 3: `docs: record returned-subchild left-return findings`
