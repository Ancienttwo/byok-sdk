# Task Review: agent-provider-profile-binding

> **Status**: Accepted
> **Plan**: plans/plan-20260826-1405-agent-provider-profile-binding.md
> **Contract**: tasks/contracts/20260826-1405-agent-provider-profile-binding.contract.md
> **Notes File**: tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-03 02:40
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:c0634337d06e07744c1f19390376e817bc98568d7654973080f70de82f62a817
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 8b7e9568bd644339b4e6999663a25992bc67299b

## Human Review Card

- Verdict: pass; no P0-P3 findings.
- Change type: code-change (security/release authority).
- Intended files changed: protocol, keys local authority, client admission/manifest/Pi composition, focused tests/docs, and unpublished RC evidence.
- Actual files changed: exactly the Change Assessment selected paths bound to subject `sha256:c0634337d06e07744c1f19390376e817bc98568d7654973080f70de82f62a817`.
- Commands passed: contract 17/17, full build/typecheck/test, release graph, release pack, strict workflow, and diff check.
- Residual risks: RC is intentionally unpublished; downstream production pin/deploy remains outside this work-package.
- Reviewer action required: none.
- Rollback: revert the provider-profile work-package before any downstream pin; no registry or production mutation occurred.

## Mode Evidence

- Selected route: strict local semantic review with deterministic test and packed runtime-readback oracles.
- P1/P2/P3 evidence: `tasks/notes/20260826-1405-agent-provider-profile-binding.notes.md`.
- Root cause or plan evidence: pre-fix artifact plus active plan falsifier and frozen consumer.

## Verification Evidence

- Waza `/check` run: repo-harness strict AcceptanceReceipt flow.
- Commands run: see `.ai/harness/checks/latest.json`; all criteria pass.
- Manual checks: packed consumer confirms two custom refs, image capability, stale-hash refusal, and secret/Base-URL exclusion.
- Supporting artifacts: `artifacts/agent-provider-profile-binding/` and pre-fix run artifact.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/runs/run-20260903T023804-34154-20260826-1405-agent-provider-profile-binding.json`.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract `manual_checks` entries were declared; deterministic and runtime-readback oracles cover the selected risk surfaces.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:c0634337d06e07744c1f19390376e817bc98568d7654973080f70de82f62a817
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 8b7e9568bd644339b4e6999663a25992bc67299b
> **Verification Evidence SHA256**: sha256:0112c841088e5c1cb53b94eb187296e762ff65ee9a4ec3ce14f181a50274d9fe
> **Issued At**: 2026-09-02T18:39:50.343Z

- Summary: Exact provider profile authority is fail-closed before claim and revalidated before credential access; deterministic tests, full repository gates, packed RC smoke, and frozen consumer readback pass with no findings.
- Findings: none

## Behavior Diff Notes

- Replaces fixed provider-id-as-instance selection with an opaque local profile ref while keeping provider kind separate.
- Adds exact revision/hash/model/capability admission before claim and repeats it in the credential launcher before secret access/spawn.
- Adds only credential-free protocol/status/manifest fields; Base URL and secrets remain local.

## Residual Risks / Follow-ups

- No code finding remains. Publication, downstream exact pin, deployment, and persistent migration are not authorized by this RC.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | pass | Exact positive and negative admission paths plus packed consumer passed. |
| Product depth | pass | Multiple custom profiles and image capability reach the Pi projection contract. |
| Design quality | pass | Protocol, dispatch, and credential authority remain separated with no new keys dependency edge. |
| Code quality | pass | Full build/typecheck/test and release checks passed. |

## Failing Items

- None.

## Retest Steps

- Re-run: `repo-harness run verify-sprint`.
- Re-check: AcceptanceReceipt against subject and target revision.

## Summary

- Accepted for merge as one work-package; registry remains unpublished.
