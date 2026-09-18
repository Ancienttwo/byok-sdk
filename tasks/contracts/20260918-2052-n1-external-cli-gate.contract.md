# Task Contract: n1-external-cli-gate

> **Status**: Partial
> **Plan**: plans/plan-20260918-2052-n1-external-cli-gate.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-18 20:52
> **Review File**: `tasks/reviews/20260918-2052-n1-external-cli-gate.review.md`
> **Notes File**: `tasks/notes/20260918-2052-n1-external-cli-gate.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Owner 裁决：external-CLI lane 终态 = B（第六条 custody edge），首刀 = admission 门。现状 runner payload（custody 门控边）可在 SDK bundle 内经 external-cli-runner.ts:330 拉起持凭证外部 CLI 进程树，无 DescendantLaunchV1 / cap slot / launch record——D7 唯一在世的链外 delegation 边。无门则 B 落地前该盲区持续存在，且多租户 10x 下无界并发与成本失归因不可诊断。

## Goal

external-cli kind（claude-code / codex-exec / cursor-agent 三个 adapter 面及裸 external-cli）在 SDK custody 边界被 typed fail-closed 错误拒绝，所有可到达该 lane 的 SDK 侧入口（dispatcher admission / payload minting / subagent 定义注册）全覆盖；回归测试证明 typed rejection 且无第二路径；现有五边零回归。纯 SDK 面：零 vendored 文件、零 closure manifest 改动。

## Scope

- In scope：custody admission 门 + 定向回归测试 + todos 两行（B 终态 deferred goal、acceptance.ts 兄弟面定性行）+ 四件套 + push。
- Out of scope：B 本体设计包、charge table 扩展、vendored 任何文件、acceptance.ts 面、五边行为。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

构造 external-cli subagent 定义经 SDK 面提交 → 若任一路径仍能拉起外部二进制（或 payload 未被拒）= FAIL；diff 出现 vendored 文件 = FAIL；五边测试回归 = FAIL。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260918-2052-n1-external-cli-gate.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260918-2052-n1-external-cli-gate.review.md`
- Notes file: `tasks/notes/20260918-2052-n1-external-cli-gate.notes.md`
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
{"protocol":2,"reviewer":"gatekeeper","source":"independent-gate","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/custody/
  - packages/client/src/adapters/pi/
  - packages/client/src/__tests__/
  - tasks/todos.md
  - plans/plan-20260918-2052-n1-external-cli-gate.md
  - tasks/contracts/20260918-2052-n1-external-cli-gate.contract.md
  - tasks/reviews/20260918-2052-n1-external-cli-gate.review.md
  - tasks/notes/20260918-2052-n1-external-cli-gate.notes.md
```（vendored 与 closure manifest 硬禁）

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
    - plans/plan-20260918-2052-n1-external-cli-gate.md
  artifacts_exist:
    - tasks/notes/20260918-2052-n1-external-cli-gate.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {"id":"build","kind":"command","command":"bun run build","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"tree builds","inputs":{"env":[]}},
    {"id":"typecheck","kind":"command","command":"bun run typecheck","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"tree typechecks","inputs":{"env":[]}},
    {"id":"client-tests","kind":"command","command":"bun run --filter @byok-sdk/client test","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"full client suite incl. five-edge 零回归 + 新 gate 测试（已知本地项 pi-s2-bundle-resolution.test.ts:327 CI authoritative）","inputs":{"env":[]}},
    {"id":"api-surface","kind":"command","command":"bun run check:api-surface","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"golden","inputs":{"env":[]}},
    {"id":"version-authority","kind":"command","command":"bun run check:version-authority","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"version authority","inputs":{"env":[]}},
    {"id":"vendored-untouched","kind":"command","command":"git diff --name-only origin/main..HEAD | grep -c '^packages/client/vendor/' || true","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"输出必须为 0（vendored 零改动）","inputs":{"env":[]}},
    {"id":"no-conflict-markers","kind":"command","command":"! grep -rn '^<<<<<<<' packages/ scripts/ api-surface/ docs/ tasks/","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"zero markers","inputs":{"env":[]}}
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

- 行为变化：external-cli lane 从「未裁决可达」变「typed fail-closed 拒绝」——纯收紧，无既有消费者（已核验零引用）。
- 覆盖：新定向测试（typed rejection + 无第二路径）+ 既有 five-edge 套件零回归即覆盖面。
- 已知本地项：K1 tripwire（CI authoritative）。
- 行为 gate = push 后分支 CI 全绿。

## Rollback Point

- Commit / checkpoint: e0423d84（origin/main；reset --hard 恢复）
- Revert strategy: revert 单 commit；无数据/契约面
