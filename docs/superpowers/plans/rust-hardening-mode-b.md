# Rust Hardening — Mode B (Scoped)

Date: 2026-05-08
Scope: `packages/jam-audio-engine`, `packages/jam-audio-flutter`
Predecessor: Mode A complete (commits 5c5911f, 00d795b, f661618)

## What This Plan Is

Three targeted improvements identified from the Mode A audit that were intentionally deferred.
No architectural changes. No public API churn. No newtypes.

Items in execution order:

1. **Worker 1** — Fix `flutter_rust_bridge` macro warning in the Flutter crate
2. **Worker 2** — Deduplicate tag-mapping logic in `metadata.rs`
3. **Worker 3** — Scope `unsafe impl Send/Sync` to wasm32 in `lib.rs`

Each worker is a fresh agent. Workers 1 and 2 can run in parallel.
Worker 3 runs last — it requires a clean native `cargo check` baseline.

---

## Lead Agent Responsibilities

- Dispatch workers (1 and 2 in parallel, then 3)
- Run final `cargo check` for both crates after Worker 3 completes
- Run `cargo test` in `packages/jam-audio-engine` after all workers complete
- Confirm test count is still 51 (or more if workers added tests)
- Own the unsafe boundary decision if Worker 3 hits unexpected complexity

---

## Worker 1 — Flutter Bridge Warning

**Can run in parallel with Worker 2.**

### Context

`cargo check` on `packages/jam-audio-flutter` emits:

```
warning: unexpected `cfg` condition name: `frb_expand`
  --> src/api.rs:32:1
   |
32 | #[flutter_rust_bridge::frb(sync)]
```

The compiler suggests updating `flutter_rust_bridge_macros`. The warning is emitted by the
macro expansion — not first-party code.

### Task

1. Run `cargo update -p flutter_rust_bridge_macros` in the repo root.
2. Run `cargo check --manifest-path packages/jam-audio-flutter/Cargo.toml` and confirm the
   warning is gone.
3. If the warning persists after the update, add `#![allow(unexpected_cfgs)]` at the top of
   `packages/jam-audio-flutter/src/api.rs` as a scoped suppression. Do not add it crate-wide.
4. Do not change any other files.

### Verification

```
cargo check --manifest-path packages/jam-audio-flutter/Cargo.toml 2>&1 | grep warning
```

Expected: zero warnings. If warnings remain, they must be unrelated to `frb_expand`.

### Files

- `packages/jam-audio-flutter/Cargo.toml` (update only, if cargo update changes the lock)
- `packages/jam-audio-flutter/src/api.rs` (allow attribute only if update doesn't fix it)

---

## Worker 2 — Metadata Tag Deduplication

**Can run in parallel with Worker 1.**

### Context

`packages/jam-audio-engine/src/metadata.rs` has two nearly identical `match tag.std_key`
blocks inside `extract_metadata_internal`. Both map `StandardTagKey` variants onto
`AudioMetadata` fields. Adding a new field (e.g., `disc_number`) currently requires updating
both blocks.

The two passes differ in one guard: the second pass has
`Some(StandardTagKey::TrackNumber) if result.track_number.is_none()` — the first does not.
That asymmetry is likely unintentional but must be preserved during refactor.

### Exact duplication

First pass: `metadata.rs` lines 61–70 (inside `probed.format.metadata().current()` block)

```rust
match tag.std_key {
    Some(StandardTagKey::TrackTitle) => result.title = Some(tag.value.to_string()),
    Some(StandardTagKey::Artist) => result.artist = Some(tag.value.to_string()),
    Some(StandardTagKey::Album) => result.album = Some(tag.value.to_string()),
    Some(StandardTagKey::TrackNumber) => {
        result.track_number = tag.value.to_string().parse::<u32>().ok()
    }
    _ => {}
}
```

Second pass: `metadata.rs` lines 78–87 (inside `probed.metadata.get()` block)

```rust
match tag.std_key {
    Some(StandardTagKey::TrackTitle) => result.title = Some(tag.value.to_string()),
    Some(StandardTagKey::Artist) => result.artist = Some(tag.value.to_string()),
    Some(StandardTagKey::Album) => result.album = Some(tag.value.to_string()),
    Some(StandardTagKey::TrackNumber) if result.track_number.is_none() => {
        result.track_number = tag.value.to_string().parse::<u32>().ok();
    }
    _ => {}
}
```

### Task

Extract a private helper to `metadata.rs`:

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

Call it with `overwrite: true` for the first pass (container metadata) and `overwrite: false`
for the second pass (metadata block). This preserves the existing asymmetry explicitly rather
than hiding it.

Replace both `for tag in metadata.tags() { match ... }` blocks with calls to `apply_tags`.

### Verification

```
cargo check --manifest-path packages/jam-audio-engine/Cargo.toml
cargo test --manifest-path packages/jam-audio-engine/Cargo.toml
```

All 51 existing tests must pass. No new tests required — the existing metadata tests cover
both extraction paths.

### Files

- `packages/jam-audio-engine/src/metadata.rs` only

---

## Worker 3 — Scope `unsafe impl Send/Sync` to wasm32

**Run after Workers 1 and 2 are complete.**

### Context

`packages/jam-audio-engine/src/lib.rs` lines 131–132 and 168–169:

```rust
unsafe impl Send for SharedWindowedMediaSource {}
unsafe impl Sync for SharedWindowedMediaSource {}
// ...
unsafe impl Send for SharedAppendableMediaSource {}
unsafe impl Sync for SharedAppendableMediaSource {}
```

The SAFETY comment (lines 128–130) says these are valid only for single-threaded Wasm. The
problem: the crate also compiles on native (the `Cargo.toml` has native-specific opus deps at
`[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`), and `cargo check` currently
passes on native. The unsafe claims are therefore in effect on native with no guard.

The structs hold `Rc<RefCell<>>`. The player cores that own the underlying `Rc` are:
- `WindowedStreamingPlayerCore` (line 202): `source: Rc<RefCell<WindowedMediaSource>>`
- `StreamingPlayerCore` (line 519): `source: Rc<RefCell<AppendableMediaSource>>`

### Task

Gate the struct definitions, all trait impls, and the unsafe impls behind
`#[cfg(target_arch = "wasm32")]`. For native targets, provide equivalent structs backed by
`Arc<Mutex<>>` that are genuinely `Send + Sync` without unsafe.

The native variants follow the same structure:

```rust
#[cfg(not(target_arch = "wasm32"))]
struct SharedWindowedMediaSource {
    inner: Arc<Mutex<WindowedMediaSource>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl SharedWindowedMediaSource {
    fn new(inner: Arc<Mutex<WindowedMediaSource>>) -> Self {
        Self { inner }
    }
}
// ... impl Read, Seek, MediaSource using inner.lock().unwrap()
```

The player core structs (`WindowedStreamingPlayerCore`, `StreamingPlayerCore`) hold a raw
`Rc<RefCell<>>`. Those fields also need to be cfg-split:

```rust
#[cfg(target_arch = "wasm32")]
source: Rc<RefCell<WindowedMediaSource>>,
#[cfg(not(target_arch = "wasm32"))]
source: Arc<Mutex<WindowedMediaSource>>,
```

And their constructors / usage sites updated accordingly.

**Important:** Call sites at lines 351 and 647 pass `Rc::clone(&self.source)` to
`SharedWindowedMediaSource::new` and `SharedAppendableMediaSource::new`. These must be
cfg-split too.

**If the scope grows beyond lib.rs** (e.g., the player core structs are used from other
modules), do not proceed with structural changes — stop and report back to the lead agent with
a description of what additional files would be affected.

### Verification

```
# wasm target
cargo check --manifest-path packages/jam-audio-engine/Cargo.toml --target wasm32-unknown-unknown

# native target (host)
cargo check --manifest-path packages/jam-audio-engine/Cargo.toml

# tests (native runner, covers both code paths)
cargo test --manifest-path packages/jam-audio-engine/Cargo.toml
```

All three must pass. The test count must be >= 51.

### Files

- `packages/jam-audio-engine/src/lib.rs` only (unless scope expansion forces otherwise —
  stop and report if it does)

---

## Integration Checkpoint

After all three workers complete, the lead agent runs:

```
cargo check --manifest-path packages/jam-audio-engine/Cargo.toml
cargo check --manifest-path packages/jam-audio-flutter/Cargo.toml
cargo test --manifest-path packages/jam-audio-engine/Cargo.toml
```

Expected:
- Zero warnings across both crates
- All tests pass (>= 51 in `jam-audio-engine`)
- No `frb_expand` warning in Flutter crate

## Non-Goals

- Newtypes (`SampleRate`, `FrameCount`, etc.) — not in scope
- Metadata field additions — not in scope
- Public API changes — not in scope
- `apps/` folder cleanup — separate project hygiene concern
- Threading model redesign — deferred unless Worker 3 uncovers concrete unsoundness on native
