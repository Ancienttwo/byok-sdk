# Task Review: pg-pool-error-and-flake

> **Status**: Pending
> **Plan**: plans/plan-20260813-0259-pg-pool-error-and-flake.md
> **Contract**: tasks/contracts/20260813-0259-pg-pool-error-and-flake.contract.md
> **Notes File**: tasks/notes/20260813-0259-pg-pool-error-and-flake.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-13 02:59
> **Recommendation**: fail
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pending
- Change type: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | frontend
- Intended files changed:
- Actual files changed:
- Commands passed:
- Residual risks:
- Reviewer action required: inspect diff and card
- Rollback:

## Mode Evidence

- Selected route:
- P1/P2/P3 evidence:
- Root cause or plan evidence:

## Verification Evidence

- Waza `/check` run:
- Commands run:
- Manual checks:
- Supporting artifacts:
- Implementation notes reviewed:
- Run snapshot:

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- [ ] Exact manual_checks requirement
  - Evidence: concrete observation, command output, screenshot path, or reviewer note

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:6532690b732973780987eda39a102fa26436e852f233d2588030b3dd35055f09
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9050d1fef78664b4395d84cf7261cda0ac6f456c
> **Verification Evidence SHA256**: sha256:ac02690bcbae6e4b22fa980d9912b245dd6825604fcc15fd5322362b553c83fa
> **Issued At**: 2026-08-12T19:30:04.199Z

- Summary: B-1 pg pool error handler + undici keep-alive teardown flake fix: gatekeeper PASS (fresh context), sound-by-construction. Part 1 (pool 'error' handler) fully verified; Part 2 (undici keep-alive off, process-wide, covers conformance path) CI-verified via Node 22+24 dataplane. protocol zero-diff, no error-masking, no uncaughtException swallow, int8 parser untouched. 9/9 contract checks Fulfilled. Unrelated pre-existing daemon-owner mutex-port flake (packages/client) noted, out of scope.
- Findings: none

## Behavior Diff Notes

- ...

## Residual Risks / Follow-ups

- ...

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 0/10 | |
| Product depth | 0/10 | |
| Design quality | 0/10 | |
| Code quality | 0/10 | |

## Failing Items

- ...

## Retest Steps

- Re-run:
- Re-check:

## Summary

- ...
