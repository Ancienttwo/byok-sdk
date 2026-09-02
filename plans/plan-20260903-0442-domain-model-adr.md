# Plan: Domain model and authority ADR ledger (WP2)

> **Status**: Executing
> **Created**: 20260903-0442
> **Slug**: domain-model-adr
> **Artifact Level**: work-package
> **Promotion Reason**: `docs/researches/2026-09-03_architecture-review.md` §8 WP2 and §12: before any wire v2 code, freeze the target vocabulary (Tenant / Computer / Installation / Agent / Session / Run / Attempt / Workspace / ResultContext), the one-fact-one-authority matrix, the capability model (one FeatureRegistry, three independent authorities, admission by intersection), the local-first deployment profile and the legacy cutover policy as Accepted ADRs, so WP3A/WP3B/WP4 implement one shape instead of re-deciding it in code.
> **Verification Boundary**: docs-only; `repo-harness run check-task-workflow --strict`, `bun run check:version-authority` (spec untouched), `git diff --check`; every ADR cites the review section and the current `file:line` it constrains.
> **Rollback Surface**: one new file under `docs/architecture/` plus appended rows in the ADR ledger table; revert the commit.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-03_architecture-review.md` §6, §8, §9, §12, §13; `docs/researches/20260903-GPT-review.md`; `docs/researches/20260903-GPT-review-2.md`
> **Task Contract**: `tasks/contracts/20260903-0442-domain-model-adr.contract.md`
> **Task Review**: `tasks/reviews/20260903-0442-domain-model-adr.review.md`
> **Implementation Notes**: `tasks/notes/20260903-0442-domain-model-adr.notes.md`

## Agentic Routing
- Selected route: docs-only, delegated to `fast-worker`, accepted by `gatekeeper`
- Routing reason: Decision content is already fixed in the review (owner-delegated); the work is to transcribe it into the repo's ADR convention with citations, not to decide.
- Due diligence:
  - P1 map: The repo's ADR ledger lives in `docs/architecture/sdk-architecture.md` 附录A (table rows `| ADR-0NN | title | status |`, currently ADR-001…022, several marked 目标设计). `docs/architecture/` has `index.md`, `domains/`, `modules/`, `requests/`, `snapshots/`, `diagrams/`; no `adr/` directory. The review is the decision source; GPT review 1/2 are inputs it already reconciled.
  - P2 trace: review §8 WP2 bullet list → one ADR each (ADR-023…ADR-031) in a new `docs/architecture/adr-2026-09-03-domain-model-and-authority.md` → rows appended to the 附录A table with status `Accepted` and a pointer to the new file → `docs/architecture/index.md` gains one link.
  - P3 decision rationale: A separate dated file keeps the 409-commit-stale canonical doc untouched except for ledger rows; ADRs are stated as constraints on future code (what must be true, what is forbidden, which `file:line` today violates it) so WP3/WP4 contracts can cite them as exit criteria. No spec edit here: WP0 owns `docs/spec.md:551-556` concurrently, and the computer/agent/session overview in spec is a later docs slice after WP0 merges.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260903-0442-domain-model-adr.md`
- Sprint contract: `tasks/contracts/20260903-0442-domain-model-adr.contract.md`
- Sprint review: `tasks/reviews/20260903-0442-domain-model-adr.review.md`
- Implementation notes: `tasks/notes/20260903-0442-domain-model-adr.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260903-0442-domain-model-adr.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260903-0442-domain-model-adr.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260903-0442-domain-model-adr.md`.

## Approach
### Strategy
Nine ADRs, each: Context (one paragraph, cites review section and today's `file:line`), Decision (normative, "must / must not"), Consequences (what WP3A/WP3B/WP4/WP5 must do; what is forbidden), Status Accepted (owner-delegated 2026-09-03).

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Dated ADR file + ledger rows (chosen) | Canonical doc untouched except rows; ADRs citeable by contracts | Two places to look | Use |
| Rewrite 附录A in place | One place | Edits a 409-commit-stale doc marked 目标设计; large diff | Reject |
| Put ADRs in spec | Spec is product truth | Spec is concurrently edited by WP0; ADRs are engineering constraints, not product behaviour | Reject |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `docs/architecture/adr-2026-09-03-domain-model-and-authority.md` | Create | ADR-023 Domain vocabulary (Tenant/Computer/Installation/Agent/Session/Run/Attempt/Workspace/ResultContext; `deviceId` = Installation; Computer stays host-side until a real multi-installation need). ADR-024 One fact, one authority matrix (SaaS vs Local Agent rows from GPT review §十一, reconciled). ADR-025 Native session locator never leaves the device; cloud `sessionId` is SDK-minted; Session stores no runtime intermediate state. ADR-026 Store-minted Attempt identity + leaseEpoch fencing on every authoritative side effect; old epoch → audit only. ADR-027 Capability model: one FeatureRegistry (id/version/dependency/compatibility/readback schema); Deployment, Installation, Runtime report facts independently; RunRequirements declares; admission = intersection; the two current vocabularies (`CAPABILITY_FLAGS`, ADR-010 declaration) converge on the registry, not on one object. ADR-028 AgentHome / SessionState / Workspace separation; mutable Workspace single writer; same-Session runs serial; Git worktree is a Workspace backend (plain-directory, git-worktree only). ADR-029 Coordination kernel single authority: `server` = cloud kernel + in-memory/SQLite stores + façade; WS retired after consumer audit (review §13); implemented before any v2 code. ADR-030 Data policy profiles: `local-first-v1` default (no contentful capability, no content-read routes, no memory-projection store, status-only ActivityStore, no per-task widening, provable by readback) and explicit `shared-observability-v1`; ActivityRelay vs ActivityStore naming; SessionResultCommitter as the result transaction authority. ADR-031 Legacy cutover policy: legacy `task.offer*`, `strictAgentOnly`, task-scoped gitWorkspace authority, ambient device selection are removed in the v2 cutover; no dual read/write; Salesko exact-pin migration |
| `docs/architecture/sdk-architecture.md` | Edit | Append ADR-023…031 rows to the 附录A ledger table (status Accepted, pointer to the new file); no other change |
| `docs/architecture/index.md` | Edit | One link to the new ADR file |

### Code Snippets
None (docs-only).

### Data Flow
Review §8/§12 → ADR text → ledger rows → cited by WP3/WP4 contracts.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| ADR restates review prose instead of normative constraints | Medium | Not citeable as exit criteria | Each Decision uses must/must-not and names the current violating `file:line` |
| Conflicts with WP0's spec edit | — | — | No spec edit in this plan |
| Ledger numbering collides with 目标设计 ADR rows | Low | Confusing ledger | Worker reads the current max ADR number and continues from it |

## Task Contracts
- Contract file: `tasks/contracts/20260903-0442-domain-model-adr.contract.md`
- Review file: `tasks/reviews/20260903-0442-domain-model-adr.review.md`
- Implementation notes file: `tasks/notes/20260903-0442-domain-model-adr.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260903-0442-domain-model-adr.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one docs commit.
- **Rollback surface**: see header.
- **Verification boundary**: see header.
- **Review/acceptance boundary**: `gatekeeper` checks every ADR cites the review section and a current `file:line`, and that no ADR contradicts an owner ruling recorded in the review (D1–D5, §12).
- **High-risk surface**: none.
- **Why not checklist row**: nine normative decisions that later contracts cite.

## Evidence Contract

- **State/progress path**: `tasks/notes/20260903-0442-domain-model-adr.notes.md`
- **Verification evidence**: `check-task-workflow --strict`, `git diff --check`, `check:version-authority` outputs in notes
- **Evaluator rubric**: 9 ADRs present, each with Context/Decision/Consequences/Status, review citation and `file:line`; ledger rows appended; index linked; spec untouched
- **Stop condition**: an ADR would require deciding something the review left open (then record it as Proposed with the open question, do not decide)
- **Rollback surface**: see header

## Annotations
- Resolved: numbering continues from the current 附录A maximum (ADR-023 onward unless the worker finds a higher existing number, then it continues from there); status wording is `Accepted (owner-delegated 2026-09-03)`.

## Task Breakdown
- [x] T1 Read review §6/§8/§12/§13 and 附录A; determine next ADR number
- [x] T2 Write ADR-026…034 with citations (附录A 当前最大值为 ADR-025)
- [x] T3 Ledger rows + index link
- [x] T4 Run verification boundary; notes
