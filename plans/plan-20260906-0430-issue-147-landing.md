# Plan: issue147 local main landing

> **Status**: Completed
> **Artifact Level**: work-package
> **Promotion Reason**: Exact-subject local landing across an accepted main successor
> **Verification Boundary**: Required source checks and typed Claude receipt for the main target
> **Rollback Surface**: Preserve original e542d210 target and revert only this landing change
> **Task Contract**: tasks/contracts/20260906-0430-issue-147-landing.contract.md
> **Task Review**: tasks/reviews/20260906-0430-issue-147-landing.review.md
> **Implementation Notes**: tasks/notes/20260906-0430-issue-147-landing.notes.md

## Authority and scope
User approved actual release-train target alignment and local landing. Frozen local main base e542d210719a43fe1111b793bba1a76d37076cbf contains PR149, PR150 and independently accepted relay integration. Integrate exact #147 candidate90c110630a5fbe98df88ad91e3f2fa9b50144fa4. Preserve primary dirty packages/AGENTS.md and CLAUDE.md byte-for-byte. No push, registry, tag, release, deploy or downstream exact-pin.

## P1 Architecture Map
Protocol offer registry -> daemon journal projection -> SQLite task/terminal/recovery. Main successor adds UI spill projection and team_notifications.snapshot; only create-daemon.ts overlaps, at unrelated import/control dispatch hunks. Primary ownership stays untouched.

## P2 Concrete Trace
Offer classification/append precedes runner and cursor; terminal sanitizer/spill precedes journaling; restart marks interrupted. The new relay control route calls team workspace notificationSnapshot and does not alter this path. Revalidate combined source before landing.

## P3 Design Decision
Merge exact commits in an isolated landing worktree. Remove integration-only pinned policy and restore normal review_base main; bind receipt to observed main e542d210. If target advances, stop before publication rather than force it. Save dirty target diff and use only fast-forward local landing when changed paths are disjoint, with byte-for-byte readback. No new code abstraction/dependency.

## Task Breakdown
- [ ] L1 Freeze actual target, preserve dirty WIP evidence, merge accepted candidate and restore policy.
- [ ] L2 Run required source gates and one Claude acceptance review for this changed target.
- [ ] L3 Verify exact receipt, land locally with compare-and-readback safety, publish one handoff.

## Stop boundaries
No unrelated fixes, no external release actions. Keep inherited P2 observer and coverage advisories report-only. Stop if same-target evidence cannot be obtained, main moves, or WIP overlaps the landing diff. No user waiver inferred.

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260906-0430-issue-147-landing.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260906-0430-issue-147-landing.md`; after execution revert branch `codex/issue-147-task-offer-journal` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260906-0430-issue-147-landing.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260906-0430-issue-147-landing.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Cross-package protocol classification and durable recovery invariant; independently reviewable bugfix

## Evidence Contract

- **State/progress path**: `plans/plan-20260906-0430-issue-147-landing.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260906-0430-issue-147-landing.contract.md`, `tasks/reviews/20260906-0430-issue-147-landing.review.md`, and `tasks/notes/20260906-0430-issue-147-landing.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260906-0430-issue-147-landing.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260906-0430-issue-147-landing.md`; after execution revert branch `codex/issue-147-task-offer-journal` or the explicitly reviewed diff.


## Target ownership readback

Primary checkout moved to a separate audit-spill-size branch while main itself remains e542d210. If no worktree owns main at final readback, local landing uses git update-ref refs/heads/main <accepted-head> e542d210... (compare-and-swap) instead of checking out or editing primary. Otherwise require disjoint dirty-state equality and a normal fast-forward. Neither route force-overwrites an advanced main.

## Verified closeout — 2026-09-06

Lifecycle reconciled from exact SDK/consumer CI and live PR/Issue readback in `tasks/notes/20260906-pr152-closeout.md`. Historical checkboxes and acceptance text remain frozen; this completion record supersedes earlier pending-state statements. This closes the source/candidate delivery boundary only; registry publication and production rollout remain separate.
