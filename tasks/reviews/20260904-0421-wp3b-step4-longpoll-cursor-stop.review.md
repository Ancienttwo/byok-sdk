# Task Review: wp3b-step4-longpoll-cursor-stop

> **Status**: Ready for gate
> **Plan**: plans/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md
> **Contract**: tasks/contracts/20260904-0421-wp3b-step4-longpoll-cursor-stop.contract.md
> **Notes File**: tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-04 04:36
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending exact commit
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: `10bb9fc76b0a1ee3a533f50a42e869235c5c7bd1`

## Human Review Card

- Verdict: ready for exact-subject gate.
- Change type: bugfix.
- Intended files changed: two client daemon internals, four named client regression files, and workflow artifacts only.
- Actual files changed: matches intended scope; no protocol, cloud, server, public API, deployment, or release diff.
- Commands passed: focused 13 tests, full client suite, root build/typecheck/test, API surface, version authority, workflow, diff check, contract 27/27.
- Residual risks: the wire remains one cursor by design; repeated reads while processing rely on bounded retry plus local in-flight/processed seq suppression.
- Reviewer action required: inspect the exact committed diff and rerun the focused guards plus workflow gate.
- Rollback: revert the one Step 4a dependent commit.

## Mode Evidence

- Selected route: bugfix with regression-first evidence and read-only archaeology.
- P1/P2/P3 evidence: recorded in the plan and implementation notes.
- Root cause evidence: `tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.pre-fix.txt`.

## Verification Evidence

- Commands run: all contract exit criteria passed; `verify-contract` reported 27 total, 0 failed.
- Manual checks: all five former `it.skip` calls are active; in-flight offer response count proves non-vacuity; intentional stop abort emits no route-failure warning.
- Supporting artifacts: pre-fix failure capture and implementation notes.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/runs/` and `.ai/harness/checks/latest.json`.

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: `10bb9fc76b0a1ee3a533f50a42e869235c5c7bd1`
> **Verification Evidence SHA256**: pending
> **Issued At**: pending

- Summary: no exact-subject AcceptanceReceipt has been recorded yet.
- Findings: none before the final gate.

## Behavior Diff Notes

- Long-poll query/ack uses the successfully processed cursor; eager delivery watermark is local dedup state only.
- Duplicate-only reads without cursor progress back off instead of spinning.
- Stop and revocation abort the active GET and loop delays without touching outbound POST drain semantics.

## Residual Risks / Follow-ups

- Remaining WP3B Step 4 work is WS transport deletion and `ConnectionState` narrowing; intentionally excluded from this approved slice.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Real-kernel failure/restart paths and held-GET stop pass. |
| Product depth | 9/10 | Preserves the one-field protocol and kernel authority. |
| Design quality | 9/10 | Separates ack from local dedup without a compatibility path. |
| Code quality | 9/10 | Loop generation cancellation and non-vacuous tests are explicit. |

## Failing Items

- None before exact-subject gate.

## Retest Steps

- Re-run the contract verifier, focused client guards, and workflow strict check against the committed subject.

## Summary

- Ready for exact-subject gate; not pushed, proposed, or merged.
