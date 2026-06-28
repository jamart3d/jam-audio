# Rust Quality Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rust formatting and Clippy checks clean and enforced in CI without changing audio behavior, supported formats, public APIs, or test coverage.

**Architecture:** This is a conservative maintenance pass. The implementation keeps changes local to formatter output, mechanical Clippy fixes, and the Rust GitHub Actions workflow. No codec features, decoder architecture, test coverage, or generated-code ownership policy changes are introduced.

**Tech Stack:** Rust 2024, Cargo workspace, Clippy, rustfmt, GitHub Actions, Flutter Rust Bridge generated Rust.

---

## File Structure

- Modify: `.github/workflows/rust.yml`
  - Adds Rust quality gates to CI and explicitly installs `rustfmt` and `clippy`.
- Modify: `packages/jam-audio-engine/src/decoder.rs`
  - Applies mechanical Clippy fixes and rustfmt output.
- Modify: `packages/jam-audio-engine/src/gapless_player.rs`
  - Applies rustfmt output only.
- Modify: `packages/jam-audio-engine/src/lib.rs`
  - Applies rustfmt output only.
- Modify: `packages/jam-audio-engine/src/opus_decoder.rs`
  - Applies one mechanical Clippy fix and rustfmt output.
- Modify: `packages/jam-audio-flutter/src/frb_generated.rs`
  - Applies rustfmt import ordering only if `cargo fmt` changes it.

Do not modify:

- `packages/jam-audio-engine/Cargo.toml`
- `packages/jam-audio-flutter/Cargo.toml`
- `Cargo.toml`
- `third_party/opus-rs/**`
- test counts, assertions, or codec feature selection

### Task 1: Capture The Current Quality-Gate Baseline

**Files:**
- No file changes.

- [ ] **Step 1: Confirm the working tree only contains the committed planning artifacts ahead of origin**

Run:

```bash
git status --short --branch
```

Expected: the branch reports `main...origin/main [ahead 2]` after this plan is committed, with no unstaged or staged source changes.

- [ ] **Step 2: Reproduce rustfmt drift**

Run:

```bash
cargo fmt --check
```

Expected: FAIL. Output includes formatting diffs for:

```text
packages/jam-audio-engine/src/decoder.rs
packages/jam-audio-engine/src/gapless_player.rs
packages/jam-audio-engine/src/lib.rs
packages/jam-audio-engine/src/opus_decoder.rs
packages/jam-audio-flutter/src/frb_generated.rs
```

- [ ] **Step 3: Reproduce Clippy warnings**

Run:

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: FAIL. Output includes:

```text
packages/jam-audio-engine/src/decoder.rs:95:32 manual_repeat_n
packages/jam-audio-engine/src/decoder.rs:96:32 manual_repeat_n
packages/jam-audio-engine/src/decoder.rs:378:9 collapsible_if
packages/jam-audio-engine/src/decoder.rs:502:13 extend_with_drain
packages/jam-audio-engine/src/decoder.rs:511:13 collapsible_if
packages/jam-audio-engine/src/decoder.rs:1112:18 needless_range_loop
packages/jam-audio-engine/src/opus_decoder.rs:79:24 unnecessary_lazy_evaluations
```

### Task 2: Apply Formatter Output

**Files:**
- Modify: `packages/jam-audio-engine/src/decoder.rs`
- Modify: `packages/jam-audio-engine/src/gapless_player.rs`
- Modify: `packages/jam-audio-engine/src/lib.rs`
- Modify: `packages/jam-audio-engine/src/opus_decoder.rs`
- Modify: `packages/jam-audio-flutter/src/frb_generated.rs`

- [ ] **Step 1: Apply rustfmt**

Run:

```bash
cargo fmt
```

Expected: command exits successfully with no required console output.

- [ ] **Step 2: Inspect formatter-only diff**

Run:

```bash
git diff --stat
git diff -- packages/jam-audio-engine/src/decoder.rs packages/jam-audio-engine/src/gapless_player.rs packages/jam-audio-engine/src/lib.rs packages/jam-audio-engine/src/opus_decoder.rs packages/jam-audio-flutter/src/frb_generated.rs
```

Expected: only formatting changes. Generated FRB changes should be limited to rustfmt import ordering if present.

- [ ] **Step 3: Verify rustfmt now passes**

Run:

```bash
cargo fmt --check
```

Expected: PASS with no diff output.

- [ ] **Step 4: Commit formatter output**

Run:

```bash
git add packages/jam-audio-engine/src/decoder.rs packages/jam-audio-engine/src/gapless_player.rs packages/jam-audio-engine/src/lib.rs packages/jam-audio-engine/src/opus_decoder.rs packages/jam-audio-flutter/src/frb_generated.rs
git commit -m "style: format rust sources"
```

Expected: commit succeeds. If a listed file was unchanged, `git add` still succeeds.

### Task 3: Fix Mechanical Clippy Findings

**Files:**
- Modify: `packages/jam-audio-engine/src/decoder.rs`
- Modify: `packages/jam-audio-engine/src/opus_decoder.rs`

- [ ] **Step 1: Replace manual repeat/take in resampler flush**

In `packages/jam-audio-engine/src/decoder.rs`, update `StereoResampler::flush` to:

```rust
    /// Flush any remaining buffered frames by padding with silence and processing.
    fn flush(&mut self, out: &mut Vec<f32>) {
        if self.pending[0].is_empty() {
            return;
        }
        // Pad both channels to chunk_frames with silence.
        let have = self.pending[0].len();
        let need = self.chunk_frames - have;
        self.pending[0].extend(std::iter::repeat_n(0.0f32, need));
        self.pending[1].extend(std::iter::repeat_n(0.0f32, need));
        self.process_one_chunk(out);
    }
```

- [ ] **Step 2: Collapse finalized Ogg reprobe conditional**

In `packages/jam-audio-engine/src/decoder.rs`, update the conditional near `StreamingDecoder::seek_to_ms` to:

```rust
        if self.is_ogg_family
            && self.has_known_byte_len
            && !self.reprobed_after_finalized
            && let Some(format_reader) = self.format.take()
        {
            let mut mss = format_reader.into_inner();
            let _ = mss.seek(SeekFrom::Start(0));
            let hint = Hint::new();
            let probed = get_probe().format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )?;
            self.format = Some(probed.format);
            self.reprobed_after_finalized = true;
        }
```

- [ ] **Step 3: Replace extend/drain with append**

In `packages/jam-audio-engine/src/decoder.rs`, update the transfer from `chunk_samples` into `intermediate_samples` to:

```rust
            // append retains chunk_samples' capacity for reuse on the next iteration
            self.intermediate_samples.append(&mut chunk_samples);
```

- [ ] **Step 4: Collapse resampler flush conditional**

In `packages/jam-audio-engine/src/decoder.rs`, update the stream-exhausted resampler block to:

```rust
        if self.intermediate_samples.is_empty() {
            // Stream exhausted: flush any buffered resampler frames.
            if self.source_sample_rate != self.target_sample_rate
                && let Some(resampler) = self.resampler.as_mut()
            {
                let before = out.len();
                resampler.flush(out);
                if out.len() > before {
                    return Ok(true);
                }
            }
            return Ok(false);
        }
```

- [ ] **Step 5: Rewrite the flagged test range loop**

In `packages/jam-audio-engine/src/decoder.rs`, update `windowed_header_survives` header setup to:

```rust
        for (i, byte) in data.iter_mut().take(50).enumerate() {
            *byte = i as u8;
        } // header
```

- [ ] **Step 6: Replace unnecessary ok_or_else**

In `packages/jam-audio-engine/src/opus_decoder.rs`, update `audio_buffer` to:

```rust
    fn audio_buffer(
        sample_rate: u32,
        samples_per_channel: u64,
        num_channels: usize,
    ) -> Result<AudioBuffer<f32>> {
        let channels =
            map_to_channels(num_channels).ok_or(Error::DecodeError("opus: invalid channel count"))?;
        let spec = SignalSpec::new(sample_rate, channels);
        Ok(AudioBuffer::new(samples_per_channel, spec))
    }
```

- [ ] **Step 7: Re-run formatter after manual edits**

Run:

```bash
cargo fmt
```

Expected: command exits successfully with no required console output.

- [ ] **Step 8: Verify Clippy now passes**

Run:

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 9: Verify tests still pass after Clippy fixes**

Run:

```bash
cargo test --workspace
```

Expected: PASS. Current baseline is 89 Rust tests passing for `jam_audio_engine`, 0 integration tests in `wasm_surface.rs`, and 0 tests in `jam_audio_flutter`.

- [ ] **Step 10: Commit Clippy fixes**

Run:

```bash
git add packages/jam-audio-engine/src/decoder.rs packages/jam-audio-engine/src/opus_decoder.rs
git commit -m "chore: fix rust clippy warnings"
```

Expected: commit succeeds.

### Task 4: Add CI Quality Gates

**Files:**
- Modify: `.github/workflows/rust.yml`

- [ ] **Step 1: Install rustfmt and clippy in the stable toolchain action**

In `.github/workflows/rust.yml`, update the `Install Rust` step to:

```yaml
      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: stable
          targets: wasm32-unknown-unknown
          components: rustfmt, clippy
```

- [ ] **Step 2: Add fmt and Clippy steps after system dependency installation**

In `.github/workflows/rust.yml`, insert these steps after `Install system deps (libopus for native)` and before `cargo check — engine (native)`:

```yaml
      - name: cargo fmt
        run: cargo fmt --check

      - name: cargo clippy
        run: cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 3: Verify workflow YAML diff**

Run:

```bash
git diff -- .github/workflows/rust.yml
```

Expected: the diff only adds `components: rustfmt, clippy` and the two quality-gate steps.

- [ ] **Step 4: Run local equivalents of the new CI gates**

Run:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: both commands PASS.

- [ ] **Step 5: Commit CI changes**

Run:

```bash
git add .github/workflows/rust.yml
git commit -m "ci: enforce rust formatting and clippy"
```

Expected: commit succeeds.

### Task 5: Final Verification

**Files:**
- No additional file changes expected.

- [ ] **Step 1: Run the full approved verification suite**

Run:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo check --workspace --all-targets
cargo test --workspace
```

Expected: all commands PASS.

- [ ] **Step 2: Confirm no accidental scope creep**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected changed files are limited to:

```text
docs/superpowers/specs/2026-06-28-rust-quality-maintenance-design.md
docs/superpowers/plans/2026-06-28-rust-quality-maintenance.md
.github/workflows/rust.yml
packages/jam-audio-engine/src/decoder.rs
packages/jam-audio-engine/src/gapless_player.rs
packages/jam-audio-engine/src/lib.rs
packages/jam-audio-engine/src/opus_decoder.rs
packages/jam-audio-flutter/src/frb_generated.rs
```

No `Cargo.toml`, `Cargo.lock`, `third_party/opus-rs/**`, test deletion, or `symphonia` feature changes should appear.

- [ ] **Step 3: Confirm working tree state**

Run:

```bash
git status --short --branch
```

Expected: clean working tree. Branch is ahead of `origin/main` by the spec, plan, formatting, Clippy, and CI commits.

## Self-Review Checklist

- Spec coverage: the plan covers formatter drift, Clippy warnings, CI quality gates, and full verification.
- Scope guard: no plan step changes audio formats, test coverage, public APIs, package versions, or codec architecture.
- Type consistency: all commands and file paths match the current repository layout.
- Generated code: `frb_generated.rs` is touched only by `cargo fmt`.
