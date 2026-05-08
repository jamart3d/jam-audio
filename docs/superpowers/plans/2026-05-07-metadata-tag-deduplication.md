# Metadata Tag Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a private helper function to deduplicate metadata tag mapping logic in `jam-audio-engine`.

**Architecture:** Introduce `apply_tags` helper in `metadata.rs` to map `StandardTagKey` variants to `AudioMetadata` fields, preserving existing asymmetry via an `overwrite` flag.

**Tech Stack:** Rust, symphonia

---

### Task 1: Baseline Verification

**Files:**
- Test: `packages/jam-audio-engine/src/metadata.rs`

- [ ] **Step 1: Run existing tests to ensure baseline passes**

Run: `cargo test --manifest-path packages/jam-audio-engine/Cargo.toml`
Expected: PASS (51 tests)

---

### Task 2: Implement `apply_tags` helper

**Files:**
- Modify: `packages/jam-audio-engine/src/metadata.rs`

- [ ] **Step 1: Define `apply_tags` helper function**

Add this function to `packages/jam-audio-engine/src/metadata.rs` (private, inside the module):

```rust
fn apply_tags(result: &mut AudioMetadata, tags: &[symphonia::core::meta::Tag], overwrite: bool) {
    for tag in tags {
        match tag.std_key {
            Some(StandardTagKey::TrackTitle) => result.title = Some(tag.value.to_string()),
            Some(StandardTagKey::Artist) => result.artist = Some(tag.value.to_string()),
            Some(StandardTagKey::Album) => result.album = Some(tag.value.to_string()),
            Some(StandardTagKey::TrackNumber) if overwrite || result.track_number.is_none() => {
                result.track_number = tag.value.to_string().parse::<u32>().ok();
            }
            _ => {}
        }
    }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cargo check --manifest-path packages/jam-audio-engine/Cargo.toml`
Expected: PASS (with unused function warning)

---

### Task 3: Refactor First Metadata Pass

**Files:**
- Modify: `packages/jam-audio-engine/src/metadata.rs`

- [ ] **Step 1: Replace first `for` loop with `apply_tags`**

In `extract_metadata_internal`, replace:

```rust
    // Try container metadata first
    if let Some(metadata) = probed.format.metadata().current() {
        for tag in metadata.tags() {
            match tag.std_key {
                Some(StandardTagKey::TrackTitle) => result.title = Some(tag.value.to_string()),
                Some(StandardTagKey::Artist) => result.artist = Some(tag.value.to_string()),
                Some(StandardTagKey::Album) => result.album = Some(tag.value.to_string()),
                Some(StandardTagKey::TrackNumber) => {
                    result.track_number = tag.value.to_string().parse::<u32>().ok()
                }
                _ => {}
            }
        }
    }
```

with:

```rust
    // Try container metadata first
    if let Some(metadata) = probed.format.metadata().current() {
        apply_tags(&mut result, metadata.tags(), true);
    }
```

- [ ] **Step 2: Run tests to verify no regressions**

Run: `cargo test --manifest-path packages/jam-audio-engine/Cargo.toml`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/jam-audio-engine/src/metadata.rs
git commit -m "refactor: use apply_tags for container metadata pass"
```

---

### Task 4: Refactor Second Metadata Pass

**Files:**
- Modify: `packages/jam-audio-engine/src/metadata.rs`

- [ ] **Step 1: Replace second `for` loop with `apply_tags`**

In `extract_metadata_internal`, replace:

```rust
    // Try metadata block
    if (result.title.is_none() || result.artist.is_none())
        && let Some(metadata) = probed.metadata.get().as_ref().and_then(|m| m.current())
    {
        for tag in metadata.tags() {
            match tag.std_key {
                Some(StandardTagKey::TrackTitle) => result.title = Some(tag.value.to_string()),
                Some(StandardTagKey::Artist) => result.artist = Some(tag.value.to_string()),
                Some(StandardTagKey::Album) => result.album = Some(tag.value.to_string()),
                Some(StandardTagKey::TrackNumber) if result.track_number.is_none() => {
                    result.track_number = tag.value.to_string().parse::<u32>().ok();
                }
                _ => {}
            }
        }
    }
```

with:

```rust
    // Try metadata block
    if (result.title.is_none() || result.artist.is_none())
        && let Some(metadata) = probed.metadata.get().as_ref().and_then(|m| m.current())
    {
        apply_tags(&mut result, metadata.tags(), false);
    }
```

- [ ] **Step 2: Run tests to verify all tests pass**

Run: `cargo test --manifest-path packages/jam-audio-engine/Cargo.toml`
Expected: PASS (51 tests)

- [ ] **Step 3: Commit**

```bash
git add packages/jam-audio-engine/src/metadata.rs
git commit -m "refactor: use apply_tags for metadata block pass"
```
