# Implementation Notes: pr187-review-closeout

> **Status**: Active
> **Plan**: plans/plan-20260917-0218-pr187-review-closeout.md
> **Contract**: tasks/contracts/20260917-0218-pr187-review-closeout.contract.md
> **Review**: tasks/reviews/20260917-0218-pr187-review-closeout.review.md
> **Last Updated**: 2026-09-17 02:18
> **Lifecycle**: notes

## Design Decisions

- ...

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.

## Scope and design freeze

- Starting PR187 source: e81e2b336cfaf55bfb2cd7d20f8c0a3648b9c2e7. Merged current main b323cb058fb54b5a8b4adc8e0a2ad4152fe84d3c into this branch at 54eca099f4413bba9bbdf8cf050e4525df4e3d74 before final evidence. PR187 base retargeted to main; old base remote retained until all dependents are checked.
- Existing configured authority gains a mandatory independent resolveSource decision, receiving trusted grant and cloned source/snapshot. A typed successful source pair must exactly equal the claimed pair; SDK does not re-derive Host semantics. Invalid/missing authority is a refusal before reservation, compilation and counting. Caller/resolver mutation cannot rewrite the frozen request.
- Counter waiting is bounded by SDK cancellation/deadline independently of adapter cooperation. The reserved call remains charged; an unknown outcome is durable counter_interrupted, never automatic retry. Late settlement cannot overwrite this outcome.
- Retention runs after startup replay/reconciliation and through a single lifecycle-owned expiry timer. GC errors are latched, visible to requests and stop; pinned artifacts remain retained. Contrary to an initial truncated-output reading, store.gc already unlinks artifact files when tombstones expire; no duplicate fix is needed.
- Runtime import failure maps to runtime_identity_unavailable. Once reserved, the same request ID remains spent, consistent with the existing idempotency contract; this repair does not silently recreate it after installation repair.
- main checkout's three untracked files, all other candidate worktrees, native forks, provider calls and publication remain outside this slice. Browser review is deferred.

## Pre-fix evidence

- `_ops/pr187-closeout/pre-fix.log`: four existing focused files with added regressions on unmodified production source produced 11 failures / 72 passes (`PRE_FIX_EXIT=1`). Failures cover source authority, non-cooperative counter timeout/cancel/stop, runtime classification, idle/startup collection and background collection fault propagation.
- Additional actual daemon restart regression in `input-preparation-control.test.ts` failed before any new preparation RPC: 1 failed / 9 skipped (`STARTUP_PRE_FIX_EXIT=1`). This proves startup integration separately from calling the service's open method directly.
- Source base for the repair is `54eca099f4413bba9bbdf8cf050e4525df4e3d74`, which includes PR187 and current main; workspace package resolutions point inside this worktree and the installed fork is 0.85.1001. Local toolchain observed: Node 24.18.0, Bun 1.4.2. Cross-platform CI remains a separate gate.

## Implementation freeze and focused verification

The four owning focused suites pass: 4 files / 87 tests, `_ops/pr187-closeout/focused.log` (`FOCUSED_EXIT=0`). Client `tsc --noEmit` passes (`_ops/pr187-closeout/typecheck.log`). Tests include timeout/cancel/stop with non-cooperative counter and late settlement, stop/reservation race, wrong/malformed/mutating source authority, runtime failure with spent request ID, idle and daemon-restart retention, pin/in-flight safety, GC fault visibility and stop waiting for in-flight collection. No live counter/provider request was made.

Implementation uses a one-shot timer at the earliest eligible durable expiry; empty/pinned/nonterminal records do not cause a timer or spin, and terminal settlement reschedules. Store GC's existing unlink logic is retained; the lifecycle GC excludes nonterminal records to protect the active writer. Source resolver additions are a required unpublished API contract change; no fallback is installed. Client declarations and their golden are regenerated from the compiler before the final repository verification.

Full repository checks and independent acceptance are still pending at this freeze. Their canonical results are in the harness verification evidence, not inferred from this focused pass.

## Closeout blocked — scope stop

- `verify-sprint --prepare-acceptance` exited 1 before acceptance freeze: architecture projection status human-action-required, reason verified-flow-proof-changed, signal sha256:2416b4c5ebe07f0dba1069d46388407fa14dbbe27c1bd07cb1a8a21d7aa3d155. `architecture-projection reconcile` failed with "architecture reconciliation requires ready CodeGraph proof". This worktree has no .codegraph directory; no index was created and no approval was fabricated. Logs: `_ops/pr187-closeout/prepare-acceptance.log`, `architecture-reconcile.json`.
- Independent canonical `verification-plan execute` completed the four focused guards, repository build (4876ms) and repository typecheck (4601ms). The outer repo-harness helper supervisor then killed the still-running complete test command at 120000ms. Log: `_ops/pr187-closeout/verification.log`. This is incomplete full-suite evidence, not a product-test PASS or a proved product failure. No retry or timeout policy change was made.
- The user's second-out-of-scope-discovery hard stop applies. Product source is frozen and uncommitted; no repair push, PR merge, review-thread resolution, further branch deletion or browser submission occurred. Required next operator decision is a bounded tooling slice to produce current-worktree CodeGraph proof and run the existing canonical verification without the outer 120-second truncation; then resume acceptance and shipment.

## Approved tooling unblock — 2026-09-17

Owner approved completing PR187 acceptance and the remaining C07 PR dependency train. This slice stays in the PR187 worktree. Initialized current-worktree CodeGraph: 919 files, 17914 nodes, 73493 edges. Ready proof requires refreshing the two generated architecture projection paths, now explicitly allowed. The installed helper runner gives ordinary helpers 120000ms, but verify-sprint/verify-contract have 3660000ms; use the canonical verify-sprint entrypoint without changing global tooling or relaxing test assertions. Existing successful evidence is reusable only where canonical fingerprints match.
