# Task Contract: official-pi-migration

> **Status**: Fulfilled
> **Plan**: plans/plan-20260919-1603-official-pi-migration.md
> **Task Profile**: migration
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-19 16:10
> **Review File**: `tasks/reviews/20260919-1603-official-pi-migration.review.md`
> **Notes File**: `tasks/notes/20260919-1603-official-pi-migration.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

BYOK SDK 的活动运行依赖当前是自维护 Pi fork（`npm:@byok-sdk/pi-coding-agent@0.85.1005`、`npm:@byok-sdk/pi-ai@0.85.1005`）。fork 的维护成本、来源可解释性与发布风险都落在 BYOK 自己头上；`@byok-sdk/pi-coding-agent` 在 npm 上没有 `gitHead`、没有 provenance attestation，仓库字段只指向上游 URL，无法把已发布字节绑回一个可核对的构建提交。Official Pi Migration 方案（OP0–OP8）要把活动依赖换成官方未修改发行包 + BYOK 小型适配层。

在没有先固定官方发行基线、也没有先证明「官方公开接口能满足 task-free preparation / 授权历史注入 / 最终请求消费 / 装载约束」之前切换产品依赖，会把一个不可验证的替代品塞进产品路径。本契约先闭 OP0（发行基线 + fork 增量清单 + 写范围登记），再按 OP1（五项有界 probe）判定 G1。

## Goal

在独立 worktree `byok-sdk-wt-official-pi`（branch `codex/official-pi-migration`，基线 `origin/main@79f6a0d`）完成 OP0 与 OP1 的证据面：

1. OP0：固定一个官方正式发行候选（名称/版本/tarball integrity/发布仓库-commit 对应/exports/engines/完整传递依赖/生命周期脚本），清点当前 fork 包的上游 base 与真实字节增量，产出一份符合方案 §6.2 必填列的 fork-delta-map，以及 `official-pi-baseline.json` 工程证据。**不切换产品依赖、不改 lock、不改根 manifest、不执行实际模型。**
2. OP1：在真实官方 npm tarball、临时目录、独立子进程上运行 P01–P05 五项有界 probe，输出可运行证据、失败案例与逐项实际网络/工具调用计数，并按方案 §7.2 给出 G1 裁定。

## Scope

- In scope: `docs/researches/` 下的两份 OP0 证据产物；OP1 probe 的登记实验目录与其最小可运行脚本；本 plan/contract/review/notes 登记与收口；`tasks/todos.md` deferred ledger。
- Out of scope: 任何产品依赖切换（`packages/**/package.json`、`bun.lock`、根 manifest）、身份 gate 重写（`scripts/release/pi-runtime-identity.mjs`）、Host 侧改动、Salesko 侧改动、真实付费 provider 调用、安装/发布/迁移操作。OP0/OP1 不得改旧资料字节（既存 reports、冻结契约、历史 evidence）。
- Taste constraints: probe 只用真实官方 tarball；禁止 private deep import、禁止 patch package、禁止复制 Pi serializer、禁止全局 fetch/undici monkey patch；"能启动"不得写成"去 fork 完成"。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

若官方发行候选的 tarball integrity 无法在本机独立复算，或该候选的 exports 面根本不导出 Session/ResourceLoader 级公开入口，则「官方发行包可作候选基座」不成立——此时 OP1 的结论只能是 G1 的第三档（该技术路径拒绝），而不是继续适配。最便宜的先行验证点：下载官方 tarball 并复算 sha512/sha256，再读其 `package.json` exports。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

## Workflow Inventory

- Source plan: `plans/plan-20260919-1603-official-pi-migration.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260919-1603-official-pi-migration.review.md`
- Notes file: `tasks/notes/20260919-1603-official-pi-migration.notes.md`
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
  - plans/plan-20260919-1603-official-pi-migration.md
  # OP0 两份工程证据产物
  - docs/researches/2026-09-19-official-pi-baseline.json
  - docs/researches/2026-09-19-official-pi-fork-delta-map.md
  - tasks/contracts/20260919-1603-official-pi-migration.contract.md
  - tasks/reviews/20260919-1603-official-pi-migration.review.md
  - tasks/notes/20260919-1603-official-pi-migration.notes.md
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
      purpose: codebase_and_artifact_research
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
    - plans/plan-20260919-1603-official-pi-migration.md
    - docs/researches/2026-09-19-official-pi-baseline.json
    - docs/researches/2026-09-19-official-pi-fork-delta-map.md
    - tasks/contracts/20260919-1603-official-pi-migration.contract.md
    - tasks/notes/20260919-1603-official-pi-migration.notes.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260919-1603-official-pi-migration.notes.md
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
    },
    {
      "id": "baseline-json-parse",
      "kind": "command",
      "command": "node -e \"const fs=require('fs');const b=JSON.parse(fs.readFileSync('docs/researches/2026-09-19-official-pi-baseline.json','utf8'));const p=b.officialCandidate.packages[0];if(b.notProductConfig!==true)throw new Error('baseline must declare notProductConfig');if(!p.integrity.startsWith('sha512-'))throw new Error('missing integrity');if(p.gitHead!=='d981de1229ef899957bbe968bc8dcda02a21f477')throw new Error('gitHead drift');if(!fs.existsSync(b.forkDeltaSummary.detailArtifact))throw new Error('delta map missing');if(b.verification.registryIntegrityMatches!==true)throw new Error('integrity not verified');console.log('baseline-json-parse OK')\"",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "OP0 evidence artifact must parse and keep the frozen official candidate identity.",
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

- Changed behavior/boundary, existing covering tests and remaining gap: OP0/OP1 属证据与可行性 probe 面，不改产品行为。剩余 gap：OP1 五项 probe 尚未执行；G1 未裁定；产品依赖仍指向 fork。
