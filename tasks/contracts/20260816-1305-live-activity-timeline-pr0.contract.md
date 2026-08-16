# Task Contract: live-activity-timeline-pr0

> **Status**: Fulfilled
> **Plan**: plans/plan-20260816-1305-live-activity-timeline-pr0.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-16 13:08
> **Review File**: `tasks/reviews/20260816-1305-live-activity-timeline-pr0.review.md`
> **Notes File**: `tasks/notes/20260816-1305-live-activity-timeline-pr0.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`docs/spec.md` 当前没有 UI runtime 产品边界，但 proposal 后续四个实现
work package 会同时修改 frozen wire、公开 `ActivityTail`、新增 package 与 host
读取边界。若不先裁决，`output-error` 会从 opaque output 被猜出来、text fixture
会被误升格为 transcript 语义，或旧 string tail 与 typed tail 形成双 authority。
PR 0 只冻结产品 contract，使实现 slice 不能各自重开这些决定。

## Goal

完成一个 docs-only 产品边界决策：V1 是 bounded、lossy、read-only Live
Activity Timeline；future `@byok-sdk/ui-runtime` 是 React-free pure fold；wire
观察字段是 `toolCallId?` 与 `tool_result.isError?`；text 保留 fragments、unknown
保留原位；typed `ActivityTail` 以协调式 breaking replacement 维持单一
`readActivity` authority；browser auth/redaction 属 host BFF。proposal 与 spec
必须一致，且不得改任何产品代码、schema、golden、manifest 或数据库。

## Scope

- In scope: `docs/spec.md` product boundary、Live Activity Timeline proposal 修订、
  本 plan/contract/notes/review 与 workflow state。
- Out of scope:
  - 任何 `packages/**` 产品代码、测试、manifest 或 protocol golden 修改。
  - 创建 `packages/ui-runtime`、改 wire schema、改 ActivityTail 存储或新增 browser route。
  - deepseek presentation 组件移植、approval timeline、canonical transcript。
  - commit、push、PR、merge、release 或部署。
- Taste constraints: current state 与 staged target 必须分开；一份 activity
  authority；无 output heuristic、text semantic join、legacy detail parser、dual
  endpoint 或 bundled-adapter silent fallback。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

方向在以下任一事实成立时错误：现有 protocol 已有一等 tool identity/outcome；
`ActivityTail` 不是公开 host control-plane contract；或 proposal/spec 声称 future
surface 已实现。最便宜证明点是检查 `agent-event.ts`、`core/presence.ts`、
`cloud.ts:readActivity` 与最终 docs diff。当前源码已证明前两项均不存在，docs 必须
继续用 staged/future 措辞。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260816-1305-live-activity-timeline-pr0.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260816-1305-live-activity-timeline-pr0.review.md`
- Notes file: `tasks/notes/20260816-1305-live-activity-timeline-pr0.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md
  - plans/plan-20260816-1305-live-activity-timeline-pr0.md
  - tasks/current.md
  - tasks/todos.md
  - tasks/contracts/20260816-1305-live-activity-timeline-pr0.contract.md
  - tasks/reviews/20260816-1305-live-activity-timeline-pr0.review.md
  - tasks/notes/20260816-1305-live-activity-timeline-pr0.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
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
      - main-thread
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
    - docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md
    - plans/plan-20260816-1305-live-activity-timeline-pr0.md
    - tasks/contracts/20260816-1305-live-activity-timeline-pr0.contract.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260816-1305-live-activity-timeline-pr0.notes.md
  tests_pass: []
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: docs-only；不改变当前 runtime。
- Edge cases: N/N-1 缺 ID、error outcome unknown、unknown event ordering、TTL drain migration均有明确语义。
- Regression risks: spec 可能被误读为已实现；以 staged/future 措辞与产品代码零 diff 守卫。

## Rollback Point

- Commit / checkpoint: 当前 main 基线；本 work package 尚未提交。
- Revert strategy: revert proposal/spec/workflow artifact diff；无 runtime 或数据回滚。
