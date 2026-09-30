# Task Contract: context-usage-gap

> **Status**: Active
> **Plan**: plans/plan-20261001-0132-context-usage-gap.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: chris
> **Capability ID**: root
> **Last Updated**: 2026-10-01 01:32
> **Review File**: `tasks/reviews/20261001-0132-context-usage-gap.review.md`
> **Notes File**: `tasks/notes/20261001-0132-context-usage-gap.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

只读context UI不可混淆最后provider观测、估计和未知，不能让estimated进入token admission。

## Goal

基于main12ca4402写短研究，带字段来源与源码行号、Host消费例、falsifier/stop；Claude文档验收。仅新分支commit，无AI署名、不push/PR。

## Scope

只读trace与五份新研究/任务文档。safe path /Users/chris/Projects/byok-sdk-context-usage，codex/context-usage-gap。主checkout仅已授权pull；不动旧worktree，不改SDK/API/wire/Pi，不装插件/不provider/不建索引。

## Stop Conditions

architecture gate或daemon版本不匹配停报；不自行处理。需要SDK改动或provider请求则停止。未证不冒充runtime验证。

## Falsifier

若目标必须实时精确当前token占用，现有last-observed不能满足；提交具体UI验收需求后再研究最小只读增量，不擅改wire。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20261001-0132-context-usage-gap.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20261001-0132-context-usage-gap.review.md`
- Notes file: `tasks/notes/20261001-0132-context-usage-gap.notes.md`
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
{"protocol":1,"reviewer":"Claude","user_waiver":"forbidden"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/researches/2026-10-01-pi-context-usage-observation-gap.md
  - plans/plan-20261001-0132-context-usage-gap.md
  - tasks/contracts/20261001-0132-context-usage-gap.contract.md
  - tasks/notes/20261001-0132-context-usage-gap.notes.md
  - tasks/reviews/20261001-0132-context-usage-gap.review.md
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

```yaml
exit_criteria:
  files_exist:
    - docs/researches/2026-10-01-pi-context-usage-observation-gap.md
    - plans/plan-20261001-0132-context-usage-gap.md
    - tasks/contracts/20261001-0132-context-usage-gap.contract.md
    - tasks/notes/20261001-0132-context-usage-gap.notes.md
    - tasks/reviews/20261001-0132-context-usage-gap.review.md
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "diff",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "只读设计文档范围与治理",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "workflow",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "只读设计文档范围与治理",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes (Human Review)

docs-only。source locators核对、workflow strict必跑；build/typecheck/root test/api/version未跑，不报PASS，不安装dependencies。不调用prepare自动架构apply；若需要正式receipt且架构gate出现则停报。Claude内容验收未完成不自签receipt。

## Rollback Point

只revert本分支五份文档的授权commit，不修改其他worktree。
