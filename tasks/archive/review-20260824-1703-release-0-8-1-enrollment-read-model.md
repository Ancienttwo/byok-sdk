> **Archived**: 2026-08-24 17:03
> **Related Plan**: plans/archive/plan-20260824-1648-release-0-8-1-enrollment-read-model.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260824-1703

# Task Review: release-0-8-1-enrollment-read-model

> **Status**: Accepted
> **Plan**: plans/plan-20260824-1648-release-0-8-1-enrollment-read-model.md
> **Contract**: tasks/contracts/20260824-1648-release-0-8-1-enrollment-read-model.contract.md
> **Notes File**: tasks/notes/20260824-1648-release-0-8-1-enrollment-read-model.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-24 16:48
> **Recommendation**: pass; source and packed candidate accepted for the authorized publication gate
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:322696b9816f1f51e268fd955ceb9cc7a81fc67d807e0600f648da6b05ac58fd
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 0b91d621fd260810f88eacddbd4e36aaa60faaa2

## Human Review Card

- Verdict: pass for the exact combined source and packed candidate.
- Change type: public client API plus immutable release.
- Intended files changed: accepted 0.8.1 repair subject plus the credential-blind reader/test/docs and release workflow artifacts.
- Actual files changed: matches the contract allowlist and exact review subject.
- Commands passed: focused 6/0, client build/typecheck, full repository build/typecheck/test, release graph, pack-smoke test, strict workflow, release-driver dry run, and exact-subject verify-sprint.
- Residual risks: npm/tag/Release and Salesko exact-pin readback remain separate pending external gates.
- Reviewer action required: none before the authorized publish execution; receipt is valid for the exact subject.
- Rollback: discard before the first npm write; afterward complete/read back only the same immutable versions.

## Mode Evidence

- Selected route: strict isolated combined release worktree.
- P1/P2/P3 evidence: the plan maps parser/package/external authorities, traces the exact consumer flow, and records why one combined 0.8.1 train is the smallest coherent release.
- Root cause or plan evidence: component root causes remain in the accepted repair and enrollment plans; this contract owns their combined publication boundary.

## Verification Evidence

- Waza `/check` run: not invoked; repository-native strict gates and the user-waiver receipt were used.
- Commands run: all 15 contract checks passed; full package tests include client 1396/0 plus the remaining repository suites.
- Manual checks: npm identity, registry vacancy, remote tag vacancy, and GitHub Release vacancy were read back before packaging.
- Supporting artifacts: `.ai/harness/checks/latest.json` and `/tmp/byok-0.8.1-rc.w8vKXQ/release-manifest.json`.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/runs/run-20260824T170056-30213-20260824-1648-release-0-8-1-enrollment-read-model.json`.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract-specific manual checks are declared.

## Acceptance Receipt Projection

> **Disposition**: user_waiver
> **Reviewer**: User
> **Source**: user-waiver
> **Actor**: kito
> **Reviewed Subject SHA256**: sha256:322696b9816f1f51e268fd955ceb9cc7a81fc67d807e0600f648da6b05ac58fd
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 0b91d621fd260810f88eacddbd4e36aaa60faaa2
> **Verification Evidence SHA256**: sha256:015a934b31e1dcce6f81bda1bb25f797de2f679548fd617a17f4867a58da9159
> **Issued At**: 2026-08-24T09:01:53.115Z

- Summary: User approved the bounded BYOK 0.8.1 enrollment read-model publication, registry readback, Salesko exact pin, verification, merge, and cleanup; deploy, migration, live-device rollout, and unrelated worktrees remain out of scope.
- Findings: none

## Behavior Diff Notes

- Adds one public credential-blind enrollment reader while preserving the accepted exact-replay ensure repair in the same aligned 0.8.1 train.

## Residual Risks / Follow-ups

- Registry/tag/Release and Salesko exact-pin readback remain pending until the authorized execute step completes.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Focused and full suites pass for both public behaviors. |
| Product depth | 9/10 | Preserves credential and Agent-home ownership boundaries. |
| Design quality | 10/10 | Reuses the canonical validator and single release authority. |
| Code quality | 10/10 | Narrow additive API with redaction and failure-path tests. |

## Failing Items

- None for source acceptance; immutable external readback is pending.

## Retest Steps

- Re-run: release driver from a clean exact commit.
- Re-check: npm integrities/edges/import closure, source/tag/Release SHA, and downstream exact lockfile.

## Summary

- Exact combined source and packed candidate are accepted for publication; no deploy, migration, or live rollout is implied.
