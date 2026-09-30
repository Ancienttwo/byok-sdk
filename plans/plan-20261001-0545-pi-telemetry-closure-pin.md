# Plan: Pin published official Pi closure dependencies

> **Status**: Executing
> **Created**: 20261001-0545
> **Slug**: pi-telemetry-closure-pin
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: 用户授权限定client manifest/lock切片，实施仍须监工审方案OK
> **Verification Boundary**: unchanged baseline fail / fresh isolated npm install pass plus required checks
> **Rollback Surface**: only client manifest/lock and four task documents
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20261001-0545-pi-telemetry-closure-pin.contract.md`
> **Task Review**: `tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md`
> **Implementation Notes**: `tasks/notes/20261001-0545-pi-telemetry-closure-pin.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20261001-0545-pi-telemetry-closure-pin.md`
- Sprint contract: `tasks/contracts/20261001-0545-pi-telemetry-closure-pin.contract.md`
- Sprint review: `tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md`
- Implementation notes: `tasks/notes/20261001-0545-pi-telemetry-closure-pin.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20261001-0545-pi-telemetry-closure-pin.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20261001-0545-pi-telemetry-closure-pin.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20261001-0545-pi-telemetry-closure-pin.md`.

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
- Contract file: `tasks/contracts/20261001-0545-pi-telemetry-closure-pin.contract.md`
- Review file: `tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md`
- Implementation notes file: `tasks/notes/20261001-0545-pi-telemetry-closure-pin.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20261001-0545-pi-telemetry-closure-pin.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20261001-0545-pi-telemetry-closure-pin.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: only client manifest/lock and four task documents
- **Verification boundary**: unchanged baseline fail / fresh isolated npm install pass plus required checks
- **Review/acceptance boundary**: `tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: 用户授权限定client manifest/lock切片，实施仍须监工审方案OK

## Evidence Contract

- **State/progress path**: `plans/plan-20261001-0545-pi-telemetry-closure-pin.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20261001-0545-pi-telemetry-closure-pin.contract.md`, `tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md`, and `tasks/notes/20261001-0545-pi-telemetry-closure-pin.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20261001-0545-pi-telemetry-closure-pin.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: only client manifest/lock and four task documents

## Captured Planning Output

## Brief
基线main708ed45b，新worktree codex/pin-pi-telemetry。closure八Pi包均0.99.1，npm隔离消费者不继承root overrides，传递^0.99.1当前可能解析0.99.2。
## P1/P2/P3
P1 client published manifest / bun workspace lock vs closure integrity authority。P2 bun pack→隔离npm install→official-pi-installation identity检查。P3补齐五个传递Pi包exact direct dependency，closure/byok pin/API不改；nested漂移仍存在则停报，不扩到shrinkwrap/bundle。
## Approval boundary
方案已发Claude w9:p1；只有OK后才能改manifest/lock。PR243 OPEN，未修改这两个文件；不动旧worktree。不push/PR。
## Task Breakdown
- [x] main独立worktree、closure/registry/PR243只读核对。
- [x] 未修改基线pack/install真实红证据：exit1 telemetry mismatch。
- [x] 监工已OK，client manifest五pin与lock workspace同步；frozen install0。
- [ ] release-graph policy冲突裁定：chord禁止direct，tui native addon拒绝，已停报。
- [ ] 修复后隔离pack/install绿与frozen install、required checks。
- [ ] 授权commit无署名，Claude独立验收；架构/daemon gate停报。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] main独立worktree、closure/registry/PR243只读核对。
- [x] 未修改基线pack/install真实红证据：exit1 telemetry mismatch。
- [x] 监工已OK，client manifest五pin与lock workspace同步；frozen install0。
- [ ] release-graph policy冲突裁定：chord禁止direct，tui native addon拒绝，已停报。
- [ ] 修复后隔离pack/install绿与frozen install、required checks。
- [ ] 授权commit无署名，Claude独立验收；架构/daemon gate停报。
