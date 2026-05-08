# Design Doc - Metadata Tag Deduplication

Extract a private helper function to deduplicate metadata tag mapping logic in `packages/jam-audio-engine/src/metadata.rs`.

## Problem

`extract_metadata_internal` contains two nearly identical `match` blocks for mapping `StandardTagKey` variants to `AudioMetadata` fields. This duplication makes it harder to maintain and add new metadata fields.

## Proposed Solution

Introduce a private helper function `apply_tags` that encapsulates the mapping logic.

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

### Implementation Details

1.  **Extract `apply_tags`**: Move the shared mapping logic into this function.
2.  **Preserve Asymmetry**: Use the `overwrite` parameter to maintain the existing behavior where the second pass only updates `track_number` if it's currently `None`.
3.  **Update `extract_metadata_internal`**:
    *   First pass (container metadata): Call `apply_tags(result, metadata.tags(), true)`.
    *   Second pass (metadata block): Call `apply_tags(result, metadata.tags(), false)`.

## Verification Plan

### Automated Tests
*   Run existing tests: `cargo test --manifest-path packages/jam-audio-engine/Cargo.toml`
*   Verify all 51 tests pass.

### Manual Verification
*   N/A (covered by existing tests)
