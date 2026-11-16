# Track 4U Child-Internal Left Recursion Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the first child-internal defect inside the deeper left-child recursive path in `quant_partition(...)` after equal left-child call inputs have been proven, and land one bounded `bands.rs` fix only if the trace proves a local recursion-state bug.

**Architecture:** This pass stays entirely inside `third_party/opus-rs/src/bands.rs` and the two CELT trace tests. The key move is to split the current “child-internal after equal call inputs” bucket into finer sub-stages inside the child itself: child entry, child local theta/split setup, child first returned subchild, and child local post-children state. That gives one narrower boundary before any production edit.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Pin the First Child-Internal Node After Equal Left-Call Inputs

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a selector for the first child-internal descendant that already has equal left-call inputs**

Refine the current descendant reporting so the tests explicitly identify the first node where:

```rust
entry.encode_left_child_budget_before_call == entry.decode_left_child_budget_before_call
    && entry.encode_left_child_fill_before_call == entry.decode_left_child_fill_before_call
    && (entry.encode_left_child_gain_before_call - entry.decode_left_child_gain_before_call).abs() <= 1e-6
    && entry.left_child_max_abs_error > 0.0
```

Keep this separate from the broader “first descendant under the bad left branch” selector so the test output names the first stable-input child-internal node directly.

- [ ] **Step 2: Run the focused trace and verify the child-internal selector lands on the current proven node**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with output still naming the current child-internal node around:

- `band=12`
- `depth=1`
- equal left-child call inputs
- nonzero `left_child_max_abs_error`

### Task 2: Add Child-Internal Recursive Step Tracing

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Test: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Test: `third_party/opus-rs/tests/celt_budget_test.rs`

- [ ] **Step 1: Extend recursive node tracing with child-local step fields**

Add bounded fields to the recursive node trace and encode snapshot for the child’s own internal progression, not parent state:

```rust
pub encode_child_remaining_bits_on_entry: i32,
pub decode_child_remaining_bits_on_entry: i32,
pub encode_child_tell_on_entry: i32,
pub decode_child_tell_on_entry: i32,
pub encode_child_fill_on_entry: u32,
pub decode_child_fill_on_entry: u32,
pub encode_child_theta_qalloc: i32,
pub decode_child_theta_qalloc: i32,
pub encode_child_theta_delta: i32,
pub decode_child_theta_delta: i32,
pub encode_child_theta_itheta: i32,
pub decode_child_theta_itheta: i32,
```

Only add scalar state needed to distinguish:

- child entry mismatch
- child local theta/split mismatch
- later subchild-return mismatch

Do not add large vector dumps here.

- [ ] **Step 2: Record the child-local entry state at the start of the traced child recursion**

Inside the recursive child path in `quant_partition(...)`, record the exact values on entry to that child before its own `compute_theta(...)` work:

```rust
ctx.remaining_bits
tell_frac_inline!(ctx.rc)
fill
```

These must be paired encode/decode on the same traced node.

- [ ] **Step 3: Record the child-local theta/split outputs after the child computes its own split**

After the child’s own `compute_theta(...)` and local split calculations, record:

```rust
sctx.qalloc
sctx.delta
sctx.itheta
```

for that traced child node.

Do not change:

- recursion order
- theta math
- PVQ coding
- zero-pulse handling
- parent assembly

- [ ] **Step 4: Run the focused trace and verify the new child-local scalar fields populate**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with the first child-internal node carrying non-default child-entry and child-theta scalar fields on both encode and decode traces.

### Task 3: Split “Child-Internal” Into Entry, Local Theta, or Returned-Subchild

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add a finer child-internal stage classification**

Update the focused and real trace output so a child-internal node is further classified as:

```rust
let child_internal_stage =
    if entry.encode_child_remaining_bits_on_entry != entry.decode_child_remaining_bits_on_entry
        || entry.encode_child_tell_on_entry != entry.decode_child_tell_on_entry
        || entry.encode_child_fill_on_entry != entry.decode_child_fill_on_entry
    {
        "child_entry_state_diverges"
    } else if entry.encode_child_theta_qalloc != entry.decode_child_theta_qalloc
        || entry.encode_child_theta_delta != entry.decode_child_theta_delta
        || entry.encode_child_theta_itheta != entry.decode_child_theta_itheta
    {
        "child_local_theta_state_diverges"
    } else if entry.left_child_max_abs_error > 0.0 {
        "child_subrecursion_or_leaf_return_diverges"
    } else {
        "no_child_internal_divergence"
    };
```

Print the exact scalar values next to the stage.

- [ ] **Step 2: Run the focused trace and capture the first true child-internal substage**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with one of these concrete outcomes:

- child entry state already differs
- child local theta/split state differs despite equal parent-to-child call inputs
- child entry and theta state match, so the bug is deeper in returned subchild state or leaf return

- [ ] **Step 3: Only land one bounded `bands.rs` fix if the child-local scalar trace proves it**

Only make a production edit if the trace proves a local bug at one of these exact surfaces inside the child node:

```rust
ctx.remaining_bits
tell_frac_inline!(ctx.rc)
fill
sctx.qalloc
sctx.delta
sctx.itheta
```

Do not touch:

- `celt.rs`
- `rate.rs`
- `pvq.rs`
- parent trace wiring
- top-level partition assembly
- zero-pulse reconstruction
- broad renormalization changes

- [ ] **Step 4: Re-run the focused trace after the bounded fix or diagnostic stop**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected:

- if a local child-state fix was real: PASS with the first child-internal mismatch moved below the current node or eliminated
- if no fix was justified: PASS with the next deeper substage explicitly proven

### Task 4: Re-run the Real CELT Gate and Record the Narrower Boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Run the real 160-byte CELT gate**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected:

- if a bounded child-local fix was real, SNR should improve beyond `0.72 dB`
- otherwise the test may still fail, but the first child-internal substage must now be explicit

- [ ] **Step 2: Update the findings report with exact Track 4U evidence**

Append a Track 4U section that records:

- the new child-entry and child-theta scalar fields
- the first child-internal node under equal left-call inputs
- whether the earliest child-internal failure is:
  - child entry state
  - child local theta/split state
  - deeper returned-subchild or leaf-return state
- whether a bounded `bands.rs` fix was justified
- the next narrower target if the bug survives

## Success Condition

- the current “child-internal after equal call inputs” bucket is reduced to one narrower recursive substage
- either one bounded `bands.rs` fix is landed and verified, or the next deeper child-local boundary is proven without guessing
- no unrelated codec subsystems are touched
