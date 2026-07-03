# Track 4W Returned-Subchild Recursive Node Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the first live mismatch inside the returned-subchild recursive node directly below the current stable child in `quant_partition(...)`, and land one bounded `bands.rs` fix only if the trace proves a local recursive-node bug.

**Architecture:** This pass stays inside `third_party/opus-rs/src/bands.rs` and the two CELT trace tests. Track 4V proved the earliest deeper seam is a returned-subchild recursive node, not leaf return. The next move is to split that returned-subchild node into its own internal stages: node entry, local theta/split state, its first returned left subchild, its first returned right subchild, and its own post-children return state.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Pin the First Returned-Subchild Recursive Node Under the Stable Child

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a selector for the first returned-subchild recursive node**

In both tests, keep the current stable-child selector from Track 4V, then select the first recursive node beneath that subtree that already carries recursive error:

```rust
let first_returned_subchild_node = trace
    .nodes
    .iter()
    .filter(|entry| {
        entry.depth > stable_child.depth
            && entry.depth == stable_child.depth + 1
            && (entry.path_bits >> (entry.depth - stable_child.depth))
                == stable_child.path_bits
            && (entry.left_child_max_abs_error > 0.0
                || entry.right_child_max_abs_error > 0.0)
    })
    .min_by_key(|entry| entry.encode_visit_index);
```

Print this node explicitly before looking deeper. Do not mix it with the broader subtree scan from Track 4V.

- [ ] **Step 2: Add a selector for the first deeper descendant below that returned-subchild node**

Once `first_returned_subchild_node` is present, add the next descendant selector under that node:

```rust
let first_descendant_below_returned_subchild = trace
    .nodes
    .iter()
    .filter(|entry| {
        entry.depth > returned_subchild.depth
            && (entry.path_bits >> (entry.depth - returned_subchild.depth))
                == returned_subchild.path_bits
    })
    .min_by_key(|entry| entry.encode_visit_index);
```

Also select the first leaf under that returned-subchild subtree:

```rust
let first_leaf_below_returned_subchild = trace
    .leaves
    .iter()
    .filter(|entry| {
        entry.depth > returned_subchild.depth
            && (entry.path_bits >> (entry.depth - returned_subchild.depth))
                == returned_subchild.path_bits
    })
    .min_by_key(|entry| entry.encode_visit_index);
```

These selectors only identify the next recursive seam under the returned-subchild node.

- [ ] **Step 3: Run the focused trace and verify the returned-subchild selector lands on the current seam**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with output naming:

- the stable child node around `band=12`, `depth=1`
- the first returned-subchild recursive node below it
- the first deeper descendant and first leaf beneath that returned-subchild node

### Task 2: Add Returned-Subchild Internal Scalar Tracing in `bands.rs`

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Test: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Extend `PartitionNodeRoundtripTrace` with returned-subchild local-entry scalars**

Add bounded scalar fields for the returned-subchild node’s own local state:

```rust
pub encode_subchild_remaining_bits_on_entry: i32,
pub decode_subchild_remaining_bits_on_entry: i32,
pub encode_subchild_tell_on_entry: i32,
pub decode_subchild_tell_on_entry: i32,
pub encode_subchild_fill_on_entry: u32,
pub decode_subchild_fill_on_entry: u32,
pub encode_subchild_theta_qalloc: i32,
pub decode_subchild_theta_qalloc: i32,
pub encode_subchild_theta_delta: i32,
pub decode_subchild_theta_delta: i32,
pub encode_subchild_theta_itheta: i32,
pub decode_subchild_theta_itheta: i32,
```

Only add scalar state needed to distinguish returned-subchild entry mismatch from later returned-left / returned-right / post-children mismatch. Do not add large vector dumps.

- [ ] **Step 2: Record returned-subchild local-entry state inside the traced recursive node**

At the start of the returned-subchild node’s own `quant_partition(...)` recursion, pair encode/decode state using the existing trace context:

```rust
ctx.remaining_bits
tell_frac_inline!(ctx.rc)
fill
```

Record these into the new `encode_subchild_*` / `decode_subchild_*` fields on the matching `PartitionNodeRoundtripTrace`.

- [ ] **Step 3: Record returned-subchild local theta/split outputs**

After the returned-subchild node computes its own local split, record:

```rust
sctx.qalloc
sctx.delta
sctx.itheta
```

into the same node trace fields.

Do not change:

- recursion order
- theta math
- PVQ coding
- zero-pulse handling
- parent recombine
- any non-tracing codec math

- [ ] **Step 4: Run the focused trace and verify the returned-subchild scalar fields populate**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with the returned-subchild node carrying non-default local-entry and local-theta scalar fields on both encode and decode traces.

### Task 3: Split the Returned-Subchild Node Into Entry, Local Theta, Left Return, Right Return, or Post-Children

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a returned-subchild stage classification**

In both tests, classify the returned-subchild node as:

```rust
let returned_subchild_stage =
    if entry.encode_subchild_remaining_bits_on_entry
        != entry.decode_subchild_remaining_bits_on_entry
        || entry.encode_subchild_tell_on_entry != entry.decode_subchild_tell_on_entry
        || entry.encode_subchild_fill_on_entry != entry.decode_subchild_fill_on_entry
    {
        "returned_subchild_entry_state_diverges"
    } else if entry.encode_subchild_theta_qalloc != entry.decode_subchild_theta_qalloc
        || entry.encode_subchild_theta_delta != entry.decode_subchild_theta_delta
        || entry.encode_subchild_theta_itheta != entry.decode_subchild_theta_itheta
    {
        "returned_subchild_local_theta_diverges"
    } else if entry.left_child_max_abs_error > 0.0 {
        "returned_subchild_left_return_diverges"
    } else if entry.right_child_max_abs_error > 0.0 {
        "returned_subchild_right_return_diverges"
    } else {
        "returned_subchild_post_children_or_leaf_diverges"
    };
```

Print the exact scalar values next to the stage.

- [ ] **Step 2: Run the focused trace and capture the first true returned-subchild substage**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with one concrete outcome:

- returned-subchild entry state already differs
- returned-subchild local theta/split state differs
- returned-subchild left return is first
- returned-subchild right return is first
- returned-subchild entry/theta/child returns stay aligned, so only its post-children or leaf-adjacent state remains

- [ ] **Step 3: Only land one bounded `bands.rs` fix if the trace proves a local returned-subchild bug**

Only make a production edit if the trace proves a local bug at one of these exact surfaces inside the returned-subchild node:

```rust
ctx.remaining_bits
tell_frac_inline!(ctx.rc)
fill
sctx.qalloc
sctx.delta
sctx.itheta
record_partition_node_left_call_inputs(...)
record_partition_node_left_return(...)
record_partition_node_post_children(...)
```

Do not touch:

- `celt.rs`
- `rate.rs`
- `pvq.rs`
- zero-pulse reconstruction
- top-level parent assembly
- broad trace model code outside the returned-subchild path

- [ ] **Step 4: Re-run the focused trace after the bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected:

- if a local returned-subchild fix was real: PASS with the first mismatch moved below that node
- if no fix was justified: PASS with the next exact returned-subchild substage explicitly proven

### Task 4: Re-run the Real 160-Byte Gate and Record the Narrower Boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Run the real 160-byte CELT gate**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:

- if a bounded returned-subchild fix was real, SNR should improve beyond `0.72 dB`
- otherwise the test may still fail, but the next returned-subchild substage must now be explicit

- [ ] **Step 2: Update the findings report with exact Track 4W evidence**

Append a Track 4W section that records:

- the stable child node
- the returned-subchild recursive node directly below it
- the first deeper descendant and first leaf beneath that returned-subchild node
- whether the first live substage is:
  - returned-subchild entry state
  - returned-subchild local theta/split state
  - returned-subchild left return
  - returned-subchild right return
  - returned-subchild post-children / leaf-adjacent state
- whether a bounded `bands.rs` fix was justified
- the next narrower target if the bug survives

## Success Condition

Track 4W is successful when:

1. the focused trace proves the first exact substage inside the returned-subchild recursive node below the stable child;
2. any production edit is limited to one bounded, trace-proven `bands.rs` surface;
3. the real `celt_loopback_160bytes` gate is rerun; and
4. the findings report names the next surviving seam if the codec bug remains.

## Commit Plan

- Commit 1: `test: trace returned-subchild recursive node state`
- Commit 2: `fix: correct returned-subchild recursive node state` *(only if a bounded production fix is justified)*
- Commit 3: `docs: record returned-subchild recursive findings`
