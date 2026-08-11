# Plan: Presence Producer + Hosted Capability Discovery

> **Status**: Executing
> **Created**: 20260812-0201
> **Slug**: presence-producer-capability-discovery
> **Artifact Level**: work-package
> **Promotion Reason**: salesko 集成 handoff 唯一 P0（阻塞其 Phase C pairing UX）：cloud 已宣称 `presence.hints` capability 并挂好路由与 store，client daemon 却没有任何 producer——capability 宣称当前无第一方实现背书。同时 daemon 尚未消费 `GET /byok/capabilities`（ADR-010 的 client 侧还缺失），presence publisher 必须建立在 declaration 之上，两件事构成一个不可拆的 slice。
> **Verification Boundary**: client 全套测试 + 新增 capability-gating/heartbeat/401/shutdown 测试、对真实 cloud composition 的集成断言（hint 出现与 TTL 过期）、`@byok-sdk/protocol` zero diff、workspace hard gates。
> **Rollback Surface**: revert client-only 新模块与 create-daemon 接线；cloud、protocol、database migration 与 package identity 不动。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-12-salesko-integration-handoff.md` 条目 1（P0）；ADR-010（declaration-not-probe，见 `packages/cloud/src/capabilities.ts` 头注）
> **Task Contract**: `tasks/contracts/20260812-0201-presence-producer-capability-discovery.contract.md`
> **Task Review**: `tasks/reviews/20260812-0201-presence-producer-capability-discovery.review.md`
> **Implementation Notes**: `tasks/notes/20260812-0201-presence-producer-capability-discovery.notes.md`

## Agentic Routing
- Selected route: contract worktree + fast-worker 执行，gatekeeper 验收；计划与最终裁决留主循环。
- Routing reason: 多文件 client 行为变更，跨 daemon lifecycle 与 hosted HTTP 面，达到验收门槛。
- Due diligence:
  - P1 map: core 的 presence 语义完备（`packages/core/src/presence.ts`：五级 level、TTL 过期即缺席、`minimumIntervalMs` 节流、§12.7.5 建议 60-120s TTL），in-memory 与 Postgres store 双实现齐备；cloud 侧 `PUT /byok/presence` 路由存在（device bearer + `{level, detail}`），`presence.hints` 在 `CLOUD_CAPABILITIES` 中宣称（capabilities.ts:48）；`GET /byok/capabilities` 是 hosted-only 路由，capabilities.ts:12 自述 "the daemon does not consume it yet"；client 源码经 grep 与 codegraph 双重确认零 producer（命中全是注释里的英文单词）。presence 属 hosted HTTP 面，不在冻结的 device wire 契约内，`@byok-sdk/protocol` 零接触。
  - P2 trace（目标链路）: daemon start/reconnect → `GET /byok/capabilities` → `CapabilityDeclarationSchema` 校验（shape 归 core）→ `hasCapability('presence.hints')` 为真才启动 publisher → 周期 `PUT /byok/presence {level:'online'}`（device bearer，token lifecycle 归 AuthManager）→ 401 触发续签或 revoked 停止 → 优雅停机停止发布，离线由 TTL 过期表达（expiry = absence 是 core 已定语义）。
  - P3 decision rationale: ① 按 declaration 不按 probe——404 探测被 ADR-010 明文禁止；capabilities 获取失败时 fail-closed：不启动 publisher 并记录可观测降级，绝不回退到探测。② 第一刀只发布 `online` heartbeat；`thinking/working/error` 映射等真实产品消费证据出现再加，不预造语义。③ 心跳间隔必须大于 store 的 `minimumIntervalMs` 且小于 TTL，语义文档化为「online = 最近 N 秒内有 heartbeat」。④ presence 永不参与任务生命周期决策（core 头注已立此禁令，本 slice 维持）。

## Workflow Inventory

- Active plan: `plans/plan-20260812-0201-presence-producer-capability-discovery.md`
- Sprint contract: `tasks/contracts/20260812-0201-presence-producer-capability-discovery.contract.md`
- Sprint review: `tasks/reviews/20260812-0201-presence-producer-capability-discovery.review.md`
- Implementation notes: `tasks/notes/20260812-0201-presence-producer-capability-discovery.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260812-0201-presence-producer-capability-discovery.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260812-0201-presence-producer-capability-discovery.md`.

## Approach
### Strategy
1. 新增 hosted capability discovery client：daemon 启动/重连后拉取并校验 declaration；获取失败不阻塞 daemon 连接，仅使 publisher 不启动并留下可观测记录。
2. 新增 capability-gated presence publisher：仅在 declaration 含 `presence.hints` 时启动；周期发布 `online` heartbeat，间隔可配置且默认满足 `minimumIntervalMs < interval < TTL`；停机时停发，不写 offline。
3. 认证走现有 AuthManager token lifecycle：401 先续签重试一次，revoked 则永久停止 publisher（不 retry-spin）。
4. 文档化 presence 语义（online 定义、TTL 选择、expiry=absence），并在 salesko 侧留一条 dogfood 集成证据（tarball sha + 下游 commit + 走通面）后才在 release notes 里宣称该能力。

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| 404 探测决定是否发布 | 少一次往返 | 违反 ADR-010，status code 语义脆弱 | 拒绝 |
| 首刀就做完整 level 映射（thinking/working/error） | 一次到位 | 无消费方，预造语义，映射错了要背兼容包袱 | 拒绝，等产品证据 |
| 停机时显式发布 offline | 下游更快看到离线 | expiry=absence 是 core 已定语义，双通道表达同一事实 | 拒绝；产品确需更快离线信号时再议 |
| capability discovery 单独成刀 | slice 更小 | publisher 无 declaration 可依，只能探测或裸发 | 拒绝，两者同刀 |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/daemon/capabilities-client.ts` | Add | 拉取 + `CapabilityDeclarationSchema` 校验 hosted declaration，fail-closed |
| `packages/client/src/daemon/presence-publisher.ts` | Add | capability-gated online heartbeat 循环，401/revoked 处理 |
| `packages/client/src/daemon/create-daemon.ts` | Modify | lifecycle 接线：启动后 discovery→publisher，停机停发 |
| `packages/client/src/__tests__/…` | Add | gating、cadence、401 续签、revoked 停止、shutdown、fail-closed 获取失败 |
| `docs/`（presence 语义段） | Modify | online = 最近 N 秒内有 heartbeat；expiry = absence |

### Data Flow
declaration（`GET /byok/capabilities`，schema 校验）→ gate → heartbeat timer → `PUT /byok/presence {level:'online'}`（AuthManager bearer）→ store TTL → 下游 `list/read` 只见未过期 hint。

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 心跳间隔与 `minimumIntervalMs` 冲突触发 `hint_rate_limited` | Medium | Medium | 默认 interval > minimumInterval，启动时断言配置关系并测试 |
| revoked device 导致 401 重试风暴 | Medium | High | 续签仅一次；revoked 判定后永久停止并记录 |
| capabilities 获取失败拖慢/阻塞 daemon 启动 | Medium | Medium | discovery 异步于连接主路径；失败只影响 publisher |
| presence 被误用为协调状态 | Low | High | 维持 core 禁令；publisher 不读不写任务状态 |
| 上游定型后 salesko 未真实消费即宣称能力 | Medium | Medium | dogfood 证据条目作为 release notes 宣称前置条件 |

## Task Contracts
- Contract file: `tasks/contracts/20260812-0201-presence-producer-capability-discovery.contract.md`
- Review file: `tasks/reviews/20260812-0201-presence-producer-capability-discovery.review.md`
- Implementation notes file: `tasks/notes/20260812-0201-presence-producer-capability-discovery.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260812-0201-presence-producer-capability-discovery.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: 一个 PR：discovery client + publisher + 接线 + 测试 + 语义文档。
- **Rollback surface**: client-only revert；cloud/protocol/migration 零改动。
- **Verification boundary**: 新增行为测试 + client 全套 + 真实 cloud composition 集成断言 + protocol zero diff + workspace hard gates。
- **Review/acceptance boundary**: gatekeeper 验收（多步 client 行为变更达门槛）；salesko dogfood 消费证据在能力宣称前落账。
- **High-risk surface**: 401/revoked 处理、fail-closed discovery、心跳与节流/TTL 关系。
- **Why not checklist row**: 跨 daemon lifecycle 与 hosted HTTP 面的行为契约，有独立 falsifier 与回滚面。

## Evidence Contract

- **State/progress path**: 本 plan Task Breakdown、contract、notes、review。
- **Verification evidence**: fake-clock 单测（cadence/TTL/节流）、401/revoked 注入测试、cloud composition 集成测试（hint 出现→过期）、client suite、CI。
- **Evaluator rubric**: declaration 不含 `presence.hints` → 零 presence 请求；含 → 一个 interval 内 `list` 可见 hint；停止发布后 TTL 到期 hint 消失；获取 declaration 失败 → publisher 不启动且 daemon 其余功能不受影响；revoked → 发布永久停止；`@byok-sdk/protocol` 无 diff。
- **Stop condition**: 出现任何 404 探测、无 declaration 启动 publisher、presence 影响任务逻辑、或 401 无限重试。
- **Rollback surface**: revert 新模块与接线 commit；无持久化数据回滚。

## Annotations

- 无未决注释；计划经 2026-08-12 会话逐段评审（含对第一轮方案的三处证据纠错），owner 以 "go on" 批准激活。

## Task Breakdown
- [x] hosted capability discovery client（schema 校验 + fail-closed + 可观测降级记录）
- [x] capability-gated online heartbeat publisher（AuthManager token lifecycle、401 续签一次、revoked 永久停止）
- [x] create-daemon lifecycle 接线（启动/重连启动 discovery→publisher，停机停发）
- [x] 测试：gating、cadence 与 `minimumIntervalMs`/TTL 关系、401/revoked、shutdown、fail-closed、cloud composition 集成
- [x] 文档：presence 语义（online 定义、TTL 建议、expiry = absence）
- [ ] salesko dogfood 集成证据落账（byok commit + tarball sha + 下游 commit + 走通面），作为能力宣称前置 —— 已移入 `tasks/todos.md` 延期账本（条目「salesko dogfood 集成证据落账」），不在本 slice 执行
