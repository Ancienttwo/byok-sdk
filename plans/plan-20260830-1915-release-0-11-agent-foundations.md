# Plan: Compose 0.11.0 agent foundations release candidate

> **Status**: Executing
> **Created**: 20260830-1915
> **Slug**: release-0-11-agent-foundations
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: User approved an exact local 0.11.0 composition from accepted source lines.
> **Verification Boundary**: Root build/typecheck/test/strict workflow plus exact client tarball pack-and-smoke.
> **Rollback Surface**: Delete only this isolated branch/worktree after preserving evidence; no external state exists.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md`
> **Task Review**: `tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md`
> **Implementation Notes**: `tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md`

## Agentic Routing
- Selected route: code-change
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260830-1915-release-0-11-agent-foundations.md`
- Sprint contract: `tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md`
- Sprint review: `tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md`
- Implementation notes: `tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260830-1915-release-0-11-agent-foundations.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260830-1915-release-0-11-agent-foundations.md`.

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
- Contract file: `tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md`
- Review file: `tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md`
- Implementation notes file: `tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260830-1915-release-0-11-agent-foundations.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Delete only this isolated branch/worktree after preserving evidence; no external state exists.
- **Verification boundary**: Root build/typecheck/test/strict workflow plus exact client tarball pack-and-smoke.
- **Review/acceptance boundary**: `tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User approved an exact local 0.11.0 composition from accepted source lines.

## Evidence Contract

- **State/progress path**: `plans/plan-20260830-1915-release-0-11-agent-foundations.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md`, `tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md`, and `tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Delete only this isolated branch/worktree after preserving evidence; no external state exists.

## Captured Planning Output

## Goal
Compose one unpublished 0.11.0 local release candidate from the accepted agent-foundations and agent-memory source lines, preserving the aligned nine-package train and the independent keys package.

## P1 Architecture Map
- Release authority: docs/spec.md, CHANGELOG.md, aligned package manifests, and bun.lock.
- Source inputs: codex/agent-foundations-integration and codex/agent-memory-mcp-grant; main, registry, tags, downstream, and production remain untouched.

## P2 Concrete Trace
- Merge the accepted memory/release line into this isolated branch, resolve overlapping client/changelog/version projections once, install from frozen lockfile, build/typecheck/test, then pack and smoke the exact client tarball.

## P3 Decision
- Keep a single 0.11.0 version authority. Reuse the existing aligned train bump instead of creating a competing release edit. Fail closed on merge conflicts, lock drift, package-content drift, or packed-host smoke failure.

## Task Breakdown
- [x] Merge accepted agent-memory-mcp-grant and retain both accepted feature sets.
- [x] Verify aligned package versions, changelog/spec authority, and frozen lockfile.
- [x] Run required root gates and exact packed artifact smoke without publishing.
- [x] Record local candidate identity and residual publication gate.

## Out of Scope
- Push, npm publish, tag, GitHub Release, deploy, production rollout, and downstream pinning.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Approved Release Repair Amendment (2026-08-30)

Live npm preflight proved `@byok-sdk/keys@0.3.7` is already immutable with an exact
`@byok-sdk/core@0.10.2` edge, while the frozen 0.11.0 candidate repacks the same
version with `@byok-sdk/core@0.11.0`. The approved repair advances keys to 0.3.8,
regenerates the exact ten-package artifact set, then non-force pushes the exact
candidate SHA and waits for GitHub Actions. npm publish, tag, GitHub Release,
downstream pinning, deploy, and production remain out of scope.

- [x] Advance keys to 0.3.8 and update the single version projections.
- [x] Regenerate and verify the exact ten-package frozen artifact set.
- [x] Commit, non-force push the exact candidate SHA, and verify GitHub Actions.

## Approved Stable Publication Amendment (2026-08-30)

The user authorized publication of the exact source and frozen artifacts bound to
`main@7a937e5ed8eb5aef102eacb0df9183f296da7e1f`. The registry operation is the
stable channel: omit `--tag`, publish the nine aligned packages at `0.11.0` plus
`@byok-sdk/keys@0.3.8`, then require the canonical registry readback before
claiming publication. The release driver may create the local annotated
`v0.11.0` tag. Remote tag push, GitHub Release, downstream pinning, deploy, and
production remain separate gates.

- [x] Recheck npm identity/ownership, ten version vacancies, dist-tags, tag and Release vacancy.
- [x] Run the canonical non-executing publish dry-run and prove the manifest is byte-identical.
- [ ] Refresh strict checks/review/AcceptanceReceipt for this publication authority.
- [ ] Publish all ten frozen artifacts and complete registry readback.
- [ ] Record immutable registry identity and stop before remote tag/Release/downstream actions.

## Task Breakdown
- [x] Merge accepted agent-memory-mcp-grant and retain both accepted feature sets.
- [x] Verify aligned package versions, changelog/spec authority, and frozen lockfile.
- [x] Run required root gates and exact packed artifact smoke without publishing.
- [x] Record local candidate identity and residual publication gate.
