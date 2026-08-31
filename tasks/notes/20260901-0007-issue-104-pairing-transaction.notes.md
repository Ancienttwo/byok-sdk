# Implementation Notes: issue-104-pairing-transaction

> **Status**: Complete
> **Plan**: plans/plan-20260901-0007-issue-104-pairing-transaction.md
> **Contract**: tasks/contracts/20260901-0007-issue-104-pairing-transaction.contract.md
> **Review**: tasks/reviews/20260901-0007-issue-104-pairing-transaction.review.md
> **Last Updated**: 2026-09-01 00:40

## Design Decisions

- `PairingEnrollment` is mandatory and is the only code-consumption API; `PairingCodeStore` becomes issuance-only.
- Enrollment input contains code and device facts, never tenant/product. Only guarded code claims choose identity scope.
- Standalone device registration and transactional pairing share one concrete Postgres mutation implementation.
- Historical redeemed/no-device rows cannot be safely inferred or repaired; operators must issue a new code outside this source slice.

## Evidence Links

- Pre-fix failure: `tasks/notes/20260901-0007-issue-104-pairing-transaction.pre-fix.txt`
- Checks: `.ai/harness/checks/latest.json`
- Clean-base root-cause guard: 17 tests, 16 pass / 1 expected failure; first
  registration raised, retry returned 401 instead of 200; the tracked artifact
  records `PRE_FIX_EXIT=1` against base `2c039165`.
- Fixed hosted auth parity plus constraints: 37/37 pass. The same one-shot
  `devices.register` failure now leaves the in-memory code retryable.
- In-memory cloud conformance: 61/61 pass, including exact-code concurrent
  enrollment with one registered winner and tenant/product claim authority.
- Real disposable Postgres pairing transaction plus full cloud conformance:
  64/64 pass. The test-local trigger fails device insert after the guarded code
  update, then reads back `redeemed_at = NULL`, preserves the superseded
  predecessor, and succeeds with the same code after the trigger is removed.
- Independent gatekeeper: PASS, no P0-P3 finding. It reran cloud 37/37,
  in-memory 61/61, real Postgres 64/64, worker packaging/live E2E 11/11,
  package typechecks/builds, and diff checks.
- Root `bun run build`, `bun run typecheck`, and `bun run test`: pass. The first
  full test saw the existing Wrangler dry-run's fixed 5-second cold timeout;
  the isolated unchanged test passed 6/6 and the complete rerun passed.
- Strict task-workflow and `git diff --check`: pass.

## Deviations From Plan Or Spec

- The initial Postgres failure guard proved code rollback but not the machine
  supersession side effect named by the falsifier. Before final freeze it was
  strengthened with an existing same-machine predecessor: failed enrollment
  preserves it, successful retry replaces it.

## Residual Risks

- This is a breaking cloud composition API and needs a separately authorized release boundary.
- Historical redeemed/no-device rows have no safe device linkage and remain an
  operator re-issue case; no repair or compatibility path was added.
- Disposable database evidence is not production migration or deployment
  evidence. No schema change was needed in this source slice.

## Promotion Filter

Promote only durable concurrency rules; commit, CI, issue, worktree, release,
and registry snapshots remain in their authoritative systems rather than this
note.
