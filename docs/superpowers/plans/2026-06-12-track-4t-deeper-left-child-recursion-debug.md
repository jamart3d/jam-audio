# Track 4T Deeper Left-Child Recursion Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the next deeper defect inside the recursive left-child path in `quant_partition(...)`, below the parent-observed left-slice seam proven in Track 4S, and land one bounded `bands.rs` fix only if the trace proves a local recursion bug.

**Architecture:** This pass stays entirely inside `third_party/opus-rs/src/bands.rs` and the focused CELT diagnostics. The key move is to trace recursive left-child subnodes with enough path-local state to determine whether the next defect comes from the child’s own split recursion, its local theta/split setup, or the first leaf returned under that branch.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Pin the First Deeper Left-Child Descendant

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a focused selector for the earliest descendant under the first bad left-child branch**

Update the focused trace so it identifies the earliest recursive descendant under the first bad node’s left branch:

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

let first_left_descendant = trace
    .nodes
    .iter()
    .filter(|entry| {
        entry.depth > first_recursive_node_mismatch.depth
            && (entry.path_bits >> (entry.depth - first_recursive_node_mismatch.depth - 1))
                == (first_recursive_node_mismatch.path_bits << 1)
    })
    .min_by_key(|entry| entry.encode_visit_index)
    .expect("expected descendant under first bad left-child branch");
```

Keep the assertion narrow: the test should fail if no deeper left-child descendant is found.

- [ ] **Step 2: Run the focused trace and verify the descendant exists**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with output naming both:

- the first bad left-child node
- the earliest traced descendant beneath that left branch

### Task 2: Add Branch-Local Split-State Instrumentation

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Test: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Extend node tracing with branch-local split state**

Add bounded trace fields to `PartitionNodeRoundtripTrace` and the paired encode snapshot so each traced node can expose the exact state entering its own left recursion:

```rust
pub encode_left_child_budget_before_call: i32,
pub decode_left_child_budget_before_call: i32,
pub encode_left_child_fill_before_call: u32,
pub decode_left_child_fill_before_call: u32,
pub encode_left_child_gain_before_call: f32,
pub decode_left_child_gain_before_call: f32,
```

Use exact scalar fields, not broad buffer snapshots.

- [ ] **Step 2: Record those fields immediately before the recursive left-child call**

Inside each `quant_partition(...)` split branch, record the actual values passed into the left recursion:

```rust
mbits
fill_mut
gain * (sctx.imid as f32 / 32768.0)
```

for the left branch that is about to be called.

Do not change:

- recurse order
- `compute_theta(...)`
- allocation logic
- PVQ coding
- leaf modeling

- [ ] **Step 3: Run the focused trace and verify the new fields populate**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with the earliest deeper descendant carrying populated branch-local split-state fields.

### Task 3: Prove Whether the Deeper Left Defect Is Split-State or Child-Internal

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Report whether the earliest deeper mismatch begins before or after the child call**

Update focused reporting so it distinguishes these outcomes:

```rust
let deeper_stage = if entry.encode_left_child_budget_before_call != entry.decode_left_child_budget_before_call
    || entry.encode_left_child_fill_before_call != entry.decode_left_child_fill_before_call
    || (entry.encode_left_child_gain_before_call - entry.decode_left_child_gain_before_call).abs() > 1e-6
{
    "left_child_call_inputs_diverge"
} else if entry.left_child_max_abs_error > 0.0 {
    "child_internal_after_equal_call_inputs"
} else {
    "not_left_child_internal"
};
```

Print the exact scalar inputs next to the vector error summary.

- [ ] **Step 2: Run the focused trace and capture the exact deeper boundary**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, proving one of two concrete outcomes:

- the deeper left-child branch is entered with mismatched inputs
- the deeper left-child branch is entered symmetrically and the defect is inside that child’s own recursion or leaf return

- [ ] **Step 3: Land one bounded `bands.rs` fix only if a local split-state bug is proven**

Only make a production edit if the trace proves a local `bands.rs` recursion bug on the left-child call inputs or immediate child handoff. Acceptable surfaces:

```rust
mbits
fill_mut
gain * (sctx.imid as f32 / 32768.0)
ctx.trace_path_bits
ctx.trace_depth
```

as they are threaded into the recursive left-child call.

Do not touch:

- `celt.rs`
- `rate.rs`
- `pvq.rs`
- right-child recursion
- zero-pulse reconstruction
- top-level parent recombine

- [ ] **Step 4: Re-run the focused trace after the bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected:

- if a fix was landed: PASS with the first deeper mismatch moved below the current descendant or eliminated
- if no fix was justified: PASS with the next exact inner boundary established

### Task 4: Re-run the Real CELT Gate and Record the New Boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Run the real 160-byte gate**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:

- if a bounded left-child recursion fix was real, SNR should improve beyond `0.72 dB`
- otherwise the test may still fail, but the deeper left-child boundary must now be explicit

- [ ] **Step 2: Update the findings report with exact evidence**

Append a Track 4T section that records:

- the new branch-local split-state fields
- whether the deeper defect begins at child-call inputs or inside a symmetric child path
- the exact focused and real-gate outputs
- whether a bounded `bands.rs` fix was justified
- the next narrower target if the bug survives

## Success Condition

- the next deeper defect under the left-child recursion path is proven at the narrowest visible seam
- either one bounded `bands.rs` fix is landed and verified, or the next exact inner boundary is established without guessing
- no unrelated codec subsystems are touched
