> **Archived**: 2026-09-04 13:21
> **Related Plan**: plans/archive/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260904-1321
> **Archive Projection V1**: `plans/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md` => `plans/archive/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md`
> **Archive Projection V1**: `tasks/notes/20260904-0421-wp3b-step4-longpoll-cursor-stop.notes.md` => `tasks/archive/notes-20260904-1321-wp3b-step4-longpoll-cursor-stop.md`
> **Archive Projection V1**: `tasks/contracts/20260904-0421-wp3b-step4-longpoll-cursor-stop.contract.md` => `tasks/archive/contract-20260904-1321-wp3b-step4-longpoll-cursor-stop.md`
> **Archive Projection V1**: `tasks/reviews/20260904-0421-wp3b-step4-longpoll-cursor-stop.review.md` => `tasks/archive/review-20260904-1321-wp3b-step4-longpoll-cursor-stop.md`

# Task Review: wp3b-step4-longpoll-cursor-stop

> **Status**: Accepted
> **Plan**: plans/archive/plan-20260904-0421-wp3b-step4-longpoll-cursor-stop.md
> **Contract**: tasks/archive/contract-20260904-1321-wp3b-step4-longpoll-cursor-stop.md
> **Notes File**: tasks/archive/notes-20260904-1321-wp3b-step4-longpoll-cursor-stop.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-04 04:36
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:5dbb9838e3b0b41fa4a1bd3a80fe4295d5a95bf767ea984e6268bdd6e88155c5
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 4894bc7c7b8a816e959fba840c6c2a3028828116

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

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:5dbb9838e3b0b41fa4a1bd3a80fe4295d5a95bf767ea984e6268bdd6e88155c5
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 4894bc7c7b8a816e959fba840c6c2a3028828116
> **Verification Evidence SHA256**: sha256:a0220301831c269ff7816277ad875bb481d9c7660dc97060d0a1dbc49c3fa84b
> **Issued At**: 2026-09-04T05:21:18.021Z

- Summary: WP3B Step 4a accepted after rebasing onto the integrated Step 3 main; durable long-poll acknowledgement, bounded dedup, and cancellable stop passed exact-subject gates.
- Findings: none

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
