# Task Review: long-poll-capability-negotiation

> **Status**: Pass
> **Plan**: plans/plan-20260815-1532-long-poll-capability-negotiation.md
> **Contract**: tasks/contracts/20260815-1532-long-poll-capability-negotiation.contract.md
> **Notes File**: tasks/notes/20260815-1532-long-poll-capability-negotiation.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-15 15:47
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:5495f5f1e99d374196a54969b3bbe49b1a1291d687618750691c770283969755
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 27de48a2e30ce24461827f9c05fe2fd081260544

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: protocol response schema/golden, client transport and capability state, cloud/server responders, focused tests, protocol docs.
- Actual files changed: matches intended scope; workflow artifacts are the only additional files.
- Commands passed: `bun run build`; `bun run typecheck`; `bun run test`; `repo-harness run check-task-workflow --strict`.
- Residual risks: release/version bump and downstream smoke are outside this work-package.
- Reviewer action required: none before commit; release selection remains a maintainer decision.
- Rollback: revert the optional response field, responder advertisements, and client ingestion as one additive-minor unit.

## Mode Evidence

- Selected route: Waza `/check`, deep main-thread fallback (subagents disabled by task policy).
- P1/P2/P3 evidence: protocol schema -> cloud/server responder -> long-poll parser -> ConnectionManager -> TaskRunner gate traced end to end.
- Root cause or plan evidence: contract Root Cause Evidence and pre-fix artifact.

## Verification Evidence

- Waza `/check` run: complete; security, architecture, and four-angle adversarial passes performed sequentially.
- Commands run: required workspace checks plus focused protocol/client/cloud/server suites.
- Manual checks: diff scope, N/N-1 behavior, WS-priority race, failed-poll withdrawal, sibling responders.
- Supporting artifacts: `.ai/harness/runs/long-poll-capability-negotiation-pre-fix.log`.
- Implementation notes reviewed: yes.
- Run snapshot: terminal evidence from this session; checks projection pending contract verifier.

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

- Added an optional long-poll server capability advertisement without changing required v1 fields.
- Missing capability fields and failed/malformed polls resolve to `[]`; successful advertisements are visible before event handlers.
- A late poll response cannot overwrite a fresh WS ack.
- Cloud and server both advertise `result-document` through their owned protocol vocabulary.

## Residual Risks / Follow-ups

- Release version selection and salesko repin/smoke remain outside this SDK code work-package.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Red-green guard and complete transport path are covered. |
| Product depth | 10/10 | Restores the accepted pure-cloud topology without a second result authority. |
| Design quality | 9/10 | Additive and fail-closed; unavoidable cross-request rollback window remains documented. |
| Code quality | 9/10 | Small protocol surface, explicit ownership, no new dependency or compatibility shim. |

## Failing Items

- None.

## Retest Steps

- Re-run: required workspace checks from `AGENTS.md`.
- Re-check: downstream repin and ALL PASS smoke after release.

## Summary

- PASS. One deep-review finding (stale capability after failed poll) was fixed and observed red/green; no remaining hard stops.
