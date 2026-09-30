# Task Contract: saas-bot-clarification-design

> **Status**: Active
> **Plan**: plans/plan-20260930-1907-saas-bot-clarification-design.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: chris
> **Capability ID**: root
> **Last Updated**: 2026-09-30 19:07
> **Review File**: `tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md`
> **Notes File**: `tasks/notes/20260930-1907-saas-bot-clarification-design.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

无人值守 SaaS Bot 需要持久化、跨进程的 clarification；不能把 TUI ask 或 permission approval 当成远程问答。

## Goal

按已验收 A 设计实施 copy-and-own Host clarification reference：single_choice/text、strict parser、SQLite ticket/answer CAS、notification outbox、exact fresh dispatch outbox、注入时钟。文档+代码同一 commit，无 AI 署名；不 push/PR。

## Scope

- In scope: examples/basic clarification 文件、tsconfig include、README 使用入口，研究和任务文档。
- Out of scope: packages/**、API/wire/Pi pin、server.ts、pi-ask、provider、架构模型、push/PR。
- Safe path: /Users/chris/Projects/byok-sdk-clarification，codex/clarification-design；已 fast-forward main 186e210c，保留原设计 trace 基线 d61eaff4。主 checkout/pi099 不写。
- 用户明确授权 implementation 与文档+代码 commit，Claude 独立验收后签 receipt。

## Stop Conditions

需要越过 allowed_paths、缺 public SDK 导出、真实 provider、architecture gate 或 contract_not_committed 时停报。不手写 receipt、不旁路 gate、不改共享工具。

## Falsifier

若真实消费者必须保留无法 checkpoint/rebuild 的 native run 状态才能回答后继续，A 不充分；先用可复现 stub/native 场景反证，再提 B。

## Root Cause Evidence

不适用：这是设计研究，不是 bugfix。

## Workflow Inventory

- Source plan: `plans/plan-20260930-1907-saas-bot-clarification-design.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md`
- Notes file: `tasks/notes/20260930-1907-saas-bot-clarification-design.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"example-tests","kind":"deterministic_test","paths":["examples/basic/clarification.ts","examples/basic/clarification-store.ts","examples/basic/clarification.test.ts"]},{"id":"clarification-sdk-readback","kind":"runtime_readback","paths":["examples/basic/clarification.ts","examples/basic/clarification.test.ts"]}]}
```

example-tests 对应 Verification Plan 的 example-tests。runtime_readback 只消费同一测试的 byok.tasks.offer/attempt/deviceTerminal exact taskId 读回，例如 single_choice terminal→fresh、restart reserve recovery、sending cancel、real home busy decline；不是 native/provider oracle。

## Acceptance Policy

```json
{"protocol": 1, "reviewer": "Claude", "user_waiver": "forbidden"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/researches/2026-09-30-saas-bot-clarification-design.md
  - plans/plan-20260930-1907-saas-bot-clarification-design.md
  - tasks/contracts/20260930-1907-saas-bot-clarification-design.contract.md
  - tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md
  - tasks/notes/20260930-1907-saas-bot-clarification-design.notes.md
  - examples/basic/clarification.ts
  - examples/basic/clarification-store.ts
  - examples/basic/clarification.test.ts
  - examples/basic/clarification-usage.md
  - examples/basic/README.md
  - examples/basic/tsconfig.json
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
    - docs/researches/2026-09-30-saas-bot-clarification-design.md
    - plans/plan-20260930-1907-saas-bot-clarification-design.md
    - tasks/contracts/20260930-1907-saas-bot-clarification-design.contract.md
    - tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md
    - tasks/notes/20260930-1907-saas-bot-clarification-design.notes.md
    - examples/basic/clarification.ts
    - examples/basic/clarification-store.ts
    - examples/basic/clarification.test.ts
    - examples/basic/clarification-usage.md
    - examples/basic/README.md
    - examples/basic/tsconfig.json
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "example-tests",
      "kind": "command",
      "command": "bun run --cwd examples/basic test",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "实施与仓库 required checks",
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
      "necessity": "实施与仓库 required checks",
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
      "necessity": "实施与仓库 required checks",
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
      "necessity": "实施与仓库 required checks",
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
      "necessity": "实施与仓库 required checks",
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
      "necessity": "实施与仓库 required checks",
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
      "necessity": "实施与仓库 required checks",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes (Human Review)

用户已授权实施与 commit。Claude 文档验收认可 A/B，未来参考实施覆盖设计 §9 的 1-5；§9.6 prepared capture 不做，明确未证。测试真实 HTTP/stub daemon 与两 SQLite connection，fake clock。CI credential flag 与 mcpToolsets:true 沿用 main；非 root Linux Docker 独立测试。本机 BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun、BYOK_REQUIRE_BUN=1（CI 同名 env）用于 root 与 example。运行结果逐项记 notes，不将未执行写 PASS。Formal receipt 仍需 Claude，不手写 projection。

## Rollback Point

base 186e210c；仅本切片 allowed 文件，可独立 revert 用户授权的 commit，不动其他 worktree。
