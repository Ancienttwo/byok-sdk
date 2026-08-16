# Plan: Registry Readback uiRuntime Closeout

> **Status**: Archived
> **Created**: 20260817-0219
> **Slug**: registry-readback-ui-runtime
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: post-publication registry verifier drift blocks v0.4.2 closeout
> **Verification Boundary**: pre-fix repro, frozen-manifest registry readback, full required checks
> **Rollback Surface**: revert verifier-only commit; published artifacts unchanged
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260817-0219-registry-readback-ui-runtime.contract.md`
> **Task Review**: `tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md`
> **Implementation Notes**: `tasks/notes/20260817-0219-registry-readback-ui-runtime.notes.md`

## Agentic Routing
- Selected route: parent-agent:waza
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260817-0219-registry-readback-ui-runtime.md`
- Sprint contract: `tasks/contracts/20260817-0219-registry-readback-ui-runtime.contract.md`
- Sprint review: `tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md`
- Implementation notes: `tasks/notes/20260817-0219-registry-readback-ui-runtime.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260817-0219-registry-readback-ui-runtime.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260817-0219-registry-readback-ui-runtime.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260817-0219-registry-readback-ui-runtime.md`.

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
- Contract file: `tasks/contracts/20260817-0219-registry-readback-ui-runtime.contract.md`
- Review file: `tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md`
- Implementation notes file: `tasks/notes/20260817-0219-registry-readback-ui-runtime.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260817-0219-registry-readback-ui-runtime.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260817-0219-registry-readback-ui-runtime.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert verifier-only commit; published artifacts unchanged
- **Verification boundary**: pre-fix repro, frozen-manifest registry readback, full required checks
- **Review/acceptance boundary**: `tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: post-publication registry verifier drift blocks v0.4.2 closeout

## Evidence Contract

- **State/progress path**: `plans/plan-20260817-0219-registry-readback-ui-runtime.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260817-0219-registry-readback-ui-runtime.contract.md`, `tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md`, and `tasks/notes/20260817-0219-registry-readback-ui-runtime.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert verifier-only commit; published artifacts unchanged

## Captured Planning Output

# Registry Readback uiRuntime Closeout

## Thesis

Repair the post-publication registry readback so its exact umbrella namespace
expectation matches the already-published `byok-sdk@0.4.2` artifact. The
published bytes and frozen manifest remain immutable; this work changes only
the verifier that drifted when `uiRuntime` was added to the umbrella.

## P1 — Architecture Map

- Published authority: npm registry packages and frozen manifest
  `/tmp/byok-release-0.4.2-XM2BjB/release-manifest.json`, bound to
  `de07001c85c274ce955d1f76181de143fee2cc80`.
- Authoring authority: `packages/sdk/src/index.ts` exports seven namespaces,
  including `uiRuntime`.
- Pre-publication oracle: `scripts/release/pack-and-smoke.mjs` already expects
  all seven namespaces and passed for the frozen artifact.
- Post-publication oracle: `scripts/release/registry-readback.mjs` still expects
  the pre-ui-runtime six-namespace set and is the only product file in scope.
- Workflow artifacts generated for this strict release-surface fix are in
  `plans/`, `tasks/contracts/`, `tasks/reviews/`, `tasks/notes/`,
  `tasks/current.md`, and `.ai/harness/` projections.

## P2 — Concrete Trace / Root Cause Evidence

- Input: the frozen manifest names the exact nine registry packages and their
  expected integrity.
- Trace: `registry-readback.mjs` verifies metadata/integrity and exact internal
  dependency edges, installs all registry packages, imports `byok-sdk`, then
  compares `Object.keys(sdk).sort()` to a literal list.
- Root cause: commit `df9074a` added `uiRuntime` to the umbrella and updated the
  pack smoke, but did not update the independent literal at
  `registry-readback.mjs:163`.
- Repro: `node scripts/release/registry-readback.mjs --manifest
  /tmp/byok-release-0.4.2-XM2BjB/release-manifest.json` fails because actual
  includes `uiRuntime` and expected does not.
- Pressure point: the stale literal only; registry metadata, integrity,
  dependency graph, imports, and package bytes are correct.
- Pre-fix failure evidence: capture the non-zero repro output before editing in
  the contract-bound run artifacts.

## P3 — Decision

Add `uiRuntime` to the exact registry umbrella namespace expectation, matching
the existing pack oracle and source export. Do not remove the exact assertion,
derive semantic exports heuristically, change manifest schema, repack, or
republish. The one-line correction preserves the independent post-publication
smoke and is sufficient because the remaining metadata, integrity, dependency,
import, and single-version checks already pass on the same path.

## Scope

### In scope

- `scripts/release/registry-readback.mjs`: add `uiRuntime` to the exact expected
  umbrella namespace list.
- Strict workflow artifacts and evidence required for this bugfix.
- Run the live frozen-manifest readback, required repository checks, review,
  merge, and release closeout.

### Out of scope

- Any package source, manifest, version, lockfile, tarball, npm republish,
  compatibility alias, fallback, deployment, or SQLite migration.
- Moving the `v0.4.2` tag away from published source SHA `de07001`.

## Task Breakdown

- [x] T1 Capture the pre-fix non-zero registry-readback failure and freeze the
  one-file contract/worktree boundary.
- [x] T2 Add `uiRuntime` to the exact registry umbrella namespace expectation.
- [x] T3 Prove the frozen-manifest registry readback succeeds, including exact
  integrity, dependency edges, imports, and one 0.4.2 install set.
- [x] T4 Run `bun run build`, `bun run typecheck`, `bun run test`, and
  `repo-harness run check-task-workflow --strict`; complete review and merge the
  gate fix to main.
- [x] T5 Create annotated tag `v0.4.2` at `de07001`, push it, create the GitHub
  Release from the existing changelog, and verify npm/GitHub final state.

## Workflow Inventory

- Active plan: captured `plans/plan-*.md` for slug
  `registry-readback-ui-runtime`.
- Contract/review/notes: matching generated files under `tasks/`.
- Deferred ledger: `tasks/todos.md` remains unchanged except workflow projection
  if the harness requires it; this is active release closeout, not a deferred
  goal.
- Checks and runs: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`.
- Allowed-path owner: one isolated contract worktree owns
  `scripts/release/registry-readback.mjs` plus its own workflow artifacts.
- Main remains the merge target; published artifacts remain bound to `de07001`.

## Verification Boundary

- Pre-fix repro is non-zero with the exact missing `uiRuntime` diff.
- Post-fix frozen-manifest registry readback is zero and prints exact imports plus
  a single 0.4.2 version set.
- All root required checks pass.
- No package or tarball bytes change.

## Stop Conditions

- Stop if registry integrity differs from the frozen manifest, any internal
  dependency edge is not exactly 0.4.2, the installed graph splits, or any
  package import fails.
- Stop if the fix requires package source/version changes, republishing, a
  fallback, or a compatibility alias.
- Stop after three failed fix/reverify rounds for the same issue.

## Rollback

Revert the verifier-only commit. It has no effect on already-published npm
artifacts. Do not delete or move published versions; do not create the release
tag until post-fix registry readback passes.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] T1 Capture the pre-fix non-zero registry-readback failure and freeze the
- [x] T2 Add `uiRuntime` to the exact registry umbrella namespace expectation.
- [x] T3 Prove the frozen-manifest registry readback succeeds, including exact
- [x] T4 Run `bun run build`, `bun run typecheck`, `bun run test`, and
- [x] T5 Create annotated tag `v0.4.2` at `de07001`, push it, create the GitHub
