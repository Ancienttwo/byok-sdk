# Task Review: local-agent-version-tolerance

> **Status**: Review
> **Plan**: plans/plan-20260821-2336-local-agent-version-tolerance.md
> **Contract**: tasks/contracts/20260821-2336-local-agent-version-tolerance.contract.md
> **Notes File**: tasks/notes/20260821-2336-local-agent-version-tolerance.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-23 19:04
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pass for the rebased current-main implementation diff; explicit
  user authorization covers integration and the subsequent 0.6.1 release.
- Change type: code-change
- Intended files changed: self-hosted MachineInfo projection, WS/hub forwarding, fixtures, integration tests, spec, and workflow evidence.
- Actual files changed: matches the contract allowlist.
- Commands passed: server integration 18/18; server typecheck/build; full workspace build; root typecheck; full test suite including client 1375/1375; architecture/task/workflow gates; strict contract 12/12.
- Residual risks: the branch is local and unmerged; published `v0.6.0` does not contain this self-hosted readback closure.
- Reviewer action required: record and verify the typed user-waiver AcceptanceReceipt before merge.
- Rollback: revert the additive field, forwarding, tests, and spec text together.

## Mode Evidence

- Selected route: user-approved public read-model closure.
- P1/P2/P3 evidence: captured plan traces release identity through WS registration into `machines.list()` and preserves protocol/capability authority.
- Root cause or plan evidence: `docs/researches/2026-08-21_local-agent-version-tolerance-handoff.md` plus the red focused integration result.

## Verification Evidence

- Waza `/check` run: not invoked; no explicit Claude review request was made.
- Commands run: see Human Review Card and implementation notes.
- Manual checks: diff contains no Latest lookup, SemVer comparison, protocol change, fallback, or inferred identity.
- Supporting artifacts: `.ai/harness/runs/run-20260823T190319-38409-20260821-2336-local-agent-version-tolerance.json`.
- Implementation notes reviewed: yes.
- Run snapshot: strict read-only contract verification 12/12 pass.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract `manual_checks` requirements are declared.

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

- Older Local Agent releases remain eligible based only on protocol and action
  capabilities; the self-hosted machine read model now exposes the exact
  reported release for operator observation.

## Residual Risks / Follow-ups

- Branch integration and registry publication remain separate gates after the
  subject-bound AcceptanceReceipt.
- The published 0.6.0 artifacts predate this local additive server readback.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Older-release work path and readback are covered end to end. |
| Product depth | 9/10 | Explicit legacy-unknown and protocol separation are covered. |
| Design quality | 9/10 | One bounded projection; no new authority or behavior gate. |
| Code quality | 9/10 | Small typed diff with focused integration and repository gates. |

## Failing Items

- No implementation finding.
- Closeout-only: record the typed AcceptanceReceipt and integrate upstream.

## Retest Steps

- Re-run: `bun run --cwd packages/server test -- src/__tests__/integration.test.ts`.
- Re-check: strict contract report, diff allowlist, and branch ancestry before merge.

## Summary

- The rebased implementation is complete and verified. It is ready for the
  authorized typed user-waiver receipt and upstream integration; no merge or
  release claim is made by this review alone.
