# Plan: Close out the root architecture queue card

> **Status**: Executing
> **Created**: 20260807-1144
> **Slug**: architecture-root-card-closeout
> **Artifact Level**: work-package
> **Promotion Reason**: Closing the pending root architecture-queue card requires an adjudication note, the repo's first architecture snapshot, and a contract-sync run whose write surface spans docs/architecture/ and .ai/context/ — a scope no active contract covers; the card has sat as an advisory blocker since 2026-08-05 and will re-trigger against K4's keys work.
> **Verification Boundary**: `repo-harness run architecture-queue status` reports pending=0/blocking=0, `repo-harness run check-architecture-sync` reports no pending request, and `repo-harness run check-task-workflow --strict` passes (docs-only slice).
> **Rollback Surface**: The slice edits `docs/architecture/requests/root.md`, adds one snapshot under `docs/architecture/snapshots/`, and applies whatever link updates `context-contract-sync sync-latest` writes. Reverting those files to their pre-slice commit restores the pending card; no runtime surface is touched.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260807-1144-architecture-root-card-closeout.contract.md`
> **Task Review**: `tasks/reviews/20260807-1144-architecture-root-card-closeout.review.md`
> **Implementation Notes**: `tasks/notes/20260807-1144-architecture-root-card-closeout.notes.md`

## Agentic Routing
- Selected route: parent-agent orchestration with a delegated execution pass
- Routing reason: The adjudication is already grounded (the drift events are the K0 creation of packages/keys/package.json and tsconfig.json in a3ab9a9, fully documented by canonical §7); remaining work is mechanical card/status/snapshot/sync execution plus queue verification.
- Due diligence:
  - P1 map: `docs/architecture/requests/root.md` is the pending card (capability root, severity medium, boundary-or-config, 2 events dated 2026-08-05); `docs/architecture/snapshots/` is empty; `docs/architecture/index.md` is the architecture module the card points at; ArchitectureSync runs in advisory mode with gate_min_severity=medium.
  - P2 trace: file watcher event on packages/keys/{package.json,tsconfig.json} → card written with Status Pending → `architecture-queue status` counts pending=1 → `check-architecture-sync` warns blocking=1 → archive-workflow surfaces the advisory. Closing path: card Status edit (legal value to be read from the repo-harness script source, not guessed) → snapshot artifact → `context-contract-sync sync-latest` links it → queue reports pending=0.
  - P3 decision rationale: the boundary change is real (a new package plane) but already captured in the canonical architecture document §7 with file:line evidence re-verified during the v1/v2 slices; the card therefore closes by adjudication with a thin snapshot that records the ruling and gives the empty snapshots/ directory its first artifact for contract sync, not by re-documenting the package.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-1144-architecture-root-card-closeout.md`
- Sprint contract: `tasks/contracts/20260807-1144-architecture-root-card-closeout.contract.md`
- Sprint review: `tasks/reviews/20260807-1144-architecture-root-card-closeout.review.md`
- Implementation notes: `tasks/notes/20260807-1144-architecture-root-card-closeout.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-1144-architecture-root-card-closeout.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: docs-only profile; no contract worktree required. The K line stays sealed; `switch-plan` restores it after this slice completes.

## Approach
### Strategy
Adjudicate the card in place: record that the K0 keys-package boundary is already canonical, close the card with the legal status value read from the architecture-queue script source, write one snapshot under `docs/architecture/snapshots/` that records the ruling and links canonical §7, then run `context-contract-sync sync-latest` and verify the queue drains.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A. Dismiss the card without artifacts | Fastest | Leaves snapshots/ empty (contract sync has nothing to link) and loses the adjudication record; next keys drift re-opens the same argument | Rejected |
| B. Close with adjudication note + thin snapshot + contract sync | Queue drains, ruling is durable, sync gains its first artifact | Slightly more ceremony than a bare status flip | **Use** |
| C. Full re-documentation snapshot of the keys package | Thorough | Duplicates canonical §7, violating the one-source-of-truth rule | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `docs/architecture/requests/root.md` | Edit | Status to the legal closed value plus a dated adjudication note naming a3ab9a9 and canonical §7 |
| `docs/architecture/snapshots/` | Create | One thin snapshot recording the ruling and linking the canonical document |
| `.ai/context/` and any contract block touched by `context-contract-sync sync-latest` | Edit (tool-written) | Link the latest snapshot into the architecture contract surface |
| `packages/**`, `docs/spec.md`, K-line artifacts | Do not touch | Docs-only slice |

### Code Snippets
### Data Flow

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Guessed card status value is not recognized and the queue still counts pending | Medium | Advisory persists and re-triggers on K4 | Read the legal value from the installed repo-harness architecture-queue script before editing; verify with `architecture-queue status` after |
| `context-contract-sync sync-latest` writes outside allowed_paths | Low | Scope gate blocks the slice | allowed_paths includes `.ai/context/` and `docs/architecture/`; stop and report if it writes elsewhere |

## Task Contracts
- Contract file: `tasks/contracts/20260807-1144-architecture-root-card-closeout.contract.md`
- Review file: `tasks/reviews/20260807-1144-architecture-root-card-closeout.review.md`
- Implementation notes file: `tasks/notes/20260807-1144-architecture-root-card-closeout.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-1144-architecture-root-card-closeout.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One documentation PR: the closed card, the ruling snapshot, contract-sync link updates, and this slice's workflow artifacts.
- **Rollback surface**: Revert the card, snapshot, and sync-written files to their pre-slice commit; the card returns to Pending.
- **Verification boundary**: `architecture-queue status` pending=0/blocking=0, `check-architecture-sync` clean, `check-task-workflow --strict` pass.
- **Review/acceptance boundary**: The card's Required Follow-up list is the rubric — each item either done or explicitly adjudicated as not applicable in the closure note.
- **High-risk surface**: `docs/architecture/requests/root.md` closure semantics; a wrongly-dismissed real boundary drift would hide architecture debt from K4.
- **Why not checklist row**: Cross-surface writes (docs/architecture/ + .ai/context/) plus a tool-discovery step (legal status value) and a three-command verification boundary.

## Evidence Contract

- **State/progress path**: `tasks/notes/20260807-1144-architecture-root-card-closeout.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json` from `repo-harness run check-task-workflow --strict`, plus captured `architecture-queue status` and `check-architecture-sync` output in the notes file.
- **Evaluator rubric**: The card's Required Follow-up list and the queue/sync command outputs.
- **Stop condition**: Stop if the legal closed status cannot be determined from the repo-harness script source, or if `context-contract-sync sync-latest` writes outside allowed_paths.
- **Rollback surface**: See Promotion Gate.

## Annotations

## Task Breakdown
- [ ] C1 Card closure: read the legal closed status from the repo-harness architecture-queue script, edit `docs/architecture/requests/root.md` with that status and a dated adjudication note (drift = K0 package creation a3ab9a9; boundary already canonical in §7).
- [ ] C2 Snapshot + sync: write the thin ruling snapshot under `docs/architecture/snapshots/`, then run `repo-harness run context-contract-sync sync-latest` and keep its writes inside allowed_paths.
- [ ] C3 Verification: `architecture-queue status` pending=0/blocking=0, `check-architecture-sync` clean, `check-task-workflow --strict` pass.
