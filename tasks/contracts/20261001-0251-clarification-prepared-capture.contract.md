# Task Contract: clarification-prepared-capture

> **Status**: Active
> **Plan**: plans/plan-20261001-0251-clarification-prepared-capture.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: chris
> **Capability ID**: root
> **Last Updated**: 2026-10-01 02:51
> **Review File**: `tasks/reviews/20261001-0251-clarification-prepared-capture.review.md`
> **Notes File**: `tasks/notes/20261001-0251-clarification-prepared-capture.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

补clarification设计§9.6的离线byte证据，不把stub Host测试误当prepared/provider验收。

## Goal

两个新测试资产证明新答案生成新的source/receipt/D，真实Pi launcher首请求等于自身D且不是旧D；保留ready=false与provider计数未证。短结论文档，独立Linux复跑，授权commit无AI署名，不push/PR。

## Scope

worktree /Users/chris/Projects/byok-sdk-prepared-capture，branch codex/clarification-prepared-capture，base708ed45b。仅两个获准client新测试资产与五文档，不改现有tests/fixtures或生产源/SDK出口/API/wire/Pi/package/lock，不碰examples现有文件。所有HTTP仅loopback，不装插件/不真实provider。

## Stop Conditions

需要生产改动、其他packages路径、architecture gate或daemon版本不匹配时停报，不自行处理/绕gate。生产receipt.ready不成立则明确局限，不伪造ready或生产counter。

## Falsifier

若第二个captured body!=第二个冻结D，或新答案仍复用旧source/receipt/D，测试失败；若fixture能ready=true却counter=test_fixture也必须失败，不改生产代码变绿。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20261001-0251-clarification-prepared-capture.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20261001-0251-clarification-prepared-capture.review.md`
- Notes file: `tasks/notes/20261001-0251-clarification-prepared-capture.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"focused","kind":"deterministic_test","paths":["packages/client/src/__tests__/clarification-prepared-capture.test.ts","packages/client/src/__tests__/fixtures/clarification-prepared-capture.ts"]},{"id":"native-loopback-readback","kind":"runtime_readback","paths":["packages/client/src/__tests__/fixtures/clarification-prepared-capture.ts"]}]}
```

focused 与 native-loopback-readback 均映射已有 focused check：two persisted receipts/Ds and own D；mixed old artifact zero transport。readback仅durable artifacts与真实native loopback request bytes，不是production计数/admission oracle。

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"forbidden"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/architecture/.projection-manifest.json
  - packages/client/src/__tests__/clarification-prepared-capture.test.ts
  - packages/client/src/__tests__/fixtures/clarification-prepared-capture.ts
  - docs/researches/2026-10-01-clarification-prepared-offline-capture.md
  - plans/plan-20261001-0251-clarification-prepared-capture.md
  - tasks/contracts/20261001-0251-clarification-prepared-capture.contract.md
  - tasks/notes/20261001-0251-clarification-prepared-capture.notes.md
  - tasks/reviews/20261001-0251-clarification-prepared-capture.review.md
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
    - packages/client/src/__tests__/clarification-prepared-capture.test.ts
    - packages/client/src/__tests__/fixtures/clarification-prepared-capture.ts
    - docs/researches/2026-10-01-clarification-prepared-offline-capture.md
    - plans/plan-20261001-0251-clarification-prepared-capture.md
    - tasks/contracts/20261001-0251-clarification-prepared-capture.contract.md
    - tasks/notes/20261001-0251-clarification-prepared-capture.notes.md
    - tasks/reviews/20261001-0251-clarification-prepared-capture.review.md
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "focused",
      "kind": "command",
      "command": "bun run --cwd packages/client test src/__tests__/clarification-prepared-capture.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "offline capture与required checks",
      "inputs": {
        "env": [
          "BYOK_TEST_BUN_BIN",
          "BYOK_REQUIRE_BUN"
        ]
      }
    },
    {
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "offline capture与required checks",
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
      "necessity": "offline capture与required checks",
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
      "necessity": "offline capture与required checks",
      "inputs": {
        "env": [
          "BYOK_TEST_BUN_BIN",
          "BYOK_REQUIRE_BUN"
        ]
      }
    },
    {
      "id": "api",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "offline capture与required checks",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "version",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "offline capture与required checks",
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
      "necessity": "offline capture与required checks",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes (Human Review)

预存 architecture gate，用户授权本切片处理；缺本地 CodeGraph 索引导致 verified-flow-proof-changed / proof 退化，恢复索引后 flowProofDigest=c105ee1286780504c1041f4587ff6c06a1d292ff18d33aa3359e656950ce1214。架构元数据变更与 prepared-capture 测试无关，可独立 revert。manifest provenance 是本地索引证据：branch codex/clarification-prepared-capture，base commit c146d18a；plan/apply 时尚未提交本轮元数据，不代表已提交完整状态。仅更新 manifest，不改 sdk-root/model/flow/P3。

监工明确两个packages测试资产例外。counter=test_fixture→receipt.ready=false，provider计数/真实production admission未证；native launcher直接消费持久化artifact只证明离线首请求bytes，不等于task.offer_prepared全链准入。clientvitest已设置BYOK_TEST_DEVICE_CREDENTIAL_STORE=1，真实Pi adapter支持mcpToolsets，无新stub改变能力；非rootLinux复跑。Bun测试本机env BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun BYOK_REQUIRE_BUN=1。

## Rollback Point

只revert七个allowed文件的新分支commit，旧worktree不动。
