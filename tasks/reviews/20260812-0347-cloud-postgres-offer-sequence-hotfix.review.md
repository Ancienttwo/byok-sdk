# Task Review: cloud-postgres-offer-sequence-hotfix

> **Status**: Passed
> **Plan**: plans/plan-20260812-0347-cloud-postgres-offer-sequence-hotfix.md
> **Contract**: tasks/contracts/20260812-0347-cloud-postgres-offer-sequence-hotfix.contract.md
> **Notes File**: tasks/notes/20260812-0347-cloud-postgres-offer-sequence-hotfix.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-12 11:41
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pass
- Change type: code-change / bugfix
- Intended files changed: contract Allowed Paths only
- Actual files changed: 37 staged files; all within Allowed Paths
- Commands passed: real dataplane 204/204; workspace typecheck/test/build;
  strict workflow check; staged diff check
- Residual risks: public breaking API cut requires a non-patch release; a slow
  materializer intentionally holds one per-device serializer/row lock
- Reviewer action required: none for source acceptance
- Rollback: revert the work-package commit; no schema/data rollback

## Mode Evidence

- Selected route: main-thread implementation plus security, architecture, and
  adversarial read-only review
- P1/P2/P3 evidence: plan and P0 research report
- Root cause or plan evidence: pre-fix non-zero regression artifact and real
  Postgres dual-allocation trace

## Verification Evidence

- Waza `/check` run: Deep; final security/architecture/adversarial verdicts PASS
  on pinned base `bf8d71141c03ead2e0497db9e4eba145bebc4062`
- Commands run: `BYOK_TEST_POSTGRES_URL=... BYOK_TEST_S3_ENDPOINT=... pnpm
  --filter @byok-sdk/cloud-postgres test`; `pnpm -r run typecheck`; `pnpm -r
  run test`; `pnpm -r run build`; `repo-harness run check-task-workflow
  --strict`; `git diff --cached --check`
- Manual checks: one runtime allocator source; no remaining product references
  to `DeviceSequenceStore`/`stores.sequence`
- Supporting artifacts: P0 report and pre-fix evidence
- Implementation notes reviewed: yes
- Run snapshot: pending subject-bound harness evidence after commit

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract `manual_checks` requirements.

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending
> **Verification Evidence SHA256**: pending
> **Issued At**: pending

- Summary: No AcceptanceReceipt has been recorded.
- Findings: none

## Behavior Diff Notes

- Mailbox append changes from caller-supplied bytes to mailbox-owned
  `materialize(seq)`; sequence allocation and body insertion become one
  serialized authority.
- Dead-letter replay rebinds the envelope, hash, and byte size to the newly
  allocated row sequence.

## Residual Risks / Follow-ups

- The API cut removes `DeviceSequenceStore`, so the release must not remain on
  the published `0.2.x` contract line.
- Per-device materialization holds the intended lock while encoding/hashing;
  cross-device traffic remains independent.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Real Postgres offer/replay and concurrency guards pass. |
| Product depth | 9/10 | Fixes normal delivery and dead-letter sibling path. |
| Design quality | 9/10 | One authority; protocol-free core; explicit lock tradeoff. |
| Code quality | 9/10 | Shared allocator, typed failures, conformance coverage. |

## Failing Items

- None.

## Retest Steps

- Re-run: contract `commands_succeed` and real dataplane suite.
- Re-check: release semver and package graph in a separate release contract.

## Summary

- PASS. The P0 root cause is removed; both review-discovered races are guarded.
  Source is ready to commit and bind to canonical acceptance evidence.
