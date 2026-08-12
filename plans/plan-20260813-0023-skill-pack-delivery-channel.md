# Plan: Skill-pack delivery channel (R1)

> **Status**: Executing
> **Created**: 20260813-0023
> **Slug**: skill-pack-delivery-channel
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md#R1
> **Artifact Level**: work-package
> **Promotion Reason**: shared_protocol_capability_and_multi_package_boundary
> **Verification Boundary**: core/cloud/client/cloud-postgres/conformance package tests; freeze-guard zero diff; rejection-path tests for every declared limit; full recursive typecheck/test/build; strict workflow gate
> **Rollback Surface**: Phase 1: revert single PR, no persisted migration. Phase 2: forward-only migration per existing discipline; R2 prefix cleanable per tenant
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260813-0023-skill-pack-delivery-channel.contract.md`
> **Task Review**: `tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md`
> **Implementation Notes**: `tasks/notes/20260813-0023-skill-pack-delivery-channel.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md#R1
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260813-0023-skill-pack-delivery-channel.md`
- Sprint contract: `tasks/contracts/20260813-0023-skill-pack-delivery-channel.contract.md`
- Sprint review: `tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md`
- Implementation notes: `tasks/notes/20260813-0023-skill-pack-delivery-channel.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260813-0023-skill-pack-delivery-channel.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260813-0023-skill-pack-delivery-channel.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260813-0023-skill-pack-delivery-channel.md`.

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
- Contract file: `tasks/contracts/20260813-0023-skill-pack-delivery-channel.contract.md`
- Review file: `tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md`
- Implementation notes file: `tasks/notes/20260813-0023-skill-pack-delivery-channel.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260813-0023-skill-pack-delivery-channel.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260813-0023-skill-pack-delivery-channel.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Phase 1: revert single PR, no persisted migration. Phase 2: forward-only migration per existing discipline; R2 prefix cleanable per tenant
- **Verification boundary**: core/cloud/client/cloud-postgres/conformance package tests; freeze-guard zero diff; rejection-path tests for every declared limit; full recursive typecheck/test/build; strict workflow gate
- **Review/acceptance boundary**: `tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: shared_protocol_capability_and_multi_package_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260813-0023-skill-pack-delivery-channel.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260813-0023-skill-pack-delivery-channel.contract.md`, `tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md`, and `tasks/notes/20260813-0023-skill-pack-delivery-channel.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260813-0023-skill-pack-delivery-channel.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Phase 1: revert single PR, no persisted migration. Phase 2: forward-only migration per existing discipline; R2 prefix cleanable per tenant

## Captured Planning Output

## Goal

新增 `skills.pack` 能力：SaaS 侧向已配对 daemon 分发声明式技能包（agentskills.io 兼容 SKILL.md + 资源文件），daemon 侧以 fetch→验证→content-addressed store→lock→audit 管线安装，宿主决定向 vendor CLI 技能目录的投影。首个示范载荷为「长任务 Git 工作流」技能。

证据基础：`docs/researches/2026-08-12_hermes-buzz-extraction-assessment.md` §3（hermes skills hub 拆解）与 §5.1（buzz 条件文法未求值教训）；hermes 源码引用见 `~/Projects/hermes-agent/docs/architecture/modules/skills-system.md`。

## Design Constraints（红线）

- 不触碰 frozen-v1 wire envelope：分发走 hosted HTTP（复用 capability discovery 模式），不新增 `MESSAGE_TYPES`；freeze-guard 测试零 diff 是验收硬条件。
- 凭证隔离铁律：manifest schema 显式不含 exec/env/credential 字段，包内容仅 Markdown/YAML/静态资源；以 constraint test 钉死。
- buzz 教训：每条声明的限制（尺寸上限、路径安全、schema 校验、hash 核验）与其求值点同 slice 交付，且各有拒绝路径测试——不允许「定义了但不求值」的装饰性约束。
- fail-closed：任何校验失败 = 拒装 + 可观测错误上报，无降级安装。
- K4 判例：vendor CLI 技能目录布局是 host policy。SDK 只拥有自有 content-addressed store 与投影 API，不写 `~/.claude/skills` 等目录。

## Phase 1（独立可合并：contracts + 内存实现 + daemon 安装管线）

- `@byok-sdk/core`：
  - `SkillPackManifestSchema`（zod）：name（沿 hermes 正则 `^[a-z0-9][a-z0-9._-]*$`、≤64）、description（≤1024）、version、files 清单（相对路径 + sha256 + bytes）、pack 级 content-hash；显式无 exec/env/credential 字段。
  - `SkillPackStore` port（tenant-first，进 `CORE_PORT_INTERFACES`/`CORE_PORT_METHODS` 契约表）+ in-memory 参考实现。
  - 尺寸常量与 `checkSkillPack`（字节实测，模式对齐 `RESULT_DOCUMENT_MAX_BYTES`/`checkResultDocument`）。
- `@byok-sdk/cloud`：stateless handlers `GET /byok/skill-packs`（manifest 列表）与 `GET /byok/skill-packs/:name/files/:path`（内容），挂 `skills.pack` capability flag（ADR-010 声明，`assertNoOverDeclaration` 覆盖）。
- `@byok-sdk/client`：daemon 安装管线——capability 发现后拉取 manifest → 逐文件校验（路径安全：拒 `..`/绝对路径/symlink；尺寸；sha256）→ 写入 SDK store（`<dataDir>/skill-packs/<name>/<content-hash>/`）→ `lock.json`（content_hash/source/installed_at/files，模式对齐 hermes HubLockFile）→ append-only 审计行。公开 API：`listInstalledSkillPacks()`、`projectSkillPack(name, targetDir)`（宿主投影用，拷贝不 symlink）。
- fixture：`packages/client/src/__tests__/fixtures/skill-packs/long-task-git-workflow/SKILL.md`——「长任务 Git 工作流」技能（指导 agent 用 git init/commit/log 管理多日任务状态），同时作为验收样例与首个真实载荷。
- 测试：manifest schema 正反例；每条拒绝路径（超尺寸/坏 hash/路径穿越/缺 capability 时 daemon 不拉取）；install→list→project 端到端（in-memory cloud + 真实文件系统 store）；credential 字段出现在 manifest 即拒的 constraint test；freeze-guard 零 diff。

## Phase 2（独立可合并：持久化）

- `@byok-sdk/cloud-postgres`：`SkillPackStore` Postgres 实现 + forward-only migration（进 `migrationsDir()` SQL 投影）；bundle 字节走既有 R2 blob store（复用 `keyPrefix`）。
- `@byok-sdk/conformance`：`SkillPackStore` 加入组合断言（in-memory 与 Postgres 同套断言源）。

## Non-scope

- 多源/marketplace（唯一源 = 已配对 SaaS 认证通道）、regex 安全扫描器、信任分级矩阵。
- agent 自建技能上行同步；技能执行/注入语义（vendor CLI 职责）。
- vendor CLI 目录自动挂载（等第二个宿主证明共同 policy）。
- 推送式即时分发（v1 为 connect 时 + capability version bump 拉取；若 salesko 要求即时性，后续加触发信号，管线不变）。
- 协议 envelope / `MESSAGE_TYPES` 任何改动。

## Task Breakdown

- [ ] Phase 1: core 的 SkillPackManifestSchema、SkillPackStore port（含契约表登记）、尺寸/校验函数与 in-memory 实现，含 schema 正反例测试。
- [ ] Phase 1: cloud 的 skill-packs handlers 与 `skills.pack` capability 声明，含 capability 缺失拒绝路径测试。
- [ ] Phase 1: client 安装管线（fetch→验证→store→lock→audit）、`listInstalledSkillPacks`/`projectSkillPack` 公开 API，含全部拒绝路径与端到端测试。
- [ ] Phase 1: 「长任务 Git 工作流」fixture 载荷 + credential 字段 constraint test + freeze-guard 零 diff 验证。
- [ ] Phase 1: 文档对齐（docs/spec.md 能力条目、docs/architecture/sdk-architecture.md 增量、protocol 文档不动）。
- [ ] Phase 1: 全量验证（pnpm -r typecheck/test/build + strict workflow gate），冻结 diff 审查。
- [ ] Phase 2: cloud-postgres SkillPackStore 实现 + migration + R2 bundle 存储。
- [ ] Phase 2: conformance 组合断言 + 全量验证。
- [ ] Commit, push, open PR, merge to main, and verify the merged revision.

## Verification Boundary

core/cloud/client/cloud-postgres/conformance 包测试；freeze-guard 零 diff；每条声明限制的拒绝路径测试；`pnpm -r run typecheck && pnpm -r run test && pnpm -r run build`；`repo-harness run check-task-workflow --strict`。

## Rollback Surface

Phase 1 无持久化迁移，revert 单 PR 即净。Phase 2 migration forward-only，按既有 migration 纪律；R2 前缀内容按 tenant 前缀可清。

## Open Item（显式延迟）

pack 的 tenant 归属粒度：v1 tenant-scoped（走既有 port 惯例）；product-global 共享包等第二个真实分发场景再裁（owner：下次 plan 修订）。最脆弱假设：salesko 要的是拉取式分发——plan 冻结前向 salesko 确认一句话；若要求推送即时性，管线不变、加触发信号。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Phase 1: core 的 SkillPackManifestSchema、SkillPackStore port（含契约表登记）、尺寸/校验函数与 in-memory 实现，含 schema 正反例测试。
- [ ] Phase 1: cloud 的 skill-packs handlers 与 `skills.pack` capability 声明，含 capability 缺失拒绝路径测试。
- [ ] Phase 1: client 安装管线（fetch→验证→store→lock→audit）、`listInstalledSkillPacks`/`projectSkillPack` 公开 API，含全部拒绝路径与端到端测试。
- [ ] Phase 1: 「长任务 Git 工作流」fixture 载荷 + credential 字段 constraint test + freeze-guard 零 diff 验证。
- [ ] Phase 1: 文档对齐（docs/spec.md 能力条目、docs/architecture/sdk-architecture.md 增量、protocol 文档不动）。
- [ ] Phase 1: 全量验证（pnpm -r typecheck/test/build + strict workflow gate），冻结 diff 审查。
- [ ] Phase 2: cloud-postgres SkillPackStore 实现 + migration + R2 bundle 存储。
- [ ] Phase 2: conformance 组合断言 + 全量验证。
- [ ] Commit, push, open PR, merge to main, and verify the merged revision.
