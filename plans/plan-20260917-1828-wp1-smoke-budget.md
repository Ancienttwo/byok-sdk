# Plan: WP1 Windows CI: scope the keys rpcState budget on win32

> **Status**: Executing
> **Created**: 20260917-1828
> **Slug**: wp1-smoke-budget
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1828-wp1-smoke-budget.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260917-1828-wp1-smoke-budget.md`; after execution revert branch `codex/wp1-smoke-budget` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260917-1828-wp1-smoke-budget.contract.md`
> **Task Review**: `tasks/reviews/20260917-1828-wp1-smoke-budget.review.md`
> **Implementation Notes**: `tasks/notes/20260917-1828-wp1-smoke-budget.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan-or-waza-think planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260917-1828-wp1-smoke-budget.md`
- Sprint contract: `tasks/contracts/20260917-1828-wp1-smoke-budget.contract.md`
- Sprint review: `tasks/reviews/20260917-1828-wp1-smoke-budget.review.md`
- Implementation notes: `tasks/notes/20260917-1828-wp1-smoke-budget.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260917-1828-wp1-smoke-budget.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260917-1828-wp1-smoke-budget.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260917-1828-wp1-smoke-budget.md`.

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
- Contract file: `tasks/contracts/20260917-1828-wp1-smoke-budget.contract.md`
- Review file: `tasks/reviews/20260917-1828-wp1-smoke-budget.review.md`
- Implementation notes file: `tasks/notes/20260917-1828-wp1-smoke-budget.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260917-1828-wp1-smoke-budget.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260917-1828-wp1-smoke-budget.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260917-1828-wp1-smoke-budget.md`; after execution revert branch `codex/wp1-smoke-budget` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1828-wp1-smoke-budget.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260917-1828-wp1-smoke-budget.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260917-1828-wp1-smoke-budget.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260917-1828-wp1-smoke-budget.contract.md`, `tasks/reviews/20260917-1828-wp1-smoke-budget.review.md`, and `tasks/notes/20260917-1828-wp1-smoke-budget.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260917-1828-wp1-smoke-budget.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260917-1828-wp1-smoke-budget.md`; after execution revert branch `codex/wp1-smoke-budget` or the explicitly reviewed diff.

## Captured Planning Output

# WP1 Windows CI: scope the keys rpcState budget on win32

## Why
CI rounds 8 (35206575959) and 9 (35208560163) fail deterministically at pack-and-smoke: `pi-launcher-smoke.mjs` keys full-launch scenario, child closes silently before the first RPC response (stderr = launcher SQLite warning only, no JS stack). The chain — keys launcher (node + SQLite + ACL powershell) -> SDK Pi host — is executing for the first time ever on Windows (admin rounds never reached it; launch-cwd admission refused). The direct-SDK-Pi scenario passes the same default 30s cap, so the keys chain's added cold-start cost crosses it under a fresh lowpriv account.

## Task Breakdown
- [ ] `scripts/release/pi-launcher-smoke.mjs`: `rpcState` gains a `timeoutMs = 30_000` parameter used by the `:54` SIGTERM timer; the keys call site (`:431` area, the only `rpcState(...custodyProbe)` call) passes `process.platform === 'win32' ? 120_000 : 30_000` with a comment naming rounds 8-9.
- [ ] Local verification: `node --check scripts/release/pi-launcher-smoke.mjs`; grep assertions; `git diff --check`.

## Constraints
- ~2 lines of logic; default 30s unchanged everywhere else (all other rpcState callers, POSIX keys, spawnSync timeouts untouched).
- No product semantics; no global blanket raise; the cap remains a hard SIGTERM.
- Owner ruling 2026-09-17 authorizes exactly this surface (scripts/release) and shape.

## Evidence Contract
- Round 8/9 logs: silent close, stderr = SQLite warning only, identical signature, deterministic.
- Behavioral gate: Windows CI round 10 on this branch.

## Stop Conditions
- Stop if the edit touches any other timeout or any non-comment line beyond the parameter + call-site argument.
- Stop if round 10 still fails this scenario (then re-diagnose under a fresh ruling; do not raise further).

## Annotations
tasks/notes/20260917-1745-wp1-smoke-budget.notes.md
tasks/reviews/20260917-1745-wp1-smoke-budget.review.md

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] `scripts/release/pi-launcher-smoke.mjs`: `rpcState` gains a `timeoutMs = 30_000` parameter used by the `:54` SIGTERM timer; the keys call site (`:431` area, the only `rpcState(...custodyProbe)` call) passes `process.platform === 'win32' ? 120_000 : 30_000` with a comment naming rounds 8-9.
- [ ] Local verification: `node --check scripts/release/pi-launcher-smoke.mjs`; grep assertions; `git diff --check`.
