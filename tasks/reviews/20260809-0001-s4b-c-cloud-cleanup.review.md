# Task Review: s4b-c-cloud-cleanup

> **Status**: Fulfilled
> **Plan**: plans/plan-20260809-0001-s4b-c-cloud-cleanup.md
> **Contract**: tasks/contracts/20260809-0001-s4b-c-cloud-cleanup.contract.md
> **Notes File**: tasks/notes/20260809-0001-s4b-c-cloud-cleanup.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-09 01:30
> **Recommendation**: pass
> **Review Rubric Version**: 2

## Human Review Card

- Verdict: pass
- Change type: migration
- Intended files changed: see contract allowed_paths
- Actual files changed: additive 0003、cloud-postgres maintenance/R2 adapter/tests、runbooks/architecture/sprint/workflow artifacts、fast-xml-parser dependency
- Commands passed: hard-env full workspace typecheck/test/build；deploy SQL order/catalog；strict workflow
- Residual risks: same-size/type byte substitution remains invisible by ADR-024；host must actually schedule jobs and provision policy；public abort HTTP route remains target-only
- Reviewer action required: none；SHA-bound AcceptanceReceipt 已记录
- Rollback: stop worker, retain additive schema and tombstones

## Mode Evidence

- Selected route: main-thread isolated migration contract
- P1/P2/P3 evidence: plan + `docs/researches/s4b-c-cleanup-design.md`
- Root cause or plan evidence: sprint S4B.4-S4B.7 and ADR-024

## Verification Evidence

- Commands run: see implementation notes evidence；all passed
- Manual checks: `git diff --check`；0001/0002/protocol source zero-diff audit；R2 hash-authority source scan
- Supporting artifacts: `deploy/runbooks/cloud-cleanup.md`、cleanup job/cursor rows、real Postgres+MinIO tests
- Implementation notes reviewed: Claude independent review completed；four P1/P2 findings fixed with deterministic guards
- Run snapshot: `.ai/harness/runs/run-20260809T013423-59576-20260809-0001-s4b-c-cloud-cleanup.json`；finalized checks status=pass

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:07b4b25d4d81d8397bc1de8a010e9f40f768c9e7fcfebb8785b2d566ef79a55c
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 4aafc8228de97a172a8ae4c3d2e0f300ab19e2d2
> **Verification Evidence SHA256**: sha256:f857bf111860105a0f744a7b7ec61d900070a5b9d073754351160951987b2406
> **Issued At**: 2026-08-08T17:35:40.199Z

- Summary: Independent review found four concurrency defects; all were fixed with deterministic regression guards, and final reservation/cursor plus device-scoped replay re-reviews returned No findings.
- Findings: none

## Behavior Diff Notes

- Device blob port gains no methods；host maintenance gains retention policy, job/cursor, dead-letter operator, R2 tombstone/delete/reconcile and usage rebuild。
- Post-review delta: atomic deleted-byte accounting、entitlement-serialized tombstone/reservation、rotating delete cursor、exact-source replay provenance。

## Independent Review Findings

- Fixed: concurrent ACK between retention scans could delete more bytes than accounting released。
- Fixed: new reservation could appear after tombstone eligibility and before external DELETE。
- Fixed: a full batch of persistent DELETE failures could starve later tombstones。
- Fixed: concurrent different source rows could collide on one device-scoped replay id and surface a raw unique failure；`replay_source_seq` now binds exact provenance。
- Rejected with full-path evidence: manifest cursor does not strand delete settlement because the primary delete scan is independent；rotating delete cursor clears after an empty/short page；reserve locks entitlement before its guarded INSERT；invalid R2 keys are counted and quarantined, never deleted；replay ids are device-scoped by the frozen outbox identity。
- Final Claude post-fix reviews: reservation/cursor `No findings`；device-scoped replay `No findings`。

## Residual Risks / Follow-ups

- Host scheduling/telemetry export is deployment-owned；SDK intentionally ships no timer or provider-specific metrics client。

## Summary

- external pass；可以进入 PR/CI merge gate
