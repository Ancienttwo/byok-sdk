# Task Review: release-0-11-agent-foundations

> **Status**: Accepted
> **Plan**: plans/plan-20260830-1915-release-0-11-agent-foundations.md
> **Contract**: tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md
> **Notes File**: tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-30 19:16
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:bcf130ab70fa50e355662a3ac974192edf831a036de9e3e59d4a4ed6c9c4552a
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: e6dff60f74d939d382d38ee757681d4b63d84bb7

## Human Review Card

- Verdict: objective release gates pass; semantic acceptance pending.
- Change type: code-change / local release composition
- Intended files changed: accepted Agent-memory source, aligned 0.11.0 manifests/lock/spec/changelog, and workflow evidence.
- Actual files changed: both accepted source lines plus the existing 0.11.0 train; no external state.
- Commands passed: frozen install, package graph, focused 47-test cross-feature guard, root build/typecheck/test, strict workflow, exact ten-tarball pack-and-smoke.
- Residual risks: registry publication and downstream fresh-install/runtime readback remain separate gates.
- Reviewer action required: accept or reject the exact prepared subject; publication is not authorized by this review.
- Rollback: delete the isolated release worktree/branch; no registry, tag, deploy, or production cleanup exists.

## Mode Evidence

- Selected route: code-change release composition.
- P1/P2/P3 evidence: `plans/plan-20260830-1915-release-0-11-agent-foundations.md`.
- Root cause or plan evidence: two separately accepted source lines required one version/package authority before any publication gate.

## Verification Evidence

- Waza `/check` run: not invoked; user waiver is allowed by contract.
- Commands run: contract commands plus exact `pack-and-smoke` at source commit `4f76deb`.
- Manual checks: release manifest contains ten tarballs; nine packages are 0.11.0 and keys is 0.3.7.
- Supporting artifacts: `.ai/harness/runs/20260830-release-0-11-agent-foundations/artifacts/release-manifest.json`.
- Implementation notes reviewed: `tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md`.
- Run snapshot: pending final `verify-sprint --prepare-acceptance`.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract `manual_checks` requirements.

## Acceptance Receipt Projection

> **Disposition**: user_waiver
> **Reviewer**: User
> **Source**: user-waiver
> **Actor**: kito
> **Reviewed Subject SHA256**: sha256:bcf130ab70fa50e355662a3ac974192edf831a036de9e3e59d4a4ed6c9c4552a
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: e6dff60f74d939d382d38ee757681d4b63d84bb7
> **Verification Evidence SHA256**: sha256:10fffc0a49901aacb6f0733cbe72707b013fae5715800aef901bed582d5c6042
> **Issued At**: 2026-08-30T11:24:24.006Z

- Summary: Approved the exact unpublished local 0.11.0 composition from accepted agent-foundations and agent-memory source lines; no main merge, push, npm publish, registry release, tag, deploy, downstream pin, or production rollout.
- Findings: none

## Behavior Diff Notes

- The combined source retains Pi web/MCP/subagent/todo defaults, durable TeamWorkspace/tmux view, and exact flat Agent-memory MCP grants in one 0.11.0 package train.

## Residual Risks / Follow-ups

- The local tarballs are validation artifacts only. Registry state, tag/Release, downstream consumption, and live runtime are unproven and unauthorized.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Contract and exact packed-artifact gates pass locally. |
| Product depth | 9/10 | Foundation scope is complete; downstream rollout is intentionally separate. |
| Design quality | 10/10 | One version authority, no compatibility aliases or tmux IPC backdoor. |
| Code quality | 10/10 | Both accepted lines and all root suites pass together. |

## Failing Items

- Semantic AcceptanceReceipt pending; no source or package gate failure remains.

## Retest Steps

- Re-run: `repo-harness run verify-sprint --prepare-acceptance` after workflow evidence is committed.
- Re-check: exact source SHA and tarball manifest before any future publication request.

## Summary

- Local 0.11.0 composition is ready for exact-subject semantic acceptance; external release actions remain blocked.
