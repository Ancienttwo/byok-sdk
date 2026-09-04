# Plan: Public package topology decision

> **Status**: Executing
> **Created**: 20260905-0114
> **Slug**: public-package-topology
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved a bounded architecture ruling after observing that WP3B collapsed implementation authority but did not reduce the public package count. The ruling affects the public npm topology and a later breaking release boundary, so it needs durable ADR authority rather than an inline note.
> **Verification Boundary**: `git diff --check`; exact consumer inventory for `@byok-sdk/server` and `byok-sdk`; `repo-harness run check-architecture-sync`; `repo-harness run check-task-workflow --strict`
> **Rollback Surface**: Revert this docs-only decision package. No manifest, source, lockfile, npm registry, release, or downstream state changes in this slice.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-03_architecture-review.md`; `docs/researches/evidence/2026-09-03-architecture-review/track-opus.md`; `docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md`
> **Task Contract**: `tasks/contracts/20260905-0114-public-package-topology.contract.md`
> **Task Review**: `tasks/reviews/20260905-0114-public-package-topology.review.md`
> **Implementation Notes**: `tasks/notes/20260905-0114-public-package-topology.notes.md`

## Agentic Routing
- Selected route: parent-agent, docs-only architecture decision.
- Routing reason: the current manifests, release scripts, repo imports, Salesko imports, WP3B packet, and prior O1 ruling provide a bounded evidence set. No code implementation or broad external research is authorized.
- Due diligence:
  - P1 map: `@byok-sdk/server` is the Node/Hono self-hosted deployment adapter over `@byok-sdk/cloud`; `byok-sdk` is a one-source-file namespace umbrella that depends on every dispatch package. The release graph currently publishes ten public artifacts plus private `@byok-sdk/conformance`.
  - P2 trace: self-hosted calls enter `createByokServer`, compose server-local deployment policy and stores, and delegate coordination semantics to `createByokCloud`. The umbrella has no product path: its only in-repo consumers are README/package documentation and pack/registry smokes; Salesko imports neither `byok-sdk` nor `@byok-sdk/server`.
  - P3 decision rationale: retain `@byok-sdk/server` because it owns a real Node deployment boundary and shields the environment-neutral cloud kernel from Hono Node composition. Retire the redundant `byok-sdk` umbrella in one later breaking release: direct package imports already express ownership, selective installation, and runtime boundaries; no compatibility package or alias remains after cutover. At 10x package count, the umbrella's exact dependency fan-out, install weight, and release/readback matrix scale linearly while adding no capability.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260905-0114-public-package-topology.md`
- Sprint contract: `tasks/contracts/20260905-0114-public-package-topology.contract.md`
- Sprint review: `tasks/reviews/20260905-0114-public-package-topology.review.md`
- Implementation notes: `tasks/notes/20260905-0114-public-package-topology.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260905-0114-public-package-topology.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260905-0114-public-package-topology.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260905-0114-public-package-topology.md`.

## Approach
### Strategy

Record one durable topology decision now, and leave the mechanical removal for a separately approved breaking-release work package. This slice distinguishes the already-completed WP3B authority fold from package-count reduction.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Delete `@byok-sdk/server` | Removes one package named in the WP3B fold | Erases a real self-hosted Node deployment boundary; pushes Node/Hono policy into the environment-neutral cloud kernel or requires a replacement package | Reject |
| Retain `@byok-sdk/server` | Preserves a meaningful deployment adapter and direct consumers | Public count does not fall through WP3B itself | Accept |
| Retain `byok-sdk` umbrella | One convenient install/import | Duplicates all direct entrypoints, installs every dispatch package, expands every release/readback, has no product-code consumer found | Reject for steady state |
| Retire `byok-sdk` in a breaking release | Reduces public artifacts from 10 to 9 and leaves one entrypoint per ownership boundary | Breaking for unknown external umbrella consumers; requires coordinated docs/release-script cutover | Accept for later implementation |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `docs/architecture/adr-2026-09-05-public-package-topology.md` | Create | Freeze server retention and umbrella retirement decision, invariants, consequences, and later cutover gate |
| `docs/architecture/sdk-architecture.md` | Edit | Make current package count explicit and point to the topology decision |
| `docs/architecture/requests/archive/2026/20260905-012013-root.md`, `packages/{AGENTS,CLAUDE}.md` | Generated closeout | Archive the pre-existing aggregated WP3B queue card as no-change against its existing snapshot and clear the pending projection |
| plan/contract/notes/review artifacts | Create/update | Preserve scope, evidence, verification, and completion state |

### Data Flow

Current self-hosted runtime: `host -> @byok-sdk/server -> @byok-sdk/cloud -> @byok-sdk/core stores`.

Later package install topology: consumers install only the owning scoped packages; there is no `byok-sdk` aggregate authoring or compatibility path.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Confusing this docs decision with an authorized package deletion | Medium | High | State explicitly that implementation, publish, and downstream migration are separate approvals |
| Unknown external `byok-sdk` consumers | Unknown | High | Make removal a SemVer-breaking one-shot cutover with release notes and packed direct-package smoke; do not claim zero consumers outside inspected repos |
| Moving server behavior into cloud while chasing package count | Medium | High | Freeze the Node/Hono adapter boundary and server -> cloud dependency direction |
| Compatibility shim keeps two entrypoints alive | Medium | Medium | Forbid aliases, dual exports, or a newly published empty umbrella after cutover |

## Task Contracts
- Contract file: `tasks/contracts/20260905-0114-public-package-topology.contract.md`
- Review file: `tasks/reviews/20260905-0114-public-package-topology.review.md`
- Implementation notes file: `tasks/notes/20260905-0114-public-package-topology.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260905-0114-public-package-topology.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: ADR plus architecture projection and docs-only workflow evidence.
- **Rollback surface**: Revert the docs-only unit.
- **Verification boundary**: consumer inventory, diff check, architecture sync, strict workflow.
- **Review/acceptance boundary**: owner approval authorizes only this topology ruling, not implementation or release.
- **High-risk surface**: future public npm package removal and unknown external consumers.
- **Why not checklist row**: the ruling changes a public distribution boundary and must be independently citable by a later breaking-release contract.

## Evidence Contract

- **State/progress path**: this plan and its contract/notes/review artifacts.
- **Verification evidence**: exact imports, package manifests, release graph, architecture ADR linkage, and strict repo workflow checks.
- **Evaluator rubric**: one unambiguous outcome: retain server, retire umbrella later; no product code or package manifests changed; implementation remains separately gated.
- **Stop condition**: evidence of a unique umbrella-owned capability or an in-scope product-code consumer that cannot use direct imports.
- **Rollback surface**: revert documentation files.

## Annotations

- [RESOLVED]: The required Claude planning session was attempted once in read-only plan mode. It emitted only local model-catalog warnings and no decision, then was terminated after two minutes; no retry was made. The repository evidence remains the decision authority.
- [RESOLVED]: The capability-context sync that preceded this plan generated unrelated projection changes in `docs/architecture/index.md`, `packages/AGENTS.md`, `packages/CLAUDE.md`, and `docs/architecture/requests/root.md`; this plan does not claim or overwrite them.

## Task Breakdown
- [x] Inventory current public/private packages and direct dependency graph.
- [x] Trace current repo and Salesko consumers of `@byok-sdk/server` and `byok-sdk`.
- [x] Record ADR-035 and update the current SDK architecture package-topology statement.
- [x] Produce docs-only contract notes/review, run bounded verification, and archive the completed workflow.
