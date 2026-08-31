# Implementation Notes: issue-105-json-body-limits

> **Status**: Complete
> **Plan**: plans/plan-20260901-0058-issue-105-json-body-limits.md
> **Contract**: tasks/contracts/20260901-0058-issue-105-json-body-limits.contract.md
> **Review**: tasks/reviews/20260901-0058-issue-105-json-body-limits.review.md
> **Last Updated**: 2026-09-01 01:40

## Design Decisions

- Auth uses an internal 16 KiB request ceiling; messages uses 2 MiB.
- The limits are route resource policy, not protocol-schema maxima. The messages limit supports one maximum 1 MiB terminal document plus envelope overhead and normal batches, but deliberately rejects aggregate multi-document abuse before parsing.
- Unrelated `readJsonBody` callers remain outside this approved issue slice.
- Declared length is only an early signal; streamed byte count is authoritative.

## Evidence Links

- Pre-fix failure: `tasks/notes/20260901-0058-issue-105-json-body-limits.pre-fix.txt`
- Checks: `.ai/harness/checks/latest.json`
- Focused Cloud verification after rebasing onto current `main`: request boundary, auth parity, device surface, and existing Agent-memory limit suites passed 52/52 tests.
- Root verification after the rebase: `bun run build`, `bun run typecheck`, and `bun run test` passed; root tests executed 3,344 passing tests with environment-gated skips unchanged.
- Workflow verification: `repo-harness run check-task-workflow --strict` and `git diff --check` passed.

## Deviations From Plan Or Spec

- The first isolated-worktree typecheck attempt lacked projected workspace package resolution. Dependency projection was repaired without source changes; focused package and root typechecks then passed.
- The first independent gate found that awaiting request-stream cancellation could indefinitely delay the 413 response and that the pre-fix log retained trailing whitespace. Cancellation is now fire-and-forget with synchronous and asynchronous failure handling, two non-settling regressions cover the liveness invariant, and the artifact passes an explicit base-range whitespace check.
- The candidate was rebased from `2c039165` onto current `main` (`9d2b052`) before the final gate; the atomic nonce-consumption behavior already on `main` remains intact.

## Residual Risks

- Per-request bounds do not replace deployment-level concurrency/rate controls.
- Reference server and unrelated Cloud JSON routes remain separate review surfaces.
