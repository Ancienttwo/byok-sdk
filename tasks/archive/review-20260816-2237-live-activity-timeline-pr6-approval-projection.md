> **Archived**: 2026-08-16 22:37
> **Related Plan**: plans/archive/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260816-2237

# Task Review: live-activity-timeline-pr6-approval-projection

> **Status**: Passed
> **Plan**: plans/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md
> **Contract**: tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md
> **Notes File**: tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-16 22:26
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:3f8ed5a07f5d7d5d0a76cd7b64a34fb46c945e2bfe69b51980108dfc0f98d67b
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: afd997c689e5a5014788396dc0c4f01a5a755298

## Human Review Card

- Verdict: pass
- Change type: code-change, frontend read-model, host reference integration
- Intended files changed: UI-runtime approval fold/types/tests, live-activity host read/redaction/presentation/tests, README, product spec, workflow evidence
- Actual files changed: matched the contract allowed paths; protocol and cloud persistence were unchanged
- Commands passed: contract 15/15, targeted UI/host tests, workspace build/typecheck/test, strict workflow
- Residual risks: the private host example makes its option contract intentionally required/coordinated; hosts must bump `representationRevision` when redaction policy changes
- Reviewer action required: none
- Rollback: revert the UI-runtime/host projection commits; PR5 persistence remains independently usable

## Mode Evidence

- Selected route: Codex deep acceptance review on the frozen normalized subject
- P1/P2/P3 evidence: traced `ApprovalTimelineTail` through validation, pure fold, host authorization, redaction, ETag, and presentation; confirmed no shared activity order or tool identity
- Root cause or plan evidence: approved PR6 plan and proposal decision table

## Verification Evidence

- Waza `/check` run: selected new-abstraction paths reviewed; no unresolved finding
- Commands run: `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md`
- Manual checks: no `toolCallId` in approval projection; `needs_approval` activity behavior unchanged; host remains GET-only; redaction preserves all approval authority fields
- Supporting artifacts: `.ai/harness/checks/latest.json`, `.ai/harness/checks/change-assessment.latest.json`, and `.ai/harness/runs/`
- Implementation notes reviewed: `tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md`
- Run snapshot: `run-20260816T222557-86733`, contract 15/15

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract-specific manual check requirement was declared.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:3f8ed5a07f5d7d5d0a76cd7b64a34fb46c945e2bfe69b51980108dfc0f98d67b
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: afd997c689e5a5014788396dc0c4f01a5a755298
> **Verification Evidence SHA256**: sha256:dd8d16d3d2d52556f281e997ab7d6ac96715fb3c24999759eb0fafff7cd6fd3f
> **Issued At**: 2026-08-16T14:27:15.279Z

- Summary: Approval projection passed: native-ID-only correlation, explicit unpaired states, deterministic replay/incremental behavior, conflict and cursor rollback failures, authority-preserving host redaction, separate snapshots, and no mutation or cross-stream ordering. Review found and fixed bounded-tail eviction retention before acceptance.
- Findings: none

## Behavior Diff Notes

- Added a separate approval projection with native-ID-only pairing and explicit unpaired states.
- Host presentation now receives separate activity/approval snapshots after one authorization binding and per-stream redaction.
- Review found that incremental tail application retained entries evicted by a newer bounded tail; `c2b1480` now replaces the tail window, validates overlap, and rejects cursor rollback.

## Residual Risks / Follow-ups

- No open correctness or security finding. The host reference is private composition code; its required option change is intentionally coordinated rather than shimmed.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Covers correlation, unpaired states, conflicts, tail replacement, ETag, auth, binding, and redaction. |
| Product depth | 10/10 | Completes the read-only approval projection without expanding into mutation or transcript semantics. |
| Design quality | 9/10 | Separate folds preserve independent authorities and avoid synthetic total order. |
| Code quality | 9/10 | Pure immutable API, typed failures, focused invariants, and no new dependency. |

## Failing Items

- None.

## Retest Steps

- Re-run: strict contract verification and targeted UI-runtime/host tests.
- Re-check: resolution-before-request convergence, bounded-tail eviction, approval redaction authority, and GET-only route.

## Summary

- PASS. The frozen normalized subject satisfies the PR6 approval projection contract.
