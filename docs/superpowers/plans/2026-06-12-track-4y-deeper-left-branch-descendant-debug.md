# Track 4Y Deeper Left-Branch Descendant Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the first exact defect in the deeper left-branch recursive descendant under the returned-subchild node, and land one bounded `bands.rs` fix only if the trace proves a local descendant bug.

**Architecture:** This pass stays inside `third_party/opus-rs/src/bands.rs` and the two CELT trace tests. Track 4X proved the returned-subchild node’s own left-call inputs are aligned and its left child is already wrong before parent writeback. The real `160`-byte gate also exposed a deeper left-branch descendant whose own local left-call inputs diverge. This plan follows that exact descendant seam instead of editing the returned-subchild node itself.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Pin the First Deeper Left-Branch Descendant With Divergent Local Left-Call Inputs

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Keep the Track 4X selectors through the returned-subchild left seam**

In both tests, preserve the existing selection chain:

- stable child node
- first returned-subchild node
- first left-branch descendant below that returned-subchild node

Do not broaden the search again; all new classification must stay under that already-proven left branch.

- [ ] **Step 2: Add a selector for the first deeper descendant whose own left-call inputs diverge**

Under the returned-subchild left branch, select:

```rust
let first_descendant_with_left_call_input_divergence = trace
    .nodes
    .iter()
    .filter(|entry| {
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
    })
    .min_by_key(|entry| entry.encode_visit_index);
```

This selector should identify the real-gate node already observed around `band=19`, `depth=2`.

- [ ] **Step 3: Run the focused and real traces to verify where this selector exists**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:

- focused trace may not have a deeper descendant with divergent local left-call inputs
- real `160`-byte gate should identify the first descendant whose own local left-call inputs diverge

### Task 2: Separate Descendant Local-Left-Call Inputs From Earlier Parent-Carried State

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Test: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Add one bounded ancestry hint for the descendant’s immediate traced parent**

Add one bounded scalar field to `PartitionNodeRoundtripTrace` and the encode snapshot:

```rust
pub encode_parent_node_visit_index: usize,
pub decode_parent_node_visit_index: usize,
```

This is for recursive nodes, not leaves. Use the nearest traced parent node in the current recursion path. The purpose is to prove whether the divergent descendant is receiving wrong left-call inputs from its immediate traced parent or is being mismatched by trace pairing.

- [ ] **Step 2: Record that parent ancestry without changing recursion or codec math**

Inside `quant_partition(...)`, record the nearest traced parent node visit index when creating a node trace. Only wire ancestry; do not change:

- `ctx.remaining_bits`
- `sctx`
- recursion order
- left/right branch order
- PVQ or zero-pulse behavior

- [ ] **Step 3: Run the focused trace to verify recursive-node parent ancestry populates**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with recursive nodes below the returned-subchild branch now carrying non-default parent-node ancestry.

### Task 3: Prove Whether the Deeper Descendant Bug Is Parent-Carried or Local to That Descendant

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a deeper-descendant stage classification**

Classify the first descendant whose own local left-call inputs diverge as:

```rust
let deeper_left_descendant_stage =
    if let Some(parent_visit_index) = entry.decode_parent_node_visit_index.checked_sub(0) {
        if let Some(parent) = trace.nodes.iter().find(|node| node.decode_visit_index == parent_visit_index) {
            if parent.left_child_max_abs_error > 0.0
                && (parent.left_return_parent_slice_max_abs_error - parent.left_child_max_abs_error)
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
        "descendant_parent_missing_from_trace"
    };
```

The exact helper can differ, but the classification must distinguish:

- the parent already returned a bad left child before this descendant
- this descendant is the first node where local left-call inputs actually diverge
- trace ancestry is insufficient / mismatched

- [ ] **Step 2: Run the real gate and capture the first exact deeper-descendant stage**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected: FAIL at about `0.72 dB`, but with one explicit result:

- the deeper descendant is the first real left-call-input divergence
- or the parent above it was already returning a bad left child, meaning the divergence is inherited

- [ ] **Step 3: Only land one bounded `bands.rs` fix if the trace proves a local descendant bug**

Only make a production edit if the trace proves a local bug at one of these exact descendant surfaces:

```rust
record_partition_node_left_call_inputs(...)
ctx.trace_path_bits
ctx.trace_depth
the exact recursive left-call site for that descendant
```

Do not touch:

- `celt.rs`
- `rate.rs`
- `pvq.rs`
- zero-pulse reconstruction
- right-branch logic
- top-level parent assembly
- returned-subchild node writeback unless the descendant proof directly points back there

- [ ] **Step 4: Re-run focused and real traces after the bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:

- if a local descendant fix was real: the first divergent descendant moves deeper or disappears
- if no fix was justified: the next exact descendant seam is explicitly proven

### Task 4: Update Findings With the Descendant-Level Result

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Append a Track 4Y section with exact descendant-level evidence**

Record:

- the stable child node
- the returned-subchild node
- the first left-branch descendant under that node
- whether that descendant is:
  - the first local left-call-input divergence
  - inheriting an already-bad left child from its parent
  - blocked by trace ancestry mismatch
- whether a bounded `bands.rs` fix was justified
- the next narrower target if the bug survives

## Success Condition

Track 4Y is successful when:

1. the real `160`-byte trace proves whether the deeper left-branch descendant is the first local left-call-input divergence or is inheriting earlier corruption;
2. any production edit is limited to one bounded, trace-proven `bands.rs` surface;
3. focused and real traces are rerun; and
4. the findings report names the next surviving seam if the codec bug remains.

## Commit Plan

- Commit 1: `test: trace deeper left-branch descendant ancestry`
- Commit 2: `fix: correct deeper left-branch descendant seam` *(only if a bounded production fix is justified)*
- Commit 3: `docs: record deeper left-branch descendant findings`
