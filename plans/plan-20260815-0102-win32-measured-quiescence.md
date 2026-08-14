# Plan: Stage 1: Measured Windows Process-Tree Quiescence

> **Status**: Executing
> **Created**: 20260815-0102
> **Slug**: win32-measured-quiescence
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: pnpm -r typecheck/test/build; windows-latest CI leg; gatekeeper review before user merge decision
> **Rollback Surface**: Revert process-tree.ts, three adapter callers, new tests/fixtures, check-package-graph rule as one commit
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260815-0102-win32-measured-quiescence.contract.md`
> **Task Review**: `tasks/reviews/20260815-0102-win32-measured-quiescence.review.md`
> **Implementation Notes**: `tasks/notes/20260815-0102-win32-measured-quiescence.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260815-0102-win32-measured-quiescence.md`
- Sprint contract: `tasks/contracts/20260815-0102-win32-measured-quiescence.contract.md`
- Sprint review: `tasks/reviews/20260815-0102-win32-measured-quiescence.review.md`
- Implementation notes: `tasks/notes/20260815-0102-win32-measured-quiescence.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260815-0102-win32-measured-quiescence.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260815-0102-win32-measured-quiescence.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260815-0102-win32-measured-quiescence.md`.

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
- Contract file: `tasks/contracts/20260815-0102-win32-measured-quiescence.contract.md`
- Review file: `tasks/reviews/20260815-0102-win32-measured-quiescence.review.md`
- Implementation notes file: `tasks/notes/20260815-0102-win32-measured-quiescence.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260815-0102-win32-measured-quiescence.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260815-0102-win32-measured-quiescence.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert process-tree.ts, three adapter callers, new tests/fixtures, check-package-graph rule as one commit
- **Verification boundary**: pnpm -r typecheck/test/build; windows-latest CI leg; gatekeeper review before user merge decision
- **Review/acceptance boundary**: `tasks/reviews/20260815-0102-win32-measured-quiescence.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260815-0102-win32-measured-quiescence.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260815-0102-win32-measured-quiescence.contract.md`, `tasks/reviews/20260815-0102-win32-measured-quiescence.review.md`, and `tasks/notes/20260815-0102-win32-measured-quiescence.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260815-0102-win32-measured-quiescence.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert process-tree.ts, three adapter callers, new tests/fixtures, check-package-graph rule as one commit

## Captured Planning Output

# Stage 1: Measured Windows Process-Tree Quiescence

## Recommendation

Replace the Windows exit-code proxy in `packages/client/src/adapters/process-tree.ts` with a measured PID-set quiescence loop. `taskkill /T /F` stays the kill verb; its own stdout supplies the walked PID set (structural co-occurrence extraction, no localized-text parsing); `process.kill(pid, 0)` polls that set to ESRCH exactly like the POSIX `groupExists` branch. Delete the `terminationRequestFailed` exit-code interpretation. Switch `spawnSync` to async `spawn` (removes an existing event-loop stall under concurrent teardowns). No new dependencies; `templates/packaging/*` untouched; Job Object / daemon-crash orphan prevention explicitly out of scope (deferred behind a separate opt-in-package spike per the deep-reasoner consultation of 2026-08-15).

Decision provenance: deep-reasoner consultation (dual-candidate evaluation: koffi FFI Job Object vs pure-JS measured quiescence; FFI rejected for Node SEA/bun single-file packagability regression — SEA loads native addons only by extracting an unsigned `.node` to TEMP + `process.dlopen`, unacceptable inside a Windows Service deployment and against Decision #6). Final call by orchestrator; user directive 2026-08-15 ("创建方案派工") is the human decision boundary.

## P1 map

- Single termination authority: `packages/client/src/adapters/process-tree.ts` (`withOwnedProcessTree` / `requestOwnedProcessTreeTermination` / `disposeOwnedProcessTree`); the only importers are the three adapter process clients (pi/claude/codex).
- Windows today: `taskkill /PID <pid> /T /F` via `spawnSync`; direct child `close` is the sole quiescence receipt; `terminationRequestFailed` WeakSet reinterprets a non-zero exit code afterward (44517be workaround).
- POSIX today: process-group signal + `groupExists` kernel-observed poll — the model this change mirrors onto win32.
- Out of scope: POSIX changes, sandboxing, Job Object/FFI, daemon-crash orphan reaping, MCP subprocess supervision.

## P2 trace (defect)

win32 `disposeOwnedProcessTree` accepts the direct child's `close` as tree quiescence without measuring descendants; exit code stands in for a state never observed. Existing test `runtime-process-tree.test.ts` already asserts descendant death platform-ungated — it passes by luck, not contract. `spawnSync` additionally blocks the daemon event loop for the whole taskkill duration; N concurrent teardowns serialize into a full stall.

## P3 decision

Measure instead of proxy. Extract the walked PID set structurally from taskkill output (seed {rootPid}; accept every integer on any line containing an already-accepted PID; iterate to fixpoint; latin1 decode; **exclude `process.pid`** — taskkill names the daemon itself on the root's line, discovered red-first in T1). Poll accepted set to ESRCH (EPERM = alive), re-sweep at half killGraceMs merging newly reported PIDs, then still require child `close` as the stdio-flush receipt. `stage:'signal'` narrows to "taskkill could not be spawned"; `stage:'quiescence'` reports how many walked PIDs stayed alive. Honest residual boundary documented: a descendant whose intermediate parent died before any sweep is unreachable (Windows does not re-parent orphans).

## Task Breakdown

- [x] T1 PID-set extractor (`adapters/taskkill-pid-set.ts`) + multi-locale fixtures (en/de/zh/ja + hostile) with red-first negative control; excludedPids correction landed. (10/10 tests green)
- [x] T2 process-tree.ts win32 rework: async spawn, WeakMap accepted-set state, measured quiescence poll, half-grace re-sweep, delete terminationRequestFailed, receipt semantics + doc comments; update three adapter interrupt-path callers coherently (fire-and-forget preserved with rationale; disposal-path spawn failure still surfaces as RuntimeDisposalFailure).
- [x] T3 tests: 3-level fixture (root/descendant/grandchild all ESRCH before resolve), escape-race (spawner child every 100ms), receipt-authority regression (dead-PID non-zero taskkill → clean close; stage:'signal' only on unspawnable taskkill), adapter-parity structural test, check-package-graph.mjs rule rejecting deps with `.node` files or install/postinstall scripts — deferred to tasks/todos.md (StrictWorktreeGuard + direct-scope ruling). Behavioral tests shown red on pre-change implementation where feasible.

## Verification boundary

`pnpm -r run typecheck && pnpm -r run test && pnpm -r run build`; windows-latest CI leg exercises real taskkill paths; gatekeeper review against this plan before merge decision (merge stays with user).

## Rollback surface

Revert process-tree.ts + three adapter caller updates + new test/fixture files + check-package-graph rule as one commit; never keep the async signature beside the exit-code proxy.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] T1 PID-set extractor (`adapters/taskkill-pid-set.ts`) + multi-locale fixtures (en/de/zh/ja + hostile) with red-first negative control; excludedPids correction landed. (10/10 tests green)
- [x] T2 process-tree.ts win32 rework: async spawn, WeakMap accepted-set state, measured quiescence poll, half-grace re-sweep, delete terminationRequestFailed, receipt semantics + doc comments; update three adapter interrupt-path callers coherently (fire-and-forget preserved with rationale; disposal-path spawn failure still surfaces as RuntimeDisposalFailure).
- [x] T3 tests: 3-level fixture (root/descendant/grandchild all ESRCH before resolve), escape-race (spawner child every 100ms), receipt-authority regression (dead-PID non-zero taskkill → clean close; stage:'signal' only on unspawnable taskkill), adapter-parity structural test, check-package-graph.mjs rule rejecting deps with `.node` files or install/postinstall scripts — deferred to tasks/todos.md (StrictWorktreeGuard + direct-scope ruling). Behavioral tests shown red on pre-change implementation where feasible.
