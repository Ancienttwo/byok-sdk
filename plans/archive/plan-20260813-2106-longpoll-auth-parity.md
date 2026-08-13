# Plan: bearer-auth instance-product parity (O-3)

> **Status**: Archived
> **Created**: 20260813-2106
> **Slug**: longpoll-auth-parity
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: todos:长轮询 auth 不对称条目(S0 D-4)
> **Artifact Level**: work-package
> **Promotion Reason**: O-3:WS hello 门传递性保证 row==实例 productId,全部 bearer-authed HTTP 路由(长轮询+blob)从不查——异 product 设备 WS 被拒但 HTTP 全放行;安全相关,S 尺寸,裁决已定(实例等值进 authenticateBearer + protocolVersions 显式豁免)
> **Verification Boundary**: packages/server 全量测试 + 守卫红→绿 + pnpm -r typecheck;protocol 与其余包零 diff
> **Rollback Surface**: revert;零迁移;401 语义不可区分保持
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260813-2106-longpoll-auth-parity.contract.md`
> **Task Review**: `tasks/reviews/20260813-2106-longpoll-auth-parity.review.md`
> **Implementation Notes**: `tasks/notes/20260813-2106-longpoll-auth-parity.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: todos:长轮询 auth 不对称条目(S0 D-4)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260813-2106-longpoll-auth-parity.md`
- Sprint contract: `tasks/contracts/20260813-2106-longpoll-auth-parity.contract.md`
- Sprint review: `tasks/reviews/20260813-2106-longpoll-auth-parity.review.md`
- Implementation notes: `tasks/notes/20260813-2106-longpoll-auth-parity.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260813-2106-longpoll-auth-parity.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260813-2106-longpoll-auth-parity.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260813-2106-longpoll-auth-parity.md`.

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
- Contract file: `tasks/contracts/20260813-2106-longpoll-auth-parity.contract.md`
- Review file: `tasks/reviews/20260813-2106-longpoll-auth-parity.review.md`
- Implementation notes file: `tasks/notes/20260813-2106-longpoll-auth-parity.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260813-2106-longpoll-auth-parity.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260813-2106-longpoll-auth-parity.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert;零迁移;401 语义不可区分保持
- **Verification boundary**: packages/server 全量测试 + 守卫红→绿 + pnpm -r typecheck;protocol 与其余包零 diff
- **Review/acceptance boundary**: `tasks/reviews/20260813-2106-longpoll-auth-parity.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: O-3:WS hello 门传递性保证 row==实例 productId,全部 bearer-authed HTTP 路由(长轮询+blob)从不查——异 product 设备 WS 被拒但 HTTP 全放行;安全相关,S 尺寸,裁决已定(实例等值进 authenticateBearer + protocolVersions 显式豁免)

## Evidence Contract

- **State/progress path**: `plans/plan-20260813-2106-longpoll-auth-parity.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260813-2106-longpoll-auth-parity.contract.md`, `tasks/reviews/20260813-2106-longpoll-auth-parity.review.md`, and `tasks/notes/20260813-2106-longpoll-auth-parity.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260813-2106-longpoll-auth-parity.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert;零迁移;401 语义不可区分保持

## Captured Planning Output

# Plan: bearer-auth instance-product parity (O-3 长轮询校验不对称)

> **Spec**: `docs/spec.md`
> **Research**: `tasks/todos.md` 长轮询不对称条目(S0 D-4 发现,2026-08-07);本 session P1/P2(http.ts 全量 + ws-server.ts:104-128 hello 门对照)

## Agentic Routing
- Selected route: fast-worker 执行,gatekeeper 验收。
- Routing reason: S 尺寸、单包、裁决已定;安全相关但改动面窄。
- Due diligence:
  - P1 map: 校验权威两处——`packages/server/src/auth.ts:341` `authenticateBearer`(row-authority:claims 是查找键,row 是权威,row.productId==claims.productId 已查)被 http.ts 全部 bearer 路由(blobs×3、events、messages)与 ws-server.ts upgrade 共用;`ws-server.ts:104-128` hello 门另查 protocolVersions 包含、payload.productId==deps.productId(实例)、==principal.productId(row)、payload.deviceId==token。`AttachDeps` 有 productId,`HttpDeps` 没有。
  - P2 trace: 异 product 设备(同 server `createPairingCode({tenantId, productId:'other'})` 铸码配对,row 落库)→ WS upgrade 过 bearer → hello `productId mismatch` close 1002,连不上;同设备走 HTTP:`GET /byok/events`/`POST /byok/messages`/blob 路由 → authenticateBearer 只查 row==claims → 全放行,可 poll 事件、注入 envelope、建 blob。实例等值在 HTTP 面整体缺失,不止长轮询。
  - P3 decision rationale: ① 等价校验落 `authenticateBearer` 加第四条:row.productId !== 本实例 productId → undefined(与既有失败同型,401 不可区分,无跨租户/跨产品 existence oracle)。单源修全类(长轮询+blob+upgrade 前置),WS hello 的宣告验证(payload vs 实例/row/token)原样保留——它验的是「客户端宣告」这一不同事实。零 wire 契约改动、零 client 改动、protocol 包零 diff。② protocolVersions 不加到长轮询:长轮询每请求独立、envelope 逐条过 `EnvelopeSchema`+`handleInbound` 门,版本 skew 已在逐 envelope 面显形;让客户端专门宣告一个字段再验之是仪式非安全。写显式豁免(http.ts §8 注释 + docs/protocol.md 一句澄清,如 docs 面允许则加,否则仅代码注释)。③ cloud 包 `auth/bearer.ts` 同形状,但 hosted 多产品部署的实例归属权威不同,不并刀——记 todos 条目。

## Approach
1. `packages/server/src/auth.ts`:`AuthDeps` 增 `productId`(实例);`authenticateBearer` 增 row.productId 等值检查,注释说明与 ws hello 门的分工(row==实例在此,宣告==row/实例在 hello)。
2. `packages/server/src/index.ts`(或 deps 组装点):把 `options.productId` 接进 HttpDeps/AttachDeps 共享的 AuthDeps。
3. `packages/server/src/http.ts`:长轮询两路由处补显式豁免注释(protocolVersions 为何不在此验)。
4. 测试(`packages/server/src/__tests__/`):红→绿——异 product row 的有效 token 此前在 `/byok/events`、`/byok/messages`、`POST /byok/blobs` 得 200,修后 401;同 product 全路由不回归;WS hello 行为零变化。
5. todos:原不对称条目销账 + cloud bearer.ts 平行缺口新条目。
6. gatekeeper 验收。

## Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| 长轮询加宣告头(x-byok-protocol-version 等)再验 | 与 WS 形式对齐 | wire 契约改动+client 改动,验的是本不存在的宣告,仪式非安全 | 拒绝,写显式豁免 |
| 只修长轮询两路由不动 blob | 严格贴 todos 原文 | 同类缺口修一半,blob 路由继续放行异 product | 拒绝,authenticateBearer 单源修全类 |
| cloud 包并刀 | 一次清完 | 多产品部署的实例权威形状不同,需独立裁决 | 拒绝,记 ledger |
| 豁免也不写只修代码 | 最小 diff | 下个读者重新发现「不对称」再开一刀 | 拒绝,豁免入注释 |

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 存在依赖异 product row 走 HTTP 的部署 | Low | Med | WS 门已禁同场景,无可工作的既有依赖;发布说明记 behavior change |
| authenticateBearer 改动波及 upgrade 路径 | Low | Low | WS 本就要求实例等值,前移只是提早拒绝;测试断言 hello 行为零变化 |

## Promotion Gate
- **Merge/PR unit**: 单 PR。
- **Rollback surface**: revert;零迁移。
- **Verification boundary**: `packages/server` 全量测试 + 新守卫红→绿 + `pnpm -r typecheck`;protocol 与其余包零 diff。
- **Review/acceptance boundary**: gatekeeper 单轨。
- **High-risk surface**: 认证门收紧,401 语义必须保持不可区分。
- **Why not checklist row**: 安全相关行为变化 + 独立回滚面。

## Evidence Contract
- **State/progress path**: 本 plan + contract + notes。
- **Verification evidence**: 守卫红→绿输出、server suite、typecheck。
- **Evaluator rubric**: 异 product token 全 HTTP bearer 路由 401 且与其他失败不可区分;同 product 零回归;WS hello 零变化;protocol 零 diff。
- **Stop condition**: 任何给 401 加可区分原因、或动 wire 契约的方案。
- **Rollback surface**: revert commit。

## Annotations

- 已解决:todos 条目的「等价校验 or 显式豁免」二选一,裁决为「实例等值进 authenticateBearer + protocolVersions 显式豁免」双落。无遗留注释。

## Task Breakdown
- [ ] fast-worker: authenticateBearer 实例等值 + deps 接线 + 豁免注释 + 守卫红→绿
- [ ] todos 销账 + cloud 平行缺口条目
- [ ] gatekeeper 验收

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] fast-worker: authenticateBearer 实例等值 + deps 接线 + 豁免注释 + 守卫红→绿
- [ ] todos 销账 + cloud 平行缺口条目
- [ ] gatekeeper 验收
