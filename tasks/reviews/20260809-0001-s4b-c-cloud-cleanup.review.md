# Task Review: s4b-c-cloud-cleanup

> **Status**: Pending
> **Plan**: plans/plan-20260809-0001-s4b-c-cloud-cleanup.md
> **Contract**: tasks/contracts/20260809-0001-s4b-c-cloud-cleanup.contract.md
> **Notes File**: tasks/notes/20260809-0001-s4b-c-cloud-cleanup.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-09 00:05
> **Recommendation**: pending
> **Review Rubric Version**: 2

## Human Review Card

- Verdict: pending
- Change type: migration
- Intended files changed: see contract allowed_paths
- Actual files changed: additive 0003、cloud-postgres maintenance/R2 adapter/tests、runbooks/architecture/sprint/workflow artifacts、fast-xml-parser dependency
- Commands passed: hard-env full workspace typecheck/test/build；deploy SQL order/catalog；strict workflow
- Residual risks: same-size/type byte substitution remains invisible by ADR-024；host must actually schedule jobs and provision policy；public abort HTTP route remains target-only
- Reviewer action required: inspect cross-system delete/accounting crash matrix
- Rollback: stop worker, retain additive schema and tombstones

## Mode Evidence

- Selected route: main-thread isolated migration contract
- P1/P2/P3 evidence: plan + `docs/researches/s4b-c-cleanup-design.md`
- Root cause or plan evidence: sprint S4B.4-S4B.7 and ADR-024

## Verification Evidence

- Commands run: see implementation notes evidence；all passed
- Manual checks: `git diff --check`；0001/0002/protocol source zero-diff audit；R2 hash-authority source scan
- Supporting artifacts: `deploy/runbooks/cloud-cleanup.md`、cleanup job/cursor rows、real Postgres+MinIO tests
- Implementation notes reviewed: pending independent reviewer
- Run snapshot: `.ai/harness/checks/latest.json` refresh pending final contract verification

## Acceptance Receipt Projection

> **Disposition**: pending
> **Reviewer**: Claude
> **Source**: claude-review

## Behavior Diff Notes

- Device blob port gains no methods；host maintenance gains retention policy, job/cursor, dead-letter operator, R2 tombstone/delete/reconcile and usage rebuild。

## Residual Risks / Follow-ups

- Host scheduling/telemetry export is deployment-owned；SDK intentionally ships no timer or provider-specific metrics client。

## Summary

- pending
