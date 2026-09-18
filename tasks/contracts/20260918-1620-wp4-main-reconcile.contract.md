# Task Contract: wp4-main-reconcile

> **Status**: Partial
> **Plan**: plans/plan-20260918-1620-wp4-main-reconcile.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-18 16:20
> **Review File**: `tasks/reviews/20260918-1620-wp4-main-reconcile.review.md`
> **Notes File**: `tasks/notes/20260918-1620-wp4-main-reconcile.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

三段合流收尾（#193 已合 d882aef4；WP1 已合 PR #198 → main 49ec7477，Windows face 消除 receipt 在案）。WP4（420d1306）承载 custody 五边派发面（冻结设计 D1–D7，gatekeeper r2 PASS，CI 收据 35305890535）；不合流则 main 缺 custody 面。merge-tree 预检：冲突面仅 tasks/todos.md。

## Goal

wp4-main-reconcile 分支上一个 merge commit（parents 420d1306 + 49ec7477），todos.md ledger 合并保两侧行，其余全部 auto-merge 不手改；本地全矩阵绿（K1 已知项除外）；gatekeeper PASS 后由 orchestrator push。前向验收 = push 后 CI 全矩阵绿（已知红面已全部消除，无预留豁免）。

## Scope

- In scope：merge commit、todos.md ledger 合并、plan/contract/review/notes 四件套、push + CI watcher。
- Out of scope：产品语义改动、custody 冻结设计 D1–D7 任何调整、N1 external-CLI lane（Owner 裁决项）、WP4 合入 main 的 PR 开关（Owner-gated）。
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

diff 中出现 todos.md 以外的手改文件 = FAIL；todos.md 丢行（任一侧 ledger 行消失且非重复）= FAIL；custody 测试（custody-five-edge-dispatch 等）红 = FAIL。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260918-1620-wp4-main-reconcile.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260918-1620-wp4-main-reconcile.review.md`
- Notes file: `tasks/notes/20260918-1620-wp4-main-reconcile.notes.md`
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
  - tasks/todos.md
  - plans/plan-20260918-1605-wp4-main-reconcile.md
  - plans/plan-20260918-1620-wp4-main-reconcile.md
  - tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md
  - tasks/reviews/20260918-1620-wp4-main-reconcile.review.md
  - tasks/notes/20260918-1620-wp4-main-reconcile.notes.md
```（auto-merged 其余文件一律不手改）

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
    - plans/plan-20260918-1620-wp4-main-reconcile.md
  artifacts_exist:
    - tasks/notes/20260918-1620-wp4-main-reconcile.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {"id":"build","kind":"command","command":"bun run build","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"merged tree builds","inputs":{"env":[]}},
    {"id":"typecheck","kind":"command","command":"bun run typecheck","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"merged tree typechecks","inputs":{"env":[]}},
    {"id":"identity-tests","kind":"command","command":"bun run --filter @byok-sdk/implementation-identity test","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"identity package green","inputs":{"env":[]}},
    {"id":"client-tests","kind":"command","command":"bun run --filter @byok-sdk/client test","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"full client suite on merged tree incl. custody five-edge tests（已知本地项 pi-s2-bundle-resolution.test.ts:327 CI authoritative）","inputs":{"env":[]}},
    {"id":"api-surface","kind":"command","command":"bun run check:api-surface","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"api surface golden","inputs":{"env":[]}},
    {"id":"version-authority","kind":"command","command":"bun run check:version-authority","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"version authority","inputs":{"env":[]}},
    {"id":"no-conflict-markers","kind":"command","command":"! grep -rn '^<<<<<<<' packages/ scripts/ api-surface/ docs/ tasks/","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"zero leftover markers","inputs":{"env":[]}}
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

- 行为面：零产品语义改动。custody 五边启用（D1–D7 冻结 + 冻结 charge table）与 post-198 main 在树上叠加。
- 已知本地项：pi-s2-bundle-resolution.test.ts:327 本地 registry tripwire（CI authoritative，沿 1307/1507/1526 定性）。
- 行为 gate = push 后分支 CI；前向验收 = 全矩阵绿（无预留豁免——Windows face 已在 WP1 消除，flake 已在 6a7e6632 消除）。

## Rollback Point

- Commit / checkpoint: 420d1306（WP4 tip；`git reset --hard 420d1306` 恢复）
- Revert strategy: 本刀仅新增 merge commit + 四件套；revert 单 commit 即净
