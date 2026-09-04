# Plan: WP3B CI smoke long-poll status closeout

> **Status**: Executing
> **Created**: 20260904-1428
> **Slug**: wp3b-ci-smoke-longpoll-status
> **Artifact Level**: work-package
> **Promotion Reason**: PR #133 exact-head CI proved the built adapter smoke still waited for the deleted `degraded` WebSocket fallback state; the same script is the credential-isolation audit workload.
> **Verification Boundary**: focused built adapter smoke, credential-audit unit coverage, client/full required gates, exact-subject review, then GitHub CI.
> **Rollback Surface**: one CI-oracle script/comment correction on the existing WP3B PR branch.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260904-1428-wp3b-ci-smoke-longpoll-status.contract.md`
> **Task Review**: `tasks/reviews/20260904-1428-wp3b-ci-smoke-longpoll-status.review.md`
> **Implementation Notes**: `tasks/notes/20260904-1428-wp3b-ci-smoke-longpoll-status.notes.md`

## P1 Architecture Map

- `packages/client/scripts/adapter-task-smoke.mjs` is the built-artifact runtime oracle used directly by the adapter lifecycle CI job and indirectly by the Linux credential-isolation audit.
- `DaemonStatus.connected` is the current long-poll connection fact; the removed `degraded` field and WS tuning keys have no product owner after Step 4b.
- Production transport behavior is already accepted; this slice repairs the CI consumer of that public status contract.

## P2 Concrete Trace

CI builds packages, starts the real embedded server, constructs a daemon, pairs, and awaits `daemon.start()`. The daemon reaches long-poll `open`, but the script then waits on missing `daemon.status().degraded` until its 20-second deadline. Both failing jobs share this script, so one stale predicate explains both failures before any adapter task runs.

## P3 Decision

- Wait for `daemon.status().connected`, remove WS-only long-poll override keys, and update the stale test comments.
- Do not add a `degraded` alias or compatibility status; that would reintroduce the authority Step 4b deleted.
- The first 10x pressure point remains runtime duration across the three adapters; this correction adds no polling or process work.

## Evidence Contract

- State/progress path: implementation notes and this Task Breakdown.
- Verification evidence: local built adapter smoke, exact contract/Sprint evidence, and GitHub PR #133 exact-head checks.
- Evaluator rubric: smoke reaches real long-poll connection and all adapter lifecycles; no stale WS fallback/status claim remains in the touched current tests/scripts.
- Stop condition: any required product transport compatibility path or server behavior change.
- Rollback surface: revert this follow-up commit without altering the accepted WP3B runtime cutover.

## Promotion Gate

- Merge/PR unit: append this CI-oracle correction to existing PR #133.
- Rollback surface: one script/comment follow-up commit.
- Verification boundary: focused smoke, client/root required gates, and GitHub exact-head CI.
- Review/acceptance boundary: normalized final subject including this script correction.
- High-risk surface: the credential audit reuses the smoke and must still execute its real workload.
- Why not checklist row: two required CI jobs are red and block the already-authorized merge.

## Task Breakdown

- [x] T1 Replace stale WS/degraded smoke configuration and predicate with the long-poll-only status contract.
- [ ] T2 Run focused smoke and required local gates; record exact-subject acceptance.
- [ ] T3 Push PR #133 head, require exact-head CI green, and merge.
