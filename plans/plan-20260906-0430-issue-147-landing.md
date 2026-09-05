# Plan: issue147 local main landing

> **Status**: Executing
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
