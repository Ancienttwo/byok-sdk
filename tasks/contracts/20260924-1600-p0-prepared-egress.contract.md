# Task Contract: p0-prepared-egress

> **Status**: Active
> **Plan**: plans/plan-20260924-1600-p0-prepared-egress.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-24 16:59
> **Review File**: `tasks/reviews/20260924-1600-p0-prepared-egress.review.md`
> **Notes File**: `tasks/notes/20260924-1600-p0-prepared-egress.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

P0 用户 Turn 必须消费已经计数的 D，并以严格 message egress 完成；失配会造成 token 与实际输入脱节或未交付即 complete。

## Goal

完成冻结 Amendment 2 的 SDK S1–S3/S5/S6：wire v6 prepared egress、零 native 工具语义、pre-pin 拒绝及回归证据（S4 已由 orchestrator 移至官方迁移 WP）；仅本地提交。

## Scope

- In scope: protocol/cloud/client、spec/protocol 文档与 API golden、现有测试和任务工件。
- Out of scope: Pi fork、D serializer、14 项 admission 比较、Salesko 产品改动、provider 调用、push/publish。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

若当前 P0 的非空 MCP prepared session 或 text_delta 收集必须修改 fork，立即停止并报告。S4 零工具 session 已证实需 fork 改动，依裁定移出本次。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260924-1600-p0-prepared-egress.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260924-1600-p0-prepared-egress.review.md`
- Notes file: `tasks/notes/20260924-1600-p0-prepared-egress.notes.md`
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
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/protocol/
  - packages/cloud/
  - packages/client/
  - docs/spec.md
  - docs/protocol.md
  - scripts/api-surface/
  - api-surface/
  - plans/plan-20260924-1600-p0-prepared-egress.md
  - tasks/todos.md
  - tasks/contracts/20260924-1600-p0-prepared-egress.contract.md
  - tasks/reviews/20260924-1600-p0-prepared-egress.review.md
  - tasks/notes/20260924-1600-p0-prepared-egress.notes.md
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
  files_exist: []
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
  {
    "id": "build",
    "kind": "command",
    "command": "bun run build",
    "cwd": ".",
    "phase": "verification",
    "cost": "normal",
    "evidence_policy": "current_exact",
    "necessity": "生成所有 workspace 构建产物。",
    "inputs": {
      "env": []
    }
  },
  {
    "id": "typecheck",
    "kind": "command",
    "command": "bun run typecheck",
    "cwd": ".",
    "phase": "verification",
    "cost": "normal",
    "evidence_policy": "current_exact",
    "necessity": "验证 v6 调用点类型。",
    "inputs": {
      "env": []
    }
  },
  {
    "id": "test",
    "kind": "command",
    "command": "bun run test",
    "cwd": ".",
    "phase": "verification",
    "cost": "expensive",
    "evidence_policy": "current_exact",
    "necessity": "验证共享协议及完整离线回归。",
    "inputs": {
      "env": []
    }
  },
  {
    "id": "api-surface",
    "kind": "command",
    "command": "bun run check:api-surface",
    "cwd": ".",
    "phase": "verification",
    "cost": "normal",
    "evidence_policy": "current_exact",
    "necessity": "验证公开 API golden。",
    "inputs": {
      "env": []
    }
  },
  {
    "id": "version-authority",
    "kind": "command",
    "command": "bun run check:version-authority",
    "cwd": ".",
    "phase": "verification",
    "cost": "normal",
    "evidence_policy": "current_exact",
    "necessity": "确认单版本权威。",
    "inputs": {
      "env": []
    }
  },
  {
    "id": "release-pack",
    "kind": "command",
    "command": "bun run check:release-pack",
    "cwd": ".",
    "phase": "verification",
    "cost": "expensive",
    "evidence_policy": "current_exact",
    "necessity": "验证 tarball 与冻结 fork 身份。",
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
    "necessity": "验证任务治理。",
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

- Changed behavior/boundary, existing covering tests and remaining gap: v6 strict prepared egress; prepared-offer-lane and cloud enqueue cover ordering/admission; real Pi host tests cover zero native tools. S4 moved by orchestrator.
- New test case/file rationale, or why existing coverage is sufficient: extend existing suites to catch missing usage publish, premature completion, helper injection, pre-pin native rejection, old-token enqueue and real daemon sanitizer bypass.
- Selected check IDs and why their coverage is sufficient; omitted coverage: all seven user-required commands; no live provider, CI/publish, or Salesko integration in scope.
- Full/expensive check justification and expected cost, if applicable: public wire and native launch change require full suite plus isolated packed install; estimated 5–10 minutes for canonical matrix.
- Execution/baseline references, subject, current delta and disposition: base 99a1b238 with local P0 diff; /private/tmp/h5-salesko-prep-20260923/p0-sdk-logs; final frozen run follows focused regressions.
- Residual risks and incomplete observations: v6 drain required; S4 deferred; unrelated initial launch-cwd timeout recorded, no fix or relaxed assertion.

## Rollback Point

- Commit / checkpoint: 99a1b2387a4dd2dfa67921a8bd7187effa2005c8
- Revert strategy: 仅本地独立 worktree 的本任务提交可整体 revert；不操作其他 WIP。
