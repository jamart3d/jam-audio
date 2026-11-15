# Jam Audio 0.5.2 Release Preparation and Verification Design

Date: 2026-11-15
Status: Approved design

## Purpose

Prepare the existing post-0.5.1 worklet changes for a 0.5.2 patch release and make the repository's release verification faster and repeatable. This work prepares and validates a local release commit; it does not tag, push, or publish the release.

## Scope

The implementation will:

- bump the engine, Flutter bridge, and worklet package manifests from 0.5.1 to 0.5.2;
- update affected lockfiles so local package versions remain consistent;
- add a dated 0.5.2 changelog entry for Play-only activation behavior, stale-start protection, media-state corrections, and the associated regression tests;
- restore rustfmt-compatible import ordering in `packages/jam-audio-flutter/src/frb_generated.rs`, resolving the current formatting-only working-tree difference;
- add `scripts/verify-release.sh` as the canonical local release-verification entry point; and
- update `RELEASING.md` to document that entry point while retaining the individual commands for troubleshooting.

The implementation will not delete existing build caches, change product behavior, add dependencies, create a release tag, push commits, publish packages, or claim fresh real-device/browser coverage.

## Verification architecture

`scripts/verify-release.sh` will locate the repository root from its own path and run from that root. It will create an isolated temporary log directory and start independent verification groups concurrently:

1. Worklet group: syntax checks and the complete Node test suite through the package's existing `npm test` command.
2. Rust group: clippy, native engine check, Wasm engine check, Flutter bridge check, and engine tests. These commands remain sequential inside one group so they share Cargo artifacts without contending on Cargo target locks.
3. Static group: rustfmt check, generated protocol check, and Git whitespace validation.
4. Package group: local npm package-content validation with `npm pack --dry-run` and a temporary npm cache, avoiding writes to a user-global cache.

All groups will run against the same checkout. Only the Rust group writes Cargo build artifacts, so the groups do not compete for a mutable target directory. Cargo commands will execute from the workspace root and use its existing `target/` cache.

The script will retain each group's complete output until completion, print a concise pass/fail summary, print the failing group's log on error, and return a nonzero status if any group fails. Temporary logs will be removed on exit. Interrupt handling will terminate outstanding child processes before cleanup.

## Error handling and safety

- A failure in one group will not hide failures already produced by another group.
- The script will wait for every started group and report every failed group.
- Shell strict mode and explicit process-status capture will prevent pipelines or summary printing from replacing the real test status.
- Package validation will be local-only. Authentication and actual registry publication remain explicit release steps.
- The existing generated-file change is limited to three import-order lines. Restoring rustfmt ordering intentionally removes that pre-existing formatting-only diff.
- No existing cache directory will be removed or migrated automatically.

## Release metadata

Version 0.5.2 is a patch release because the shipped work is a non-breaking correction to startup activation and media-state behavior. The new helper module remains internal to the worklet package and does not expand its exported package surface.

The changelog will describe user-visible behavior and verification without claiming unsupported device coverage. Because 0.5.1 has a release commit but no local `v0.5.1` tag, the implementation will record that fact in the handoff; it will not create a retroactive tag without separate authorization.

## Testing the verifier

Implementation will follow test-driven development for the new shell entry point. A shell-level test will exercise process-status aggregation and a controlled failing group before the production script is finalized. Final verification will run:

- the verifier's own test;
- `scripts/verify-release.sh` end to end;
- a direct shell syntax check;
- the final release diff and whitespace check; and
- a package-content inspection confirming test files remain excluded and the activation helper is included.

## Success criteria

- All manifests and relevant lockfiles report 0.5.2.
- The changelog accurately describes the release slice.
- The working tree has no unrelated or formatting-only generated-file difference.
- The parallel verifier returns zero only when every verification group passes.
- The complete verification finishes faster than running the independent groups serially.
- The final handoff clearly lists remaining external actions: optional 0.5.1 tag reconciliation, release commit/tag creation, push, authenticated dry-runs, real-browser caveat review, and publication.
