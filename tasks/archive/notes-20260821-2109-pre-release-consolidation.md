> **Archived**: 2026-08-21 21:09
> **Related Plan**: plans/archive/plan-20260821-2058-pre-release-consolidation.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260821-2109

# Implementation Notes: pre-release-consolidation

> **Status**: Active
> **Plan**: plans/plan-20260821-2058-pre-release-consolidation.md
> **Contract**: tasks/contracts/20260821-2058-pre-release-consolidation.contract.md
> **Review**: tasks/reviews/20260821-2058-pre-release-consolidation.review.md
> **Last Updated**: 2026-08-21 21:00
> **Lifecycle**: notes

## Design Decisions

- Treat `codex/hosted-live-activity-pilot-plan` as absorbed only after both commits are
  patch-equivalent and its sole document blob matches current main.
- Preserve the main worktree's current root policy/card state on
  `codex/root-policy-current`; it supersedes the stale timestamp projection in
  `codex/root-architecture-wip` while sharing the same architecture event key.
- Merge hosted authority as a reviewed coherent unit, but resolve every conflict with
  current U1-U5 product semantics as the newer authority.
- Split source consolidation from immutable registry publication. This contract stops
  at merged release readiness; a separate release contract binds the clean main SHA.

## Deviations From Plan Or Spec

- The Live Activity branch was patch-equivalent and its document blob already
  matched main. Because the user explicitly requested that every named branch be
  merged and then cleaned, it received a history-only merge; the candidate tree
  hash was identical before and after that merge.
- `prepare-handoff` hit the already documented repo-harness consumer-relative
  `scripts/recovery-view-cli.ts` lookup defect. `codex-handoff-resume` refreshed
  the required recovery view directly; no helper was copied into this repo.
- The root architecture request was archived as `no-change`: circuit-breaker
  limits affect repo workflow policy, not product modules, entrypoints,
  dependencies, runtime paths, or verification command ownership.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Synthetic merge of patch-equivalent Live Activity branch | Reject | Adds ancestry noise without changing content.
| Discard dirty root policy projection | Reject | It is newer user WIP and directly explains the pending architecture request.
| Publish before cleanup | Reject | Release proof must bind clean main, not a candidate or dirty worktree.

## Open Questions

- npm default auth currently returns 401. Source consolidation can continue; release
  execution must locate an existing authorized userconfig or stop before publish.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Prior hosted-authority external-pass evidence is preserved under
  `tasks/archive/`; the final merged subject still requires a new receipt.
- Focused release graph and stale-keys negative control pass on Bun 1.4.0.
- After workspace build, hosted constraints/migration/runtime tests pass. The first
  pre-build invocation failed only because package `dist/` entries did not exist;
  no source change was needed.
- Real disposable Postgres+MinIO U1 cancellation, U3 readiness, U5 erasure and
  migration suites pass; the opt-in workerd/role-backed schema suite passes 5/5.
- Architecture queue is empty after archiving the workflow-only root policy event,
  and strict task workflow passes after refreshing the resume projection directly.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
