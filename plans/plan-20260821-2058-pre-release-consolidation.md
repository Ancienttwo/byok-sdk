# Plan: Consolidate remaining WIP and release 0.6.0

> **Status**: Executing
> **Created**: 20260821-2058
> **Slug**: pre-release-consolidation
> **Artifact Level**: work-package
> **Promotion Reason**: User authorized consolidation of all remaining WIP, cleanup, then release.
> **Verification Boundary**: One final merged source subject, full required checks, packed artifact closure, registry readback, tag and GitHub Release.
> **Rollback Surface**: Source consolidation is revertable before publish; npm versions are immutable after publish and therefore require frozen-artifact readback before tag/Release closeout.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260821-2058-pre-release-consolidation.contract.md`
> **Task Review**: `tasks/reviews/20260821-2058-pre-release-consolidation.review.md`
> **Implementation Notes**: `tasks/notes/20260821-2058-pre-release-consolidation.notes.md`

## Agentic Routing
- Selected route: single orchestrator in one clean integration worktree; no concurrent writers.
- Routing reason: the hosted-authority branch overlaps current U1-U5 release and dataplane files, so conflict ownership must remain serial and explicit.
- Due diligence:
  - P1 map: `origin/main` is source authority; three historical WIP branches plus current root policy WIP are candidate inputs; release authority is `scripts/release/publish.mjs` plus registry readback.
  - P2 trace: branch patch -> conflict-resolved integration -> required checks/CI -> main -> cleanup -> frozen tarballs -> ordered npm publish -> registry readback -> annotated tag/GitHub Release.
  - P3 decision rationale: patch-equivalent Live Activity work is marked absorbed without a synthetic merge; current root policy projection supersedes its stale projection; hosted authority semantics are merged while current U1-U5 contracts win conflicts.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260821-2058-pre-release-consolidation.md`
- Sprint contract: `tasks/contracts/20260821-2058-pre-release-consolidation.contract.md`
- Sprint review: `tasks/reviews/20260821-2058-pre-release-consolidation.review.md`
- Implementation notes: `tasks/notes/20260821-2058-pre-release-consolidation.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260821-2058-pre-release-consolidation.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260821-2058-pre-release-consolidation.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260821-2058-pre-release-consolidation.md`.

## Approach
### Strategy

1. Preserve the current dirty root policy/architecture WIP on a dedicated branch.
2. Merge hosted integration authority, the root release handoff, and the current policy branch into this clean candidate; prove the Live Activity branch is already patch-equivalent.
3. Resolve the pending architecture request as workflow-policy documentation rather than introducing a product module change.
4. Freeze one final subject, run build/typecheck/test/strict plus release graph/pack and real dataplane checks, obtain acceptance, merge through a PR, then clean only proven-merged worktrees/branches.
5. Run the release driver dry run on the exact clean main subject. Execute publish only with authenticated npm authority; verify registry before pushing the annotated tag and creating the GitHub Release.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Merge every branch commit literally | Preserves ancestry labels | Creates redundant merge for patch-equivalent docs and can reintroduce stale workflow state | Reject |
| Cherry-pick only selected files | Small diff | Loses reviewed hosted-authority commit lineage and risks omitting coupled tests | Reject |
| Serial conflict-resolved merge, with content/ancestry absorption proof | Preserves reviewed package and test set while retaining newer main authority | Requires a fresh final-subject acceptance | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| Hosted-authority branch paths | Merge | Add role-backed schema E2E, exact migration readback, keys graph and release readback closure.
| `docs/researches/2026-08-20_hosted-live-activity-pilot-closure.md` | Verify | Confirm branch content is already identical on main; no duplicate edit.
| Root architecture/release handoff paths | Merge | Preserve release identity handoff and current circuit-breaker policy projection.
| Workflow plan/contract/notes/review | Add/archive | Bind final subject, acceptance and cleanup evidence.
| Release artifacts | Generate outside git | Freeze tarballs and manifest from the final main SHA.

### Code Snippets
### Data Flow

`historical candidates -> one current-main merge subject -> CI/acceptance -> main -> cleanup -> immutable tarballs -> npm registry -> tag/Release`

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Old hosted branch overwrites U1-U5 semantics | Medium | High | Resolve conflicts with current main as authority and rerun full/real dataplane matrices.
| Stale architecture projection replaces newer policy event | High | Medium | Merge the current root-policy branch after the historical root branch and keep the shared event-key projection.
| Release from a dirty or non-main subject | Low | High | Clean worktree, exact HEAD manifest, remote main ancestry and registry candidacy checks.
| Partial npm publication | Low | High | Dependency-ordered frozen artifacts, fail-closed driver, registry readback of every package, no retry over already-published versions.
| Missing npm credentials | Observed | High | Finish source merge/cleanup first; stop before publish if no authenticated userconfig is available. Never print or mutate credentials.

## Task Contracts
- Contract file: `tasks/contracts/20260821-2058-pre-release-consolidation.contract.md`
- Review file: `tasks/reviews/20260821-2058-pre-release-consolidation.review.md`
- Implementation notes file: `tasks/notes/20260821-2058-pre-release-consolidation.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260821-2058-pre-release-consolidation.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one `codex/pre-release-consolidation` PR.
- **Rollback surface**: one source merge commit/PR before registry publication.
- **Verification boundary**: final PR head and then exact merged main SHA.
- **Review/acceptance boundary**: normalized final content with external Codex acceptance; prior branch receipts are inputs, not authority for the rebased subject.
- **High-risk surface**: migration verification, release graph, npm immutable publication.
- **Why not checklist row**: cross-package source merge plus irreversible release needs subject-bound evidence and a typed receipt.

## Evidence Contract

- **State/progress path**: this plan, its contract, notes, review, and `.ai/harness/runs/`.
- **Verification evidence**: required checks, deploy SQL ordering, release graph, pack/install, real Postgres+MinIO tests, GitHub CI, registry readback.
- **Evaluator rubric**: no authority regression, no compatibility fallback, current U1-U5 behavior retained, release metadata exact.
- **Stop condition**: unresolved product conflict, failing final-subject evidence, unauthenticated npm, partial registry state that does not match the frozen manifest, or target main drift.
- **Rollback surface**: discard/revert candidate before publish; after any publish, resume only from registry truth and never republish an existing version.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Preserve and inventory every WIP candidate; classify merged-by-content versus truly missing work.
- [x] Merge hosted authority and root/policy WIP into the clean candidate with current main as semantic authority.
- [x] Resolve architecture queue and refresh workflow projections.
- [ ] Run focused conflict tests, real Postgres+MinIO checks, build, typecheck, full test, strict workflow and release pack gates.
- [ ] Freeze final review subject, record AcceptanceReceipt, push PR, wait CI, and merge.
- [ ] Clean only branches/worktrees proven absorbed by `origin/main`; preserve unrelated detached/dirty state.
- [ ] Run clean-main release dry run, authenticate without exposing secrets, execute ordered publish, and perform registry readback.
- [ ] Push annotated `v0.6.0`, create GitHub Release from the verified main subject, and report production as separately unverified.
