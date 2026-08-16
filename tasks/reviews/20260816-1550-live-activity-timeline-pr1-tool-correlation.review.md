# Task Review: live-activity-timeline-pr1-tool-correlation

> **Status**: Complete
> **Plan**: plans/plan-20260816-1550-live-activity-timeline-pr1-tool-correlation.md
> **Contract**: tasks/contracts/20260816-1550-live-activity-timeline-pr1-tool-correlation.contract.md
> **Notes File**: tasks/notes/20260816-1550-live-activity-timeline-pr1-tool-correlation.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-16 16:20
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:822e1153ba84cd7346ad8cbf1ea8678e1ed3533c8e528b9b23159390817438a7
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 0d99be9d4690e0d1bbed7ca78cbca069b65084f4

## Human Review Card

- Verdict: pass; no remaining product finding
- Change type: code-change
- Intended files changed: protocol AgentEvent schema/golden; Claude/Codex/Pi adapters and scoped tests/fixtures; task workflow artifacts
- Actual files changed: 17 tracked and 6 untracked files, all within contract Allowed Paths
- Commands passed: focused post-fix set 82/82; Pi packaging probe 1/1; contract verification 18/18 including build, typecheck, full test, and strict workflow
- Residual risks: typed AcceptanceReceipt is intentionally deferred until commit/PR promotion; no code-review blocker remains
- Reviewer action required: none for code acceptance; record the contract-policy receipt only when promoting this dirty worktree
- Rollback: revert this contract's protocol, adapter, test, golden, and workflow-artifact diff from base `0d99be9`

## Mode Evidence

- Selected route: delegated implementation plus independent Deep Waza `$check`
- P1/P2/P3 evidence: plan sections `P1：架构边界`, `P2：数据路径与断点`, and `P3：设计决定`; reviewer traced all three provider mapping and typed-failure propagation paths
- Root cause or plan evidence: provider-native IDs/outcomes were present upstream but discarded by normalization; the plan and pinned Pi probe establish the authority boundary

## Verification Evidence

- Waza `/check` run: Deep review PASS on subject `sha256:822e1153ba84cd7346ad8cbf1ea8678e1ed3533c8e528b9b23159390817438a7`; two initial HIGH findings fixed and re-reviewed
- Commands run: `bun test packages/protocol/src/__tests__/agent-event.test.ts packages/protocol/src/__tests__/freeze-guard.test.ts packages/client/src/__tests__/pi-events.test.ts packages/client/src/__tests__/pi-rpc-packaging-probe.test.ts`; `repo-harness run verify-contract --contract tasks/contracts/20260816-1550-live-activity-timeline-pr1-tool-correlation.contract.md --strict`; `git diff --check`
- Manual checks: verified `needs_approval` unchanged; verified Codex outcome remains absent; verified no identity/outcome heuristic or compatibility fallback was introduced
- Supporting artifacts: protocol frozen golden and installed Pi `0.84.1` RPC JSONL probe
- Implementation notes reviewed: yes
- Run snapshot: contract verification reported `total=18 failed=0 status=Fulfilled`

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- [x] Provider-native identity/outcome remains the only mapping authority; malformed required native fields fail closed.
  - Evidence: Deep reviewer traced `AgentEventSchema`, all three provider event mappers, and their `RuntimeExecutionFailure` propagation paths; focused and full verification passed.

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

- `tool_use` and `tool_result` may now carry a nonblank provider-native `toolCallId`; `tool_result` may carry native `isError`.
- Claude, Codex, and Pi preserve native call identity. Claude/Pi preserve native outcome; Codex deliberately emits unknown outcome.
- Bundled native contract violations terminate through typed authority failures instead of becoming silently unpaired or outcome-unknown.

## Residual Risks / Follow-ups

- No product finding remains. A typed AcceptanceReceipt is a later promotion/ship gate because the current target is uncommitted and the user did not authorize commit or push.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Native identity/outcome and failure semantics are covered end to end. |
| Product depth | 9/10 | Scope cleanly closes PR 1 without pulling cloud/UI-runtime work forward. |
| Design quality | 10/10 | One authority per datum; additive wire compatibility without bundled fallback. |
| Code quality | 9/10 | Typed failures, focused fixtures, golden drift guard, and installed-runtime probe. |

## Failing Items

- None.

## Retest Steps

- Re-run: the contract verification command above after any semantic change.
- Re-check: worktree inventory and exact subject hash before commit/PR promotion.

## Summary

- PASS. The final frozen diff is on target, all blocking findings were fixed, and current-session verification is green. No commit, push, PR, or release action was performed.
