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

- None recorded.

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

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
