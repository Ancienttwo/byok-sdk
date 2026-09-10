# Plan: Complete original Issue177 through campaign worker and verifier

> **Status**: Approved
> **Created**: 20260910-2138
> **Slug**: brc177-completion
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: sprint:plans/sprints/brc1415-canary.sprint.md#Campaign byok-brc1415-20260910-completion group 1 slot 01: bugfix #177
> **Artifact Level**: work-package
> **Promotion Reason**: verification_boundary
> **Verification Boundary**: One actual acquired worker and independent verifier, exact settlement and canary publication
> **Rollback Surface**: Revert the bounded two-file repair on the disposable canary branch
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260910-2138-brc177-completion.contract.md`
> **Task Review**: `tasks/reviews/20260910-2138-brc177-completion.review.md`
> **Implementation Notes**: `tasks/notes/20260910-2138-brc177-completion.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: sprint:plans/sprints/brc1415-canary.sprint.md#Campaign byok-brc1415-20260910-completion group 1 slot 01: bugfix #177
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260910-2138-brc177-completion.md`
- Sprint contract: `tasks/contracts/20260910-2138-brc177-completion.contract.md`
- Sprint review: `tasks/reviews/20260910-2138-brc177-completion.review.md`
- Implementation notes: `tasks/notes/20260910-2138-brc177-completion.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260910-2138-brc177-completion.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260910-2138-brc177-completion.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260910-2138-brc177-completion.md`.

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
- Contract file: `tasks/contracts/20260910-2138-brc177-completion.contract.md`
- Review file: `tasks/reviews/20260910-2138-brc177-completion.review.md`
- Implementation notes file: `tasks/notes/20260910-2138-brc177-completion.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260910-2138-brc177-completion.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260910-2138-brc177-completion.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the bounded two-file repair on the disposable canary branch
- **Verification boundary**: One actual acquired worker and independent verifier, exact settlement and canary publication
- **Review/acceptance boundary**: `tasks/reviews/20260910-2138-brc177-completion.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: verification_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260910-2138-brc177-completion.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260910-2138-brc177-completion.contract.md`, `tasks/reviews/20260910-2138-brc177-completion.review.md`, and `tasks/notes/20260910-2138-brc177-completion.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260910-2138-brc177-completion.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the bounded two-file repair on the disposable canary branch

## Captured Planning Output

# Issue177 completion plan

P1 Map: The published umbrella package includes packages/sdk/README.md. packages/sdk/src/index.ts exports seven namespaces, including uiRuntime. Its existing packages/sdk/src/readme.test.ts checks that the README import and description match those exports and exclude keys. The parent owns planning and publication metadata. The acquired campaign worker owns only README.md and readme.test.ts; the independent verifier owns the semantic verdict.

P2 Trace: The README still says six namespaces and omits uiRuntime. The existing regression fails twice on the canonical unchanged README and preserves the keys check. Current canary CI34468443838 additionally demonstrated TS2532 at readme.test.ts:12: under noUncheckedIndexedAccess, the required nonempty regex capture has an indexed type including undefined. The regexp and preceding non-null expectation prove capture1 exists after a successful match. The source delivery PR182 already contains the minimal corrected two-file candidate and both push/PR CI runs passed23/23 at98eaae33c46105433955c76b5b87dc5b52ac21a5. This is patch/proof input, not the current campaign final.

P3 Decision: In the acquired worktree, apply only the exact two source files from the already-reviewed local commit98eaae33c46105433955c76b5b87dc5b52ac21a5. README SHA256 must become7c65c87fa1817269a0937b21c6a539960ca7e25989839561d99ea6f3236cc8a2; readme.test.ts SHA256 must become4eb58b428fa44da938ea3f6f3fc3f1683fff05bc4066a4e97afb1f52979f93eb. Read the two blobs individually; do not cherry-pick the commit's unrelated parent-source-delivery artifacts. Preserve the test assertions and keys exclusion. No new API, runtime export, dependency, version or config. Ten times as many namespaces still uses the explicit export surface and the same file-level check; no new abstraction is needed.

Implementation: The worker may use git show98eaae33c46105433955c76b5b87dc5b52ac21a5:packages/sdk/README.md and the corresponding readme.test.ts blob as the approved patch source. Validate both output digests. Freeze those source bytes, then prepare the contract's required executable evidence once using the image's repo-harness run verify-sprint --prepare-acceptance --contract <this contract>. The parent supplies a complete approved contract, pre-fix evidence and review stub before admission, and prepares Linux dependencies in the acquired worktree before starting the model worker. REPO_HARNESS_DIFF_BASE must name the acquisition's target revision, not an arbitrary origin/main. The parent owns changes to acceptance criteria; the worker must not edit plan, contract, review, notes or policy.

Verification: Keep target-required build, typecheck, complete workspace tests, API surface, version authority and strict workflow verification. Execute expensive criteria once after freezing the repair; the independent verifier consumes the canonical run and does not repeat those tests. Historical PR182 CI remains corroborating evidence for its own subject only. Any failing criterion remains a failure and must be reported with the artifact.

Completion: This slice requires one real acquired codex-exec worker followed by its independent verifier, a completed passing final with exact settlement, a current publication for the same lease/head, green publication CI, the permitted manual squash merge into codex/brc1415-canary, and campaign closeout cleanup. The parent then completes Issue178's formal not_planned disposition and the required fresh group audit. The approved continuation is byok-brc1415-20260910-completion; original Issues177/178 remain fixed. No package publication, production deployment or merge into byok-sdk main.

Rollback: Revert the bounded two-file repair on the disposable canary branch. Preserve original grants, ledger consumption and failed finals as historical evidence.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Execute captured plan: Complete original Issue177 through campaign worker and verifier
