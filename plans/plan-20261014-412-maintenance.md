# #412 Cloud retention / maintenance

Status: PR #456 is open and non-draft; rebased onto main 76e59b21. Approved test migrations pass targeted checks; excluded #437 fixture remains a CI integration gap.
Branch: `fix/412-maintenance-ports`.
Initial base: `5ef13002`; integrate latest cached main normally before final checks.

## Authority and boundaries

Issue #412 defines ten bounded expired-state ports and one cloud executor.
Latest owner instruction requires targeted tests only with one worker, no
full-repo suites, no #437 fixture edits, and a non-draft PR without merge.
#436 settlement, #437 client retention, #430 wake and #431 Summary are excluded.

## P1 / P2 / P3

The source map, real byte deletion/accounting trace, fairness tradeoff and
confirmed SQLite partial-result reproduction are recorded in
`docs/researches/2026-10-14-cloud-retention.md`.

The existing candidate was ported onto main, preserving exclusive SQLite
ownership, close-only lifecycle, aggregate stats and the sole TTL lease.
Herdr Claude planning identified the remaining byte-owner, partial-count,
Worker policy and scheduler-lifecycle cuts. Root implemented them sequentially.
There is one writer in this worktree; the old worker's WIP is untouched.

## Task Breakdown

- [x] Add collectExpired to the ten ports and their real implementations.
- [x] Remove replaced public methods, old retention CTE and job writer.
- [x] Add closed-order kernel executor, per-step reports and observer.
- [x] Bind physical byte owners; preserve guarded settlement and bounded retry fairness.
- [x] Preserve committed counts after later step faults without inventing remainder.
- [x] Export tenant policy read/write from the neutral runtime entry.
- [x] Schedule server passes without overlap; close waits settled work before storage release.
- [x] Migrate in-scope API consumers with business assertions intact.
- [x] Update docs, migration notes and four affected API goldens.
- [x] Merge cached main a10c67a0 normally and complete final targeted checks.
- [x] Push own branch and open non-draft PR #456 referencing #412; do not merge.
- [x] Rebase onto main 76e59b21, preserve wake close integration and apply owner-approved test migrations.
- [x] Verify 86 server tests and seven physical-object tests against real Postgres/S3 with one worker.
- [ ] Publish approved migration commit and record its hosted CI status.

## Verification boundary

Use Node 24.21.0 / Bun 1.4.2. Build and typecheck core, cloud, server,
cloud-dataplane, plus conformance typecheck. Dependencies protocol and testkit
are built only to supply dist exports. Run single-worker focused retention,
scheduler, receipts, replay and Worker packaging tests. Check only the four
changed API surfaces, version authority and installed SQL order.

Host-shell Postgres/S3 ports and GitHub CLI are now reachable through Herdr.
The seven physical-object retention tests pass without skips. Direct restricted
execution still has network limitations; shared Colima repair is outside scope.

No full-root verification, client fixtures, installed migration edits, flags,
compatibility aliases or worker merge are authorized. The later owner request
explicitly authorized rebasing the feature branch; main history remains untouched.
