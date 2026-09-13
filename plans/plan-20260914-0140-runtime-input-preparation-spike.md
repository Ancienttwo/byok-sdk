# Plan: C07 runtime input preparation and consume offline spike

> **Status**: Complete
> **Created**: 20260914-0140
> **Slug**: runtime-input-preparation-spike
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: /Users/kito/Projects/salesko-new-wt-sdk-test-90fab70/docs/researches/2026-09-09_private-agent-chat-host-reliability-s0-parameter-draft.md
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved independent SDK contract and bounded offline feasibility proof
> **Verification Boundary**: Offline runtime byte equivalence and drift refusal; no production package changes
> **Rollback Surface**: Only new experiment/docs and task-owned workflow files
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260914-0140-runtime-input-preparation-spike.contract.md`
> **Task Review**: `tasks/reviews/20260914-0140-runtime-input-preparation-spike.review.md`
> **Implementation Notes**: `tasks/notes/20260914-0140-runtime-input-preparation-spike.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: /Users/kito/Projects/salesko-new-wt-sdk-test-90fab70/docs/researches/2026-09-09_private-agent-chat-host-reliability-s0-parameter-draft.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260914-0140-runtime-input-preparation-spike.md`
- Sprint contract: `tasks/contracts/20260914-0140-runtime-input-preparation-spike.contract.md`
- Sprint review: `tasks/reviews/20260914-0140-runtime-input-preparation-spike.review.md`
- Implementation notes: `tasks/notes/20260914-0140-runtime-input-preparation-spike.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260914-0140-runtime-input-preparation-spike.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260914-0140-runtime-input-preparation-spike.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260914-0140-runtime-input-preparation-spike.md`.

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
- Contract file: `tasks/contracts/20260914-0140-runtime-input-preparation-spike.contract.md`
- Review file: `tasks/reviews/20260914-0140-runtime-input-preparation-spike.review.md`
- Implementation notes file: `tasks/notes/20260914-0140-runtime-input-preparation-spike.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260914-0140-runtime-input-preparation-spike.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260914-0140-runtime-input-preparation-spike.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Only new experiment/docs and task-owned workflow files
- **Verification boundary**: Offline runtime byte equivalence and drift refusal; no production package changes
- **Review/acceptance boundary**: `tasks/reviews/20260914-0140-runtime-input-preparation-spike.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Owner approved independent SDK contract and bounded offline feasibility proof

## Evidence Contract

- **State/progress path**: `plans/plan-20260914-0140-runtime-input-preparation-spike.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260914-0140-runtime-input-preparation-spike.contract.md`, `tasks/reviews/20260914-0140-runtime-input-preparation-spike.review.md`, and `tasks/notes/20260914-0140-runtime-input-preparation-spike.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260914-0140-runtime-input-preparation-spike.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Only new experiment/docs and task-owned workflow files

## Captured Planning Output

## Why
C07 Host must validate complete runtime input before creating Execution. Existing Pi final-request hooks are later than SDK claim, and RuntimeAdapter.prepare does not return complete request/count. Owner approved a separate SDK contract and minimal offline spike.

## P1 / P2 / P3
- P1: SDK owns runtime serializer; Host owns ContextPack/CAS. Local Pi 0.85.1 owns final provider request hook. No new public API or lifecycle is implemented in this spike.
- P2: isolated Pi request assembly → capture immutable payload before any network/model operation → separate isolated launch explicitly consumes it → compare actual boundary bytes; changed binding or altered bytes must refuse.
- P3: first falsify feasibility using existing runtime hooks, without modifying production packages or importing user homes. A spike success only proves this controlled seam, not production purity, transport authentication or model accounting.

## Scope and authority
User approved contract registration plus provider-free spike. Worktree starts at f811634c; C05/PR183 remains separate. No provider/credential access, network requests, product API implementation, deploy, push or default configuration edits. Capture the existing approved S0 design; no new planning provider or second plan authority.

## Workflow Inventory
Plan and matching tasks/contracts, tasks/reviews, tasks/notes use the generated timestamped stem. tasks/todos.md is derived; checks live at .ai/harness/checks/latest.json and .ai/harness/runs/. The new worktree owns exact docs/researches/runtime-input-preparation-contract.md and scripts/experiments/runtime-input-preparation-spike.mjs, plus its own workflow artifacts. Main and C05 worktrees are read-only.

## Verification boundary
Run the standalone offline spike, whitespace and strict workflow validation. Required repository package checks are retained as future production implementation checks; this docs/experiment slice changes no package source, exported API or dependencies. Negative outcomes are valid feasibility findings and must not be relabeled success.

## Task Breakdown
- [x] B07-1 Register exact independent experiment contract and input/consume requirements.
- [x] B07-2 Run offline prepare/consume byte-equivalence and drift refusal cases using installed Pi.
- [x] B07-3 Record source-bound result, limitations and concrete production prerequisite.

## Completion and rollback
Completion means a reviewable contract plus measured feasibility result, not a shipped SDK primitive. Preserve all WIP and only revert explicitly owned new files if needed.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] B07-1 Register exact independent experiment contract and input/consume requirements.
- [x] B07-2 Run offline prepare/consume byte-equivalence and drift refusal cases using installed Pi.
- [x] B07-3 Record source-bound result, limitations and concrete production prerequisite.

## Formal acceptance blocker

The bounded experiment and contract deliverables are complete. Canonical prepare-acceptance aborts before checks because existing architecture projection reports AC_PRECONDITION_FAILED / repo-harness-profile-node-identity-invalid. Architecture model and policy are unchanged from f811634c. No typed acceptance receipt or production PASS is claimed. Owner subsequently authorized the bounded architecture prerequisite with `go on`; the amendment below is now in scope. No production acceptance is implied.

## Approved architecture prerequisite — 2026-09-14

P1: .archcontext/model/nodes is capability authority; product.yaml lists product capabilities; repo-harness automatic projection is a required pre-acceptance step. The retired scaffold has no source ownership and no relation references; capability.sdk.sdk-root already owns packages.

P2: verify-sprint materialize_automatic_architecture_projection → archctx repo-harness/v1 layout → every capability, including retired nodes, goes through parseRepoHarnessNodeProfile. capability.architecture-context fails the required capability.domain.name format before contract checks. Native model validation itself passes, so retirement cannot resolve this profile-level failure.

P3: remove the unused template and point the product capability list to sdk-root via one typed ChangeSet. Retain the existing real capability and all product sources; do not invent a fake domain or loosen the profile parser. At larger model size, retained invalid templates cause the same whole-projection failure. Generated outputs need previewed exact scope before apply.

- [x] B07-A1 Remove retired template through a supported typed ChangeSet; native model validation and capability resolution pass. Product metadata update is deferred after the tool rejected that path.
- [x] B07-A2 Inspect projection and materialize only owned outputs; original identity/adoption blockers resolved.

## Architecture prerequisite outcome

The node-only ChangeSet is applied; the original profile identity error is gone. product.yaml remains byte-identical to base because it is outside the installed ChangeSet write allowlist. This pre-existing template text does not participate in native node identity validation; no direct-edit bypass was used.

Projection now returns adoption-required / verified-flow-proof-changed for capability.sdk.sdk-root, with codeGraphStatus unavailable. Eight architecture output paths were previewed, none applied. Full capability adoption and CodeGraph initialization are independent prerequisites beyond this identity correction; stop instead of expanding the repair. B07-A2 and formal acceptance remain blocked.

## Approved SDK Root adoption — 2026-09-14

Owner approved the exact next slice including this worktree local CodeGraph facts. Retain the existing SDK Root capability, map its current source and one provable flow, preview the ownership migration and generated docs, then accept only the exact candidate. Do not modify product.yaml through an unsupported writer or expand to production package behavior.

- [x] B07-A3 Build local CodeGraph and record SDK Root source/flow evidence.
- [x] B07-A4 Adopt previewed exact architecture outputs and resolve current/stale projection candidates.
- [x] B07-A5 Freeze adopted deliverables and register the canonical checks and semantic acceptance boundary.

## Adoption result and verification boundary

Eight provider-owned documents were adopted after an allowed exact preview; the original architecture index was byte-preserved before intentional pending-request archival. P1/P2 proven; 3/3 source selectors. The historical root request is superseded, all historical events retained, and both package context pending pointers cleared. Root capability retained; model nodes are representative internal responsibilities, not a public package repartition. Production code, dependencies and spike source are unchanged. Formal verification includes native projection, model, capability, strict sync, candidate inventory and unchanged-production checks alongside the original spike/workflow/whitespace checks.

## Final acceptance boundary

Implementation and adoption are frozen for review. Completion requires current passing verify-sprint preparation, independent Codex semantic acceptance, a valid typed AcceptanceReceipt, and finalized verify-sprint; top-level Status stays Review until those gates succeed. Historical blocker sections above are chronological evidence, superseded by this current boundary. Three prior proof-only candidates were reconciled through fresh native noop proofs; none were deleted or relabeled as accepted semantic changes. Current architecture inventory: 0 unresolved candidates, 0 invalid artifacts; strict architecture-sync has no blocking requests.
