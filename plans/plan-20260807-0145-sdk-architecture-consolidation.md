# Plan: SDK Architecture Doc Consolidation

> **Status**: Executing
> **Created**: 20260807-0145
> **Slug**: sdk-architecture-consolidation
> **Artifact Level**: work-package
> **Promotion Reason**: The active contract `tasks/contracts/20260805-1659-byok-keys-package.contract.md` is `Fulfilled` and its `allowed_paths` does not include `docs/architecture/`, so `ContractScopeGuard` hard-blocks this work. A fulfilled contract must not be retro-edited to widen its scope, so this slice needs its own contract — and a contract needs an owning plan. Under strict mode an executing plan cannot project a contract from a checklist row, which forces `work-package`.
> **Verification Boundary**: `rg -n 'raft-cli-architecture|sdk-architecture-codex' docs/` returns no hits; `docs/architecture/` holds exactly one `sdk-architecture*.md`; all 19 extracted Mermaid fences render under `@mermaid-js/mermaid-cli`; `repo-harness run verify-contract --contract tasks/contracts/20260807-0145-sdk-architecture-consolidation.contract.md --strict` passes. The repo's `pnpm` triple is deliberately outside this boundary: the slice touches zero files under `packages/`, so typecheck/test/build cannot observe it.
> **Rollback Surface**: One commit touching only `docs/` plus this slice's workflow artifacts. `git revert` restores the 621-line `docs/architecture/sdk-architecture.md` from `a126274`; the three removed files are recoverable from the revert. No runtime, package manifest, or lockfile is involved, so rollback cannot break a build.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/raft-architecture-reference.md`
> **Task Contract**: `tasks/contracts/20260807-0145-sdk-architecture-consolidation.contract.md`
> **Task Review**: `tasks/reviews/20260807-0145-sdk-architecture-consolidation.review.md`
> **Implementation Notes**: `tasks/notes/20260807-0145-sdk-architecture-consolidation.notes.md`

## Agentic Routing
- Selected route: single-worker
- Routing reason: Bounded documentation consolidation with a fixed four-step edit order and a mechanical falsifier. No architecture judgment is delegated — the choice of base document was already made by the user under review.
- Due diligence:
  - P1 map: `docs/architecture/` holds the SDK architecture surface. Two competing documents existed: tracked `sdk-architecture.md` (621 lines, `a126274`) and untracked `sdk-architecture-codex.md` (1038 lines, 19 Mermaid fences). Two untracked support files existed under `docs/researches/`: a 26-line readback carrying post-merge corrections, and a 7-line stub whose only content pointed at `raft-architecture-reference.md` (1865 lines, the canonical RAFT research). `docs/architecture/index.md` is a harness-managed ledger and is out of scope. Scope authority is `ContractScopeGuard`, reading the active contract named by `.ai/harness/active-plan`.
  - P2 trace: A reader following the Codex document's §13 RAFT section hits `` `docs/researches/raft-cli-architecture.md` ``, lands on a 7-line stub, and is redirected to `raft-architecture-reference.md` — one wasted hop, and a broken link the moment the stub is deleted. The same document's §1.2 scale table reports `server 23 / 5,192` and `client 87 / 19,379` test files/LOC; recomputing with the readback's `find` + `wc -l` commands against the live tree yields `24 / 5,494` and `90 / 20,070`. The delta is the test fixtures `main` landed during the parallel run (`src/__tests__/test-support.ts`, `src/__tests__/fixtures/*.ts`). The pressure point: deleting the readback and the stub first would strand both the corrected numbers and the link target.
  - P3 decision rationale: The parallel-run scaffolding (readback file, stub file, `-codex` filename suffix, "不覆盖并行生成" status line) exists only to let two documents coexist while under review. Review is over, so the scaffolding is pure cost — it is the mechanism by which a second source of truth persists. The invariant to preserve is that `docs/architecture/` answers "what is this SDK's shape" exactly once. The smallest coherent change folds the readback's correction values and its counting convention into the surviving document, repoints the links at canonical, then deletes the scaffolding — in that order, so no step transiently destroys information the next step needs.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-0145-sdk-architecture-consolidation.md`
- Sprint contract: `tasks/contracts/20260807-0145-sdk-architecture-consolidation.contract.md`
- Sprint review: `tasks/reviews/20260807-0145-sdk-architecture-consolidation.review.md`
- Implementation notes: `tasks/notes/20260807-0145-sdk-architecture-consolidation.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-0145-sdk-architecture-consolidation.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260807-0145-sdk-architecture-consolidation.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260807-0145-sdk-architecture-consolidation.md`.

## Approach
### Strategy

Fold information inward, then delete outward. Every value that lives only in a file scheduled for deletion moves into the surviving document first; the deletions come last and are pure subtraction. The four steps are strictly ordered and each is independently checkable.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Widen the fulfilled K3 contract's `allowed_paths` to cover `docs/architecture/` | Zero new artifacts | Retro-edits a `Fulfilled` contract, destroying the record of what K3 actually authorized; the scope gate stops meaning anything | Rejected |
| Keep both documents, mark the old one superseded | No content risk | Leaves two answers in `docs/architecture/`; a superseded marker is a compatibility path, not a decision | Rejected |
| Delete the readback and stub first, then consolidate | Fewer files to carry through the edit | Strands the corrected scale values and breaks the RAFT link mid-slice | Rejected — this is exactly the ordering hazard |
| New docs-only contract; fold in, repoint, move, delete | Scope gate enforces "zero code change" mechanically; one source of truth; no information loss | Costs a plan + contract + review + notes | **Chosen** |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `docs/architecture/sdk-architecture.md` | Replace | Receives the corrected Codex content (1048 lines, 19 Mermaid fences); the prior 621-line version is retired |
| `docs/architecture/sdk-architecture-codex.md` | Delete | Content moved to the canonical path; the `-codex` suffix was parallel-run scaffolding |
| `docs/researches/sdk-architecture-codex-current-readback.md` | Delete | Correction values and counting convention folded into §1.2 |
| `docs/researches/raft-cli-architecture.md` | Delete | 7-line stub; its link-stability job is now served by canonical directly |
| `docs/researches/raft-architecture-reference.md` | Track unmodified | Was untracked; must enter version control so the repointed links resolve. Body is not edited — its §16.2 was already corrected by the user this round |

### Data Flow

Scale numbers flow `packages/*/src` → `find` + `wc -l` → §1.2 table. The readback file was a temporary staging point in that flow; after this slice the table carries the recompute command inline, so the flow has no intermediate file left to drift.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A Mermaid fence breaks during the file move | Low | High — 19 diagrams are the document's main value | Extract every fence and render each under `@mermaid-js/mermaid-cli`; require 19/19 |
| A reference to a deleted file survives somewhere in the repo | Medium | Medium — dangling link | `rg` sweep over `docs/`, wired into `commands_succeed` |
| The corrected scale numbers are themselves wrong | Low | Medium — a doc that claims recomputability but is not | Recompute all four rows independently from the live tree before editing, not just the two that changed |
| Code accidentally changes in a docs-only slice | Low | High — silently widens the blast radius | `packages/**` excluded from `allowed_paths`; `test -z "$(git status --porcelain -- packages/)"` in `commands_succeed` |

## Task Contracts
- Contract file: `tasks/contracts/20260807-0145-sdk-architecture-consolidation.contract.md`
- Review file: `tasks/reviews/20260807-0145-sdk-architecture-consolidation.review.md`
- Implementation notes file: `tasks/notes/20260807-0145-sdk-architecture-consolidation.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-0145-sdk-architecture-consolidation.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One commit on `main` touching `docs/` plus this slice's four workflow artifacts.
- **Rollback surface**: `git revert` of that single commit. No runtime, manifest, or lockfile involved.
- **Verification boundary**: scoped `rg` sweep, single-file assertion under `docs/architecture/`, 19/19 Mermaid render, `verify-contract --strict`.
- **Review/acceptance boundary**: the contract's `exit_criteria`; the choice of base document was already accepted by the user before this slice opened.
- **High-risk surface**: none in the runtime sense. The only irreversible-feeling act is retiring the 621-line document, which is recoverable from `a126274`.
- **Why not checklist row**: strict mode forbids an executing plan from projecting a contract off a checklist row, and this slice exists precisely to own a contract.

## Evidence Contract

- **State/progress path**: `tasks/notes/20260807-0145-sdk-architecture-consolidation.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json` plus the verify-contract run report.
- **Evaluator rubric**: the contract's `exit_criteria` block verbatim — 9 `files_contain`, 6 `files_not_contain`, 3 `files_not_exist`, 3 `commands_succeed`.
- **Stop condition**: stop and hand back if any edit would fall outside `allowed_paths`, or if the four-step order is forced to invert.
- **Rollback surface**: as above — one revertible commit.

## Annotations

- Resolved: the user reviewed both parallel architecture documents on 2026-08-07 and selected the Codex version as the base before this slice opened. The four steps are mechanical corrections to that accepted base; none requires a judgment call. No open annotations remain.

## Task Breakdown
- [x] S1 §1.2 scale correction: `server` test column → `24 / 5,494`, `client` test column → `90 / 20,070`; production columns and the `protocol`/`keys` rows untouched. Fold the counting convention and the `find` + `wc -l` recompute commands in below the table so the readback file can be deleted without information loss.
- [x] S2 Link repoint: both occurrences of `docs/researches/raft-cli-architecture.md` (the §13 RAFT lead-in and the tail reference table) → `docs/researches/raft-architecture-reference.md`.
- [x] S3 Canonicalization: heading → `# BYOK SDK 架构文档`, status blockquote drops the parallel-run framing and pins the snapshot to `a8c2732`; content lands at `docs/architecture/sdk-architecture.md` and `sdk-architecture-codex.md` ceases to exist.
- [x] S4 Scaffolding removal, strictly after S1–S3: delete `docs/researches/sdk-architecture-codex-current-readback.md` and `docs/researches/raft-cli-architecture.md`.
