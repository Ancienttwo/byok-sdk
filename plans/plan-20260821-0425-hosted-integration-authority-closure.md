# Plan: Hosted Integration Authority Closure

> **Status**: Executing
> **Created**: 20260821-0425
> **Slug**: hosted-integration-authority-closure
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: contract-worktree
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: three confirmed downstream integration failures require one SDK-owned authority closure
> **Verification Boundary**: schema-isolated workerd path, package migration state matrix, exact keys tarball and clean-install graph, full workspace checks
> **Rollback Surface**: revert candidate branch before publish; disposable database roles/schemas only; no production or registry mutation
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md`
> **Task Review**: `tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md`
> **Implementation Notes**: `tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260821-0425-hosted-integration-authority-closure.md`
- Sprint contract: `tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md`
- Sprint review: `tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md`
- Implementation notes: `tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260821-0425-hosted-integration-authority-closure.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260821-0425-hosted-integration-authority-closure.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md`
- Review file: `tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md`
- Implementation notes file: `tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260821-0425-hosted-integration-authority-closure.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert candidate branch before publish; disposable database roles/schemas only; no production or registry mutation
- **Verification boundary**: schema-isolated workerd path, package migration state matrix, exact keys tarball and clean-install graph, full workspace checks
- **Review/acceptance boundary**: `tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: three confirmed downstream integration failures require one SDK-owned authority closure

## Evidence Contract

- **State/progress path**: `plans/plan-20260821-0425-hosted-integration-authority-closure.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md`, `tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md`, and `tasks/notes/20260821-0425-hosted-integration-authority-closure.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert candidate branch before publish; disposable database roles/schemas only; no production or registry mutation

## Captured Planning Output

# 格局判断：Hosted integration authority closure

## Thesis

SDK 不应要求每个 host 重新发明三份部署知识：PostgreSQL schema 会话权威、migration ledger 精确核验、以及独立 keys 包的 registry dependency graph。正确终态是每项只有一个 owner：database role 决定 schema，`cloud-dataplane` 决定 migration state，release tooling 决定 packed/registry graph。

置信度高。当前生产 Hyperdrive、direct migration readback、npm registry 与标准 npm install 已给出可重复证据；唯一仍需 operator 环境最终验收的是 role-level `search_path` 经真实 Hyperdrive 新 session 的读回。

## P1 Architecture Map

- `deploy/sql/` 是 migration byte authoring authority；`packages/cloud-dataplane/dist/sql/` 只是构建投影。
- `packages/cloud-dataplane/src/migrate.ts` 拥有 filename、ordering、checksum、ledger DDL、transaction 与 advisory-lock 语义；`./runtime` 必须保持 Worker-clean，不携带 fs/crypto migration API。
- 所有 Postgres stores 与 migration SQL 使用 unqualified table names，因此 deployment schema 的真实 authority 是 backend session `search_path`，不是 tenant identity。Tenant isolation 继续由 tenant-first ports/rows 负责。
- Worker 只通过 Hyperdrive serving；Node/operator 通过 direct DSN migration。两条路径必须认证为同一 application role/database，role-level database-scoped setting 是唯一 schema authority。
- `@byok-sdk/keys` 独立版本，但其 packed dependency 必须精确指向当前 core train；workspace manifest、packed tarball、registry metadata 与 clean install 是四层不同证据。
- Salesko 只提供消费证据；本计划不修改 Salesko composition、Cloudflare production config、生产数据库、secrets 或部署。

## P2 Concrete Traces

### Schema trace

`Node direct DSN -> createByokPool -> migrate -> byok_control ledger 8/8 exact`

与：

`Worker fetch -> Hyperdrive connectionString -> createByokPool -> store/ready query -> public -> relation missing`

同一个 production Hyperdrive binding 的独立 probe 已证明 DSN query `options` 与一等 `PoolConfig.options` 都返回 `current_schema=public`、`search_path="$user", public`。所以缺陷不是 migration bytes，而是两条 backend session 的 role/database defaults 不一致；现有 Worker E2E 又只迁移默认 schema，未覆盖这个真实 contract。

### Migration trace

`installed migrationsDir -> host readdir/regex/hash -> host raw ledger SELECT -> host missing/extra/checksum comparison`

这些语义已由 package runner 私有实现，但 host 被迫复制。目标 trace 是：

`verifyMigrations(pool, directory?) -> package readMigrationFiles + package ledger reader -> exact result or typed aggregate mismatch`

该 API 只在 Node root export；Worker runtime 不读 package files，也不承担 migration readiness truth。

### Registry trace

`keys workspace:* -> local pack rewrite -> registry keys@0.2.0/core@0.4.2 -> downstream root core@0.5.0 -> standard npm nested core@0.4.2`

当前 `check:release-graph` 通过但没有检查 keys packed/registry edge。目标 trace 是：

`keys candidate -> exact packed dependency -> isolated npm install single core version -> release manifest -> registry readback`

## P3 Decisions

### 1. Schema authority

- 采用 Hyperdrive origin PostgreSQL application role 的 database-scoped `ALTER ROLE ... IN DATABASE ... SET search_path TO <schema>, public` 作为唯一 authority。
- Node migrator 与 Hyperdrive origin 使用同一 role/database。
- 删除并禁止 DSN query options、`PoolConfig.options`、request-time/pool-event `SET search_path`、public fallback。
- SDK 不把某个 host schema 名硬编码进 stores 或 immutable migrations；它交付 role-backed schema-isolated Worker fixture、current-schema readback 与 public-negative assertion。
- 10x first failure 是 per-invocation pool connection churn，不在本计划把 pool 改为 module-global。

### 2. Migration verification API

- 新增 Node-only `verifyMigrations(pool, directory = migrationsDir())`。
- 成功返回按 version 排序的 exact expected/applied rows；任何 missing、unexpected、checksum mismatch 或 ledger missing 都抛一个 typed aggregate `MigrationStateMismatchError`，issues 顺序稳定。
- 复用 `readMigrationFiles()`、私有 ledger reader 与现有 checksum error facts；不自动 migrate、不 bootstrap ledger、不输出兼容结果。
- `./runtime` 明确不导出该 API，并由 runtime-entry/packaging tests 守卫。

### 3. Keys registry closure

- bump `@byok-sdk/keys` candidate 至 `0.2.1`，packed dependency 精确落到 `@byok-sdk/core@0.5.0`；这是 registry correction，不改 public API、persistence 或 security authority。
- keys 纳入 pack artifact、isolated npm install、single-version-set、release manifest 与 registry readback。
- 加负控：keys tarball 指向旧 core 时 gate 必须 red。
- 本计划不授权 `npm publish`、tag、push 或 `publish.mjs --execute`；只产生可发布候选与本地/CI evidence。

## Kill List / What Not To Do

- 不保留 DSN options 与 role setting 两条 schema authority。
- 不用每请求 `SET search_path` 猜 pool checkout state。
- 不把 host schema 复制到所有 SQL 字符串或改写已发布 migrations。
- 不让 host 继续复制 migration hash/ledger comparison。
- 不以 Bun hoist 成功否认标准 npm 的 nested-version failure。
- 不覆盖或重发不可变的 `keys@0.2.0`。
- 不在本计划修改 Salesko、production role、Cloudflare binding、secrets、deploy 或 registry。

## First Proof Points and Falsifiers

1. Schema cheapest proof：新测试 role 在 disposable database 上设置 database-scoped search_path；Node migration 与 workerd Worker 多次新 invocation 均读回同一非-public schema，且 public 没有 SDK tables。若 role-backed新 session仍是 public，停止并报告代理/role mismatch，不加代码 fallback。
2. Migration cheapest proof：在 unfixed package 上新增 exact/missing/extra/checksum/ledger-missing regression matrix，确认 host-local comparator 才能通过；实现后全部由 package API 通过。
3. Keys cheapest proof：fixture tarball 内 edge 固定旧 core，standard npm clean install 必须产生 nested version 且 gate red；修正 candidate 后同一 probe只有 core@0.5.0。

## Workflow Inventory

- Active plan: this captured work-package under `plans/`.
- Expected contract/review/notes: matching stem under `tasks/contracts/`, `tasks/reviews/`, `tasks/notes/`.
- Deferred ledger: `tasks/todos.md`; do not duplicate active checklist rows there.
- Checks: `.ai/harness/checks/latest.json` and `.ai/harness/runs/`.
- Allowed-path owner: the generated task contract.
- Isolation: `contract-worktree` on `codex/hosted-integration-authority-closure`; preserve the unrelated dirty `docs/architecture/index.md` and `docs/architecture/requests/root.md` in main checkout.
- Plan switching: `.ai/harness/active-plan` and `.ai/harness/active-worktree` are authoritative; do not run implementation in the dirty main checkout.

## Scope and File Ownership

### Workstream A — schema/Worker contract (writer A only)

- `docker-compose.test.yml` and disposable Postgres role/bootstrap fixture if required.
- `packages/cloud-dataplane/worker-smoke/`.
- `packages/cloud-dataplane/src/__tests__/worker-e2e.test.ts` and schema-specific support tests.
- `packages/cloud-dataplane/README.md` schema/Hyperdrive deployment contract section only after coordinating with writer B; writer A otherwise leaves README to writer B.

### Workstream B — migration exact verification (writer B only)

- `packages/cloud-dataplane/src/migrate.ts`.
- `packages/cloud-dataplane/src/index.ts`.
- migration/readback/runtime-entry tests under `packages/cloud-dataplane/src/__tests__/` excluding `worker-e2e.test.ts`.
- `packages/cloud-dataplane/README.md`.

### Workstream C — keys/release graph (writer C only)

- `packages/keys/package.json`, `bun.lock`, keys changelog/readme if version references require it.
- `scripts/release/check-package-graph.mjs`, `pack-and-smoke.mjs`, `registry-readback.mjs`, `publish.mjs` only where artifact enumeration/readback requires it.
- focused release fixtures/tests and `.github/workflows/ci.yml` only if the existing gate invocation needs wiring.
- `docs/spec.md` keys current-version statement and release evidence docs.

### Orchestrator-only integration

- `docs/researches/2026-08-12-salesko-integration-handoff.md` delta and final closure state.
- plan/contract/review/notes/check artifacts.
- shared-file conflict resolution and final scope audit.

## Task Breakdown

- [ ] Capture and activate this plan in an isolated contract worktree; fill a self-sufficient contract with root-cause evidence, disjoint writer ownership, allowed paths and machine-verifiable exit criteria.
- [ ] Workstream A: add a red-first schema-isolated Worker/Hyperdrive regression guard, role-backed disposable fixture, multi-invocation schema/current-session assertions, public-negative assertions, and pairing/mailbox/truth coverage without adding a runtime fallback.
- [ ] Workstream B: add root-only `verifyMigrations` plus typed aggregate mismatch, exact/missing/unexpected/checksum/ledger-missing tests, runtime exclusion guard, and package documentation.
- [ ] Workstream C: bump keys candidate to 0.2.1, include keys in pack/manifest/readback, add stale-core negative control and single-version clean-install proof; do not publish.
- [ ] Orchestrator updates the canonical Salesko integration handoff once with the three verified deltas and implementation status; no duplicate legacy items.
- [ ] Run focused tests per workstream, then `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:release-graph`, clean-worktree `bun run check:release-pack`, `repo-harness run check-task-workflow --strict`, and `git diff --check`.
- [ ] Run independent acceptance against the frozen subject; record review/notes/check evidence. Publish, deploy, production role mutation, Salesko edits, push and merge remain separate owner-authorized actions.

## Verification Boundary

- Schema: disposable role/database + real workerd Worker path; non-public current schema across new sessions/invocations; public-negative table check; pairing/mailbox/truth SQL round trips.
- Migration: exact result plus four mismatch classes and ledger missing; Node-only export; installed-package default directory.
- Keys: packed candidate edge, stale-edge negative control, standard npm isolated install single-version closure, manifest/readback inclusion.
- Full workspace checks and strict harness on one frozen subject.

## Rollback Surface

- Revert the candidate branch before any publish; disposable schemas/roles are deleted with the test substrate.
- No production database, Cloudflare binding, external registry, tag, release, Salesko repo, secret or deployment is mutated by this plan.

## Stop Conditions

- Stop if schema closure requires a second runtime schema authority or any request-time fallback.
- Stop if implementation needs editing an already published SQL migration rather than adding tests/config/docs.
- Stop if migration verification would require Worker runtime fs/crypto imports.
- Stop if keys correction cannot be proven from exact tarballs and standard npm install.
- Stop before any publish/tag/push/deploy/production role change or Salesko modification.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Capture and activate this plan in an isolated contract worktree; fill a self-sufficient contract with root-cause evidence, disjoint writer ownership, allowed paths and machine-verifiable exit criteria.
- [ ] Workstream A: add a red-first schema-isolated Worker/Hyperdrive regression guard, role-backed disposable fixture, multi-invocation schema/current-session assertions, public-negative assertions, and pairing/mailbox/truth coverage without adding a runtime fallback.
- [ ] Workstream B: add root-only `verifyMigrations` plus typed aggregate mismatch, exact/missing/unexpected/checksum/ledger-missing tests, runtime exclusion guard, and package documentation.
- [ ] Workstream C: bump keys candidate to 0.2.1, include keys in pack/manifest/readback, add stale-core negative control and single-version clean-install proof; do not publish.
- [ ] Orchestrator updates the canonical Salesko integration handoff once with the three verified deltas and implementation status; no duplicate legacy items.
- [ ] Run focused tests per workstream, then `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:release-graph`, clean-worktree `bun run check:release-pack`, `repo-harness run check-task-workflow --strict`, and `git diff --check`.
- [ ] Run independent acceptance against the frozen subject; record review/notes/check evidence. Publish, deploy, production role mutation, Salesko edits, push and merge remain separate owner-authorized actions.
