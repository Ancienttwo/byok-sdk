# Plan: Consolidate /byok route path constants into protocol (B-2)

> **Status**: Archived
> **Created**: 20260813-0423
> **Slug**: route-path-constants
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: survey:B-2
> **Artifact Level**: work-package
> **Promotion Reason**: single_source_of_truth_wire_routes
> **Verification Boundary**: all-package typecheck/test/build; freeze-guard zero diff; no route byte drift; strict workflow gate
> **Rollback Surface**: mechanical consolidation, revert single PR; strings byte-identical, no wire/schema/behavior change
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260813-0423-route-path-constants.contract.md`
> **Task Review**: `tasks/reviews/20260813-0423-route-path-constants.review.md`
> **Implementation Notes**: `tasks/notes/20260813-0423-route-path-constants.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: survey:B-2
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260813-0423-route-path-constants.md`
- Sprint contract: `tasks/contracts/20260813-0423-route-path-constants.contract.md`
- Sprint review: `tasks/reviews/20260813-0423-route-path-constants.review.md`
- Implementation notes: `tasks/notes/20260813-0423-route-path-constants.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260813-0423-route-path-constants.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260813-0423-route-path-constants.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260813-0423-route-path-constants.md`.

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
- Contract file: `tasks/contracts/20260813-0423-route-path-constants.contract.md`
- Review file: `tasks/reviews/20260813-0423-route-path-constants.review.md`
- Implementation notes file: `tasks/notes/20260813-0423-route-path-constants.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260813-0423-route-path-constants.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260813-0423-route-path-constants.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: mechanical consolidation, revert single PR; strings byte-identical, no wire/schema/behavior change
- **Verification boundary**: all-package typecheck/test/build; freeze-guard zero diff; no route byte drift; strict workflow gate
- **Review/acceptance boundary**: `tasks/reviews/20260813-0423-route-path-constants.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: single_source_of_truth_wire_routes

## Evidence Contract

- **State/progress path**: `plans/plan-20260813-0423-route-path-constants.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260813-0423-route-path-constants.contract.md`, `tasks/reviews/20260813-0423-route-path-constants.review.md`, and `tasks/notes/20260813-0423-route-path-constants.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260813-0423-route-path-constants.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: mechanical consolidation, revert single PR; strings byte-identical, no wire/schema/behavior change

## Captured Planning Output

## Goal

把散落在 5 个包的 ~12 个 `/byok/*` 路由路径字面量收敛到 `@byok-sdk/protocol` 的单一导出(`http-api.ts`),各处改为 import;捎带 B-6 的三处小重复(`DEVICE_PROOF_HEADER`、base64url、`dispatchSelection.runtimeId` 解析)。字符串今日字节一致,纯机械收敛,零行为改动。

## Design Decision(边界裁决,已定稿)

路由路径是 **protocol 拥有的 wire contract**(与 ADR-010 让 host 拥有的、不透明的 capability 词汇不同)。`protocol/src/http-api.ts` 今天已用注释记录这些路由但导出零常量。裁决:把它们作为具名常量从 `@byok-sdk/protocol` 导出(universal dep,所有包都依赖),各包 import。这符合仓库单一真相源原则,有 `NONCE_SIGNING_DOMAIN` 收敛先例,且 testkit 自己的注释(`simulator.ts:1-31`)已承认这一 drift class。

## Change

1. `packages/protocol/src/http-api.ts`:导出 `/byok/*` 路由路径常量(含带参路由的构造函数,如 `/byok/skill-packs/:name/files/:path` 用参数化 helper)。保持字节与现有字面量一致。若涉及 frozen-v1 语义,只加导出、不改任何既有值——freeze-guard 零 diff 是硬约束(路由常量若不在 freeze-guard 覆盖面则不触发;需确认)。
2. 替换各处字面量为 import:
   - client:`auth-manager.ts:88,167,181`、`blob-client.ts:76`、`skill-pack-installer.ts:305`、`long-poll-transport.ts:218,243`、`url.ts:13`
   - cloud:`cloud.ts:240-415`
   - server:`http.ts:76-321`、`ws-server.ts:9`
   - testkit:`simulator.ts:42-45`
   - conformance:`harness.ts:174`
3. B-6 fold-in(同一收敛精神):
   - `DEVICE_PROOF_HEADER` 两处(`client/.../truth-memory-client.ts:15` vs `cloud/handlers/truth.ts:32`)收敛到 `core/attestation.ts:33,40` 已集中的兄弟常量旁。
   - base64url 重复实现(`cloud/crypto/web-crypto.ts:16-36` vs `testkit/identity.ts:35-38`)收敛到一处共享。
   - `dispatchSelection.runtimeId` 解析重复(`task-runner.ts:1153-1167` vs `hub.ts:1488-1499`)收敛。
   注:B-6 各项若跨越 client/server/testkit 的依赖边界不便共享,则只做能干净共享的部分,其余记录为后续,不强行造依赖。

## Non-scope

- 不改任何路由的实际路径值 / wire 行为(字节一致)。
- 不改 capability 词汇(那是 host-owned,不进 protocol)。
- 不为 B-6 强造跨包依赖:只收敛依赖图允许的部分。
- 不动 protocol frozen envelope。

## Task Breakdown

- [ ] protocol:导出 `/byok/*` 路由常量 + 带参 helper;确认 freeze-guard 零 diff。
- [ ] client/cloud/server/testkit/conformance:字面量替换为 import,逐包 typecheck。
- [ ] B-6:收敛 DEVICE_PROOF_HEADER / base64url / dispatchSelection.runtimeId 中依赖图允许的部分,其余记 notes。
- [ ] 全量验证(pnpm -r typecheck/test/build)+ freeze-guard 零 diff;确认无路由字节漂移(可加一个断言导出常量等于旧字面量的测试,或 grep 确认无遗留裸字面量)。
- [ ] Commit, push, open PR, merge to main on green CI, verify merged revision。

## Verification Boundary

全包 typecheck/test/build;freeze-guard 零 diff;新增/现有测试证明路由常量字节等于替换前;grep 确认 `/byok/` 裸字面量只剩 protocol 一处定义(测试/fixture 除外);`repo-harness run check-task-workflow --strict`。

## Rollback Surface

纯机械收敛,revert 单 PR 即净;无 wire/schema/behavior 改动,字符串字节一致,风险 LOW。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] protocol:导出 `/byok/*` 路由常量 + 带参 helper;确认 freeze-guard 零 diff。
- [ ] client/cloud/server/testkit/conformance:字面量替换为 import,逐包 typecheck。
- [ ] B-6:收敛 DEVICE_PROOF_HEADER / base64url / dispatchSelection.runtimeId 中依赖图允许的部分,其余记 notes。
- [ ] 全量验证(pnpm -r typecheck/test/build)+ freeze-guard 零 diff;确认无路由字节漂移(可加一个断言导出常量等于旧字面量的测试,或 grep 确认无遗留裸字面量)。
- [ ] Commit, push, open PR, merge to main on green CI, verify merged revision。
