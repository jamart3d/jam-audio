# Track 4Q Recursive Node Trace Pairing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair recursive `quant_partition(...)` node trace pairing so post-recursion child and parent vectors are attached to the correct decode-side roundtrip node before any further CELT codec-fix work.

**Architecture:** This is an instrumentation-only pass inside the Track 4 codec worktree. Keep production codec behavior unchanged, make recursive node identity handoff explicit and stable, and stop once the first real parent/child mismatch can be observed with populated vectors.

**Tech Stack:** Rust, Cargo integration tests, vendored `third_party/opus-rs`, markdown findings docs

---

### Task 1: Reproduce the Broken Recursive Node Pairing

**Files:**
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Add one focused assertion that proves parent vectors are still missing**

Add a bounded assertion in the existing low-bitrate trace path so the test fails if the chosen roundtrip node still has empty post-recursion vectors:

```rust
assert!(
    !worst_node.encode_parent_after_children.is_empty(),
    "expected encode parent post-children vector to be populated"
);
assert!(
    !worst_node.decode_parent_after_children.is_empty(),
    "expected decode parent post-children vector to be populated"
);
```

Place the assertion next to the existing debug print for the first/worst traced node so this test becomes the guard for the pairing fix.

- [ ] **Step 2: Run the focused trace test and verify it fails for the right reason**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: FAIL with the new “expected ... vector to be populated” assertion, confirming the current issue is still trace pairing rather than codec behavior.

- [ ] **Step 3: Commit the failing guard**

```bash
git add third_party/opus-rs/tests/celt_pvq_shape_trace.rs third_party/opus-rs/tests/celt_budget_test.rs
git commit -m "test: pin missing recursive node trace pairing"
```

### Task 2: Make Recursive Node Identity Stable Across Post-Children Updates

**Files:**
- Modify: `third_party/opus-rs/src/bands.rs`
- Verify against: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`

- [ ] **Step 1: Audit the current node-snapshot lifecycle around `quant_partition(...)`**

Confirm the current encode/decode trace flow uses these seams:

```rust
fn record_partition_node_snapshot(...) -> Option<usize>
fn record_partition_node_post_children(...)
```

and identify exactly where the decode-side trace loses the visit pairing between:

- initial node snapshot
- child recursive returns
- post-children parent vector update

Do not change codec math in this step.

- [ ] **Step 2: Add an explicit stable trace node identifier for post-children updates**

Use a stable per-visit index or explicit trace-node token captured at node entry and reused after recursion returns. The important constraint is: stop relying on structural re-lookup after recursion.

Representative shape:

```rust
let trace_node_id = record_partition_node_snapshot(...);
...
record_partition_node_post_children(
    trace_node_id,
    left_child_vector,
    right_child_vector,
    parent_after_children,
    ...
);
```

If the existing `Option<usize>` visit index is not sufficient, replace it with a dedicated trace token that cannot drift across recursive calls.

- [ ] **Step 3: Keep the update path bounded to instrumentation fields only**

Only populate trace fields such as:

```rust
node.encode_left_child_vector = encode_snapshot.left_child_vector.clone();
node.decode_left_child_vector = left_child_vector;
node.encode_right_child_vector = encode_snapshot.right_child_vector.clone();
node.decode_right_child_vector = right_child_vector;
node.encode_parent_after_children = encode_snapshot.parent_after_children.clone();
node.decode_parent_after_children = parent_after_children;
```

Do not modify:

- partition budgets
- recurse order
- `compute_theta(...)`
- Hadamard or deinterleave logic
- any path that changes encoded or decoded sample values

- [ ] **Step 4: Run the focused trace guard and verify it passes**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with the chosen node now showing populated child and parent post-children vectors.

- [ ] **Step 5: Commit the instrumentation pairing fix**

```bash
git add third_party/opus-rs/src/bands.rs third_party/opus-rs/tests/celt_pvq_shape_trace.rs third_party/opus-rs/tests/celt_budget_test.rs
git commit -m "test: pair recursive node post-children traces"
```

### Task 3: Re-run the Real Low-Bitrate Gate and Stop at the First Proven Mismatch

**Files:**
- Modify: `third_party/opus-rs/tests/celt_budget_test.rs`
- Modify: `third_party/opus-rs/tests/celt_pvq_shape_trace.rs`
- Verify against: `third_party/opus-rs/src/bands.rs`

- [ ] **Step 1: Print the first real populated parent/child mismatch**

Once vectors are paired correctly, update the trace selection so it reports the first node where one of these becomes nonzero:

```rust
left_child_max_abs_error
right_child_max_abs_error
parent_after_children_max_abs_error
```

Prefer the earliest mismatching node over the largest downstream error.

- [ ] **Step 2: Run the focused trace and capture the first actual mismatch**

Run:

```bash
cargo test -p opus-rs celt_low_bitrate_partition_leaf_direct_pvq_roundtrip_matches -- --nocapture
```

Expected: PASS, with trace output now identifying whether the first live error appears in:

- left child return
- right child return
- parent-after-children assembly

- [ ] **Step 3: Re-run the real 160-byte CELT gate without changing production math**

Run:

```bash
cargo test -p opus-rs celt_loopback_160bytes -- --nocapture
```

Expected: still FAIL near the current `0.72 dB` result. That is acceptable for this plan. Success here is trustworthy trace evidence, not SNR improvement.

- [ ] **Step 4: Commit the trace-selection refinement**

```bash
git add third_party/opus-rs/tests/celt_pvq_shape_trace.rs third_party/opus-rs/tests/celt_budget_test.rs
git commit -m "test: report first recursive node mismatch"
```

### Task 4: Update Findings and Hand Off the Next Exact Fix Surface

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md`

- [ ] **Step 1: Record what Track 4Q proved**

Append a findings section that states:

- the old Track 4P premise failed because post-recursion node vectors were not paired correctly
- Track 4Q fixed the pairing
- the first real mismatch now appears at a specific child or parent assembly stage
- no production codec math changed during this pass

Include the exact command outputs and the first populated mismatch summary.

- [ ] **Step 2: State the next plan boundary explicitly**

If the first real mismatch is now proven, name the next target narrowly, for example:

- recursive child return placement
- parent assembly after child return
- another deeper trace gap if pairing still is not complete

Do not propose a broad `bands.rs` rewrite.

- [ ] **Step 3: Commit the findings update**

```bash
git add docs/superpowers/specs/2026-06-11-track-4-codec-research-findings.md
git commit -m "docs: record recursive node pairing findings"
```

## Success Condition

- the recursive node trace is trustworthy
- chosen low-bitrate parent nodes contain populated encode/decode child and parent post-children vectors
- the first real parent/child mismatch is proven with concrete trace evidence
- no production codec-fix claim is made unless a later plan proves one
