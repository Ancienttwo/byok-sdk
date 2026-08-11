# Task Review: cloud-postgres-sql-projection

> **Status**: Pending
> **Plan**: plans/plan-20260812-0201-cloud-postgres-sql-projection.md
> **Contract**: tasks/contracts/20260812-0201-cloud-postgres-sql-projection.contract.md
> **Notes File**: tasks/notes/20260812-0201-cloud-postgres-sql-projection.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-12 02:29
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
> **Reviewed Subject SHA256**: sha256:6663e9318bb670eb35dd40428b34bf6ebdc77ddf9391b865dc1f92263987c83a
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: a58b1580ef7e4c62da4ad9fd5a82c522f7d6df43
> **Verification Evidence SHA256**: sha256:731cd724d0aaf4f6f5c5bb69635926e4cbd5eb88491a52735376118ebef4cf9a
> **Issued At**: 2026-08-11T18:52:55.206Z

- Summary: Gatekeeper PASS: exit criteria 12/12; tier-1 drift assertion proven red on all three directions (missing/extra/modified) via verbatim-extract probe; tier-2 executed against real postgres:17 (migrate + idempotent rerun); single-authority discipline verified; zero diff on protocol/client/server/cloud/deploy
- Findings: P3: dev watch (tsup --watch) does not run the copy step; fails loudly in migrations-dir.test.ts, fail-closed ergonomics only; P3: ustar reader ignores prefix field (offset 345); unreachable for ~40-char migration names, would need ~78 chars; P3: ci.yml comment says SAME tarballs as pack step; job packs its own — wording only, consumer-install guarantee holds

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
