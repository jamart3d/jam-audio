# Track 4AB Band 19 Depth 2 Child-Internal Recursion Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the first child-internal recursive seam below the `band=19`, `depth=2` node in `third_party/opus-rs/src/bands.rs` now that its local left-call-input construction is proven aligned.

**Architecture:** This pass stays inside the recursive `quant_partition(...)` trace path in `third_party/opus-rs/src/bands.rs` and the two CELT trace tests. Track 4AA proved the `band=19`, `depth=2` node’s source state and local left-call inputs match on the real gate, so the remaining defect must be deeper: either its left child’s own internal recursion, its leaf return, or the corresponding right-side child return before parent assembly.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Promote the `band=19`, `depth=2` Node to the Stable Parent Selector

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Preserve the Track 4AA selector for the pinned node**

Keep the existing selector that binds:

```rust
let band19_depth2_left_call_node = earlier_parent_immediate_left_child;
```

Do not broaden the search beyond this exact node.

- [ ] **Step 2: Add selectors for the node’s first child-internal descendants**

In both tests, derive:

```rust
let band19_depth2_left_child_descendant = band19_depth2_left_call_node.and_then(|parent| {
    trace.nodes.iter().find(|entry| {
        entry.depth == parent.depth + 1
            && entry.path_bits == (parent.path_bits << 1)
    })
});

let band19_depth2_right_child_descendant = band19_depth2_left_call_node.and_then(|parent| {
    trace.nodes.iter().find(|entry| {
        entry.depth == parent.depth + 1
            && entry.path_bits == ((parent.path_bits << 1) | 1)
    })
});
```

Also derive the first leaves directly below each branch:

```rust
let band19_depth2_left_leaf = band19_depth2_left_call_node.and_then(|parent| {
    trace.leaves.iter().find(|entry| {
        entry.depth == parent.depth + 1
            && entry.path_bits == (parent.path_bits << 1)
    })
});

let band19_depth2_right_leaf = band19_depth2_left_call_node.and_then(|parent| {
    trace.leaves.iter().find(|entry| {
        entry.depth == parent.depth + 1
            && entry.path_bits == ((parent.path_bits << 1) | 1)
    })
});
```

- [ ] **Step 3: Emit those descendants in focused and real traces**

Print:

```rust
eprintln!("Band19 depth2 left child descendant: {:?}", band19_depth2_left_child_descendant);
eprintln!("Band19 depth2 right child descendant: {:?}", band19_depth2_right_child_descendant);
eprintln!("Band19 depth2 left leaf: {:?}", band19_depth2_left_leaf);
eprintln!("Band19 depth2 right leaf: {:?}", band19_depth2_right_leaf);
```

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- focused path may still not reach the same descendant shape
- real gate should show at least one child descendant or leaf directly below the `band=19`, `depth=2` node

### Task 2: Classify the First Child-Internal Recursive Seam Below `band=19`, `depth=2`

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Classify left-child internal state first**

Add:

```rust
let band19_depth2_left_child_stage = if let Some(child) = band19_depth2_left_child_descendant {
    if child.encode_left_child_budget_before_call != child.decode_left_child_budget_before_call
        || child.encode_left_child_fill_before_call != child.decode_left_child_fill_before_call
        || (child.encode_left_child_gain_before_call - child.decode_left_child_gain_before_call).abs() > 1e-6
    {
        "band19_depth2_left_child_call_inputs_diverge"
    } else if child.left_child_max_abs_error > 0.0
        && (child.left_return_parent_slice_max_abs_error - child.left_child_max_abs_error).abs() < 1e-6
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
```

- [ ] **Step 2: Classify right-child internal state separately**

Add:

```rust
let band19_depth2_right_child_stage = if let Some(child) = band19_depth2_right_child_descendant {
    if child.right_child_max_abs_error > 0.0 {
        "band19_depth2_right_child_visible_before_parent_writeback"
    } else {
        "band19_depth2_right_child_unresolved"
    }
} else {
    "missing_band19_depth2_right_child_descendant"
};
```

This keeps the right side narrow. Do not add new right-branch instrumentation unless the trace proves the left branch is clean.

- [ ] **Step 3: Classify direct leaf seams only if no child descendant resolves the defect**

Add:

```rust
let band19_depth2_leaf_stage =
    if band19_depth2_left_child_descendant.is_none() && band19_depth2_right_child_descendant.is_none() {
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
```

- [ ] **Step 4: Run focused and real traces**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- the real gate should now name the first exact child-internal seam below `band=19`, `depth=2`

### Task 3: Add Bounded Trace Fields Only If the Child-Internal Boundary Is Still Ambiguous

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Only add new trace fields if Task 2 cannot distinguish child-descendant vs. leaf-return**

If Task 2 produces only unresolved states, add one bounded set of fields to `PartitionNodeRoundtripTrace` and the encode snapshot:

```rust
pub encode_left_grandchild_visit_index: usize,
pub decode_left_grandchild_visit_index: usize,
pub encode_right_grandchild_visit_index: usize,
pub decode_right_grandchild_visit_index: usize,
```

Use these only to map the first descendant level below `band=19`, `depth=2`. Do not add broader ancestry machinery.

- [ ] **Step 2: Do not change codec math while adding trace fields**

Allowed:

```rust
record_partition_node_post_children(...)
record_partition_node_left_return(...)
```

Disallowed:
- modifying budget math
- altering recursion order
- changing PVQ behavior
- changing lowband / zero-pulse behavior

- [ ] **Step 3: Re-run both tests after the bounded trace refinement**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- either the exact child-internal recursive seam is now named
- or you explicitly stop and record that the current instrumentation is still insufficient

### Task 4: Only Permit a Production Fix if a Single Child-Internal Surface Is Proven

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Verify with: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify with: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`

- [ ] **Step 1: Limit any production change to one exact child-internal seam**

Only if the trace proves one specific local seam may you patch one of:

```rust
the left-child recursive call site below band=19 depth=2
the right-child recursive call site below band=19 depth=2
the immediate leaf-return handoff below band=19 depth=2
```

Do not touch:
- `celt.rs`
- `rate.rs`
- `pvq.rs`
- zero-pulse reconstruction
- ancestor-node state above `band=19`, `depth=2`
- parent-left-slice writeback unless the child seam directly points there

- [ ] **Step 2: If no single child-internal seam is proven, stop without a codec fix**

If the trace still only says “somewhere below `band=19`, `depth=2`”, do not improvise a fix. Record the narrowest remaining ambiguity and stop.

- [ ] **Step 3: Re-run both tests after bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- if a bounded fix is real: the first divergent child-internal seam moves deeper or disappears
- if no fix was justified: the next exact descendant seam is named

### Task 5: Update Findings With the Child-Internal Result

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Append a Track 4AB section with the exact child-internal seam result**

Record:

- the aligned `band=19`, `depth=2` node from Track 4AA
- the first child descendant or leaf below it
- whether the first surviving seam is:
  - left-child recursive
  - right-child recursive
  - direct leaf-return
  - still trace-ambiguous
- whether a bounded `bands.rs` fix was justified
- the next narrower seam if CELT quality still fails

## Success Condition

Track 4AB is successful when:

1. the real `160`-byte gate identifies the first child-internal seam below the aligned `band=19`, `depth=2` node;
2. any added trace fields stay bounded to that immediate child layer;
3. any production edit is limited to one trace-proven `bands.rs` seam; and
4. the findings report names the next surviving seam if the CELT gate still fails.

## Commit Plan

- Commit 1: `test: trace band19 depth2 child-internal seam`
- Commit 2: `fix: correct band19 depth2 child-internal seam` *(only if a bounded production fix is justified)*
- Commit 3: `docs: record band19 depth2 child-internal findings`
