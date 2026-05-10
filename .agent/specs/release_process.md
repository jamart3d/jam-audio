# jam-audio Release Process

This document defines how to version, save, and publish the jam-audio package.
Agents working in either the `jam-audio` or `jamdisc` repository should follow
this process when asked to release, version-bump, or publish jam-audio.

## Repository Location

```
c:\Users\jeff\StudioProjects\jam-audio          (Windows)
/mnt/c/Users/jeff/StudioProjects/jam-audio      (WSL)
```

This is a **sibling** of the `jamdisc` repo, not a subdirectory.

## Package Structure

| Crate | Path | Purpose |
|-------|------|---------|
| `jam-audio-engine` | `packages/jam-audio-engine/` | Rust audio engine: decode, metadata, artwork, buffering, gapless playback. Exports via `wasm_bindgen`. |
| `jam-audio-flutter` | `packages/jam-audio-flutter/` | Flutter bindings via `flutter_rust_bridge`. Depends on `jam-audio-engine`. |
| `jam-audio-worklet` | `packages/jam-audio-worklet/` | JavaScript AudioWorklet bridge and processor. No Cargo crate. |

## Version Scheme

- All Rust crates (`jam-audio-engine`, `jam-audio-flutter`) share **one version number**.
- The version lives in each crate's `Cargo.toml` → `version = "X.Y.Z"`.
- Both crates MUST be bumped together.
- Git tags use the format `vX.Y.Z`.
- Worklet has no independent version — it rides the repo tag.

### When to Bump

| Change type | Bump |
|-------------|------|
| Bug fix, internal refactor | Patch (0.2.5 → 0.2.6) |
| New public API, new wasm export | Minor (0.2.5 → 0.3.0) |
| Breaking API change | Minor pre-1.0 (0.2.5 → 0.3.0) |

## Release Steps

### 1. Verify

```bash
cd packages/jam-audio-engine
cargo test
cargo clippy --all-targets
```

### 2. Bump Version

Edit **both** Cargo.toml files to the new version:

- `packages/jam-audio-engine/Cargo.toml`  →  `version = "X.Y.Z"`
- `packages/jam-audio-flutter/Cargo.toml`  →  `version = "X.Y.Z"`

### 3. Update CHANGELOG

Add a new section to `CHANGELOG.md` at the repo root:

```markdown
## [X.Y.Z] — YYYY-MM-DD

### Added / Changed / Fixed
- Description of changes

### Verified
- What tests/checks passed
```

Move any content from `[Unreleased]` into the new version section.

### 4. Commit and Tag

```bash
git add -A
git commit -m "Release X.Y.Z"
git tag vX.Y.Z
```

### 5. Push

```bash
git push origin main
git push origin vX.Y.Z
```

## Cross-Repo Impact

When `jam-audio` is released, the `jamdisc` build scripts will pick up
the new version on the next build. The build scripts (`build.sh`,
`deploy.sh`, `build_local.ps1`) automatically:

1. Build `jam-audio-engine` Wasm and sync to `web/pkg/`
2. Build `jam-audio-flutter` Wasm and sync to `web/pkg/`
3. Regenerate `flutter_rust_bridge` Dart bindings
4. Copy worklet JS files

No manual sync is needed from `jamdisc` after a `jam-audio` release
unless the `jam-audio` release includes worklet changes that were
authored in `jamdisc` (use `/sync_canonical` for that first).

## Common Mistakes

- **Bumping only one Cargo.toml**: Both must match. `jam-audio-flutter`
  depends on `jam-audio-engine` via path — a version mismatch won't
  break the build but makes the tag misleading.
- **Forgetting the git tag**: The build scripts embed `git rev-parse --short HEAD`
  into the jamdisc display string. Tags make release tracking possible.
- **Skipping `jam-audio-flutter`**: If `jam-audio-engine` API surface changes,
  `jam-audio-flutter` must re-export or wrap the change. The FRB codegen
  in `jamdisc` will fail otherwise.
