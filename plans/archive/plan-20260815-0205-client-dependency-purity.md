# Plan: Client Dependency Purity Rule

> **Status**: Archived
> **Created**: 20260815-0205
> **Slug**: client-dependency-purity
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: check-package-graph exits 0 on today's graph; negative control red; pnpm -r typecheck/test/build green
> **Rollback Surface**: Revert the single script change (plus test/fixture) as one commit
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260815-0205-client-dependency-purity.contract.md`
> **Task Review**: `tasks/reviews/20260815-0205-client-dependency-purity.review.md`
> **Implementation Notes**: `tasks/notes/20260815-0205-client-dependency-purity.notes.md`

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

- Active plan: `plans/plan-20260815-0205-client-dependency-purity.md`
- Sprint contract: `tasks/contracts/20260815-0205-client-dependency-purity.contract.md`
- Sprint review: `tasks/reviews/20260815-0205-client-dependency-purity.review.md`
- Implementation notes: `tasks/notes/20260815-0205-client-dependency-purity.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260815-0205-client-dependency-purity.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260815-0205-client-dependency-purity.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260815-0205-client-dependency-purity.md`.

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
- Contract file: `tasks/contracts/20260815-0205-client-dependency-purity.contract.md`
- Review file: `tasks/reviews/20260815-0205-client-dependency-purity.review.md`
- Implementation notes file: `tasks/notes/20260815-0205-client-dependency-purity.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260815-0205-client-dependency-purity.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260815-0205-client-dependency-purity.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the single script change (plus test/fixture) as one commit
- **Verification boundary**: check-package-graph exits 0 on today's graph; negative control red; pnpm -r typecheck/test/build green
- **Review/acceptance boundary**: `tasks/reviews/20260815-0205-client-dependency-purity.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260815-0205-client-dependency-purity.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260815-0205-client-dependency-purity.contract.md`, `tasks/reviews/20260815-0205-client-dependency-purity.review.md`, and `tasks/notes/20260815-0205-client-dependency-purity.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260815-0205-client-dependency-purity.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the single script change (plus test/fixture) as one commit

## Captured Planning Output

# Client Dependency Purity Rule

## Recommendation

Extend `scripts/release/check-package-graph.mjs` with a rule failing the release graph check when any **direct** dependency of `@byok-sdk/client` ships a `.node` file or declares an `install`/`postinstall`/`preinstall` script. Purpose: durable guard for the SEA/bun single-file packagability invariant (decision from the 2026-08-15 deep-reasoner consultation) — a future koffi-style native dependency must fail CI, not slip past review.

Scope ruling (already decided, do not revisit): **direct dependencies only.** The transitive closure fails today through the pinned `@earendil-works/pi-coding-agent@0.84.1` subtree (9 native addons, `@google/genai` preinstall, `protobufjs` postinstall); a transitive allowlist would be a steady-state compatibility layer. Direct scope passes clean today (pi-coding-agent, @byok-sdk/core, @byok-sdk/protocol, ws) and catches the threat model (adding a native dep directly).

Validated prototype (both scopes tested against the real graph): session scratchpad `client-purity-rule.mjs` — reuse its resolution + scanning logic.

## Task Breakdown

- [ ] Port the direct-scope rule into `scripts/release/check-package-graph.mjs`, following that script's existing error-reporting conventions.
- [ ] Negative control: prove the scanner detects a violation (e.g. a self-test mode or unit test pointing the scanner at a known-addon package such as the pi subtree's `@earendil-works/pi-tui`, or a temp fixture package) — the rule must be shown red against a violating input, not only green on today's graph.
- [ ] Run the script and the repo verification: `node scripts/release/check-package-graph.mjs`, `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`.

## Verification boundary

`node scripts/release/check-package-graph.mjs` exits 0 on today's graph; negative control demonstrably red; `pnpm -r` typecheck/test/build green.

## Rollback surface

Revert the single script change (and its test/fixture if added) as one commit.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Port the direct-scope rule into `scripts/release/check-package-graph.mjs`, following that script's existing error-reporting conventions.
- [ ] Negative control: prove the scanner detects a violation (e.g. a self-test mode or unit test pointing the scanner at a known-addon package such as the pi subtree's `@earendil-works/pi-tui`, or a temp fixture package) — the rule must be shown red against a violating input, not only green on today's graph.
- [ ] Run the script and the repo verification: `node scripts/release/check-package-graph.mjs`, `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`.
