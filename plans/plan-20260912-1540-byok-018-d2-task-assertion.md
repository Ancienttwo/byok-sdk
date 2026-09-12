# Plan: SDK D2 — task-scoped tool authority (byok-task-assertion-v1)

> **Status**: Executing
> **Created**: 2026-09-12
> **Slug**: byok-018-d2-task-assertion
> **Artifact Level**: work-package
> **Promotion Reason**: D2 跨 core/cloud/client/cloud-dataplane 四包并新增 replay schema 迁移，属于需要独立验收与回退面的 work-package，不是单文件改动。
> **Verification Boundary**: 契约 §15「实施阶段」对 SDK 的六项 root 必需检查（build / typecheck / test / check:api-surface / check:version-authority / check-task-workflow --strict），外加 `check:release-pack` 产出 AC13 G2 候选 artifact 证据。
> **Rollback Surface**: 未发布源码；回退即丢弃 contract worktree 分支，无已发布 artifact、无生产数据、无包版本/lock 改动。
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260912-1540-byok-018-d2-task-assertion.contract.md`
> **Task Review**: `tasks/reviews/20260912-1540-byok-018-d2-task-assertion.review.md`
> **Implementation Notes**: `tasks/notes/20260912-1540-byok-018-d2-task-assertion.notes.md`

## Authority

- 契约 ID：`salesko.bot-centric-chat.v1`
- Revision：`draft-3`
- Frozen SHA-256：`c7288bdbf399d71af6ec131fc86047ced363fb7541af5493c74cf990ae5c6678`
- Owner 冻结收据：C02（`20260912-byok-018-c02-owner-freeze.md`，与正文同仓存放）
- 契约正文只在 `S/` 与 salesko-new 主仓 `docs/researches/` 存放。本仓（`B/`）**不复制正文**，只按条款号引用。
- 引用或实施前必须先 `shasum -a 256` 校验正文文件命中上面的 frozen hash；不命中则停止，不按记忆中的条款执行。

## Agentic Routing
- Selected route: work-package plan + task contract（C05 实施前的 C03 登记）
- Routing reason: C05 的前置是 C02 冻结 + C03 在 `B/` 侧登记 allowlist + 「SDK 对应实施授权」。SDK 实施授权已于 2026-09-12 授予；2026-09-13 Owner 批准接管与 discovery/offer 追加片，当前执行 C05。
- Due diligence:
  - P1 map: SDK D2 接缝落在四个包。`packages/core` 持 device assertion envelope 与 replay 消费接口（`src/device-assertion.ts`，`src/in-memory/device-assertion-replay.ts`）；`packages/cloud` 持云侧验证入口（`src/auth/device-assertion.ts`）；`packages/client` 持 daemon 侧签发与 control 协议（`src/daemon/{assertion-client,control-protocol,create-daemon,device-assertion-signer,task-runner,toolset-registry}.ts`）；`packages/cloud-dataplane` 持 Postgres replay authority（`src/stores/device-assertion-replay.ts`）。持久化边界是 `deploy/sql/0008_device_assertion_replay`，当前最大迁移号 0021。
  - P2 trace: 一次 assertion 签发到消费的现状路径为 `create-daemon.ts:3244` 调 `device-assertion-signer.ts:65` mintDeviceAssertion（jti 来自 `signer.ts:61`），RPC schema 在 `control-protocol.ts:600-670`，handler 在 `create-daemon.ts:3169-3260`（六道 gate，mint 前二次复核 shutting_down / revoked）；云侧 `packages/cloud/src/auth/device-assertion.ts` 校验后经 `DeviceAssertionReplayConsumeInput`（`core/src/device-assertion.ts:406-413`，六字段、无 `schema` 判别段）落到 replay authority，内存实现 `core/src/in-memory/device-assertion-replay.ts:6-14`，Postgres 实现 `cloud-dataplane/src/stores/device-assertion-replay.ts:8-35`（`ON CONFLICT` 六列，对应 `0008` 的六列主键）。当前撤权只有设备级 `revoked` 布尔（`core/src/device-assertion.ts:307` 要求 `revoked === false`），没有 task 级 revoke 通道；`host-mcp-task-context`、`BYOK_HOST_TOOLSET_CONTEXT`、`byok-task-assertion` 在本仓零命中。压力点即在此：replay 键没有 envelope kind 判别段，两种 schema 的同一 jti 会互相占位。
  - P3 decision rationale: 现状 shape 来自单一 device-only 凭证假设（一枚 device assertion + 六列 replay 主键就够用）。要保留的不变量是「jti 原子一次消费、失败即拒绝不降级」。§8.2(2) 要求把判别段加进 replay 键并扩 `DeviceAssertionReplayConsumeInput`，这必须同时落到接口、内存实现、Postgres 实现和迁移，否则出现「接口已扩、存储仍按六列去重」的半态。最小连贯改动因此是四包同批 + 一条新迁移，而不是只改 core 接口。

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260912-1540-byok-018-d2-task-assertion.md`
- Sprint contract: `tasks/contracts/20260912-1540-byok-018-d2-task-assertion.contract.md`
- Sprint review: `tasks/reviews/20260912-1540-byok-018-d2-task-assertion.review.md`
- Implementation notes: `tasks/notes/20260912-1540-byok-018-d2-task-assertion.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260912-1540-byok-018-d2-task-assertion.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. 本仓当前 `.ai/harness/active-plan` = `plans/plan-20260910-0214-downstream-issue-intake.md`（Executing）。**本计划不接管、不切换该 marker**；进入 C05 时按 `plan-to-todo` / `contract-worktree start` 在新 worktree 执行，不与 downstream-issue-intake 串行化在同一工作树上。
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260912-1540-byok-018-d2-task-assertion.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260912-1540-byok-018-d2-task-assertion.md`.

## Approach
### Strategy
C03 登记已完成。当前按冻结契约实施并收口 C05，精确源码/测试/元数据边界见 Active contract；保留包版本/lock，不发布、不改生产。新增 discovery 等待只修复已授权 task lane 的准入时序。

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| 在 `B/` 复制契约 D2 正文 | 实施时不用跨仓读 | 出现第二份规范权威，draft-3 之后必然漂移 | 否决：只引用条款号 + hash 校验 |
| allowlist 用目录通配（`packages/client/src/daemon/`） | 登记省事 | §14 末段明确「不能从宽目录推断授权」 | 否决：逐条精确路径 |
| 把 cloud-dataplane Postgres replay 留到实施时再补 | 严格贴合 §14 字面 | §8.2(2) 的 schema 判别段落不到存储层，只能改接口 | 采纳枚举补登，标注待 Owner 在 C05 实施授权时确认 |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| (deferred to C05) | — | 具体文件级改动在实施授权后由 C05 填写；本轮只登记 allowlist 边界 |

### Code Snippets
（无。本轮不产出实现代码。）

### Data Flow
见 P2 trace。目标态数据流差异由契约 §8.1 / §8.2 定义，不在本文复述。

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 契约正文在 `S/` 侧被修订，`B/` 按旧条款实施 | medium | high | 每次引用前 `shasum -a 256` 校验 frozen hash |
| allowlist 漏项导致实施时越界改文件 | medium | medium | contract `allowed_paths` 逐条精确路径；越界即停并先修订契约 |
| 与 downstream-issue-intake 争抢 active-plan marker | low | medium | 本计划不切 marker，C05 在独立 contract worktree 执行 |
| 迁移编号 0022 被其它分支抢占 | low | low | 实施时按当时最大值顺延（§14 明文允许） |

## Task Contracts
- Contract file: `tasks/contracts/20260912-1540-byok-018-d2-task-assertion.contract.md`
- Review file: `tasks/reviews/20260912-1540-byok-018-d2-task-assertion.review.md`
- Implementation notes file: `tasks/notes/20260912-1540-byok-018-d2-task-assertion.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260912-1540-byok-018-d2-task-assertion.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: 一个 D2 SDK work-package 分支（四包 + 一条新迁移 + api-surface golden + 文档耦合元数据）
- **Rollback surface**: 未发布源码，丢弃 contract worktree 分支即完成回退
- **Verification boundary**: §15 SDK root 六项检查 + `check:release-pack` 候选 artifact
- **Review/acceptance boundary**: AC11 / AC12 / AC13（G2 候选级）与 C09 的 SDK 侧检查
- **High-risk surface**: replay 键变更（`deploy/sql` 0008 → 0022）与 assertion 验证路径，认证语义，不允许降级 fallback
- **Why not checklist row**: 跨四包 + schema 迁移 + 认证语义变更，单条 checklist 无法承载验收与回退面

## Evidence Contract

- **State/progress path**: `tasks/notes/20260912-1540-byok-018-d2-task-assertion.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json` 与 `.ai/harness/runs/`
- **Evaluator rubric**: 契约 §15 的 AC11 / AC12 / AC13 可证伪条件
- **Stop condition**: 需要写 `allowed_paths` 之外的路径、或缺少 SDK 实施授权时停止并交回 Owner
- **Rollback surface**: 未发布源码；丢弃分支

## Annotations
<!-- [RESOLVED]: prefixed inline. Claude processes all and revises. -->
<!-- [RESOLVED]: 2026-09-12 Owner 授予「SDK 对应实施授权」；C05 三项前置齐备，Status 转 Approved，contract 转 Active。 -->

## Task Breakdown

下表只引用契约条款号，**不复制产品规范正文**。实施细节在获得 SDK 实施授权后由 C05 按条款展开。

| # | 条款 | 责任面 | 状态 |
| --- | --- | --- | --- |
| 1 | §8.1 | `byok-task-assertion-v1` envelope / signed schema / capability `host-mcp-task-context` 两条通道 | DONE (slice 1, c6dc5b5, gate PASS) |
| 2 | §8.2(1) | SDK/client 侧：context token RPC、registry 校验、每次 invoke 新 assertion/new jti、终止后拒签 | DONE (slice 2, 67cbea87, gate PASS) |
| 3 | §8.2(2) | replay 键加 `schema` 判别段并扩 `DeviceAssertionReplayConsumeInput`（含新迁移与 Postgres 实现） | DONE (slice 1, c6dc5b5, gate PASS) |
| 4 | §14「SDK D2」行 | 实施文件边界：本 contract `allowed_paths` 即该行在 `B/` 侧的精确枚举 | DONE (slices 1–3; allowlist 按 §14:430 枚举补登共 18 条，见 contract) |
| 5 | §15 AC11 | 越 task/AgentRef/toolset 拒绝、副作用前拒绝、两 schema 下 jti 各自一次消费 | PARTIAL (core/replay + daemon 侧已覆盖；Host cancel commit 侧待第三片/C06) |
| 6 | §15 AC12 | cancel commit 与新工具准入线性化（SDK 侧可证伪面） | NOT_STARTED |
| 7 | §15 AC13 | 新 SDK artifact / capability 连通；G2 候选证据 = `check:release-pack` packed artifact，标 candidate 不冒充 released | PARTIAL (SDK 两条通道就绪；G2 packed 候选 artifact 已产出 sourceGitSha 3e70523b；Host 连通待 C06) |
| 8 | §13 C09 | SDK 侧必需检查执行与汇总（§15 实施阶段的六项 + release-pack） | READY (六项 root 检查 + release-pack 于 3e70523b 通过；最终矩阵待 C09 冻结 base) |

### C05 追加片（2026-09-13 Owner 已批准）

| # | 范围 | 状态 |
| --- | --- | --- |
| 9 | 首次连接/重连 discovery 在 host toolset nonce 冻结前有界等待；超时/不可读/未声明可观测；cancel/shutdown 释放等待 | IMPLEMENTED，focused 42 tests + cancel 增量 1 test 通过，root acceptance 待执行 |
| 10 | 冻结新候选，root verification → typed AcceptanceReceipt → verify-sprint → Draft PR | PENDING |

P1：部署 declaration 是 capability 权威；TaskRunner 构造 child env 是 nonce 的唯一作者。P2：首个 long-poll open → discovery 与 task offer 并发 → pickAdapter → 原代码直接冻结 nonce；pre-fix barrier 测试证明 declaration 尚未返回时 runtime 已启动。P3：在 nonce 冻结前等待最新 connection generation 的声明，单次 read 与每个 offer 均限 5000ms；10x 并发共享一次 read，每个等待者持有一个可清理 timer，重连不延长该 offer 的截止点。缺失声明仍不签发、不换 device lane；Agent task 没有 host toolsets 时不等待。
