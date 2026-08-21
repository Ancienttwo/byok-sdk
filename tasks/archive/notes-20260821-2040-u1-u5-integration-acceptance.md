> **Archived**: 2026-08-21 20:40
> **Related Plan**: plans/archive/plan-20260821-1959-u1-u5-integration-acceptance.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260821-2040

# U1-U5 integration acceptance notes

## Authority

- User approved the bounded next slice: external AcceptanceReceipt and merge
  decision for PR #81.
- No publish, tag/Release, deploy, production migration, registry mutation, or
  secret mutation is authorized.
- The five component contracts remain authoritative for product behavior; this
  contract owns only final-subject integration acceptance.

## Pre-envelope evidence

- Integrated product subject passed local build, typecheck, full tests, strict
  workflow, deploy SQL ordering, package graph, current-subject pack/install,
  and real disposable Postgres+MinIO cancellation/readiness/erasure/invariant
  suites.
- Independent read-only integration audit found no product blocker.
- PR #81 passed its full macOS/Linux/Windows CI matrix before this acceptance
  envelope was added. The final envelope commit must receive a fresh CI result
  before acceptance is recorded.

## Stop boundary

Any product-path edit after the envelope commit invalidates this path and must
return to the relevant U1-U5 contract. Workflow projection updates produced by
repo-harness are allowed only when they remain inside the contract allow-list.

## Acceptance preparation corrections

- The first prepare pass materialized the contract-declared latest trace; its
  only failure was the circular pre-existence check for that trace. The second
  pass satisfied all 17 contract checks.
- Change Assessment then rejected an invalid `semantic_review` oracle kind and
  correctly required `runtime_readback` for the strict deploy/release risk
  categories. The contract now declares only supported full-subject
  `deterministic_test` and `runtime_readback` oracles. Independent semantic
  judgment remains the separate Codex AcceptanceReceipt reviewer boundary.
- After merging the current `origin/main` ancestry, the product tree remained
  byte-identical to the previously accepted tree, but the new merge base made
  three already-reviewed U1 workflow cleanup paths visible to the allow-list
  gate. Those exact paths are now declared; this does not expand product scope.
