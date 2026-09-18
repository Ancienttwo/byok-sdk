# Task Contract: wp3-charge-once-red

> **Status**: Active
> **Plan**: plans/plan-20260917-1545-wp3-charge-once-red.md
> **Task Profile**: code-change（测试编写，RED 刻意）
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-17 15:48
> **Review File**: `tasks/reviews/20260917-1545-wp3-charge-once-red.review.md`
> **Notes File**: `tasks/notes/20260917-1545-wp3-charge-once-red.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Owner 裁定（2026-09-17）WP3 执行顺序：先冻结 charge-once 计数表，再建立可复现的双扣失败测试，最后才修 vendor 接线。没有 RED 测试，接线修复无法证明消除了「一次逻辑委派扣 2 层」的冲突，也无法防止回归。

## Goal

在未修复的 vendor 接线上，用真实 spawn 链（rpc→runner→print）复现双扣：print 子代观察到的深度投影为物理 2，冻结表契约为 1；新增测试断言契约值 1，因现状物理 2 而红。修接线（后续切片）后同一测试转绿。

## Scope

- In scope: 新增一个测试文件 `packages/client/src/__tests__/custody-charge-once-double-charge.test.ts`（可含 __tests__ 内测试自有 fixture）、RED 运行产物捕获、typecheck。
- Out of scope: vendor 源码修改、maxDepth/root 语义、既有断言放宽、dispatcher 启用、任何产品代码。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if真实 spawn 链无法在测试环境驱动（如需网络/真实模型 key）：上报 BLOCKED，不得改用 mock 深度逻辑顶替。

## Falsifier

新测试在当前接线上意外转绿（物理深度已是 1），或测试红的原因与深度断言无关（如 fixture 错误）——都说明双扣未被真实复现。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.（本切片是 bugfix 的前置 regression guard 创作，RED 产物按 Exit Criteria/Verification Plan 登记；Root Cause Evidence 四字段在接线修复切片补齐。）

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260917-1545-wp3-charge-once-red.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260917-1545-wp3-charge-once-red.review.md`
- Notes file: `tasks/notes/20260917-1545-wp3-charge-once-red.notes.md`
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
  - plans/plan-20260917-1545-wp3-charge-once-red.md
  - tasks/contracts/20260917-1545-wp3-charge-once-red.contract.md
  - tasks/reviews/20260917-1545-wp3-charge-once-red.review.md
  - tasks/notes/20260917-1545-wp3-charge-once-red.notes.md
  - tasks/notes/20260917-1545-wp3-charge-once-red.red-run.txt
  - packages/client/src/__tests__/custody-charge-once-double-charge.test.ts
  - packages/client/src/__tests__/fixtures/
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
    - packages/client/src/__tests__/custody-charge-once-double-charge.test.ts
  artifacts_exist:
    - tasks/notes/20260917-1545-wp3-charge-once-red.red-run.txt
    - .ai/harness/checks/latest.json
    - tasks/notes/20260917-1545-wp3-charge-once-red.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "red-test-is-red",
      "kind": "command",
      "command": "bun test packages/client/src/__tests__/custody-charge-once-double-charge.test.ts > tasks/notes/20260917-1545-wp3-charge-once-red.red-run.txt 2>&1; ec=$?; echo \"RED_EXIT=$ec\" >> tasks/notes/20260917-1545-wp3-charge-once-red.red-run.txt; grep -q 'custody-charge-once-double-charge' tasks/notes/20260917-1545-wp3-charge-once-red.red-run.txt && test $ec -ne 0",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "RED 刻意：未修接线上该测试必须非零退出（双扣复现），且产物含测试路径字符串。",
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
      "necessity": "新测试文件类型正确。",
      "inputs": {
        "env": []
      }
    },
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

- Changed behavior/boundary, existing covering tests and remaining gap: 仅新增测试；vendor 行为零变更。剩余 gap = 接线修复切片（③）。
- New test case/file rationale, or why existing coverage is sufficient: 无既有测试覆盖深度计费契约；本文件即未来修复的 regression guard。
- Selected check IDs and why their coverage is sufficient; omitted coverage: red-test-is-red（RED 语义）+ typecheck + diff-whitespace；`bun run test` 全量刻意省略——新测试刻意红会使全量红，全量绿门挪到接线修复切片。
- Full/expensive check justification and expected cost, if applicable: 无。
- Execution/baseline references, subject, current delta and disposition: 基线 d4dcf961 worktree claude/wp3-custody-wiring；依赖已 bun install。
- Residual risks and incomplete observations: RED 真实性（非 trivially-failing）由 gatekeeper 复核；真实 spawn 链若需外部资源则 BLOCKED 上报。

## Rollback Point

- Commit / checkpoint: 分支 claude/wp3-custody-wiring 本地 commit（基线 d4dcf961）。
- Revert strategy: 删除新增测试文件与 red-run 产物，回到 d4dcf961 树状态；无产品代码可回滚。
