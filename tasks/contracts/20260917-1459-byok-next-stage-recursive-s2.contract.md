# Task Contract: byok-next-stage-recursive-s2

> **Status**: Active
> **Plan**: plans/plan-20260917-1459-byok-next-stage-recursive-s2.md
> **Task Profile**: docs-only（program 登记）；输入：外部复核文档（Owner 保存）
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-17 15:45
> **Supersedes**: `tasks/contracts/20260910-0214-downstream-issue-intake.contract.md`（Owner 裁定 2026-09-17 边界 1→A；旧契工作已由历史提交承载，剩余 scope 由本契约接管）
> **Review File**: `tasks/reviews/20260917-1459-byok-next-stage-recursive-s2.review.md`
> **Notes File**: `tasks/notes/20260917-1459-byok-next-stage-recursive-s2.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

active 契约（20260910-0214 downstream-issue-intake）的 allowed_paths 与当前实际工作面（WP0–WP6 program 的 plan/研究文档/任务工件）错位，ContractScopeGuard 依契约拦截 docs/researches/ 写入。不换契则每次 repo-harness 门控写入都错路由，或被迫长期借 plan 附录规避路径约束。

## Goal

正式契约换手（Owner 裁定边界 1→A）：旧契 20260910-0214 标记 Superseded，本契约登记当前切片的精确 allowed_paths，WP2-N1/WP3 证据图落位 `docs/researches/20260917-wp2n1-native-custody-evidence-map.md`，`check-task-workflow --strict` 通过。

## Scope

- In scope: 契约换手（旧契 Superseded 标记 + 继任契约登记）、证据图迁移落位、plan 注册与附录指针化、transition 三件套（contract/review/notes）、todos ledger。
- Out of scope: 产品代码（WP1/WP3/WP4 各自在 worktree 独立 slice contract + gate）、CI/workflow 层（WP1 面）、#193 merge 决策（Owner 门）。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

`repo-harness state resolve --json --target-path <path> --operation edit` 对 docs/researches/ 路径仍报 blocker，或 `check-task-workflow --strict` 红，即换手未成立。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260917-1459-byok-next-stage-recursive-s2.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-1459-byok-next-stage-recursive-s2.review.md`
- Notes file: `tasks/notes/20260917-1459-byok-next-stage-recursive-s2.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260917-1459-byok-next-stage-recursive-s2.md
  - docs/researches/BYOK_SDK_next_stage_review_2026-09-17.md
  - docs/researches/20260917-wp2n1-native-custody-evidence-map.md
  - tasks/contracts/20260917-1459-byok-next-stage-recursive-s2.contract.md
  - tasks/reviews/20260917-1459-byok-next-stage-recursive-s2.review.md
  - tasks/notes/20260917-1459-byok-next-stage-recursive-s2.notes.md
  # transition 用途：旧契 Superseded 收口编辑 + 中间产物 1533 三件套删除（删后路径失效即止）
  - tasks/contracts/20260910-0214-downstream-issue-intake.contract.md
  - tasks/contracts/20260917-1533-byok-next-stage.contract.md
  - tasks/reviews/20260917-1533-byok-next-stage.review.md
  - tasks/notes/20260917-1533-byok-next-stage.notes.md
  - tasks/todos.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

This block contains only non-executable artifact requirements. Define every
executable check once in the canonical Verification Plan below. Each check must
state its phase, cost, evidence policy, necessity, and input environment; a
missing or malformed plan fails closed. Populate artifact requirements only
for deliverables this task actually owns; do not create a spec, notes or report
merely to fill this template.

```yaml
exit_criteria:
  files_exist:
    - docs/researches/20260917-wp2n1-native-custody-evidence-map.md
    - tasks/contracts/20260917-1459-byok-next-stage-recursive-s2.contract.md
    - plans/plan-20260917-1459-byok-next-stage-recursive-s2.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260917-1459-byok-next-stage-recursive-s2.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "diff-whitespace",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Validate changed text formatting.",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "workflow-strict",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Confirm the contract handover satisfies the harness workflow gate.",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

Author the actual checks using [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).
The empty array is not permission to omit required repository checks: retain it
only when no executable criterion applies and explain why in Acceptance Notes.
Prefer existing covering tests; creating a task-named test or adding typecheck
is not a template requirement. For each selected check declare `id`, `kind`,
`cwd`, `phase`, `cost`, `evidence_policy`, `necessity`, `inputs.env`, and its
`command` or `path`. Declare the same execution once, including checks nested
inside aggregate scripts. Use `baseline_with_delta` only with an immutable
baseline and named current delta checks; never infer it from paths or command text.

## Acceptance Notes (Human Review)

- Changed behavior/boundary, existing covering tests and remaining gap: docs-only 契约换手切片；无产品行为变更。剩余 gap = WP1/WP2 N2-N3/WP3/WP4/WP5/WP6 各自 slice。
- New test case/file rationale, or why existing coverage is sufficient: docs-only，无测试面；结构由 workflow-strict 检查覆盖。
- Selected check IDs and why their coverage is sufficient; omitted coverage: diff-whitespace + workflow-strict；typecheck/build/test 不适用（零产品代码改动）。
- Full/expensive check justification and expected cost, if applicable: 无。
- Execution/baseline references, subject, current delta and disposition: 主 checkout 未提交 diff（transition 工件）；WP1/WP3 worktree 各自验证，不并入本切片。
- Residual risks and incomplete observations: 1533 中间三件套删除后旧契 allowed_paths 引用成为历史记录（不回读）；PR #193 正文滞留旧验收引用（merge 决策时前向收口，Owner 门）。

## Rollback Point

- Commit / checkpoint: 主 checkout 未提交 transition diff（docs/tasks 层）。
- Revert strategy: 恢复 `.ai/harness/active-plan` 指回 `plans/plan-20260910-0214-downstream-issue-intake.md`；旧契 Status 回 Active、移除 Superseded By；删除本契约三件套与 docs/researches/ 两份新文档；plan 附录指针还原为内联证据图。
