# Task Review: public-package-topology

> **Status**: Pending
> **Plan**: plans/plan-20260905-0114-public-package-topology.md
> **Contract**: tasks/contracts/20260905-0114-public-package-topology.contract.md
> **Notes File**: tasks/notes/20260905-0114-public-package-topology.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-05 01:17
> **Recommendation**: fail
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pending
- Change type: docs-only
- Intended files changed: ADR-035, `sdk-architecture.md`, this plan's workflow artifacts; generated architecture queue/context projections only.
- Actual files changed: intended docs/workflow files plus generated `packages/AGENTS.md`, `packages/CLAUDE.md`, architecture request archive and index projection; no manifest, lockfile, source, test, README install command, or release script.
- Commands passed: topology readback (`public=10`, `workspaces=15`, `umbrella_product_imports=0`); `repo-harness run check-task-workflow --strict`; `git diff --check`. Final strict architecture sync and contract verification are projected below from frozen evidence.
- Residual risks: external npm consumers of `byok-sdk` are unknown; actual package deletion, version choice, release and downstream migration remain separately gated.
- Reviewer action required: none for the architecture ruling; implementation requires a new approval/contract.
- Rollback: revert the docs-only decision unit.

## Mode Evidence

- Selected route: parent-agent docs-only decision; no delegated writer or reviewer.
- P1/P2/P3 evidence: plan `Agentic Routing`, ADR-035 Context/Decision/Rationale, current manifests and exact repo/Salesko import inventory.
- Root cause or plan evidence: WP3B collapsed semantic authority but explicitly retained the server package name; the capability-free umbrella remained the only coherent one-package retirement target.

## Verification Evidence

- Waza `/check` run: not used; docs-only deterministic contract verification.
- Commands run: contract `commands_succeed` plus package/workspace/import inventory.
- Manual checks: confirmed `@byok-sdk/server` owns Node/Hono composition; confirmed umbrella source is namespace-only and inspected product code has zero imports.
- Supporting artifacts: ADR-035; current architecture §1.2; prior O1 evidence; archived architecture queue cards.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/checks/latest.json` after `verify-sprint --prepare-acceptance`.

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

- No runtime behavior changes. Current public count remains 10; ADR-035 authorizes no deletion. The approved target is 9 only after a separate breaking-release implementation removes the umbrella.

## Residual Risks / Follow-ups

- Unknown external umbrella consumers require explicit breaking release notes and exact direct-package migration evidence. No compatibility shim is permitted.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | No runtime change; ruling distinguishes current and target state. |
| Product depth | 10/10 | Keeps the real self-hosted deployment artifact and removes only capability-free duplication. |
| Design quality | 10/10 | One package per ownership/deployment boundary; one-shot cutover, no aliases. |
| Code quality | 10/10 | Docs-only; deterministic readback covers the normative tokens and counts. |

## Failing Items

- None in the frozen docs subject; semantic acceptance remains pending until receipt projection.

## Retest Steps

- Re-run: contract `commands_succeed` and topology count/import inventory.
- Re-check: no package/source/lock/release-script diff; architecture queue has zero pending requests.

## Summary

- Retain `@byok-sdk/server`; retire `byok-sdk` umbrella in a separately approved breaking release; current 10 public artifacts become 9 only after that implementation.
