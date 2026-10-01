# Task Contract: pi-telemetry-closure-pin

> **Status**: Active
> **Plan**: plans/plan-20261001-0545-pi-telemetry-closure-pin.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: chris
> **Capability ID**: root
> **Last Updated**: 2026-10-01 05:45
> **Review File**: `tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md`
> **Notes File**: `tasks/notes/20261001-0545-pi-telemetry-closure-pin.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

client tarball消费者不继承workspace root overrides；closure-approved传递Pi依赖caret会漂移到0.99.2，破坏installed official identity。

## Goal

监工已OK：client dependencies补chord/codemode/mcp/telemetry/tui五个exact0.99.1，lock仅client workspace五项；同一隔离pack/install baseline red→after green。运行required与graph/closure相关tests，授权commit，无AI署名，不push/PR。

## Scope

base708ed45b，/Users/chris/Projects/byok-sdk-pi-telemetry-pin，codex/pin-pi-telemetry。仅两生产metadata文件和四task文档。closure/byok.piRuntimePin/rootpackage/API/wire/脚本/测试不改。PR243 OPEN，未改这两个文件；旧worktree不动。

## Stop Conditions

需要修改其他脚本/测试、lock resolved Pi版本或其他workspace条目、closure/API/wire、仅pin仍nested漂移、architecture gate或daemon mismatch时停报；不扩shrinkwrap/bundling。

## Falsifier

若client exact直接pin仍不能让同一隔离npm install的official closure验证通过，方案不充分，停报。若baseline无法复现目标identity mismatch则不归因/不假红。

## Root Cause Evidence

- root_cause: packages/client/package.json:102-103未声明closure的五个exact传递包；isolated npm解析pi-telemetry0.99.2，official-pi-installation.mjs:36拒绝。
- repro: node scripts/release/pack-and-smoke.mjs --out-dir /tmp/pi-telemetry-baseline-tarballs
- regression_guard: scripts/release/pack-and-smoke.mjs
- pre_fix_failure_artifact: /tmp/pi-telemetry-pre-fix.log


## Workflow Inventory

- Source plan: `plans/plan-20261001-0545-pi-telemetry-closure-pin.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md`
- Notes file: `tasks/notes/20261001-0545-pi-telemetry-closure-pin.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"isolated-pack-readback","kind":"runtime_readback","paths":["packages/client/package.json","bun.lock"]},{"id":"closure-tests","kind":"deterministic_test","paths":["packages/client/package.json","bun.lock"]}]}
```

isolated-pack-readback映射pack检查，已有official安装readback；closure-tests映射closure已有测试及graph检查。无新测试/生产runtime。

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"forbidden"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/package.json
  - bun.lock
  - plans/plan-20261001-0545-pi-telemetry-closure-pin.md
  - tasks/contracts/20261001-0545-pi-telemetry-closure-pin.contract.md
  - tasks/notes/20261001-0545-pi-telemetry-closure-pin.notes.md
  - tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md
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
    - packages/client/package.json
    - bun.lock
    - plans/plan-20261001-0545-pi-telemetry-closure-pin.md
    - tasks/contracts/20261001-0545-pi-telemetry-closure-pin.contract.md
    - tasks/notes/20261001-0545-pi-telemetry-closure-pin.notes.md
    - tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "pack",
      "kind": "command",
      "command": "node scripts/release/pack-and-smoke.mjs --out-dir /tmp/pi-telemetry-baseline-tarballs",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "原pack回归、依赖图及closure或required checks",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "graph",
      "kind": "command",
      "command": "bun run check:release-graph",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "原pack回归、依赖图及closure或required checks",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "closure",
      "kind": "command",
      "command": "bun run --cwd packages/client test src/__tests__/official-pi-closure.test.ts src/__tests__/dist-subpath-closure.test.ts src/__tests__/pi-sealed-factory-closure.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "原pack回归、依赖图及closure或required checks",
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
      "necessity": "原pack回归、依赖图及closure或required checks",
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
      "necessity": "原pack回归、依赖图及closure或required checks",
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
      "necessity": "原pack回归、依赖图及closure或required checks",
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
      "necessity": "原pack回归、依赖图及closure或required checks",
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
      "necessity": "原pack回归、依赖图及closure或required checks",
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
      "necessity": "原pack回归、依赖图及closure或required checks",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes (Human Review)

监工已明确OK direct five pins。官方npm overrides仅root生效，依赖自己的overrides不影响consumer；因此不加client overrides。八closure包全部0.99.1，最新registry八包均0.99.2；三已direct固定，五补齐。baseline frozen install/build0，pack1目标telemetryidentity mismatch（/tmp/pi-telemetry-baseline-pack.log）。红绿同命令与原脚本；不削弱guard，任一脚本/测试需改就停。root/closure env BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun BYOK_REQUIRE_BUN=1。

## Rollback Point

仅本分支六allowed文件的commit，可独立revert，不动旧worktree。
