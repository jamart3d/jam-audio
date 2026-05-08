# Audio Package Governance Policy

Date: 2026-05-07

## Source of Truth

`jam-audio` is the canonical source of truth for the shared audio packages:

- `packages/jam-audio-engine` (Rust)
- `packages/jam-audio-flutter` (Rust/FRB)
- `packages/jam-audio-worklet` (JavaScript)

These packages must be authored, reviewed, and verified here first.

## Consumer Model

Consumer repositories, such as `jamdisc`, reference these packages from their canonical location in the `jam-audio` repository. The current primary consuming application is `apps/jamdisc_web`.

## Governance Rules

- **No Duplication:** Do not reintroduce editable copies of these packages into consumer repositories. This prevents source-of-truth drift and maintenance fragmentation.
- **Pragmatic Back-porting:** If an emergency fix must be applied directly within a consumer repository, it MUST be back-ported to `jam-audio` immediately.
- **Verification:** Changes must pass minimum stability checks in `jam-audio` before being considered stable for consumers.
- **Review:** All functional changes and refactors require review in this repository to maintain architectural integrity.

## Verification Expectations

At minimum, the following must pass before a change is considered stable:

- `packages/jam-audio-engine`: `cargo test` or `cargo check`
- `packages/jam-audio-flutter`: `cargo check`
- `packages/jam-audio-worklet`: Syntax validation or unit tests

## Drift Management

Treat any functional divergence between this repository and consumer deployments as a critical governance issue to be resolved by aligning with `jam-audio` as the source of truth.
