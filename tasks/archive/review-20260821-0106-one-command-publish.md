> **Archived**: 2026-08-21 01:06
> **Related Plan**: plans/archive/plan-20260820-2324-one-command-publish.md
> **Outcome**: Superseded
> **Lifecycle**: review
> **Parent Run ID**: run-20260821-0106

# Task Review: one-command-publish

> **Status**: Pending
> **Plan**: plans/plan-20260820-2324-one-command-publish.md
> **Contract**: tasks/contracts/20260820-2324-one-command-publish.contract.md
> **Notes File**: tasks/notes/20260820-2324-one-command-publish.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-21
> **Recommendation**: not_applicable
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Closeout Disposition

- Disposition: Superseded artifact, not a new product acceptance.
- Change type: ledger-closeout.
- Historical implementation: `be5b16f87808add4b71e7b25ac51e858c741d658` adds `scripts/release/publish.mjs`; local `v0.5.0` contains it.
- Public readback: GitHub release `v0.5.0` is published, non-draft and non-prerelease; npm exposes `@byok-sdk/core@0.5.0` and `@byok-sdk/client@0.5.0` with public tarball/integrity metadata.
- Downstream source readback: Salesko `main@18771502724ca9383d55c097723e112979102bac` pins the published 0.5.0 train and contains hosted assertion first-use/replay/revocation cases; this is not executed acceptance evidence.

## Verification Evidence

- This closeout runs the contract's two ancestry checks plus `git diff --check`, `repo-harness run check-task-workflow --strict`, and `repo-harness state resolve --json`.
- No `scripts/release/publish.mjs --execute`, product test rerun, Waza `/check`, or typed AcceptanceReceipt is asserted.

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

- Summary: the original captured contract's test and command requirements were not truthful, so no receipt is manufactured after publication.
- Findings: no acceptance authority is asserted.

## Residual Risks / Follow-ups

- The historical release's pre-publication command matrix is not reconstructed in this closeout.
- Salesko `main@1877150` now has a fresh subject-bound `bun run check` exit 0: 1,643/1,643 tests, all typechecks/builds, byok-control 17/17, and local-agent 23/23. An older retained run had a non-reproduced loader-time missing-export failure; the current public core runtime/type exports and fresh full run contain the export, so no source-code root cause is invented. Production deployment and migration remain explicitly unverified.

## Summary

- Archive the workflow as **Superseded** after ledger verification. That preserves the release evidence while removing the stale active-plan claim.
