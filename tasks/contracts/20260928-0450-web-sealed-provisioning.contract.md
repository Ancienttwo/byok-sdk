# Task Contract: web-sealed-provisioning

> **Status**: Active
> **Plan**: plans/plan-20260928-0450-web-sealed-provisioning.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-28 04:50
> **Review File**: `tasks/reviews/20260928-0450-web-sealed-provisioning.review.md`
> **Notes File**: `tasks/notes/20260928-0450-web-sealed-provisioning.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Owner 2026-09-28 裁定 provider API key 只能在网页输入；SDK 需要提供端到端封装、设备侧解封写入 OS 凭证库与 notice-and-fetch 信封，让 Host 不接触明文。

## Goal

完成 plan §6 的 SDK 切片 S1（core sealed secret HPKE P-256 + keys DeviceSealingKeyStore/replaceSecret/applySealedProviderProvisioning/D5 pending marker）、S2（protocol notice 信封与能力常量 + client daemon providerProvisioning seam）与 S3（集成与版本 bump，不发布）；仅本地提交，不 push、不发布。

## Scope

- In scope: packages/core、packages/keys、packages/protocol、packages/client、docs/spec.md 与 provisioning 相关文档、API golden、本 work-package 工件；scripts/release 只读运行检查。
- Out of scope: Salesko（H1–H4）、Pi fork、发布/push、custom endpoint、SAS、iframe 隔离、订阅通道（见 plan §8）。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

若 P-256 HPKE 在 Bun 或 Node 的 WebCrypto 下无法通过 RFC 9180 A.3 向量，或 keys 必须读取 client enrollment 私钥（违反 package graph），立即停止并报告。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260928-0450-web-sealed-provisioning.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260928-0450-web-sealed-provisioning.review.md`
- Notes file: `tasks/notes/20260928-0450-web-sealed-provisioning.notes.md`
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
  - docs/architecture/.projection-manifest.json
  - docs/architecture/modules/sdk/sdk-root.md
  - packages/core/
  - packages/keys/
  - packages/protocol/
  - packages/client/
  - docs/spec.md
  - docs/protocol.md
  - docs/security.md
  - scripts/api-surface/
  - api-surface/
  - scripts/release/
  - plans/plan-20260928-0450-web-sealed-provisioning.md
  - tasks/todos.md
  - tasks/contracts/20260928-0450-web-sealed-provisioning.contract.md
  - tasks/reviews/20260928-0450-web-sealed-provisioning.review.md
  - tasks/notes/20260928-0450-web-sealed-provisioning.notes.md
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
      "necessity": "验证 core/keys/protocol/client 新增类型。",
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
      "necessity": "验证 HPKE 向量、负控与完整离线回归。",
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
      "id": "package-graph",
      "kind": "command",
      "command": "node scripts/release/check-package-graph.mjs",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "确认 aligned 包不依赖 keys。",
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

- Changed behavior/boundary, existing covering tests and remaining gap: 待 S1/S2 实现后填写；S0 仅注册。
- New test case/file rationale, or why existing coverage is sufficient: RFC 9180 A.3 向量、AAD 篡改/keyId/过期/重放/未知 suite 负控、SIGKILL 切点、journal 无密文测试（plan §6 S1/S2）。
- Selected check IDs and why their coverage is sufficient; omitted coverage: 上列七项；浏览器矩阵与 Salesko 集成不在本仓范围。
- Full/expensive check justification and expected cost, if applicable: 新增密码学与持久化状态机，需全量离线测试。
- Execution/baseline references, subject, current delta and disposition: base e83e685f。
- Residual risks and incomplete observations: 恶意前端不在防御范围（plan §1）。

## Rollback Point

- Commit / checkpoint: e83e685fa8a7e27b714b0fb7b90668b19fc14a8e
- Revert strategy: 仅本 worktree 分支 claude/web-sealed-provisioning 的提交整体 revert；不操作主 checkout WIP。
