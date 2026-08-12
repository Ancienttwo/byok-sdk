> **Archived**: 2026-08-13 01:50
> **Related Plan**: plans/archive/plan-20260813-0023-skill-pack-delivery-channel.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260813-0150

# Task Contract: skill-pack-delivery-channel

> **Status**: Fulfilled
> **Plan**: plans/plan-20260813-0023-skill-pack-delivery-channel.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-13 00:23
> **Review File**: `tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md`
> **Notes File**: `tasks/notes/20260813-0023-skill-pack-delivery-channel.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

salesko 方向的下一步是把 SaaS 侧策划的内容资产（技能包）分发到用户机器上的 coding agent；这是本次 hermes/buzz 研究（`docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md` §3）唯一有真实下游拉力的萃取项。做错的代价：若触碰 frozen-v1 envelope 或凭证边界，会破坏协议冻结纪律与凭证隔离铁律；若声明的限制不带求值点（buzz 教训），会出现「看起来受限、实际全通」的安全声明脱节。

## Goal

交付 Phase 1（本 contract 的 merge 单元）：`skills.pack` capability 端到端可用于 in-memory 组合——core 的 `SkillPackManifestSchema` + `SkillPackStore` port（含契约表登记）+ in-memory 实现；cloud 的 `GET /byok/skill-packs` handlers + capability 声明；client 的安装管线（fetch→路径/尺寸/hash 校验→content-addressed store→lock.json→审计）与 `listInstalledSkillPacks`/`projectSkillPack` API；「长任务 Git 工作流」fixture 载荷；全部拒绝路径测试与 freeze-guard 零 diff。Phase 2（cloud-postgres 持久化 + conformance）在 Phase 1 合入后另立 contract。

## Scope

- In scope: `packages/core`（schema/port/in-memory/常量）、`packages/cloud`（handlers + capability）、`packages/client`（安装管线 + 公开 API + fixture）、`docs/spec.md` 能力条目、`docs/architecture/sdk-architecture.md` 增量。
- Out of scope: `packages/protocol` 任何改动（freeze-guard 零 diff 是硬验收）；cloud-postgres/conformance（Phase 2）；多源 marketplace、安全扫描器、vendor CLI 目录自动挂载、推送式分发、agent 技能上行。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

方向性假设：salesko 要的是「SaaS→device 拉取式声明内容分发」。证伪证据：salesko 确认其内容资产必须即时推送、或必须携带可执行组件（脚本/hook）。最便宜的验证点：plan 冻结后、实现开始前，向 salesko 发一句话确认（拉取语义 + 纯声明内容是否满足首个用例）；若证伪，管线与 store 不变，推送触发信号或执行语义作为独立后续裁定，不在本 contract 内偷渡。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260813-0023-skill-pack-delivery-channel.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md`
- Notes file: `tasks/notes/20260813-0023-skill-pack-delivery-channel.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/architecture/sdk-architecture.md
  - plans/plan-20260813-0023-skill-pack-delivery-channel.md
  - tasks/todos.md
  - tasks/contracts/20260813-0023-skill-pack-delivery-channel.contract.md
  - tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md
  - tasks/notes/20260813-0023-skill-pack-delivery-channel.notes.md
  - packages/core/
  - packages/cloud/
  - packages/client/
  - pnpm-lock.yaml
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
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/core/src/skill-pack.ts
    - packages/client/src/__tests__/fixtures/skill-packs/long-task-git-workflow/SKILL.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260813-0023-skill-pack-delivery-channel.notes.md
  tests_pass:
    - path: packages/core/src/__tests__/skill-pack.test.ts
    - path: packages/client/src/__tests__/skill-pack-install.test.ts
    - path: packages/protocol/src/__tests__/freeze-guard.test.ts
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: contract worktree 的 base commit（start 时由 harness 记录到 worktree marker）。
- Revert strategy: Phase 1 无持久化迁移与 wire 改动，revert 单 PR 即净；SDK store 目录（`<dataDir>/skill-packs/`）为新增路径，无既有数据可损。
