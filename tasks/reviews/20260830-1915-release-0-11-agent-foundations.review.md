# Task Review: release-0-11-agent-foundations

> **Status**: Accepted
> **Plan**: plans/plan-20260830-1915-release-0-11-agent-foundations.md
> **Contract**: tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md
> **Notes File**: tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-30 20:55
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:8a48a87d4183098e73ae4f89c74fed8f1767410bd1f5272e245d4ec977b74183
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 7a937e5ed8eb5aef102eacb0df9183f296da7e1f

## Human Review Card

- Verdict: exact source, CI, frozen artifact, live registry vacancy, ownership, and stable-channel dry-run gates pass for publication.
- Change type: external stable npm publication gate; normalized source subject is empty because target main already equals the frozen release source.
- Intended files changed: workflow authority only; published bytes remain the exact `main@7a937e5` artifacts.
- Actual files changed: plan, contract, notes, and this review on the isolated evidence branch; no runtime or package bytes changed.
- Commands passed: both exact-SHA GitHub Actions runs, live npm ownership/vacancy/dist-tag checks, canonical build plus ten-tarball pack/install dry-run, and byte-identical manifest comparison.
- Residual risks: npm browser/OTP expiry or a sequential partial publish requires immediate live registry inspection; remote tag/Release and downstream remain separate gates.
- Reviewer action required: accept or reject only local annotated tag creation, ten-package stable npm publication, and canonical registry readback.
- Rollback: npm versions are immutable; on partial publication stop and inspect registry state rather than retrying occupied versions.

## Mode Evidence

- Selected route: strict external publication gate over an already accepted source SHA.
- P1/P2/P3 evidence: the approved stable publication amendment and publication preflight section in the implementation notes.
- Root cause or plan evidence: every exact target version is vacant, the final and dry-run manifests are byte-identical, and stable `0.11.0` must omit `--tag` to advance `latest` without creating a second channel authority.

## Verification Evidence

- Waza `/check` run: not invoked; user waiver is allowed by contract.
- Commands run: `npm ping`, `npm whoami`, maintainer/dist-tag/version vacancy checks, tag/Release vacancy checks, and canonical `publish.mjs` dry-run at exact source `7a937e5ed8eb5aef102eacb0df9183f296da7e1f`.
- Manual checks: all ten target versions returned E404 before and after dry-run; `latest` is 0.10.2 for the aligned train and 0.3.7 for keys; local/remote tag and GitHub Release are vacant.
- Supporting artifacts: `.ai/harness/runs/20260830-release-0-11-publish-preflight/artifacts/release-manifest.json` with SHA-256 `75e2a43204cd26944080613d3c784e1ac7adb966efd85470ad63cb99ec2b30d5`.
- Implementation notes reviewed: `tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md`.
- Run snapshot: pending fresh publication-gate `verify-sprint --prepare-acceptance`.

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
> **Reviewed Subject SHA256**: sha256:8a48a87d4183098e73ae4f89c74fed8f1767410bd1f5272e245d4ec977b74183
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 7a937e5ed8eb5aef102eacb0df9183f296da7e1f
> **Verification Evidence SHA256**: sha256:70c9440d37b21be26c978af1e33ff444f580e689d3772d1116a4d370b9a3c185
> **Issued At**: 2026-08-30T13:20:22.892Z

- Summary: User authorized stable npm publication of the exact main@7a937e5ed8eb5aef102eacb0df9183f296da7e1f ten-package artifact set, local annotated v0.11.0 tag creation, and canonical registry readback; remote tag push, GitHub Release, downstream pinning, deploy, and production remain unauthorized.
- Findings: none

## Behavior Diff Notes

- The repair changes no runtime implementation. It preserves the accepted Pi web/MCP/subagent/todo defaults, durable TeamWorkspace/tmux view, and exact flat Agent-memory MCP grants while assigning the changed keys artifact a new immutable package version.

## Residual Risks / Follow-ups

- Publication has not begun at review time. Remote tag/Release, downstream consumption, and live runtime remain unauthorized.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Contract and exact packed-artifact gates pass locally. |
| Product depth | 9/10 | Foundation scope is complete; downstream rollout is intentionally separate. |
| Design quality | 10/10 | One version authority, no compatibility aliases or tmux IPC backdoor. |
| Code quality | 10/10 | Both accepted lines and all root suites pass together. |

## Failing Items

- Fresh publication AcceptanceReceipt and final strict workflow state remain pending.

## Retest Steps

- Re-run: `repo-harness run verify-sprint --prepare-acceptance`, record the user-authorized receipt, then verify strict ship state.
- Re-check immediately before execution: npm identity, ten vacancies, local tag vacancy, and detached source SHA.

## Summary

- The exact stable publication subject passes deterministic review and is ready for a fresh user-authorized AcceptanceReceipt; registry mutation remains blocked until that receipt and checks are fresh.
