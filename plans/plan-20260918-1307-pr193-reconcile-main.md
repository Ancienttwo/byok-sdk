# Plan: pr193-reconcile-main (stage 1 of the approved three-stage merge order)

> **Status**: Executing
> **Created**: 20260918-1307
> **Slug**: pr193-reconcile-main
> **Planning Source**: fable-main-loop
> **Orchestration Kind**: host-plan
> **Source Ref**: Owner approval 2026-09-18 ("批准" on the #193 merge assessment)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: `repo-harness run verify-contract --contract tasks/contracts/20260918-1307-pr193-reconcile-main.contract.md --strict`.
> **Rollback Surface**: reset branch to d4dcf961.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260918-1307-pr193-reconcile-main.contract.md`
> **Task Review**: `tasks/reviews/20260918-1307-pr193-reconcile-main.review.md`
> **Implementation Notes**: `tasks/notes/20260918-1307-pr193-reconcile-main.notes.md`

## Why
PR #193 CONFLICTING vs main (8 files, c07 overlap where main holds the #185–#190 accepted evolution). Owner approved stage 1: in-branch reconciliation, house merge style.

## Task Breakdown
- [x] deep-worker 完成：merge commit 0a3202f3（8 文件按裁决 + 6 interlock + notes 落账，全矩阵绿除 K1/K2 已知项）
- [x] strict 12 检查 10 绿（K1 本地 tripwire、K2 继承 whitespace，均已定性）
- [x] gatekeeper PASS（B1–B7；N1/N2 非阻塞）
- [x] orchestrator push `pr193-reconcile -> codex/c07-pi-runtime-launch` + CI watcher（0a3202f3 + 145dbb97；CI 判定见 review 收据）
- [x] 回报（flake hardening 随附刀 1507 承接）

## Non-Goals
WP1/WP4 合流（stage 2/3）、CI/workflow 改动、mark ready、merge PR、任何 compatibility shim。

## Stop rules
见契约 Stop Conditions；BLOCKED 只带最小反例回报，不静默取舍。

## Rollback
`git reset --hard d4dcf961`（worktree /Users/kito/Projects/byok-sdk-wt-pr193-reconcile）。
