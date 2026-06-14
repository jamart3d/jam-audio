# Track 4AA Band 19 Depth 2 Left-Call-Input Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove why the real CELT path enters the `band=19`, `depth=2` node in `third_party/opus-rs/src/bands.rs` with zeroed encode-side left-call inputs while the parent node above it still has aligned state.

**Architecture:** This pass stays inside the recursive `quant_partition(...)` path in `third_party/opus-rs/src/bands.rs` and the two CELT trace tests. Track 4Z proved the first local divergence is no longer “somewhere on the branch”; it is specifically the local left-call-input construction at the `band=19`, `depth=2` node. The work here is to compare the node’s own left-call-input construction inputs against the immediately preceding parent-return state, not to touch codec behavior outside that seam.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Pin the Exact `band=19`, `depth=2` Node as a Dedicated Selector

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Preserve the Track 4Z earlier-parent selector**

Keep the existing real-gate selector that identifies:

```rust
let earlier_parent_left_return_node = first_descendant_with_left_call_input_divergence.and_then(|entry| {
    trace.nodes.iter().find(|node| {
        node.decode_visit_index == entry.decode_parent_node_visit_index
    })
});
```

Do not re-broaden the search. This plan is about the immediate left child below that parent.

- [ ] **Step 2: Promote the immediate child selector to the primary target**

In both tests, bind:

```rust
let band19_depth2_left_call_node = earlier_parent_left_return_node.and_then(|parent| {
    trace.nodes.iter().find(|entry| {
        entry.depth == parent.depth + 1
            && entry.path_bits == (parent.path_bits << 1)
    })
});
```

Expected in the real `160`-byte gate:
- `band=19`
- `depth=2`

Expected in the focused path:
- this node may be absent, and that is acceptable

- [ ] **Step 3: Emit the node explicitly in both tests**

Print:

```rust
eprintln!(
    "Band19 depth2 left-call node: {:?}",
    band19_depth2_left_call_node
);
```

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- focused path may report `None`
- real gate should print the pinned `band=19`, `depth=2` node

### Task 2: Compare the Node’s Left-Call-Input Construction Against Its Own Entry State

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Add bounded trace fields for the local pre-left-call construction inputs**

Extend `PartitionNodeRoundtripTrace` and the encode snapshot with only the scalars needed to prove the local left-call-input construction:

```rust
pub encode_left_call_source_b_after_theta: i32,
pub decode_left_call_source_b_after_theta: i32,
pub encode_left_call_source_fill_after_theta: u32,
pub decode_left_call_source_fill_after_theta: u32,
pub encode_left_call_source_recurse_mid_first: bool,
pub decode_left_call_source_recurse_mid_first: bool,
```

These must capture the values at the exact point where the node decides what to pass into its left child.

- [ ] **Step 2: Record those fields without changing codec math**

Wire the new fields at the node-local left-child call site only. Do not change:

```rust
ctx.remaining_bits
sctx
left/right recursion order
PVQ logic
zero-pulse behavior
```

This task is trace-only. If you cannot capture the values without changing behavior, stop and say so in the findings instead of improvising.

- [ ] **Step 3: Classify whether the local left-call-input construction is self-inconsistent**

In both tests, classify:

```rust
let band19_depth2_left_call_stage = if let Some(node) = band19_depth2_left_call_node {
    if node.encode_left_call_source_b_after_theta != node.decode_left_call_source_b_after_theta
        || node.encode_left_call_source_fill_after_theta != node.decode_left_call_source_fill_after_theta
        || node.encode_left_call_source_recurse_mid_first != node.decode_left_call_source_recurse_mid_first
    {
        "left_call_source_state_diverges_before_child_budget_construction"
    } else if node.encode_left_child_budget_before_call != node.decode_left_child_budget_before_call
        || node.encode_left_child_fill_before_call != node.decode_left_child_fill_before_call
        || (node.encode_left_child_gain_before_call - node.decode_left_child_gain_before_call).abs() > 1e-6
    {
        "left_call_budget_construction_diverges_after_equal_source_state"
    } else {
        "left_call_inputs_aligned"
    }
} else {
    "missing_band19_depth2_left_call_node"
};
```

That must distinguish:
- divergence already present in the node’s source state before left-child budget construction
- divergence introduced during left-child budget construction itself
- no local divergence

- [ ] **Step 4: Re-run focused and real traces**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- focused path may still not reach this node
- real gate should classify the `band=19`, `depth=2` node into one of the exact local stages above

### Task 3: Only Permit a Bounded `bands.rs` Fix if the Local Construction Site Is Proven

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Verify with: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify with: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`

- [ ] **Step 1: Limit any production change to the exact local left-call-input construction site**

Only if Task 2 proves:

```rust
"left_call_budget_construction_diverges_after_equal_source_state"
```

may you change the exact node-local code that computes:

```rust
left_child_budget_before_call
left_child_fill_before_call
left_child_gain_before_call
```

Do not touch:
- `celt.rs`
- `rate.rs`
- `pvq.rs`
- zero-pulse reconstruction
- right-branch logic
- parent-left-slice writeback
- ancestor-node logic above `band=19`, `depth=2`

- [ ] **Step 2: If the source state itself diverges, stop without a codec fix**

If Task 2 proves:

```rust
"left_call_source_state_diverges_before_child_budget_construction"
```

do not patch the local budget construction. Record that the next seam is upstream of the local left-call construction, and stop.

- [ ] **Step 3: Re-run both tests after bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:
- if a bounded local fix is real: the `band=19`, `depth=2` local divergence moves deeper or disappears
- if no fix was justified: the exact upstream-vs-local seam is proven for the next pass

### Task 4: Update Findings With the `band=19`, `depth=2` Result

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Append a Track 4AA section with the exact local seam result**

Record:

- the earlier parent from Track 4Z
- the pinned `band=19`, `depth=2` node
- whether the node’s source state already diverges
- or whether the divergence is introduced during left-child budget construction
- whether a bounded `bands.rs` fix was justified
- the next narrower seam if CELT quality still fails

## Success Condition

Track 4AA is successful when:

1. the real `160`-byte gate pins the `band=19`, `depth=2` node as the first locally divergent node;
2. the trace proves whether the divergence is upstream of local left-call construction or inside it;
3. any production edit is limited to one trace-proven `bands.rs` call site; and
4. the findings report names the next surviving seam if the CELT gate still fails.

## Commit Plan

- Commit 1: `test: trace band19 depth2 left-call construction`
- Commit 2: `fix: correct band19 depth2 left-call construction` *(only if a bounded production fix is justified)*
- Commit 3: `docs: record band19 depth2 left-call findings`
