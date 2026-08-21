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
