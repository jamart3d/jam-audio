# Track 4R Recursive Child Return Assembly Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the first real production mismatch in recursive child return or parent-side partition assembly inside `quant_partition(...)` and land one bounded `bands.rs` fix only if the trace proves a local bug.

**Architecture:** This pass starts from the repaired Track 4Q trace and stays entirely inside `third_party/opus-rs/src/bands.rs` and its focused CELT diagnostics. The job is to compare exact encode-side child-return state against decode-side state at the first mismatching node, then stop at the narrowest proven bad transform or slice-placement step before any broader codec changes.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Pin the First Recursive Child-Return Mismatch

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a guard that locks the earliest recursive mismatch selection**

Update the existing low-bitrate trace assertions so the focused trace fails if it cannot identify the earliest mismatching node with populated vectors:

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
    !first_recursive_node_mismatch.encode_left_child_vector.is_empty(),
    "expected populated encode left child vector"
);
assert!(
    !first_recursive_node_mismatch.decode_left_child_vector.is_empty(),
    "expected populated decode left child vector"
);
```

- [ ] **Step 2: Run the focused trace and verify it passes with the known first mismatch**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with output still showing the first recursive mismatch at the earliest node rather than a later worst node.

- [ ] **Step 3: Commit the trace guard**

```bash
git add third_party/opus-rs/tests/celt_pvq_shape_trace.rs third_party/opus-rs/tests/celt_budget_test.rs
git commit -m "test: pin earliest recursive child-return mismatch"
```

### Task 2: Instrument Parent Assembly Step-by-Step

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Test: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Add bounded step-local vectors around the parent assembly seam**

Extend `PartitionNodeRoundtripTrace` and the related encode snapshot so one traced node can expose the exact vectors at these moments:

```rust
pub encode_left_child_after_return: Vec<f32>,
pub decode_left_child_after_return: Vec<f32>,
pub encode_right_child_after_return: Vec<f32>,
pub decode_right_child_after_return: Vec<f32>,
pub encode_parent_before_final_return: Vec<f32>,
pub decode_parent_before_final_return: Vec<f32>,
```

Keep these separate from the existing `encode_parent_after_children` / `decode_parent_after_children` fields if needed to avoid overwriting already-useful data.

- [ ] **Step 2: Capture the exact parent-side assembly order without changing codec math**

Record vectors immediately after:

```rust
cm = quant_partition(... left child ...)
cm |= quant_partition(... right child ...)
```

and immediately before returning from the parent branch, using the same encode/decode visit token already proven in Track 4Q.

Do not change:

- bit allocation
- recurse order
- `compute_theta(...)`
- `haar1(...)`
- `interleave_hadamard(...)`
- PVQ encode/decode behavior

- [ ] **Step 3: Run the focused trace and verify the new vectors populate**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with the earliest recursive mismatch now carrying enough step-local vectors to tell whether the drift appears:

- immediately on left child return
- only after right child return
- only after parent-side assembly completes

- [ ] **Step 4: Commit the bounded step-local instrumentation**

```bash
git add third_party/opus-rs/src/bands.rs third_party/opus-rs/tests/celt_pvq_shape_trace.rs third_party/opus-rs/tests/celt_budget_test.rs
git commit -m "test: trace recursive child return assembly"
```

### Task 3: Prove the First Broken Parent-Side Operation

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Change reporting from broad node mismatch to first broken assembly stage**

Update the focused reporting so it names the first specific stage, for example:

```rust
let first_stage = if entry.left_child_max_abs_error > 0.0 {
    "left_child_return"
} else if entry.right_child_max_abs_error > 0.0 {
    "right_child_return"
} else {
    "parent_before_final_return"
};
```

Make the test print the vectors needed to justify that stage label.

- [ ] **Step 2: Run the focused trace and capture the exact first broken operation**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with output proving one of these precise outcomes:

- left child result is already wrong when returned
- right child return introduces the first drift
- both children are locally correct and parent-side assembly corrupts the combined buffer

- [ ] **Step 3: If and only if a local `bands.rs` bug is proven, land one bounded fix**

Only make a production edit if the trace proves a local parent-side defect. Acceptable surfaces:

```rust
let (x_mid, x_side) = x.split_at_mut(mid);
cm |= quant_partition(...);
```

or adjacent parent slice-placement / return-order logic inside `quant_partition(...)`.

Do not touch:

- `celt.rs`
- `rate.rs`
- `pvq.rs`
- zero-pulse modeling
- top-level CELT allocation

- [ ] **Step 4: Re-run the focused trace after the bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected:

- if a fix was landed: PASS with the first mismatching stage either moved deeper or eliminated
- if no fix was justified: PASS with explicit evidence of the next narrower boundary

- [ ] **Step 5: Commit the proof or bounded fix**

```bash
git add third_party/opus-rs/src/bands.rs third_party/opus-rs/tests/celt_pvq_shape_trace.rs third_party/opus-rs/tests/celt_budget_test.rs
git commit -m "fix: narrow recursive child-return assembly mismatch"
```

Use the commit even for a pure diagnostic narrowing pass; the message stays acceptable because the scope is the recursive assembly mismatch itself.

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
- if not, the test may still fail, but the first broken assembly stage must now be explicit

- [ ] **Step 2: If the real gate improves, run the broader CELT checks**

Run only if Track 4R lands a production fix:

```bash
cargo test -p opus-rs test_celt_loopback -- --nocapture
cargo test -p opus-rs test_celt_realistic_bitrate -- --nocapture
cargo test -p opus-rs opus_celt_roundtrip_basic -- --nocapture
```

Expected: these either improve materially or expose the next remaining bottleneck after the recursive assembly fix.

- [ ] **Step 3: Update the findings report with exact evidence**

Append a Track 4R section that records:

- the earliest proven assembly stage
- the exact command outputs
- whether a bounded `bands.rs` fix was justified
- whether `celt_loopback_160bytes` improved or remained at `0.72 dB`
- the next exact target if the bug survives

- [ ] **Step 4: Commit the findings update**

```bash
git add docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md
git commit -m "docs: record recursive child-return assembly findings"
```

## Success Condition

- the first real broken operation inside recursive child return / parent partition assembly is proven with concrete vectors
- either one bounded `bands.rs` fix is landed and verified, or the next narrower surface is established without hand-waving
- no unrelated codec subsystems are touched
