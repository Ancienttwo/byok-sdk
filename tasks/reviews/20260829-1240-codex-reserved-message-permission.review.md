# Task Review: codex-reserved-message-permission

> **Status**: Passed
> **Plan**: plans/plan-20260829-1240-codex-reserved-message-permission.md
> **Contract**: tasks/contracts/20260829-1240-codex-reserved-message-permission.contract.md
> **Notes File**: tasks/notes/20260829-1240-codex-reserved-message-permission.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-29 12:44
> **Recommendation**: pass for unpublished packed-RC handoff; downstream production canary remains separate
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: source acceptance passed; packed artifact generation is the final local handoff step.
- Change type: bugfix
- Intended files changed: Codex adapter permission composition, reserved MCP identifiers, tests/smokes, aligned RC versions, task evidence.
- Actual files changed: matches intended scope; no protocol, cloud route, Salesko, publish, or deploy changes.
- Commands passed: focused client tests, client build/typecheck, real Codex 0.149 native smoke, full build/typecheck/test, strict task workflow, diff check.
- Residual risks: downstream single-file Salesko production canary is still required against the exact packed bytes.
- Reviewer action required: consume the frozen tarballs and run the Salesko canary.
- Rollback: revert the isolated source commit and discard the ignored RC directory.

## Mode Evidence

- Selected route: regression-first bugfix.
- P1/P2/P3 evidence: recorded in the active plan and implementation notes.
- Root cause or plan evidence: native task reached the reserved MCP call, then Codex denied it because only global `never` existed; the regression and native smoke exercise that exact boundary.

## Verification Evidence

- Waza `/check` run: not separately requested; repository-required gates passed.
- Commands run: `bun run build`; `bun run typecheck`; `bun run test`; `repo-harness run check-task-workflow --strict`; native permission smoke; packed-host smoke.
- Manual checks: real Codex 0.149 invoked only the reserved message tool under global `never` and produced the exact receipt.
- Supporting artifacts: pre-fix artifact and native fixture/smoke named in implementation notes.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/checks/latest.json` plus command output in the active task session.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- [x] Real Codex must invoke the SDK-reserved message tool with global `approval_policy=never` and no unrelated MCP approval.
  - Evidence: `node packages/client/scripts/codex-agent-message-permission-smoke.mjs --codex-bin /Users/kito/.local/bin/codex` passed against Codex 0.149.0.

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

- Required-message Codex tasks now receive an exact per-tool native approval for the SDK-reserved message server only.
- Tasks without that reserved server, and all unrelated MCP servers/tools, retain the prior global `never` behavior.
- Unsupported or unreadable native policy fails adapter preparation before runtime work.

## Residual Risks / Follow-ups

- Salesko must consume the exact packed RC bytes and repeat its compiled-host production canary; local source/native proof is not live rollout evidence.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Exact failing boundary is covered by unit and native execution. |
| Product depth | 9/10 | Generic SDK contract only; downstream product semantics stay out of scope. |
| Design quality | 10/10 | Narrow per-tool grant plus fail-closed native readback. |
| Code quality | 9/10 | Shared identifiers prevent internal drift; full repository gates pass. |

## Failing Items

- None in source acceptance. Downstream live canary is intentionally outside this gate.

## Retest Steps

- Re-run: native permission smoke and packed-host smoke against the frozen RC.
- Re-check: Salesko compiled binary exposes and invokes `send_agent_message`, receives exact disposition, and completes without activity body leakage.

## Summary

- Pass for source acceptance and unpublished packed-RC handoff. No merge, push, tag, registry publication, deployment, or live rollout is implied.
