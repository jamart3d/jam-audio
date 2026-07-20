# Releasing Jam Audio

This repository uses lockstep package versioning across:

- `packages/jam-audio-engine`
- `packages/jam-audio-flutter`
- `packages/jam-audio-worklet`

The root `CHANGELOG.md` is the release log for the repo.

## Versioning Rule

- Use a patch release such as `0.2.1` for internal fixes, performance tuning, and non-breaking behavior changes.
- Use a minor release such as `0.3.0` for broader behavior changes or larger feature slices.
- Keep all package manifests on the same version unless there is a deliberate reason not to.

## Release Checklist

1. Confirm the intended release slice is complete and scoped cleanly.
   Example: release Phase 1 now; keep later phases as roadmap-only work.
2. Update `CHANGELOG.md` with a dated release entry.
3. Bump versions in:
   - `packages/jam-audio-engine/Cargo.toml`
   - `packages/jam-audio-flutter/Cargo.toml`
   - `packages/jam-audio-worklet/package.json`
4. Run targeted validation:

```bash
node --check packages/jam-audio-worklet/src/audio_bridge.js
node --check packages/jam-audio-worklet/src/audio_processor.js
npm --prefix packages/jam-audio-worklet test
cargo check --manifest-path packages/jam-audio-engine/Cargo.toml
cargo check --manifest-path packages/jam-audio-flutter/Cargo.toml
```

5. Review the final release diff:

```bash
git status
git diff --stat
git diff
```

6. Commit the release:

```bash
git add CHANGELOG.md packages/jam-audio-engine/Cargo.toml packages/jam-audio-flutter/Cargo.toml packages/jam-audio-worklet/package.json
git commit -m "Release X.Y.Z"
```

7. Tag the release:

```bash
git tag -a vX.Y.Z -m "jam-audio vX.Y.Z"
```

8. Push commit and tag:

```bash
git push
git push origin vX.Y.Z
```

## Registry Publishing Dry-Run

For scoped npm packages (`@jamart3d/jam-audio-worklet`, `@jamart3d/jam-audio-engine-wasm`):

1. Validate worklet package dry-run:
```bash
cd packages/jam-audio-worklet && npm publish --dry-run
```

2. Validate Wasm package dry-run:
```bash
cd packages/jam-audio-engine && wasm-pack build --target web --out-name jam_audio_engine && cd pkg && npm publish --dry-run
```

3. Actual publication (requires owner authorization):
```bash
cd packages/jam-audio-worklet && npm publish --access public
cd packages/jam-audio-engine/pkg && npm publish --access public
```

## Notes

- Do not hold a finished patch release just because later roadmap phases exist.
- Prefer one release per validated implementation slice.
- If broader browser playback validation is skipped, call that out explicitly before tagging.
