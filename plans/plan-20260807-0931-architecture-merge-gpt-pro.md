# Plan: Merge GPT Pro Architecture Increments

> **Status**: Executing
> **Created**: 20260807-0931
> **Slug**: architecture-merge-gpt-pro
> **Artifact Level**: work-package
> **Promotion Reason**: The merge touches the single canonical architecture document that every downstream due-diligence claim reads, and it must land the target-design increments without polluting the verified current-state evidence skeleton; a checklist row cannot carry the 6 corrections plus 10 merge groups and their marking rule.
> **Verification Boundary**: `repo-harness run check-task-workflow --strict` (this is a docs-only slice; no source or test file changes, so the code gates are unaffected and are not re-run as the milestone gate).
> **Rollback Surface**: The slice edits `docs/architecture/sdk-architecture.md` plus the Proposed sprint file and workflow artifacts. Reverting the document to its state at `188dca9` restores the canonical snapshot; the sprint file is Proposed and unreferenced by any Executing plan, so deleting it is a clean revert.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/gpt-pro-architecture-rewrite-decision.md`
> **Task Contract**: `tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md`
> **Task Review**: `tasks/reviews/20260807-0931-architecture-merge-gpt-pro.review.md`
> **Implementation Notes**: `tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: The merge rule ("target design" increments in, wrong current-runtime claims out) is a judgment the decision document already froze; execution is mechanical but the scope guard around `docs/architecture/` has to be opened deliberately rather than widened on the K-line contract.
- Due diligence:
  - P1 map: `docs/researches/gpt-pro-architecture-rewrite-decision.md` — canonical document is the current-state authority (P1/P2/P3 + `file:line` evidence skeleton); the GPT Pro bundle in `_ref/byok-architecture-rewrite/` is a design charter. Two different artifact classes, so the merge is additive into §12-§15, not a replacement.
  - P2 trace: the decision document's rejection table E1-E9 traces each rewritten claim back to the source line that falsifies it (`create-daemon.ts:793-816`, `permission-mapping.ts:118-125`, `ws-transport.ts:248-254`, ...), which is what makes "reject the claim, keep the increment" separable per item.
  - P3 decision rationale: `docs/researches/gpt-pro-architecture-rewrite-decision.md` §"為什麼不是整份替換(A)也不是僅存檔(C)" — whole-file replacement would trade 11 classes of verified evidence for 4 wrong runtime claims and would dismantle the P1/P2/P3 structure required by `CLAUDE.md`; archive-only would discard GAP-004/GAP-005 and the crash matrix, which are real gaps the canonical document is missing.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-0931-architecture-merge-gpt-pro.md`
- Sprint contract: `tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md`
- Sprint review: `tasks/reviews/20260807-0931-architecture-merge-gpt-pro.review.md`
- Implementation notes: `tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260807-0931-architecture-merge-gpt-pro.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260807-0931-architecture-merge-gpt-pro.md`.

## Approach
### Strategy
Execute option B from `docs/researches/gpt-pro-architecture-rewrite-decision.md`: keep `docs/architecture/sdk-architecture.md` as the current-state authority, apply the 6 self-corrections it owes regardless of the bundle, and merge the 10 target-design increment groups into §12-§15 with an explicit "目標設計" (target design) marker on every merged block. Do not run the bundle's `apply.sh`; do not import any of the E1-E9 rejected claims.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A. Replace the canonical document with the rewrite | One coherent charter document | Trades 11 classes of verified `file:line` evidence for 4 wrong runtime claims; dismantles the required P1/P2/P3 structure | Rejected |
| B. Merge the target-design increments, mark them, reject the wrong claims | Keeps the recomputable current-state snapshot and gains the genuinely new surfaces (crash matrix, journal contract, GAP-004/005, I1-I9, ADR ledger) | Requires per-item judgment, already frozen in the decision document | **Use** |
| C. Archive the rewrite without merging | Zero risk to the canonical document | Discards verified real gaps the canonical document is missing | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `docs/architecture/sdk-architecture.md` | Edit | 6 self-corrections (§7.1 secret scope, §5.1 control-socket RPC surface, §11 GAP-004/GAP-005, §14.2 reconnect jitter, §3.3 steer gate, §13 RAFT hedges) plus the 10 target-design merge groups into §12-§15 |
| `plans/sprints/` | Create (may already exist) | The Proposed sprint file with its 4+1 preconditions applied; a parallel agent may have landed it already, in which case this entry is annotated as done rather than redone |
| `docs/researches/gpt-pro-architecture-rewrite-decision.md` | Edit | Record execution state against the decision's 執行單 if items are resolved differently than written |
| `tasks/todos.md` | Edit | Park K-501 and any deferred item that must not enter the sealed K-line plan |
| `plans/plan-20260805-1659-byok-keys-package.md`, `tasks/contracts/20260805-1659-*` | Do not touch | The K line is Executing and sealed; this slice must not alter its status or content |
| `packages/**`, `docs/spec.md` | Do not touch | Docs-only slice; no runtime or spec change |

### Code Snippets
### Data Flow

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A rejected E1-E9 claim leaks in with a merged increment | Medium | Canonical document loses its current-state trustworthiness | Every merged block carries the target-design marker; anything describing current runtime must cite a `file:line` verified against local source |
| The new Proposed sprint file trips `check-task-workflow --strict` against the Executing K line | Medium | Red gate blocks the slice | Run the strict check as the milestone gate; the sprint file stays Proposed and does not become the active plan |
| Scope creep into the K line's sealed artifacts | Low | Pollutes a Fulfilled contract and its acceptance record | `allowed_paths` in this slice's contract excludes every K-line artifact |

## Task Contracts
- Contract file: `tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md`
- Review file: `tasks/reviews/20260807-0931-architecture-merge-gpt-pro.review.md`
- Implementation notes file: `tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One documentation PR: the canonical architecture merge plus the Proposed sprint file and this slice's workflow artifacts.
- **Rollback surface**: Revert `docs/architecture/sdk-architecture.md` to its `188dca9` content and delete the Proposed sprint file; nothing else depends on either.
- **Verification boundary**: `repo-harness run check-task-workflow --strict`.
- **Review/acceptance boundary**: The decision document's 併入清單 and 拒收 table are the acceptance rubric — every merged group present and marked, every rejected claim absent.
- **High-risk surface**: `docs/architecture/sdk-architecture.md` is the single canonical architecture authority; a wrong current-runtime claim merged here propagates into every later due-diligence pass.
- **Why not checklist row**: 6 corrections plus 10 merge groups, each with its own evidence anchor, and a scope-guard change to open `docs/architecture/` — too much state for a row.

## Evidence Contract

- **State/progress path**: `tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json` from `repo-harness run check-task-workflow --strict`.
- **Evaluator rubric**: `docs/researches/gpt-pro-architecture-rewrite-decision.md` — the 併入清單 (10 groups), the canonical self-correction list (6 items), and the E1-E9 rejection table.
- **Stop condition**: Stop if a merge item would require asserting a current-runtime fact not verifiable against local source, or if any edit would fall outside this contract's `allowed_paths`.
- **Rollback surface**: See Promotion Gate.

## Annotations

## Task Breakdown
- [x] A1 Canonical document merge: apply the 6 self-corrections listed under 「canonical 自身要修的錯」 in `docs/researches/gpt-pro-architecture-rewrite-decision.md`, then merge the 10 target-design increment groups from 「併入清單」 into `docs/architecture/sdk-architecture.md` §12-§15, each marked as 目標設計. Reject every E1-E9 claim.
- [x] A2 Proposed sprint file: land the sprint file under `plans/sprints/` with the 4+1 preconditions from 「sprint 檔(Proposed)的 4 項前置」 applied (crosswalk, explicit supersede record, C1/C2 withdrawal, workflow-status correction, story-point removal). A parallel agent may already have completed this; if so, verify and annotate rather than rewrite. Precondition 5's K-501 clause is satisfied outside the sprint file: K-501 is parked in `tasks/todos.md` (the `TruthStore` wiring row), not appended to the sealed K-line plan.
- [x] A3 Verification: run `repo-harness run check-task-workflow --strict` and confirm the new Proposed sprint file does not conflict with the Executing K-line plan.
