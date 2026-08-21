# Task Contract: hosted-integration-authority-closure

> **Status**: Fulfilled
> **Plan**: plans/plan-20260821-0425-hosted-integration-authority-closure.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-21 04:25
> **Review File**: `tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md`
> **Notes File**: `tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Salesko 已用真实 Worker + Hyperdrive 路径暴露三个 package-owned 缺口：schema 隔离没有 role-backed E2E 守卫，host 必须复制 migration ledger/readback 逻辑，且 registry 上 `@byok-sdk/keys@0.2.0` 精确依赖 `@byok-sdk/core@0.4.2`，与 root `core@0.5.0` 标准安装后形成双版本。若继续由 composition 层补洞，会制造第二 authority，并让本地 workspace graph 的绿色结果掩盖发布 tarball 的错误依赖图。

## Goal

交付一个闭合 work-package：以 PostgreSQL application role 的 database-scoped `search_path` 作为唯一 schema authority，并用 disposable role + Worker/Hyperdrive E2E 证明新连接落在隔离 schema 且不写 `public`；在 `@byok-sdk/cloud-dataplane/node` 提供 fail-closed 的 `verifyMigrations(pool, directory = migrationsDir())` exact ledger/readback API，runtime entry 零导出；将 keys candidate 提升为 `0.2.1`、锁定 `core@0.5.0`，并让 pack/smoke/registry gates 覆盖 keys 及标准 npm 安装的单版本图。只产出本地代码与验证证据，不 publish、push、deploy 或改生产 role。

## Scope

- In scope: cloud-dataplane schema-isolated Worker fixture/E2E；Node-only migration exact readback API、类型与文档；keys `0.2.1` candidate 与 release graph/pack/registry gate；canonical upstream handoff delta。
- Out of scope: schema-qualify SDK SQL；DSN/`PoolConfig.options`/request-time `SET` fallback；runtime migration API；Salesko composition 修改；真实 Cloudflare/Neon role 变更；publish/tag/push/deploy。
- Taste constraints: 每项只有一个 authority；缺失 ledger、额外 ledger、checksum mismatch 和 ledger table 缺失均 fail closed；不保留旧 keys 依赖兼容路径；三个 writer 文件域互斥。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop schema work if a database-scoped role setting cannot control fresh Worker/Hyperdrive sessions; return to infrastructure evidence instead of adding SQL/config fallbacks.
- Stop migration API work if exact verification requires runtime-entry exports or host-owned SQL authority.
- Stop keys work if a clean standard npm install from the candidate tarballs still yields more than one `@byok-sdk/core` version.
- Stop immediately before any publish, tag, push, deploy, production database mutation, or credential mutation.

## Falsifier

Cheapest proofs first: (1) disposable application role 的 database-scoped `search_path` 在 fresh Worker session 中必须令 `current_schema()` 为隔离 schema，且 `public` 中无 SDK tables；(2) unfixed Node API surface 必须不能由 package owner 完成 exact ledger comparison，新增 focused tests 必须覆盖 missing/unexpected/checksum/ledger-absent；(3) `npm ls @byok-sdk/core --all --json` 对 keys candidate 标准安装必须只出现 `0.5.0`，并以当前 registry `keys@0.2.0` 作为 stale-edge negative control。任一失败即证伪对应方向，禁止叠 fallback。

## Root Cause Evidence

Task Profile 为 coordinated `code-change`，不启用单一 bugfix pre-fix gate。冻结证据见 source plan 的 P2：同一 Hyperdrive 连接忽略 DSN/Pool options 后回落 `public`；Salesko 重复 migration files/hash/raw SQL comparison；registry `keys@0.2.0` 的 exact core edge 产生 nested `0.4.2`。各 writer 必须先保留对应 negative control，再提交修后守卫。

## Workflow Inventory

- Source plan: `plans/plan-20260821-0425-hosted-integration-authority-closure.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md`
- Notes file: `tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"hosted-authority-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"worker-postgres-pack-runtime-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/researches/2026-08-12-salesko-integration-handoff.md
  - CHANGELOG.md
  - plans/plan-20260821-0425-hosted-integration-authority-closure.md
  - tasks/current.md
  - tasks/todos.md
  - tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md
  - tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md
  - tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - docker-compose.test.yml
  - .github/workflows/ci.yml
  - packages/cloud-dataplane/
  - packages/keys/package.json
  - packages/keys/README.md
  - bun.lock
  - scripts/release/check-package-graph.mjs
  - scripts/release/pack-and-smoke.mjs
  - scripts/release/pg-migrate-smoke.mjs
  - scripts/release/registry-readback.mjs
  - scripts/release/publish.mjs
  - scripts/release/fixtures/keys-0.2.0-stale-core-edge.json
  - tests/unit/keys-release-graph.test.ts
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
    - packages/cloud-dataplane/src/__tests__/worker-e2e.test.ts
    - packages/cloud-dataplane/src/__tests__/migrate-runner.test.ts
    - packages/cloud-dataplane/src/__tests__/runtime-entry.test.ts
    - packages/keys/package.json
    - docs/researches/2026-08-12-salesko-integration-handoff.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md
  tests_pass:
    - path: packages/cloud-dataplane/src/__tests__/worker-e2e.test.ts
    - path: packages/cloud-dataplane/src/__tests__/migrate-runner.test.ts
    - path: packages/cloud-dataplane/src/__tests__/runtime-entry.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:release-graph
    - bun run check:release-pack
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: `1a9c661`（isolated worktree base）
- Revert strategy: 单 work-package revert；无数据迁移、无外部 role mutation、无已发布 artifact。
