# Design: Audio Package Governance Policy

Date: 2026-05-07
Status: Approved

## Overview
Update the governance model for the `jam-audio` repository to reflect its status as the canonical source of truth for shared audio packages. This involves removing stale references to a "staged mirror" workflow and formalizing the relationship with consumer repositories like `jamdisc`.

## Architecture
- **Provider:** `jam-audio` (Source of Truth)
- **Consumer:** `jamdisc` (and specifically `apps/jamdisc_web`)

## Requirements
1.  **Canonical Status:** All primary development and review must happen in `jam-audio`.
2.  **No Duplication:** Eliminate editable copies in consumer repos to prevent drift.
3.  **Pragmatic Back-porting:** Allow emergency fixes in consumers if necessary, but mandate immediate back-porting to the provider.
4.  **Verification:** Maintain stability via mandatory tests/checks before packages are considered "ready" for consumers.

## Design Details

### Policy File: `SYNC_POLICY.md`
The file will be rewritten to focus on the Provider-Consumer relationship.

#### Sections:
- **Source of Truth:** List canonical packages.
- **Consumer Model:** Explain how consumers (like `jamdisc`) interact with this repo.
- **Rules of Engagement:** 
    - No duplication.
    - Mandatory back-porting.
    - Continuous verification.

## Success Criteria
- `SYNC_POLICY.md` contains no references to "standalone mirror" or "staged" workflows.
- The policy clearly states that `jam-audio` is the source of truth.
- The workflow for emergency fixes is documented.
