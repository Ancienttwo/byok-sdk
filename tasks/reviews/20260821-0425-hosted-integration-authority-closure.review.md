# Task Review: hosted-integration-authority-closure

> **Status**: Passed
> **Plan**: plans/plan-20260821-0425-hosted-integration-authority-closure.md
> **Contract**: tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md
> **Notes File**: tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-21 11:58
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:ae3356a910355e7c86b905ef007043a2db42ece28c753ca39619a1849644549f
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 1a9c66194cb119272244b2ed719437e9a4ed624b

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: schema/Worker fixture、Node migration verification API、keys/release graph，以及对应 plan/contract/handoff。
- Actual files changed: AcceptanceReceipt 的 22 条 normalized subject paths；workflow-only plan/contract/review/notes/current/todos 另行投影。
- Commands passed: contract 19/19；build、typecheck、full test、release graph、clean release pack、strict workflow、diff check；真实 Worker/Hyperdrive 与 packed Postgres readback。
- Residual risks: Salesko production origin role 与 `/readyz` 尚需 operator action；`keys@0.2.1` live registry readback 需独立 release authorization 后执行。
- Reviewer action required: none
- Rollback: revert candidate branch；无生产 role、registry 或 deployment mutation。

## Mode Evidence

- Selected route: three disjoint writers + independent Codex gatekeeper + orchestrator integration。
- P1/P2/P3 evidence: frozen in source plan；role/database、package migration state、packed dependency graph 各保留一个 authority。
- Root cause or plan evidence: Salesko Hyperdrive `public` readback、host comparator duplication、registry `keys@0.2.0 -> core@0.4.2` negative control。

## Verification Evidence

- Waza `/check` run: repo-harness final prepare-acceptance passed。
- Commands run: contract Exit Criteria 19/19；真实 Postgres migration matrix 17/17；packed migration smoke 连续两次通过。
- Manual checks: independent gatekeeper findings（release smoke public write 与 cleanup）已修复并复核。
- Supporting artifacts: `.ai/harness/checks/latest.json`、release manifest output、typed AcceptanceReceipt。
- Implementation notes reviewed: yes。
- Run snapshot: `.ai/harness/runs/run-20260821T115607-21079-20260821-0425-hosted-integration-authority-closure.json`。

## Manual Check Evidence

- Contract 未声明额外 `manual_checks`；runtime readback 由 declared oracle 与上述 Worker/Postgres evidence 覆盖。

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:ae3356a910355e7c86b905ef007043a2db42ece28c753ca39619a1849644549f
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 1a9c66194cb119272244b2ed719437e9a4ed624b
> **Verification Evidence SHA256**: sha256:c3cb34778261c6f182f08d5aa41b1af00103f518a0004dd699a7be394072bc3f
> **Issued At**: 2026-08-21T03:57:24.320Z

- Summary: Role-backed schema authority, exact migration readback, and keys release graph satisfy the frozen contract; independent gate findings were remediated and final SHA checks pass.
- Findings: none

## Behavior Diff Notes

- Hyperdrive/Node schema isolation 由 database-scoped application role 决定；client-side schema options 被移除并设守卫。
- Host 可调用 root-only `verifyMigrations()` 取得 exact ledger truth；runtime entry 保持不导出。
- keys candidate 为 `0.2.1`，release tooling 对 packed/installed/registry graph 纳入 keys。

## Residual Risks / Follow-ups

- 生产 origin role 与 Salesko `/readyz` 验收未获本 work-package 授权。
- live registry readback 必须等 `keys@0.2.1` 经独立 release 流程发布后执行。

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | 三条 contract path 均有 deterministic 与 runtime proof |
| Product depth | 10/10 | 消除三个 downstream duplicate authorities |
| Design quality | 10/10 | role/package/release graph 各自单一 owner，无 compatibility fallback |
| Code quality | 10/10 | focused guards、typed errors、clean pack 与 real substrate evidence |

## Failing Items

- None.

## Retest Steps

- Re-run: contract Exit Criteria 或 `repo-harness run verify-sprint --prepare-acceptance --contract ...`。
- Re-check: exact target revision、AcceptanceReceipt subject hash、release manifest source SHA。

## Summary

- Pass。实现满足 frozen contract；外部生产配置与发布动作保持未授权、未执行。
