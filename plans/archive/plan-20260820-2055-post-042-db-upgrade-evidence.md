# Plan: A2 v0.4.2 Database to 0.5.0 Candidate Upgrade Evidence

> **Status**: Archived
> **Created**: 20260820-2055
> **Slug**: post-042-db-upgrade-evidence
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Exact candidate tarballs, frozen v0.4.2 checksums, isolated Postgres upgrade, full repo checks
> **Rollback Surface**: Revert local candidate commit before publish; disposable Postgres schemas only
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260820-2055-post-042-db-upgrade-evidence.contract.md`
> **Task Review**: `tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md`
> **Implementation Notes**: `tasks/notes/20260820-2055-post-042-db-upgrade-evidence.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260820-2055-post-042-db-upgrade-evidence.md`
- Sprint contract: `tasks/contracts/20260820-2055-post-042-db-upgrade-evidence.contract.md`
- Sprint review: `tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md`
- Implementation notes: `tasks/notes/20260820-2055-post-042-db-upgrade-evidence.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260820-2055-post-042-db-upgrade-evidence.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260820-2055-post-042-db-upgrade-evidence.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260820-2055-post-042-db-upgrade-evidence.md`.

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
- Contract file: `tasks/contracts/20260820-2055-post-042-db-upgrade-evidence.contract.md`
- Review file: `tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md`
- Implementation notes file: `tasks/notes/20260820-2055-post-042-db-upgrade-evidence.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260820-2055-post-042-db-upgrade-evidence.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260820-2055-post-042-db-upgrade-evidence.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert local candidate commit before publish; disposable Postgres schemas only
- **Verification boundary**: Exact candidate tarballs, frozen v0.4.2 checksums, isolated Postgres upgrade, full repo checks
- **Review/acceptance boundary**: `tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260820-2055-post-042-db-upgrade-evidence.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260820-2055-post-042-db-upgrade-evidence.contract.md`, `tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md`, and `tasks/notes/20260820-2055-post-042-db-upgrade-evidence.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260820-2055-post-042-db-upgrade-evidence.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert local candidate commit before publish; disposable Postgres schemas only

## Captured Planning Output

## Thesis

The release gate should prove one forward-only authority chain: frozen published migration bytes become a seeded v0.4.2 database, and the exact candidate tarball upgrades that database without changing existing mailbox, task, truth, or quota facts. A second migration runner or compatibility path would weaken that proof.

## P1 Architecture Map

- deploy/sql is the only migration authoring authority.
- packages/cloud-dataplane owns the forward-only runner and packaged migration directory.
- scripts/release/pack-and-smoke.mjs freezes exact candidate tarballs and proves package graph, SQL checksums, isolated install, and imports.
- scripts/release/pg-migrate-smoke.mjs consumes those exact tarballs against ephemeral Postgres.
- Git tag v0.4.2 freezes migrations 0001 through 0007; migration 0008 is the candidate delta.
- Production databases, publish, deploy, Salesko repin, and connector lifecycle are out of scope.

## P2 Concrete Trace

1. Read v0.4.2 migration checksums from a committed frozen fixture sourced from tag v0.4.2.
2. Install the exact candidate tarballs emitted by pack-and-smoke in an isolated directory.
3. Preserve the existing empty-database full migration and idempotence proof in one Postgres schema.
4. In a second schema, apply only frozen migrations 0001 through 0007, verify the ledger checksums, and insert representative mailbox, task, truth, and quota rows.
5. Run the candidate packaged migration directory; require only post-v0.4.2 migrations to apply, prior rows to remain byte-for-byte observable, migration 0008 indexes to exist, replay insertion to be atomic single-use, and a final rerun to be a no-op.

## P3 Decision

Use one existing runner and two isolated schemas in the ephemeral CI database. Freeze only the v0.4.2 checksum boundary; do not snapshot a database dump, invent a compatibility migrator, or contact production. Candidate packages use the A1-selected 0.5.0 aligned dispatch version, while keys remain independently versioned at 0.2.0.

The first proof point is a local Postgres run from exact packed tarballs. The thesis is falsified if the published v0.4.2 checksums differ, existing seeded rows change, migration 0008 cannot apply transactionally after 0001 through 0007, replay uniqueness is not atomic, or the installed candidate graph does not close to one version.

## Scope

- scripts/release/pg-migrate-smoke.mjs
- scripts/release/fixtures/v0.4.2-migration-checksums.json
- .github/workflows/ci.yml
- aligned dispatch package manifests and bun.lock for 0.5.0 candidate identity
- docs/researches/2026-08-20_post-042-progress-and-sprint-audit.md for A2 evidence closeout

## Workflow Inventory

- Active plan: this captured work-package under plans/
- Contract, review, and notes: none under the lite profile unless risk floor promotes
- Deferred ledger: tasks/todos.md remains unchanged
- Checks authority: .ai/harness/checks/latest.json and .ai/harness/runs/
- Allowed-path owner: this A2 work-package
- Isolation: preserve existing A1 worktree changes; no push, publish, deploy, migration against production, or Salesko edit

## Task Breakdown

- [x] Freeze and validate v0.4.2 migration 0001 through 0007 checksums from the published tag.
- [x] Extend packed-tarball Postgres smoke with isolated empty and seeded v0.4.2 upgrade schemas.
- [x] Set the aligned dispatch candidate manifests and lockfile to 0.5.0 without changing keys 0.2.0.
- [x] Freeze the exact candidate SHA, pack tarballs, and run package graph, isolated import, checksum, and real Postgres upgrade evidence.
- [x] Record A2 evidence and leave publish, deploy, production preflight, and Salesko repin unauthorized and untouched.
- [x] Remediate independent-review evidence gaps with tag-bound migration bytes, stream preservation, installed-package concurrent replay, explicit fresh-database diagnostics, and a default-schema empty install.
- [x] Obtain a fresh independent disposition for the remediated subject; do not reuse the rejected receipt.

## Verification

- bun run check:release-graph
- bun run build
- bun run typecheck
- bun run test
- bun run check:release-pack -- --out-dir a disposable artifact directory from a clean committed candidate
- node scripts/release/pg-migrate-smoke.mjs --artifacts the same artifact directory with an ephemeral Postgres DATABASE_URL
- repo-harness run check-task-workflow --strict
- git diff --check

## Rollback Surface

Before publish, revert the local candidate commit. Database rollback is intentionally absent; all Postgres verification targets disposable schemas only.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Freeze and validate v0.4.2 migration 0001 through 0007 checksums from the published tag.
- [x] Extend packed-tarball Postgres smoke with isolated empty and seeded v0.4.2 upgrade schemas.
- [x] Set the aligned dispatch candidate manifests and lockfile to 0.5.0 without changing keys 0.2.0.
- [x] Freeze the exact candidate SHA, pack tarballs, and run package graph, isolated import, checksum, and real Postgres upgrade evidence.
- [x] Record A2 evidence and leave publish, deploy, production preflight, and Salesko repin unauthorized and untouched.
- [x] Remediate independent-review evidence gaps with tag-bound migration bytes, stream preservation, installed-package concurrent replay, explicit fresh-database diagnostics, and a default-schema empty install.
- [x] Obtain a fresh independent disposition for the remediated subject; do not reuse the rejected receipt.
