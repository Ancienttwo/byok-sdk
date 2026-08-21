# Plan: U1-U5 Integration Acceptance

> **Status**: Archived
> **Created**: 20260821-1959
> **Slug**: u1-u5-integration-acceptance
> **Artifact Level**: work-package
> **Promotion Reason**: PR #81 combines five public-contract, persistence, release-identity, and data-erasure work packages. Their exact merged subject requires one independent semantic review and one SHA-bound merge gate; the five component receipts cannot be composed into an integration receipt.
> **Verification Boundary**: frozen PR #81 subject against `origin/main`, including CI, packed artifacts, migration order, and cross-package authority
> **Rollback Surface**: close PR #81 or revert the integration merge before any release or production migration

## Goal

Bind the exact PR #81 integration subject to a fresh Change Assessment,
independent Codex review, typed external-pass AcceptanceReceipt, and local
merge seal. Merge only if every gate remains fresh and GitHub CI is green.

## P1 — Authority map

- U1-U5 plans/contracts remain the product and implementation authorities.
- This plan owns only the aggregate acceptance, final-subject review, and merge
  decision for PR #81.
- GitHub owns remote CI status; repo-harness owns Change Assessment,
  AcceptanceReceipt, and merge-gate freshness.
- npm registry, deployment, production migration, and secrets remain outside
  this plan.

## P2 — Concrete trace

Frozen PR head and `origin/main` target → deterministic diff/CI/pack/migration
checks → independent gatekeeper review → typed AcceptanceReceipt → SHA-bound
merge seal → GitHub merge. Any subject, target, evidence, or review drift
invalidates the chain and stops before merge.

## P3 — Decision

Create one integration-only strict contract rather than reusing or weakening a
component contract. It permits no product edits. The only mutable repository
surfaces are this plan's workflow artifacts; product drift requires returning
to the owning U1-U5 contract and re-freezing the subject.

## Task Breakdown

- [x] Freeze the integrated U1-U5 product subject and open Draft PR #81.
- [x] Pass local build/typecheck/test, real Postgres+MinIO, strict workflow,
  package graph, and packed-artifact checks.
- [x] Pass the GitHub macOS/Linux/Windows CI matrix for the frozen product tree.
- [ ] Commit and push this integration acceptance envelope.
- [ ] Reconfirm final-subject GitHub CI and prepare acceptance evidence.
- [ ] Obtain independent Codex gatekeeper verdict and record external-pass receipt.
- [ ] Create and verify the merge seal, then merge PR #81 if still fresh.

## Evidence Contract

- **State/progress path**: this plan, its contract, notes, review, latest harness
  trace, typed AcceptanceReceipt, and merge-gate seal.
- **Verification evidence**: current PR #81 CI, deploy SQL ordering, package
  graph closure, current-SHA pack/install smoke, strict workflow, and Change
  Assessment.
- **Evaluator rubric**: preserve U1 cancellation priority, U2 usage separation,
  U3 readiness authority, U4 immutable release identity and packed dependency
  closure, and U5 tenant isolation/resumability; reject fallback authorities,
  migration collisions, or release/production overclaims.
- **Stop condition**: any changed product path after freeze, non-green CI,
  rejected/stale receipt, stale target, or failed merge seal.
- **Rollback surface**: close the Draft PR or revert its integration merge;
  nothing under this plan is published or deployed.

## Promotion Gate

- **Merge/PR unit**: PR #81 as one U1-U5 integration subject.
- **Rollback surface**: close/revert PR #81 before release.
- **Verification boundary**: exact base/head diff, CI, pack closure, migrations,
  strict workflow, independent review, receipt, and merge seal.
- **Review/acceptance boundary**: independent Codex gatekeeper plus typed
  `external_pass`; no user waiver is planned.
- **High-risk surface**: cancellation ordering, tenant isolation, erasure
  idempotency, migration sequence, release identity, and packed metadata.
- **Why not checklist row**: the final merge combines five independently
  verified contracts and must bind their interaction to one exact target/head.

## Authorization boundary

Authorized: acceptance artifacts, push, merge-gate creation, and merge of PR
#81 after all gates pass. Not authorized: npm publish, tag/Release creation,
deploy, production migration, registry mutation, or secret mutation.
