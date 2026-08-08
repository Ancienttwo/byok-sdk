# Task Review: s4b-a-finalize-authority

> **Status**: Pending
> **Plan**: plans/plan-20260808-1940-s4b-a-finalize-authority.md
> **Contract**: tasks/contracts/20260808-1940-s4b-a-finalize-authority.contract.md
> **Notes File**: tasks/notes/20260808-1940-s4b-a-finalize-authority.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-08 19:43
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
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:b65bae14ae2dbefac8821ea1afdc033a516af99540550c20f1bc61b22a33bfdc
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 6d1d69a1464dc70a70d4c925d98b998f93763e0c
> **Verification Evidence SHA256**: sha256:35d1bb76ee22bcf29bb102a6575691dfbba167839bdd429640f1ecec6062039b
> **Issued At**: 2026-08-08T11:53:19.434Z

- Summary: ADR-024 is implemented faithfully: finalize observes only size and content type, both compositions deduplicate from the reservation declaration, the shared quota conformance and hard-env full suite pass, packages contain no observedContentHash, and frozen migrations plus cloud/protocol surfaces are unchanged.
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
