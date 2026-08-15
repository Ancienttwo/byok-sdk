# Plan: Bun package-manager migration

> **Status**: Executing
> **Created**: 20260815-1301
> **Slug**: bun-package-manager-migration
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: user:go-on-after-todos-prioritization
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: bun ci; bun run build; bun run typecheck; bun run test; bun run check:release-pack; repo-harness run check-task-workflow --strict
> **Rollback Surface**: Single authority cut: revert the migration commit to restore pnpm manifests, lockfile, CI, release scripts, and docs together.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260815-1301-bun-package-manager-migration.contract.md`
> **Task Review**: `tasks/reviews/20260815-1301-bun-package-manager-migration.review.md`
> **Implementation Notes**: `tasks/notes/20260815-1301-bun-package-manager-migration.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: user:go-on-after-todos-prioritization
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260815-1301-bun-package-manager-migration.md`
- Sprint contract: `tasks/contracts/20260815-1301-bun-package-manager-migration.contract.md`
- Sprint review: `tasks/reviews/20260815-1301-bun-package-manager-migration.review.md`
- Implementation notes: `tasks/notes/20260815-1301-bun-package-manager-migration.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260815-1301-bun-package-manager-migration.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260815-1301-bun-package-manager-migration.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260815-1301-bun-package-manager-migration.md`.

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
- Contract file: `tasks/contracts/20260815-1301-bun-package-manager-migration.contract.md`
- Review file: `tasks/reviews/20260815-1301-bun-package-manager-migration.review.md`
- Implementation notes file: `tasks/notes/20260815-1301-bun-package-manager-migration.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260815-1301-bun-package-manager-migration.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260815-1301-bun-package-manager-migration.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Single authority cut: revert the migration commit to restore pnpm manifests, lockfile, CI, release scripts, and docs together.
- **Verification boundary**: bun ci; bun run build; bun run typecheck; bun run test; bun run check:release-pack; repo-harness run check-task-workflow --strict
- **Review/acceptance boundary**: `tasks/reviews/20260815-1301-bun-package-manager-migration.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260815-1301-bun-package-manager-migration.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260815-1301-bun-package-manager-migration.contract.md`, `tasks/reviews/20260815-1301-bun-package-manager-migration.review.md`, and `tasks/notes/20260815-1301-bun-package-manager-migration.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260815-1301-bun-package-manager-migration.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Single authority cut: revert the migration commit to restore pnpm manifests, lockfile, CI, release scripts, and docs together.

## Captured Planning Output

## Goal
Replace pnpm with Bun 1.3.14 as the repository's sole package manager and workspace script orchestrator; pin development and CI to Node 22.22.3, raise the public dispatch floor to Node >=22.22.0, and preserve npm tarball semantics.

## Architecture map
- Root package.json owns package-manager version, workspace membership, and required scripts.
- bun.lock owns dependency resolution; pnpm lock/workspace configuration is removed in the same slice.
- .node-version owns the exact Node 22.22.3 development/CI runtime; public manifests declare the >=22.22.0 compatibility floor.
- CI reads .node-version, installs Bun from packageManager, runs bun ci, and invokes root or filtered workspace scripts.
- Release pack-and-smoke builds with Bun, packs each workspace with bun pm pack, then validates tarballs through isolated npm install and Node imports.
- Current operator docs, templates, and structural tests project this authority; historical evidence remains historical.

## Concrete trace
GitHub checkout -> setup exact Node 22.22.3 from .node-version -> setup Bun 1.3.14 from root packageManager -> bun ci -> dependency-aware build -> sequential typecheck/test -> release graph -> bun pm pack per public workspace -> npm isolated install -> Node import smoke.

## Decision
Make one atomic authority cut with no pnpm compatibility path. Pin CI to one Node runtime so platform jobs exercise an identical runtime while package manifests retain a semver compatibility floor. Preserve sequential test execution because timing-sensitive client tests rely on it. Keep Vitest package scripts and Node runtime semantics; Bun owns installation and script orchestration. Fail closed on lockfile drift with bun ci.

## Task breakdown
- Cut root workspace/package-manager configuration and generate bun.lock.
- Pin development/CI to Node 22.22.3 and raise dispatch engines to >=22.22.0.
- Migrate CI, release tooling, package lifecycle scripts, templates, current docs, and constraint tests.
- Remove pnpm-only files and active references.
- Verify frozen install, build, typecheck, tests, release pack smoke, and strict workflow.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Execute captured plan: Bun package-manager migration
