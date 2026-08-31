# Implementation Notes: issue-batch-integration

> **Status**: Active
> **Plan**: plans/plan-20260901-0457-issue-batch-integration.md
> **Contract**: tasks/contracts/20260901-0457-issue-batch-integration.contract.md
> **Review**: tasks/reviews/20260901-0457-issue-batch-integration.review.md
> **Last Updated**: 2026-09-01 05:00
> **Lifecycle**: notes

## Design Decisions

- Keep the primary dirty worktree untouched; the integration worktree is based on the fetched `origin/main` authority.
- Preserve accepted ancestry with merge commits. Merge #109 as the carrier for #108, because #108 is already its ancestor.
- Resolve the #106/#107 shared files by retaining both the per-Agent opening promise and the controller-wide tenant mutation tail. Neither accepted branch is a fallback for the other.
- Push only after a fresh fetch proves the frozen remote target is still an ancestor of the verified integration head.

## Deviations From Plan Or Spec

- The first combined client run exposed a real ordering conflict between #106 and #107: placing the start of `spoolFor()` inside the controller-wide append tail prevented concurrent callers from sharing the same first-open promise and delayed a different-home rejection behind the blocked append. The final composition starts or joins the home-bound per-Agent open before queueing, but awaits and binds that spool inside the tenant-wide critical section before observing aggregate bytes and appending. This keeps same-Agent open sharing and immediate home mismatch rejection without hiding preloaded durable records from tenant quota authority.
- The first focused invocation ran before workspace package build artifacts existed, so Vitest could not resolve `@byok-sdk/core` / `@byok-sdk/protocol`. `bun run build` materialized the authoritative package exports, after which the identical focused commands entered the tests and passed.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Sequential dependency-aware merge commits | selected | Preserves accepted ancestry and makes the shared-file resolution explicit. |
| Squash all accepted branches | rejected | Loses ancestry and makes later cleanup/review unable to prove which accepted histories landed. |
| Merge into dirty primary `main` | rejected | Risks contaminating accepted authority with unrelated WIP. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Accepted per-issue receipts: each issue review projection plus its worktree `.ai/harness/checks/latest.json`; live verification is repeated against the combined subject.
- Frozen target: `9d2b05253570c13f235ef4f9aa2a1e94e431c576`.
- Accepted heads proven as ancestors: `224aa942`, `ee155265`, `19d8e7a0`, `42a8b92f`, `4b4c8db1`, `7da14ec4`, and `c575126c`.
- Focused Cloud guard: 1 file, 14 tests passed.
- Focused Client guards after the integration guard was added: 5 files, 118 tests passed, 1 skipped.
- Root verification after code freeze: `bun run build`, `bun run typecheck`, and `bun run test` passed; the final suite totals 3,372 passed and 109 skipped across package reports.
- One intermediate root suite run timed out the unrelated Wrangler packaging dry-run while typecheck ran concurrently. The exact file then passed 6/6 without parallel load, and the subsequent sequential root suite passed without source changes.
- Workflow/diff verification: `repo-harness run check-task-workflow --strict` and `git diff --check` passed.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
