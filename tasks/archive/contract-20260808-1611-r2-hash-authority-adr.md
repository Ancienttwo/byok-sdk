> **Archived**: 2026-08-08 16:11
> **Related Plan**: plans/archive/plan-20260808-1542-r2-hash-authority-adr.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260808-1611

# Task Contract: r2-hash-authority-adr

> **Status**: Fulfilled
> **Plan**: plans/plan-20260808-1542-r2-hash-authority-adr.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-08 16:00
> **Review File**: `tasks/reviews/20260808-1542-r2-hash-authority-adr.review.md`
> **Notes File**: `tasks/notes/20260808-1542-r2-hash-authority-adr.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

S4B 的 GC/reconcile 必须先知道 object identity 的权威来源。S4A-c 已证明 R2 `HEAD` 只观测存在性、size 与 content-type；R2 当前也不支持 PutObject SHA-256 `FULL_OBJECT` checksum。若在裁定前推进 S4B，现有 `StorageFinalizeInput.observedContentHash` 会诱使实现把 reservation 自身的 hash 冒充观测值，或在冻结的 `object_manifest` 四态之外增加无事实基础的 `hash_verified` 状态。

该决定横跨 daemon、cloud、Postgres manifest 与 R2 bytes 的责任边界。错误地把 `committed` 写成 cloud-verified digest 会形成无法由 runtime 兑现的安全承诺；为未来 checksum 能力预埋双模式又会违反单一 source of truth 与 no compatibility fallback 约束。

## Goal

交付 ADR-024 `Accepted`：配对且通过认证的 daemon 声明是 canonical SHA-256 authority；cloud 不读回重算、不声称验证 digest。`committed` 只表示 tenant-scoped object 存在、observed size/type 匹配且 manifest/accounting transaction 已提交。

将该裁定同步到唯一 ADR 索引与所有当前规划面：

1. 新增 `docs/researches/r2-hash-authority-decision.md`，记录 context、候选、裁定、后果、完整 read-back 的带宽/计算代价、R2 checksum 限制、tenant 内 residual risk 与严格 supersede 条件。
2. 修正 `docs/architecture/sdk-architecture.md` 的 hash/HEAD/commit/dedupe/reconcile 语义，并在附录 A 登记 `ADR-024 Accepted`。
3. platform sprint 新增 D-9，标记 S4A 三个 slice 已交付、下一 slice 为 S4B，并冻结 S4B 四项 downstream constraints。
4. 消费 `tasks/todos.md` 的 hash-authority 项；把 S4A research 的 `[unverified]` checksum 假设更新为 probe 结论。

本刀严格 docs-only，不修改 runtime API、schema、migration 或 archived evidence。

## Scope

- In scope: ADR-024、canonical architecture、platform sprint D-9/current projection、deferred todo consumption、S4A dataplane research 的 checksum probe resolution，以及本 slice 的 plan/contract/review/notes artifacts。
- Out of scope: `packages/**`、`deploy/sql/**`、runtime API、`StorageFinalizeInput` 的实际代码修改、`0003` migration、S4B GC implementation、archived S4A evidence、R2/object/database external state。
- Out of scope: 新建 `docs/adr/`；`docs/architecture/sdk-architecture.md` 附录 A 保持 ADR 编号与状态的唯一索引。
- Taste constraints: 使用 lightweight Nygard ADR；结论必须区分 declared、observed 与 verified，不用含糊的“校验 hash”；不为未来 capability 预埋兼容路径。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if canonical docs would need to claim R2 `HEAD` observes a digest, or if implementation requires adding a checksum/read-back fallback。
- Stop if any diff appears under `packages/**` or `deploy/sql/**`。

## Falsifier

若官方 R2 capability 表显示 PutObject SHA-256 `FULL_OBJECT` 已受支持，或本产品 threat model 已不再信任 tenant 内配对 device，则 daemon-authority 裁定的前提不成立。最便宜的 proof point 是检查 Cloudflare R2 S3 compatibility 的 checksum 表与 `docs/security.md` 的 paired-device trust boundary；当前分别显示 SHA-256 `FULL_OBJECT` 不支持、有效 device credential 本来就拥有 tenant 内 device 能力。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260808-1542-r2-hash-authority-adr.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260808-1542-r2-hash-authority-adr.review.md`
- Notes file: `tasks/notes/20260808-1542-r2-hash-authority-adr.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/architecture/sdk-architecture.md
  - docs/researches/r2-hash-authority-decision.md
  - docs/researches/s4a-dataplane-design.md
  - plans/plan-20260808-1542-r2-hash-authority-adr.md
  - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260808-1542-r2-hash-authority-adr.contract.md
  - tasks/reviews/20260808-1542-r2-hash-authority-adr.review.md
  - tasks/notes/20260808-1542-r2-hash-authority-adr.notes.md
  # Docs-only slice: packages/** and deploy/sql/** are deliberately absent.
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
    - docs/researches/r2-hash-authority-decision.md
    - docs/architecture/sdk-architecture.md
    - plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
    - docs/researches/s4a-dataplane-design.md
    - tasks/todos.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260808-1542-r2-hash-authority-adr.notes.md
  files_contain:
    - path: docs/researches/r2-hash-authority-decision.md
      pattern: "^# ADR-024: R2 Hash Authority"
    - path: docs/researches/r2-hash-authority-decision.md
      pattern: "Status:.*Accepted"
    - path: docs/researches/r2-hash-authority-decision.md
      pattern: "FULL_OBJECT"
    - path: docs/researches/r2-hash-authority-decision.md
      pattern: "COMPOSITE"
    - path: docs/researches/r2-hash-authority-decision.md
      pattern: "developers.cloudflare.com/r2/api/s3/api"
    - path: docs/architecture/sdk-architecture.md
      pattern: "ADR-024.*Accepted"
    - path: docs/architecture/sdk-architecture.md
      pattern: "daemon 声明"
    - path: plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
      pattern: "D-9"
    - path: plans/sprints/20260807-byok-platform-raft-aligned.sprint.md
      pattern: "下一可执行 slice.*S4B"
    - path: tasks/todos.md
      pattern: "ADR-024"
    - path: docs/researches/s4a-dataplane-design.md
      pattern: "SHA-256.*FULL_OBJECT"
  files_not_contain:
    - path: docs/architecture/sdk-architecture.md
      pattern: "经过 hash/size 验证"
    - path: docs/architecture/sdk-architecture.md
      pattern: "size/hash/type 验证"
  commands_succeed:
    - docker compose -f docker-compose.test.yml up -d --wait
    - pnpm -r run typecheck
    - BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 pnpm -r run test
    - pnpm -r run build
    - pnpm run check:deploy-sql
    - repo-harness run check-task-workflow --strict
    - git diff --check
    - git diff --exit-code main -- packages/ deploy/sql/
    - test -z "$(rg -n '经过 hash/size 验证|size/hash/type 验证' docs/architecture/sdk-architecture.md || true)"
```

## Acceptance Notes (Human Review)

- Functional behavior: ADR 正确描述 daemon declaration → pending manifest → presigned PUT → HEAD size/type → committed 的真实路径。
- Edge cases: 同 size/type 字节替换不可由 reconciler 发现；同 tenant dedupe/accounting 仍按 daemon 声明的 canonical hash；下载端声称完整性时自行 rehash。
- Regression risks: S4B 误保留 `observedContentHash`、增加 `hash_verified`、或加入 checksum/read-back fallback。

## Rollback Point

- Commit / checkpoint: branch base `4489865`。
- Revert strategy: revert docs-only PR；无 runtime 或 external-state rollback。
