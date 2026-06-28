# Rust Quality Maintenance Design

## Purpose

Improve Rust maintenance quality for `jam-audio` without changing audio behavior, public APIs, supported formats, or test coverage. The work should make routine regressions harder to merge and clean up the current formatter and Clippy drift.

## Scope

Included:

- Fix current `cargo fmt --check` drift in first-party Rust code.
- Fix current `cargo clippy --workspace --all-targets -- -D warnings` findings in first-party Rust code.
- Add CI steps that enforce formatting and Clippy warnings.
- Keep all existing tests.
- Make only low-risk code cleanups that are directly required by formatter or Clippy.

Excluded:

- Do not reduce or reorganize test coverage in this pass.
- Do not change `symphonia` feature selection or remove audio formats.
- Do not refactor decoder, streaming, gapless, or ring-buffer architecture.
- Do not hand-edit generated Flutter Rust Bridge code beyond formatting if needed for the formatter gate.
- Do not clean local ignored `target/` or `pkg/` artifacts as part of source changes.

## Current Findings

The repository is functionally healthy:

- `cargo check --workspace --all-targets` passes.
- `cargo test --workspace` passes with 89 Rust tests.
- No package `target/` or `pkg/` output is tracked by Git.

Quality gates are not yet clean:

- `cargo fmt --check` reports formatting drift in Rust source and generated FRB code.
- `cargo clippy --workspace --all-targets -- -D warnings` reports mechanical warnings in `packages/jam-audio-engine/src/decoder.rs` and `packages/jam-audio-engine/src/opus_decoder.rs`.
- `.github/workflows/rust.yml` checks and tests Rust, but does not enforce `cargo fmt --check` or Clippy.

## Design

The implementation should be a conservative maintenance change. First, apply `cargo fmt` so the formatter defines the style consistently. Then address Clippy findings with the smallest equivalent code changes:

- Use `std::iter::repeat_n` instead of `repeat().take()`.
- Collapse nested conditionals where Clippy requests it.
- Replace `extend(drain(..))` with `append`.
- Rewrite the flagged range loop in test code with iterator/enumerate.
- Replace an unnecessary `ok_or_else` with `ok_or`.

CI should add two explicit Rust quality steps before the existing check/test steps:

- `cargo fmt --check`
- `cargo clippy --workspace --all-targets -- -D warnings`

The Clippy step should run after installing the stable Rust toolchain and before `cargo test`, so style and lint failures surface early.

## Testing

After implementation, verify:

- `cargo fmt --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo check --workspace --all-targets`
- `cargo test --workspace`

Passing those commands is the success criterion. Because the scope is intentionally behavior-preserving, no new runtime tests are required unless a code change goes beyond the known formatter/Clippy fixes.

## Risks

Generated FRB formatting may create noisy diffs. That is acceptable only if needed for `cargo fmt --check`; otherwise generated code should not be manually changed.

Clippy behavior can vary by Rust version. CI should use the same stable toolchain already configured in the workflow, and the plan should verify locally with the installed stable toolchain.

Audio format support is intentionally unchanged. The existing `symphonia` defaults stay in place because the current shipped wasm size is not large enough to justify narrowing future compatibility.
