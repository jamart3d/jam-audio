# Track 4Z Earlier Parent Left-Return Seam Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the earlier recursive parent on the bad left branch that already returns a bad left child before the `band=19`, `depth=2` descendant develops its own local left-call-input divergence.

**Architecture:** This pass stays entirely inside the recursive `quant_partition(...)` trace path in `third_party/opus-rs/src/bands.rs` plus the two CELT trace tests. Track 4Y proved the `band=19`, `depth=2` node is inheriting corruption from an earlier parent-left-return seam, so this plan walks one level up that traced branch and classifies whether the first bad left return is already visible on the ancestor node itself or at its own immediate left child.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Select the Earlier Parent Above the `band=19`, `depth=2` Descendant

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Preserve the existing Track 4Y real-gate selector**

Keep the current selector that identifies:

```rust
let first_descendant_with_left_call_input_divergence = first_returned_subchild_node.and_then(|returned_subchild| {
    trace.nodes.iter().filter(|entry| {
        entry.depth > returned_subchild.depth
            && (entry.path_bits >> (entry.depth - returned_subchild.depth - 1))
                == (returned_subchild.path_bits << 1)
            && (entry.encode_subchild_left_budget_before_call
                != entry.decode_subchild_left_budget_before_call
                || entry.encode_subchild_left_fill_before_call
                    != entry.decode_subchild_left_fill_before_call
                || (entry.encode_subchild_left_gain_before_call
                    - entry.decode_subchild_left_gain_before_call)
                    .abs()
                    > 1e-6)
    }).min_by_key(|entry| entry.encode_visit_index)
});
```

Do not broaden the search outside the already-proven left branch.

- [ ] **Step 2: Add a selector for that descendant’s immediate traced parent**

In both tests, derive:

```rust
let earlier_parent_left_return_node = first_descendant_with_left_call_input_divergence.and_then(|entry| {
    trace.nodes.iter().find(|node| {
        node.decode_visit_index == entry.decode_parent_node_visit_index
    })
});
```

Expected real-gate target from Track 4Y:
- parent should resolve to the node just above `band=19`, `depth=2`
- this is the first candidate seam that may already be returning a bad left child

- [ ] **Step 3: Print the earlier parent explicitly in focused and real traces**

Emit:

```rust
eprintln!(
    "Earlier parent left-return node: {:?}",
    earlier_parent_left_return_node
);
```

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- focused path may still have no deeper divergent descendant
- real gate should resolve an earlier parent node above the `band=19`, `depth=2` descendant

### Task 2: Separate Earlier-Parent Left-Return From Its Own Immediate Left Child

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Reuse existing ancestry and add no new codec behavior**

Do not change codec math. Only use the existing trace fields already present on `PartitionNodeRoundtripTrace`:

```rust
left_child_max_abs_error
left_return_parent_slice_max_abs_error
encode_left_child_after_return
decode_left_child_after_return
encode_parent_left_slice_after_left_return
decode_parent_left_slice_after_left_return
encode_left_child_vector
decode_left_child_vector
```

If any of those vectors are unexpectedly empty on the earlier parent, treat that as trace insufficiency and stop. Do not patch production math from incomplete trace state.

- [ ] **Step 2: Add an explicit earlier-parent stage classification**

In both tests, classify the earlier parent as:

```rust
let earlier_parent_left_return_stage = if let Some(parent) = earlier_parent_left_return_node {
    if parent.left_child_max_abs_error > 0.0
        && (parent.left_return_parent_slice_max_abs_error - parent.left_child_max_abs_error).abs() < 1e-6
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
```

This must answer whether the parent is already bad on the child-return vector or only becomes bad when observed through its own parent-left slice.

- [ ] **Step 3: Print the earlier-parent stage and verify it in the real gate**

Emit:

```rust
eprintln!(
    "Earlier parent left-return stage={}",
    earlier_parent_left_return_stage
);
```

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- FAIL near `0.72 dB`
- but one exact earlier-parent stage is now proven

### Task 3: Check Whether the Earlier Parent’s Own Left Child Is the First Live Seam

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Select the earlier parent’s immediate left child descendant**

Add:

```rust
let earlier_parent_immediate_left_child = earlier_parent_left_return_node.and_then(|parent| {
    trace.nodes.iter().find(|entry| {
        entry.depth == parent.depth + 1
            && entry.path_bits == (parent.path_bits << 1)
    })
});
```

This is not a broad descendant scan. It is only the immediate left child of the earlier parent.

- [ ] **Step 2: Classify whether that child already enters with divergent local left-call inputs**

Add:

```rust
let earlier_parent_child_stage = if let Some(child) = earlier_parent_immediate_left_child {
    if child.encode_left_child_budget_before_call != child.decode_left_child_budget_before_call
        || child.encode_left_child_fill_before_call != child.decode_left_child_fill_before_call
        || (child.encode_left_child_gain_before_call - child.decode_left_child_gain_before_call).abs() > 1e-6
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
```

This distinguishes:
- earlier parent already bad with no deeper child proof
- earlier parent’s immediate left child is already locally divergent
- no immediate child evidence yet

- [ ] **Step 3: Only permit a bounded `bands.rs` fix if the earlier parent or its immediate child is locally proven**

Allowed production surfaces, only if trace-proven:

```rust
record_partition_node_left_return(...)
record_partition_node_post_children(...)
record_partition_node_left_call_inputs(...)
the exact recursive left-child call site for the earlier parent or its immediate child
```

Do not touch:
- `celt.rs`
- `rate.rs`
- `pvq.rs`
- zero-pulse reconstruction
- right-branch logic
- descendant-local fixes at `band=19`, `depth=2` unless the earlier parent proof explicitly collapses there

- [ ] **Step 4: Re-run focused and real traces after diagnostic stop or bounded fix**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- if a bounded parent-level fix was real: the first bad left-return seam moves deeper or disappears
- if no fix was justified: the exact earlier-parent or immediate-child seam is named for the next pass

### Task 4: Update Findings With the Earlier-Parent Result

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Append a Track 4Z section with exact earlier-parent evidence**

Record:

- the descendant pinned in Track 4Y
- the earlier parent above it
- the earlier parent left-return stage
- the earlier parent’s immediate left child stage
- whether a bounded `bands.rs` fix was justified
- the next narrower seam if the bug survives

## Success Condition

Track 4Z is successful when:

1. the real `160`-byte trace identifies the earlier parent above the `band=19`, `depth=2` descendant;
2. the earlier parent is classified as already-bad-on-child-return vs. only-bad-on-parent-slice;
3. the immediate left child under that parent is classified as locally divergent vs. still inheriting;
4. any production edit is limited to one trace-proven `bands.rs` seam; and
5. the findings report names the next surviving seam if CELT quality is still bad.

## Commit Plan

- Commit 1: `test: trace earlier parent left-return seam`
- Commit 2: `fix: correct earlier parent left-return seam` *(only if a bounded production fix is justified)*
- Commit 3: `docs: record earlier parent left-return findings`
