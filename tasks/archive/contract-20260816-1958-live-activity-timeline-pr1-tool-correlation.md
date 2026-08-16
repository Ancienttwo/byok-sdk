> **Archived**: 2026-08-16 19:58
> **Related Plan**: plans/archive/plan-20260816-1550-live-activity-timeline-pr1-tool-correlation.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260816-1958

# Task Contract: live-activity-timeline-pr1-tool-correlation

> **Status**: Fulfilled
> **Plan**: plans/plan-20260816-1550-live-activity-timeline-pr1-tool-correlation.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-16 15:50
> **Review File**: `tasks/reviews/20260816-1550-live-activity-timeline-pr1-tool-correlation.review.md`
> **Notes File**: `tasks/notes/20260816-1550-live-activity-timeline-pr1-tool-correlation.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Live Activity Timeline 只能在 runtime-native tool identity 与 outcome 被如实带上
`AgentEvent` 后可靠配对并发 tool calls。当前三 adapter 已能读到这些 provider
字段，却在 normalized wire 上丢弃；继续缺失会迫使 UI 依赖 FIFO、tool name 或
opaque output heuristic，违反单一 authority 与 no semantic fallback。PR 1 只闭合
observation contract，不提前修改 ActivityTail 或 UI runtime。

## Goal

以 additive optional wire fields 交付 tool observation contract：`tool_use` 与
`tool_result` 暴露 `toolCallId?: string`，`tool_result` 暴露
`isError?: boolean`；Claude、Codex、Pi adapters 映射各自 native identity，Claude/Pi
映射 native error outcome，Codex 在缺乏一等 outcome authority 时保持
`undefined`。Bundled adapters 对 native contract 中缺失或 malformed 的必需 ID
fail closed；Pi 0.84.1 packaging probe 证明真实 RPC JSONL frame 携带 ID/outcome。

## Scope

- In scope: protocol AgentEvent schema/golden；Claude/Codex/Pi event mapping；相关
  adapter/unit fixtures；Pi pinned 0.84.1 live packaging probe；本 task 的 workflow
  artifacts 与 verification evidence。
- Out of scope: ActivityTail/cloud projection、`@byok-sdk/ui-runtime`、host BFF、
  approval lifecycle、package manifests/lockfile、database、release/publish。
- Taste constraints: wire optional 仅服务 N/N-1/custom adapter；bundled adapter 不得
  silent fallback。禁止从 tool name、FIFO、时间邻近或 opaque output 推断 identity/
  outcome。`needs_approval` contract 零改动。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

若 pinned provider frames 不提供稳定 native ID，或字段只在非 RPC 内部事件存在，
则直接映射方向错误。最便宜证明点是三家现有 captured fixtures 与 installed pinned
Pi 0.84.1 RPC mode source/live probe；任何矛盾必须停止并保持 wire 值 absent，绝不
合成 ID。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260816-1550-live-activity-timeline-pr1-tool-correlation.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260816-1550-live-activity-timeline-pr1-tool-correlation.review.md`
- Notes file: `tasks/notes/20260816-1550-live-activity-timeline-pr1-tool-correlation.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"sdk-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"pi-0841-installed-rpc-probe","kind":"runtime_readback","paths":["packages/client/src/__tests__/fixtures/pi-rpc-0.84.1-live-probe.mjs","packages/client/src/__tests__/pi-rpc-packaging-probe.test.ts","packages/client/src/adapters/pi/events.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260816-1550-live-activity-timeline-pr1-tool-correlation.contract.md
  - tasks/reviews/20260816-1550-live-activity-timeline-pr1-tool-correlation.review.md
  - tasks/notes/20260816-1550-live-activity-timeline-pr1-tool-correlation.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - packages/protocol/src/agent-event.ts
  - packages/protocol/src/__tests__/agent-event.test.ts
  - packages/protocol/src/__tests__/freeze-guard.test.ts
  - packages/protocol/src/__tests__/golden/v1.frozen.json
  - packages/client/src/adapters/claude/
  - packages/client/src/adapters/codex/
  - packages/client/src/adapters/pi/
  - packages/client/src/__tests__/
  - packages/client/scripts/
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
      purpose: protocol_and_adapter_implementation
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
    - packages/protocol/src/agent-event.ts
    - packages/protocol/src/__tests__/golden/v1.frozen.json
    - packages/client/src/adapters/claude/events.ts
    - packages/client/src/adapters/codex/events.ts
    - packages/client/src/adapters/pi/events.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260816-1550-live-activity-timeline-pr1-tool-correlation.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/agent-event.test.ts
    - path: packages/protocol/src/__tests__/freeze-guard.test.ts
    - path: packages/client/src/__tests__/claude-events.test.ts
    - path: packages/client/src/__tests__/codex-events.test.ts
    - path: packages/client/src/__tests__/pi-events.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: normalized tool use/result carry provider-native correlation;
  error outcome stays three-state and authority-owned.
- Edge cases: same-name concurrent calls remain distinct；result error true/false；wire
  fields absent for N/N-1/custom adapters；bundled malformed native ID fails closed；
  `needs_approval` unchanged。
- Regression risks: schema golden drift；provider frames changing under the pinned package；
  accidentally treating Codex output/status as stable outcome authority。

## Rollback Point

- Commit / checkpoint: `0d99be9d4690e0d1bbed7ca78cbca069b65084f4` plus the
  pre-existing worker partial diff in `packages/protocol/src/agent-event.ts`.
- Revert strategy: revert only this contract's allowed product/test diff and regenerated
  golden; no data, deployment, or runtime migration exists.
