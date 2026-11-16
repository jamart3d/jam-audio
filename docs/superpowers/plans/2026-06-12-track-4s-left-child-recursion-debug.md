# Track 4S Left-Child Recursion Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the first concrete defect on the recursive left-child return path inside `quant_partition(...)` and either land one bounded `bands.rs` fix or stop with the next narrower proven boundary.

**Architecture:** This pass starts from Track 4R's result that the earliest live mismatch is already visible on left-child return. The work stays inside `third_party/opus-rs/src/bands.rs` plus the focused CELT diagnostics, and it separates child-local drift from parent observation by tracing the exact left-child slice at the parent recursion seam.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Pin the Earliest Left-Child Mismatch

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Tighten the focused trace to require the first mismatch to be a left-child stage**

Update the focused low-bitrate trace so it explicitly fails if the earliest recursive mismatch is not a populated left-child stage:

```rust
let first_recursive_node_mismatch = trace
    .nodes
    .iter()
    .filter(|entry| {
        entry.left_child_max_abs_error > 0.0
            || entry.right_child_max_abs_error > 0.0
            || entry.parent_after_children_max_abs_error > 0.0
    })
    .min_by_key(|entry| entry.encode_visit_index)
    .expect("expected first recursive node mismatch");

assert!(
    first_recursive_node_mismatch.left_child_max_abs_error > 0.0,
    "expected earliest recursive mismatch to already be visible on left child return"
);
assert!(
    !first_recursive_node_mismatch.encode_left_child_after_return.is_empty(),
    "expected populated encode left-child return vector"
);
assert!(
    !first_recursive_node_mismatch.decode_left_child_after_return.is_empty(),
    "expected populated decode left-child return vector"
);
```

- [ ] **Step 2: Run the focused trace and verify it still passes**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with the earliest recursive mismatch still reported at `stage=left_child`.

### Task 2: Trace the Parent's Exact Left-Child Slice

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Test: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Extend the node trace with parent-observed left-child slices**

Add bounded fields to the node trace and encode snapshot so the decode-side node can compare the exact left half of the parent buffer immediately after the left recursion returns:

```rust
pub encode_parent_left_slice_after_left_return: Vec<f32>,
pub decode_parent_left_slice_after_left_return: Vec<f32>,
pub left_return_parent_slice_max_abs_error: f32,
```

Mirror the same data in the encode snapshot used for pairing.

- [ ] **Step 2: Record the left-child seam before the right recursion starts**

Inside each `quant_partition(...)` split branch, capture:

```rust
let parent_left_slice_after_left_return = x[..mid].to_vec();
```

immediately after the left-child recursion returns and before:

```rust
cm |= quant_partition(... right child ...)
```

Wire that through the existing visit-token pairing so encode and decode traces compare the same node and same moment.

Do not change codec math, recurse order, allocation, `compute_theta(...)`, PVQ coding, or final recombine logic.

- [ ] **Step 3: Run the focused trace and verify the new slice fields populate**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with the earliest mismatching node now carrying:

- `encode_parent_left_slice_after_left_return`
- `decode_parent_left_slice_after_left_return`
- `left_return_parent_slice_max_abs_error`

### Task 3: Prove Whether the Left Child Is Wrong Before Parent Observation

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Report the first left-child defect at the narrowest proven seam**

Update the focused reporting so it distinguishes between:

```rust
let left_stage = if entry.left_child_max_abs_error > 0.0
    && entry.left_return_parent_slice_max_abs_error == 0.0
{
    "child_output_only"
} else if entry.left_return_parent_slice_max_abs_error > 0.0 {
    "parent_left_slice_after_left_return"
} else {
    "not_left_child"
};
```

Print the exact vectors needed to justify the label.

- [ ] **Step 2: Run the focused trace and capture the exact left-child boundary**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, proving one of two concrete outcomes:

- the left child output is already wrong before it is written back into the parent slice
- the child output is locally correct and drift appears when the parent observes or stores that left slice

- [ ] **Step 3: Land one bounded `bands.rs` fix only if the trace proves a local writeback bug**

Only make a production edit if the trace proves the defect is in parent-side left-slice storage or handoff. Acceptable surfaces are the slice/writeback path surrounding:

```rust
let (x_mid, x_side) = x.split_at_mut(mid);
cm = quant_partition(... x_mid ...)
```

Do not touch:

- `celt.rs`
- `rate.rs`
- `pvq.rs`
- right-child recursion
- top-level recombine logic

- [ ] **Step 4: Re-run the focused trace after the bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected:

- if a fix was landed: PASS with the first mismatch moved deeper or eliminated
- if no fix was justified: PASS with explicit proof of the next narrower boundary

### Task 4: Re-run the Real CELT Gate and Record the Boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Run the real 160-byte gate**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:

- if a bounded `bands.rs` fix was real, SNR should improve beyond the current `0.72 dB`
- otherwise the test may still fail, but the first left-child boundary must now be explicit

- [ ] **Step 2: Update the findings report with exact evidence**

Append a Track 4S section that records:

- the new left-child seam fields
- whether the first defect is child-local or parent-observed
- exact focused and real-gate outputs
- whether a bounded `bands.rs` fix was justified
- the next narrower target if the bug survives

## Success Condition

- the first live left-child-return defect is proven at the narrowest currently visible seam
- either one bounded `bands.rs` fix is landed and verified, or the next exact boundary is established without guessing
- no unrelated codec subsystems are touched
