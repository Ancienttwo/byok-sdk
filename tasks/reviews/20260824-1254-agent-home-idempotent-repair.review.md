# Task Review: agent-home-idempotent-repair

> **Status**: Pass
> **Plan**: plans/plan-20260824-1254-agent-home-idempotent-repair.md
> **Contract**: tasks/contracts/20260824-1254-agent-home-idempotent-repair.contract.md
> **Notes File**: tasks/notes/20260824-1254-agent-home-idempotent-repair.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-24 12:55
> **Recommendation**: source accepted; packed RC accepted; do not publish without a separate gate
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:71cbabe71837a582a4ca79715cb98c69cf8ec74664891eec23002b09ac01bd9c
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 0b91d621fd260810f88eacddbd4e36aaa60faaa2

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: client projection lifecycle/tests/docs and aligned RC metadata
- Actual files changed: matches the contract's normalized subject set
- Commands passed: focused regression, build, typecheck, full tests, release graph, pack-and-smoke, strict workflow, Salesko exact-RC acceptance
- Residual risks: hosts with non-idempotent projection hooks violate the pre-existing public contract and will now expose that violation on replay
- Reviewer action required: none before the separate formal publication gate
- Rollback: discard this unpublished branch and packed RC

## Mode Evidence

- Selected route: strict bugfix work-package in an isolated worktree
- P1/P2/P3 evidence: plan and notes freeze ownership, exact request trace, and the choice to enforce the existing idempotent hook contract
- Root cause or plan evidence: real pre-fix artifact plus `agent-home-idempotent-repair.test.ts`

## Verification Evidence

- Waza `/check` run: not invoked; formal repo-harness gates used
- Commands run: all contract exit criteria passed
- Manual checks: Salesko exact tarball consumption restored missing `profile.json` while returning `idempotent`
- Supporting artifacts: packed RC manifest and pre-fix artifact recorded in implementation notes
- Implementation notes reviewed: yes
- Run snapshot: `.ai/harness/runs/run-20260824T131327-74291-20260824-1254-agent-home-idempotent-repair.json`

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` were declared.

## Acceptance Receipt Projection

> **Disposition**: user_waiver
> **Reviewer**: User
> **Source**: user-waiver
> **Actor**: kito
> **Reviewed Subject SHA256**: sha256:71cbabe71837a582a4ca79715cb98c69cf8ec74664891eec23002b09ac01bd9c
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 0b91d621fd260810f88eacddbd4e36aaa60faaa2
> **Verification Evidence SHA256**: sha256:78b6e00fc5d3b34f93e8bdb861a4b6ad2a59f67d6a6bd2692bd1e9c763c5be81
> **Issued At**: 2026-08-24T05:15:02.247Z

- Summary: Accepted bounded 0.8.1 exact-replay ensure repair source and packed RC; publication remains a separate gate
- Findings: none

## Behavior Diff Notes

- Equal revision/hash now runs the existing idempotent product consumer under the canonical-home writer lease, then returns `idempotent`; stale/conflict remain hook-free.

## Residual Risks / Follow-ups

- Formal registry publication/readback remains intentionally unexecuted.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Downstream reconciliation falsifier and ordering negatives pass. |
| Product depth | 9/10 | Repairs local derived-state loss without adding path or schema authority. |
| Design quality | 10/10 | Reuses the existing lease and atomic/idempotent hook contract. |
| Code quality | 10/10 | Small lifecycle change with focused regression coverage. |

## Failing Items

- None.

## Retest Steps

- Re-run: contract exit criteria and Salesko Phase 2 falsifier against the frozen RC.
- Re-check: RC manifest/source SHA and original Salesko composite hash.

## Summary

- Source and packed RC are accepted; publication remains a separate authority gate.
