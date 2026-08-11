# Plan: S5 Board, SSE/Poll and Presence/Activity

> **Status**: Executing
> **Created**: 20260809-0148
> **Slug**: s5-board-streams
> **Artifact Level**: work-package
> **Promotion Reason**: S4B 已合入；S5 是平台 Sprint 当前唯一可执行 slice，且承担 S3 延后的 I6。
> **Verification Boundary**: core/InMemory/Postgres conformance、cloud route behavior、SSE/poll parity、100-way claim、I1/I6、workspace required checks。
> **Rollback Surface**: capability/config 下线新增 HTTP routes；revert S5 application commits，保留既有 0002 rows/schema，不修改 frozen wire 或 migration。
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260809-0148-s5-board-streams.contract.md`
> **Task Review**: `tasks/reviews/20260809-0148-s5-board-streams.review.md`
> **Implementation Notes**: `tasks/notes/20260809-0148-s5-board-streams.notes.md`

## Agentic Routing
- Selected route: main-thread code-change contract；不启动 subagent。
- Routing reason: 共享 contract、auth、SSE 与并发路径强耦合，需要同一执行线保持单一断言源；用户未要求并行代理。
- Due diligence:
  - P1 map: `@byok/core` 已持 board/presence/activity ports 与 InMemory reference；`@byok/cloud-postgres` 已持 SQL adapters；`@byok/cloud` 目前只有 frozen device mailbox/blob surface，缺 tenant-bound coordination handlers、capability 路由、stream behavior 与 terminal/progress projection。`deploy/sql/0002_core_domain.sql` 是既有 schema authority，本刀零 migration。
  - P2 trace: host 以显式 producer title/channel 建 board row；paired device 读 poll/SSE、以 bearer-derived holder claim；`task.progress` 复用既有 ProgressBatcher batch 写 activity；首个 terminal receipt 以 CAS 最多推 board 至 `in_review`；human acceptance 只走 host control-plane method 到 `done`。
  - P3 decision rationale: board row 保持 current-state authority，不建 event log；poll 与 SSE 共用同一 `BoardStore.list` 读模型；SSE 只由 capability 宣告启用，5xx 不触发永久降级；device route 不允许 `done`，避免把 daemon execution terminal 冒充 human review acceptance。

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260809-0148-s5-board-streams.md`
- Sprint contract: `tasks/contracts/20260809-0148-s5-board-streams.contract.md`
- Sprint review: `tasks/reviews/20260809-0148-s5-board-streams.review.md`
- Implementation notes: `tasks/notes/20260809-0148-s5-board-streams.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260809-0148-s5-board-streams.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260809-0148-s5-board-streams.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260809-0148-s5-board-streams.md`.

## Approach
### Strategy
先补齐 core batch/rate contract 与双实现 conformance，再把 tenant-bound facade、coordination handlers/capabilities、terminal/progress projection 接入 cloud，最后以共享 feed behavior suite、I1/I6 与 Postgres 100-way race 收口。
### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| 新建 board event table | 可重放每次变更 | 产生第二真相源与漂移 | 否；row + `board_seq` + reconcile |
| SSE 失败嗅探后永久 poll | 表面容错 | 违反 explicit capability，暂时 5xx 被误判 | 否；只按 capability 选路 |
| device route 可写 `done` | API 少一条边界 | daemon/device 可冒充 human acceptance | 否；`done` 仅 host method |
| activity 另造逐事件通道 | 简单 handler | 绕开既有 ProgressBatcher，写压放大 | 否；batch input + bounded bytes/events |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/{presence,errors}.ts` | modify | activity batch+dropped 与 presence minimum interval contract |
| `packages/core/src/in-memory/presence.ts` | modify | reference semantics 与 fake-clock rate gate |
| `packages/conformance/src/core/{presence,tenant-isolation}.ts` | modify | 双实现共享验收 |
| `packages/cloud-postgres/src/stores/core/presence.ts` | modify | atomic batch tail 与 atomic presence throttle |
| `packages/cloud/src/{cloud,tenant-stores,capabilities,inbound}.ts` | modify | coordination composition、explicit capability、projection |
| `packages/cloud/src/handlers/{board,presence}.ts` | add | poll/SSE/claim/status/presence/activity routes |
| `packages/cloud/src/__tests__/board-streams.test.ts` | add | shared feed behavior、reconnect/reconcile/I6/bounds |
| `packages/cloud-postgres/src/__tests__/board-concurrency.test.ts` | add | 100-way claim 与 per-tenant sequence |
| `docs/researches/s5-board-streams-design.md` | add | 3P 与协议裁定 |

### Code Snippets
### Data Flow
`ByokCloud.createBoardItem(tenant, labels)` → `BoardStore.create` → paired device `GET /byok/board?since` 或 declared SSE → device-derived holder CAS → frozen `POST /byok/messages` progress/terminal → bounded activity batch / receipt-first board projection → host `acceptBoardItem` CAS `in_review → done`。

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| claim 双 winner | 中 | 高 | SQL guarded UPDATE + 100 concurrent test |
| stream 跨租户/seq 泄漏 | 低 | 高 | tenant facade + I6 dual-tenant behavior suite |
| SSE request 持有 DB transaction | 低 | 高 | 每轮只调用 store page；sleep 在 query 返回后；测试断言 query cadence |
| terminal 自动越过 review | 中 | 高 | device path 最多到 `in_review`；`done` host-only |
| unbounded hint write pressure | 中 | 中 | atomic minimum interval、batch count/byte limits、TTL |

## Task Contracts
- Contract file: `tasks/contracts/20260809-0148-s5-board-streams.contract.md`
- Review file: `tasks/reviews/20260809-0148-s5-board-streams.review.md`
- Implementation notes file: `tasks/notes/20260809-0148-s5-board-streams.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260809-0148-s5-board-streams.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one S5 coordination PR on `codex/s5-board-streams`.
- **Rollback surface**: withhold board/presence/activity capabilities or revert S5 code; no schema rollback.
- **Verification boundary**: core/cloud/cloud-postgres targeted suites plus full required commands and strict harness.
- **Review/acceptance boundary**: normalized final diff + typed AcceptanceReceipt + PR CI/readback.
- **High-risk surface**: SSE lifecycle, auth revocation, CAS conflicts, tenant isolation, terminal projection.
- **Why not checklist row**: cross-package shared contract and concurrency/security behavior require a reviewable work package.

## Evidence Contract

- **State/progress path**: plan Task Breakdown + contract/notes/review + sprint S5 acceptance table.
- **Verification evidence**: targeted Vitest, hard-env full workspace commands, strict workflow, PR CI.
- **Evaluator rubric**: every S5.5 item has a deterministic test or explicit code/readback evidence.
- **Stop condition**: frozen protocol/schema/migration drift, device path gaining review authority, or stream requiring cross-sleep transaction.
- **Rollback surface**: capability no-mount and code revert; persisted board rows remain inert.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Record S5 design/contract and update S4B merge ledger.
- [x] Land bounded presence/activity contracts in InMemory and Postgres with shared conformance.
- [x] Land board host API, tenant facade, terminal/progress projection, and explicit capabilities.
- [x] Land poll/SSE routes with Last-Event-ID, heartbeat, reconciliation, abort/revocation behavior.
- [x] Prove I1/I6, 100-way claim, conflict snapshots, feed parity, dropped/reconcile, TTL and bounds.
- [ ] Record AcceptanceReceipt, land PR, pass CI, merge and read back `main`.
