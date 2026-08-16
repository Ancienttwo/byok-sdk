> **Archived**: 2026-08-16 20:42
> **Related Plan**: plans/archive/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260816-2042

# Task Review: live-activity-timeline-pr2-typed-activity-projection

> **Status**: Complete
> **Plan**: plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md
> **Contract**: tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md
> **Notes File**: tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-16 19:58
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:e0b2b917c41eab14f6efd5a0ddcb05590d7240dc6122ae8ef43c953a93d37f09
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: c4f52a72747eba342ea3a5e141d1869b943a8324

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: typed activity DTO/store, cloud projections, conformance, and cutover documentation within contract Allowed Paths
- Actual files changed: 41 normalized implementation paths reviewed against `main`
- Commands passed: all 18 contract checks, including build/typecheck/full tests with real Postgres/MinIO and strict workflow validation
- Residual risks: coordinated deployment must observe the documented one-TTL drain window; no legacy row translation exists by design
- Reviewer action required: none
- Rollback: stop typed writers/readers, wait one maximum TTL, then revert the merged work package

## Mode Evidence

- Selected route: Deep Waza `$check` plus contract-bound Codex acceptance
- P1/P2/P3 evidence: captured in the plan and implementation notes
- Root cause or plan evidence: `plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md`

## Verification Evidence

- Waza `/check` run: passed after four blocking findings were fixed
- Commands run: contract `tests_pass` and `commands_succeed` entries, 18/18 pass
- Manual checks: no non-built-in manual checks declared
- Supporting artifacts: `.ai/harness/checks/latest.json`
- Implementation notes reviewed: yes
- Run snapshot: `.ai/harness/runs/run-20260816T203142-15940-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.json`

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` requirements were declared.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:e0b2b917c41eab14f6efd5a0ddcb05590d7240dc6122ae8ef43c953a93d37f09
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: c4f52a72747eba342ea3a5e141d1869b943a8324
> **Verification Evidence SHA256**: sha256:1f53dd16fe8c56a3b91cde130a11f0466ac93877b3e0d948a6c80ca0c2a87716
> **Issued At**: 2026-08-16T12:33:00.197Z

- Summary: Deep review passed after moving Postgres activity ownership to cloud-dataplane, enforcing fail-closed order collisions and legacy JSONB rejection, bounding direct identity input, and covering the typed projection with shared in-memory/Postgres conformance plus real Postgres concurrency readback.
- Findings: none

## Behavior Diff Notes

- Activity tails now retain native envelope identity, batch/event order, typed events, cursor, loss and TTL metadata; legacy detail strings fail closed.

## Residual Risks / Follow-ups

- Deployments must follow `deploy/runbooks/activity-tail-cutover.md`; mixed legacy and typed rows are intentionally unsupported.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Contract and conformance behavior passed |
| Product depth | 9/10 | Establishes the bounded typed authority required by UI runtime |
| Design quality | 9/10 | Keeps core protocol-free and one store authority |
| Code quality | 9/10 | Shared conformance and fail-closed validation cover both stores |

## Failing Items

- None.

## Retest Steps

- Re-run: contract `tests_pass` plus required workspace commands.
- Re-check: real Postgres concurrency and legacy-row rejection.

## Summary

- Pass. Exact-target verification, deep review, GitHub CI, and merge all completed.
