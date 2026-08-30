# Task Review: release-0-11-agent-foundations

> **Status**: Accepted
> **Plan**: plans/plan-20260830-1915-release-0-11-agent-foundations.md
> **Contract**: tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md
> **Notes File**: tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-30 20:30
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:8698e9cd4c3e1077336e9e4a184522967241adc97c02c977122e3a2d7feb394d
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 4cedcc92270e2eebdae0a50e6d94ec5316c0a136

## Human Review Card

- Verdict: the immutable-version repair passes objective source and packed-artifact gates; semantic acceptance is projected separately below.
- Change type: release-metadata repair / exact candidate branch push.
- Intended files changed: advance only the independent keys package to 0.3.8 and align its lock/spec/changelog projections.
- Actual files changed: `packages/keys/package.json`, `bun.lock`, `docs/spec.md`, `CHANGELOG.md`, and workflow evidence; no runtime implementation changed and no registry state changed.
- Commands passed: frozen install, package graph, focused 47-test cross-feature guard, root build/typecheck/test, strict workflow, exact ten-tarball pack-and-smoke.
- Residual risks: remote exact-SHA CI, registry publication, and downstream fresh-install/runtime readback remain separate gates.
- Reviewer action required: accept or reject only the exact prepared repair subject; publication is not authorized by this review.
- Rollback: revert the repair commit or delete the isolated release branch before publication; no registry, tag, deploy, or production cleanup exists.

## Mode Evidence

- Selected route: code-change release composition.
- P1/P2/P3 evidence: the approved repair amendment in `plans/plan-20260830-1915-release-0-11-agent-foundations.md` and the root-cause evidence in the implementation notes.
- Root cause or plan evidence: live npm already owns `@byok-sdk/keys@0.3.7` with an exact core 0.10.2 edge, so repacking 0.3.7 against core 0.11.0 would violate npm immutability; the smallest coherent repair is the vacant 0.3.8 version.

## Verification Evidence

- Waza `/check` run: not invoked; user waiver is allowed by contract.
- Commands run: frozen install, package graph, release-tool tests, focused 47-test guard, root build/typecheck/full-test, and exact `pack-and-smoke` at source commit `81558983f76e66b4f09f16494b7926ff484d7ad0`.
- Manual checks: live npm vacancy for keys 0.3.8 returned E404; the release manifest contains ten tarballs, nine packages at 0.11.0 and keys at 0.3.8 with an exact core 0.11.0 edge.
- Supporting artifacts: `.ai/harness/runs/20260830-release-0-11-keys-0-3-8/artifacts/release-manifest.json`.
- Implementation notes reviewed: `tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md`.
- Run snapshot: `.ai/harness/checks/latest.json` is fresh and passing for the exact repair subject.

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
> **Reviewed Subject SHA256**: sha256:8698e9cd4c3e1077336e9e4a184522967241adc97c02c977122e3a2d7feb394d
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 4cedcc92270e2eebdae0a50e6d94ec5316c0a136
> **Verification Evidence SHA256**: sha256:220bf07e5abcc6a77d7f31cf98222f3bc0826ffa07bb65c6c45dc7609a808c2a
> **Issued At**: 2026-08-30T12:11:31.920Z

- Summary: User approved the exact keys 0.3.8 source and packed-artifact repair, non-force push of the candidate branch, and exact-SHA GitHub Actions verification; npm publish, tag, GitHub Release, downstream pin, deploy, and production remain unauthorized.
- Findings: none

## Behavior Diff Notes

- The repair changes no runtime implementation. It preserves the accepted Pi web/MCP/subagent/todo defaults, durable TeamWorkspace/tmux view, and exact flat Agent-memory MCP grants while assigning the changed keys artifact a new immutable package version.

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

- None in the local source, package, review, acceptance, or workflow gates. Exact-SHA remote CI remains the approved external check.

## Retest Steps

- Re-run: `repo-harness run check-task-workflow --strict` and verify the AcceptanceReceipt against `.ai/harness/checks/latest.json`.
- Re-check: repack from the final committed source SHA and bind GitHub Actions to that exact SHA before any future publication request.

## Summary

- The keys 0.3.8 repair subject passes deterministic review and is ready for fresh AcceptanceReceipt plus exact-SHA branch CI; registry release actions remain blocked.
