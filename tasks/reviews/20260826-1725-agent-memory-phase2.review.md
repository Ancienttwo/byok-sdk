# Task Review: agent-memory-phase2

> **Status**: Source Passed / Terminal Blocked
> **Plan**: plans/plan-20260826-1725-agent-memory-phase2.md
> **Contract**: tasks/contracts/20260826-1725-agent-memory-phase2.contract.md
> **Notes File**: tasks/notes/20260826-1725-agent-memory-phase2.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-26 18:40
> **Recommendation**: blocked
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: independent source review passed; terminal acceptance is blocked
- Change type: code-change + migration
- Intended files changed: client memory MCP and runtime injection, protocol/cloud projection contracts, cloud-dataplane store and migration, focused tests, architecture and task evidence
- Actual files changed: the intended Phase 2 surfaces under `packages/client`, `packages/protocol`, `packages/cloud`, `packages/cloud-dataplane`, `deploy/sql`, `tests/sql`, and the task artifacts listed by the contract
- Commands passed: `bun run build`; `bun run typecheck`; `bun run test`; `repo-harness run check-task-workflow --strict`; `git diff --check`; `repo-harness run check-deploy-sql-order`; disposable Linux focused client tests; disposable Postgres/MinIO dataplane tests
- Residual risks: Linux has the native descriptor backend; macOS requires the separately distributed exact helper; Windows retains Phase 1 guidance while Phase 2 remains fail closed pending real Windows-native evidence
- Reviewer action required: after commit authority exists, bind the subject to a commit, produce `.ai/harness/checks/latest.json`, record a typed `AcceptanceReceipt`, and obtain upstream CI freshness
- Rollback: revert the reviewed Phase 2 diff to checkpoint `185cf91`; migration `0014` has not been deployed

## Mode Evidence

- Selected route: planned Phase 2 implementation with disjoint delegated client, protocol/cloud, and dataplane ownership followed by independent security review and re-gate
- P1/P2/P3 evidence: `plans/plan-20260826-1725-agent-memory-phase2.md` and `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Root cause or plan evidence: local Agent-home files remain the sole authoring authority; hosted state is a capability-gated, redacted, one-way projection

## Verification Evidence

- Waza `/check` run: not used; repository-native checks and independent gate were used
- Commands run: all contract commands passed, plus deploy SQL ordering, diff check, Linux focused tests, and Postgres/MinIO integration tests
- Manual checks: verified ordinary tasks and incomplete hosted configuration expose no Phase 2 network surface; verified unsupported platforms fail closed; verified symlink-swap race cannot escape the captured Agent-home inode on Linux
- Supporting artifacts: `.ai/harness/runs/run-20260826T183152-57581-20260826-1725-agent-memory-phase2.json`
- Implementation notes reviewed: `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Run snapshot: preparation reran all source checks successfully but could not emit commit-bound evidence because the contract and implementation are uncommitted

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` are declared by the contract.

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

- Local `MEMORY.md` and `notes/**/*.md` remain the only authoring authority.
- `memory.recall` and `memory.save` are task-scoped and bind identity from the active daemon context, never from model arguments.
- Hosted projection is optional, default-off, required-redaction, ordered, idempotent, metered on accepted redacted bytes, and server-erasable.
- Generic `truth.records(kind=memory)` is not promoted into a competing per-Agent memory authority.

## Residual Risks / Follow-ups

- Phase 2 on macOS requires the explicit, version-matched helper proven in the cross-platform work-package. Windows remains disabled until a real runner proves its junction/reparse/rename matrix.
- No commit, push, merge, package publication, deployment, or production migration evidence exists for this subject.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | source-pass | Focused and full tests pass; terminal artifact remains unbound |
| Product depth | source-pass | Local authority, hosted projection, metering, erase, and audit boundaries are covered |
| Design quality | source-pass | One-way projection avoids dual authority; unsupported platforms fail closed |
| Code quality | source-pass | Independent re-gate passed after the TOCTOU repair |

## Failing Items

- `.ai/harness/checks/latest.json` is absent because evidence cannot bind to an uncommitted subject.
- No typed `AcceptanceReceipt` or upstream CI freshness exists.

## Retest Steps

- Re-run: after an authorized commit, run `verify-sprint --prepare-acceptance`, record the typed `AcceptanceReceipt`, then run `verify-sprint`.
- Re-check: confirm the evidence subject hash and target revision match the committed Phase 2 diff and that upstream CI is fresh.

## Summary

- Source verdict: PASS.
- Ship / terminal acceptance: BLOCKED until commit-bound checks, typed acceptance, and upstream freshness exist.
