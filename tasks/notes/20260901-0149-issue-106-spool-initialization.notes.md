# Implementation Notes: issue-106-spool-initialization

> **Status**: Complete
> **Plan**: plans/plan-20260901-0149-issue-106-spool-initialization.md
> **Contract**: tasks/contracts/20260901-0149-issue-106-spool-initialization.contract.md
> **Review**: tasks/reviews/20260901-0149-issue-106-spool-initialization.review.md
> **Last Updated**: 2026-09-01 02:23

## Design Decisions

- Current main already carries an AgentRef-keyed single-flight promise introduced after the issue's audit baseline; this slice verifies it and closes its missing exact-home binding.
- Cached and opening authorities reject another home for the same AgentRef instead of silently redirecting the append.
- Tests use public `appendReliable()` so open sharing, spool write serialization, controller visibility, and cursor allocation are observed together.
- Tenant-wide quota serialization and cross-profile same-home authority remain separate work packages.

## Evidence Links

- Pre-fix failure: `tasks/notes/20260901-0149-issue-106-spool-initialization.pre-fix.txt`
- Checks: `.ai/harness/checks/latest.json`
- Audit baseline `7a937e5ed8eb5aef102eacb0df9183f296da7e1f` failed the public concurrency guard because `AgentReliableSpool.open()` was called twice.
- Focused client verification passed: 2 test files, 32 tests.
- Root `bun run build` and `bun run typecheck` passed.
- Root `bun run test` passed on the frozen source: client 1566 passed / 11 skipped plus all subsequently selected packages green. The first run hit a 5-second timeout in the unrelated Cloud Dataplane Wrangler packaging test; that exact test immediately passed 6/6 and the complete root rerun passed.
- `git diff --check` and `repo-harness run check-task-workflow --strict` passed before acceptance preparation.
- Independent gatekeeper reviewed frozen commit `ef0dcb04598e282d19c0de93958de7da549a7fc5` against `9d2b05253570c13f235ef4f9aa2a1e94e431c576` and returned PASS with no P0-P3 finding or #107 scope contamination.
- Change Assessment classifies the same public append guard both as a deterministic concurrency oracle and as runtime readback: it opens a real temporary durable spool and reads the two records and cursors back through `reliableRecords()`.

## Deviations From Plan Or Spec

- Main already contained an unverified AgentRef-keyed single-flight promise added after the issue's audit baseline. This work package retains that narrow shape, adds exact-home binding, and supplies the missing deterministic proof rather than reimplementing the same promise cache.

## Residual Risks

- Different profile revisions currently produce different Agent keys even when they refer to one Agent home; this slice does not authorize that broader authority change.
- The controller retains opened spools for its process lifetime; eviction and aggregate scaling are separate concerns.
