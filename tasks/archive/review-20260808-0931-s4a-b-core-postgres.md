> **Archived**: 2026-08-08 09:31
> **Related Plan**: plans/archive/plan-20260808-0232-s4a-b-core-postgres.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260808-0931

# Task Review: s4a-b-core-postgres

> **Status**: Pending
> **Plan**: plans/plan-20260808-0232-s4a-b-core-postgres.md
> **Contract**: tasks/contracts/20260808-0232-s4a-b-core-postgres.contract.md
> **Notes File**: tasks/notes/20260808-0232-s4a-b-core-postgres.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-08 02:36
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
> **Reviewed Subject SHA256**: sha256:8a48a87d4183098e73ae4f89c74fed8f1767410bd1f5272e245d4ec977b74183
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 262832dd2af77bedd252168888d8f948c28ff5b8
> **Verification Evidence SHA256**: sha256:c5b5d609ffab9b4195d085f0503e63d2d4dd29c012f7ec4e2aa233e14114c9b6
> **Issued At**: 2026-08-08T01:31:39.414Z

- Summary: S4A-b shipped via PR #24 (merge aff8dda, CI 16/16 green incl. dataplane reference-mode ordering check). Gate round one FAIL caught a real P1: objects.addReference was read-then-write (write skew twin of the quota path), deterministically reproduced as tombstone-while-referenced; fixed by transactionalizing add/removeReference behind FOR UPDATE with a deterministic forced-interleaving regression test (unlocked = red 5/5). The reserve deviation (transaction + FOR UPDATE instead of the plan's single statement) was independently verified and accepted: the single-statement CTE shape cannot serialize aggregate guards under READ COMMITTED. Core conformance 56/56 on Postgres with zero assertion changes closes the I4 SQL side (D-2); catalog assertions live in tests/sql/control_plane_invariants.sql with a mutation check. Residuals ledgered: readCursor updatedAt fallback (todos), quota per-tenant serialization throughput ceiling (gate record).
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
