# Plan: Merge GPT Pro v2 storage/quota increments

> **Status**: Executing
> **Created**: 20260807-1058
> **Slug**: architecture-v2-storage-merge
> **Artifact Level**: work-package
> **Promotion Reason**: The v2 bundle supersedes the v1 target-design increments already merged into the canonical architecture document; the update spans two large documents (canonical §12-§15 target-design blocks and the Draft sprint file) plus the decision record, with a per-group marking rule — too much correlated state for a checklist row.
> **Verification Boundary**: `repo-harness run check-task-workflow --strict` (docs-only slice; no source or test changes, code gates unaffected).
> **Rollback Surface**: The slice edits `docs/architecture/sdk-architecture.md`, `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`, and `docs/researches/gpt-pro-architecture-rewrite-decision.md`. Reverting all three to their state at `f81e844` restores the v1-merged snapshot; nothing else references the v2 deltas.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/gpt-pro-architecture-rewrite-decision.md`
> **Task Contract**: `tasks/contracts/20260807-1058-architecture-v2-storage-merge.contract.md`
> **Task Review**: `tasks/reviews/20260807-1058-architecture-v2-storage-merge.review.md`
> **Implementation Notes**: `tasks/notes/20260807-1058-architecture-v2-storage-merge.notes.md`

## Agentic Routing
- Selected route: parent-agent orchestration with a delegated heavy-execution merge pass
- Routing reason: The merge rubric is fully determined by the mechanical v1→v2 bundle diff (`_ref/byok-architecture-rewrite/` vs `_ref/byok-architecture-rewrite-v2/`); no new current-runtime claims appear in the delta, so no fresh E-class rejection judgment is needed. Execution is bulky but bounded.
- Due diligence:
  - P1 map: canonical `docs/architecture/sdk-architecture.md` is the current-state authority with target-design blocks in §11.2/§12/§14/§15; the sprint file is a Draft program backlog; both were derived from the v1 bundle per `docs/researches/gpt-pro-architecture-rewrite-decision.md`. The v2 bundle at `_ref/byok-architecture-rewrite-v2/` replaces the v1 bundle as the design charter source.
  - P2 trace: `diff -u` of the two bundle charters (~297 changed lines) and the two bundle sprint files (~232 changed lines) enumerates every v2 increment: SQLite-canonical local journal, `LocalStoragePolicy` watermarks/cleanup ordering, Postgres + R2 as the decided production composition, tenant storage entitlement/usage/reservation contracts, stable quota error codes, full-quota behavior, R2 tombstone/reconcile GC, ADR-019..022, GAP-015/016, invariants 21-24, and the S2/S3/S4 story/acceptance rewrites.
  - P3 decision rationale: v1's merge decision (option B: keep canonical as current-state authority, mark target-design increments) still holds; v2 only revises the target design, so the same rule applies — update the marked target-design blocks in place, never alter verified current-state claims. The sprint file keeps the repo's S4A/S4B split because v2 itself prescribes exactly that decomposition (S4A data plane / S4B quota+GC), with the old second-backend parity descoped to an optional post-Beta D1 adapter per v2's 已裁定 line.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-1058-architecture-v2-storage-merge.md`
- Sprint contract: `tasks/contracts/20260807-1058-architecture-v2-storage-merge.contract.md`
- Sprint review: `tasks/reviews/20260807-1058-architecture-v2-storage-merge.review.md`
- Implementation notes: `tasks/notes/20260807-1058-architecture-v2-storage-merge.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-1058-architecture-v2-storage-merge.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: docs-only profile; no contract worktree required. The K line (`plans/plan-20260805-1659-byok-keys-package.md`) stays sealed and untouched; `switch-plan` restores it after this slice completes.

## Approach
### Strategy
Fold the v1→v2 bundle deltas into the three repo artifacts that were derived from the v1 bundle, preserving every repo-side adaptation made during the v1 merge (current-state evidence skeleton, 目標設計 markers, sprint Status/legal-value fixes, crosswalk, S4A/S4B structure, story-point removal decisions recorded in the sprint preamble). Do not run the bundle's `apply.sh`; do not overwrite repo files with bundle files.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A. Overwrite repo docs with v2 bundle files | Fast | Destroys the current-state evidence skeleton and all v1-merge adaptations; re-imports the structure the decision record rejected | Rejected |
| B. Fold the v1→v2 diff into the adapted repo artifacts | Keeps the decision record's structure and every verified claim; delta is mechanical and enumerable | Requires anchor-by-anchor mapping into the adapted documents | **Use** |
| C. Archive v2 without merging | Zero risk | Repo docs would keep superseded S3/S4 scope (file journal, Postgres/S3 + D1/R2 parity) that the user has explicitly replaced | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `docs/architecture/sdk-architecture.md` | Edit | Fold the v1→v2 charter delta into the target-design blocks: storage-plane invariants, Postgres + R2 composition, quota/entitlement/reservation contracts, SQLite local journal, local storage watermarks, retention/GC semantics, storage API rows, metrics, ADR-019..022, GAP-015/016, invariants 21-24 |
| `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` | Edit | Fold the v1→v2 sprint delta: goal item 6, milestone rows, S2 stories/tests/tree/acceptance, S3 SQLite journal rewrite, S4A/S4B re-scope (S4A Postgres+R2 data plane, S4B quota/reservation/GC, D1 optional post-Beta), matrices, risks, decision deadlines, release gates, success criteria |
| `docs/researches/gpt-pro-architecture-rewrite-decision.md` | Edit | Append a v2 supersede record: bundle path, ZIP SHA-256, delta summary, and the ruling that the v1 rubric carries over |
| `plans/plan-20260805-1659-byok-keys-package.md`, `tasks/contracts/20260805-1659-*` | Do not touch | The K line is sealed |
| `packages/**`, `docs/spec.md` | Do not touch | Docs-only slice |

### Code Snippets
### Data Flow

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A v2 sentence asserting current-runtime state leaks into a current-state section | Low | Canonical document loses current-state trustworthiness | The delta was screened: all groups are target-design; the merge only touches blocks already marked 目標設計 or ledger tables that carry target markers |
| Sprint restructure loses a repo-side v1 adaptation (status values, crosswalk, withdrawn C1/C2, point removals) | Medium | Re-introduces red-gate values or reverses recorded decisions | Worker folds the diff into the repo file rather than copying bundle text wholesale; gatekeeper checks the preamble adaptations survive |
| Strict check trips on the new plan/contract pair | Low | Red gate blocks the slice | Same shape as the v1 slice which passed; verify with `check-task-workflow --strict` as the milestone gate |

## Task Contracts
- Contract file: `tasks/contracts/20260807-1058-architecture-v2-storage-merge.contract.md`
- Review file: `tasks/reviews/20260807-1058-architecture-v2-storage-merge.review.md`
- Implementation notes file: `tasks/notes/20260807-1058-architecture-v2-storage-merge.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-1058-architecture-v2-storage-merge.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One documentation PR: canonical architecture v2 delta, sprint v2 delta, decision-record supersede note, and this slice's workflow artifacts.
- **Rollback surface**: Revert the three edited documents to their `f81e844` content; nothing else depends on the v2 deltas.
- **Verification boundary**: `repo-harness run check-task-workflow --strict`.
- **Review/acceptance boundary**: The v1→v2 bundle diffs are the acceptance rubric — every delta group present in the repo artifacts, every repo-side v1 adaptation preserved.
- **High-risk surface**: `docs/architecture/sdk-architecture.md` is the single canonical architecture authority; the sprint file feeds future contract projection.
- **Why not checklist row**: ~530 delta lines across two large adapted documents with a marking rule and a structural S4 re-scope.

## Evidence Contract

- **State/progress path**: `tasks/notes/20260807-1058-architecture-v2-storage-merge.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json` from `repo-harness run check-task-workflow --strict`.
- **Evaluator rubric**: `diff -u` between `_ref/byok-architecture-rewrite/` and `_ref/byok-architecture-rewrite-v2/` for both the charter and the sprint file, plus the v1 adaptations recorded in the sprint preamble and decision record.
- **Stop condition**: Stop if a merge item would require asserting a current-runtime fact not verifiable against local source, or if any edit would fall outside this contract's `allowed_paths`.
- **Rollback surface**: See Promotion Gate.

## Annotations

## Task Breakdown
- [ ] B1 Canonical document: fold the v1→v2 charter delta into the target-design blocks of `docs/architecture/sdk-architecture.md`, keeping every current-state section untouched and every merged block marked 目標設計.
- [ ] B2 Sprint file: fold the v1→v2 sprint delta into `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`, re-scoping S4A to the Postgres + R2 data plane and S4B to quota/reservation/GC with D1 demoted to an optional post-Beta adapter, preserving the repo-side v1 adaptations.
- [ ] B3 Decision record: append the v2 supersede record to `docs/researches/gpt-pro-architecture-rewrite-decision.md` (bundle path, ZIP SHA-256 `5ee566272d3f4baa23705f78fb5c2530ce54143ff9a301d580af0aeb65148d95`, ruling that the v1 rubric carries over).
- [ ] B4 Verification: run `repo-harness run check-task-workflow --strict` and confirm pass with the new plan/contract pair active.
