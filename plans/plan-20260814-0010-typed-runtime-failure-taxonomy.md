# Plan: Typed Runtime Failure Taxonomy

> **Status**: Executing
> **Created**: 20260814-0010
> **Slug**: typed-runtime-failure-taxonomy
> **Planning Source**: waza-think
> **Orchestration Kind**: sprint-task
> **Source Ref**: sprint:plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md#Typed runtime failure taxonomy + retryability projection
> **Artifact Level**: work-package
> **Promotion Reason**: TaskRunner currently maps only PolicyUnsupportedError distinctly while generic start errors and every event-stream failure collapse to retryable=true; session identity/protocol violations, native task failures, and process availability failures have different semantics across three bundled adapters and require one shared typed projection boundary.
> **Verification Boundary**: Run client typecheck/test/build, all three adapter suites, task-runner failure projection tests, built adapter smoke, workspace typecheck/test/build, and strict contract/workflow verification; exact negative cases must prove retryability without error-message matching.
> **Rollback Surface**: Revert the failure type module, three adapter mappings, TaskRunner exhaustive projection, docs, fixtures, and tests as one commit on top of the prepared-operation base; do not retain typed and message-derived classification in parallel.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260814-0010-typed-runtime-failure-taxonomy.contract.md`
> **Task Review**: `tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md`
> **Implementation Notes**: `tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: sprint:plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md#Typed runtime failure taxonomy + retryability projection
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md`
- Sprint contract: `tasks/contracts/20260814-0010-typed-runtime-failure-taxonomy.contract.md`
- Sprint review: `tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md`
- Implementation notes: `tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260814-0010-typed-runtime-failure-taxonomy.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md`.

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
- Contract file: `tasks/contracts/20260814-0010-typed-runtime-failure-taxonomy.contract.md`
- Review file: `tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md`
- Implementation notes file: `tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260814-0010-typed-runtime-failure-taxonomy.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the failure type module, three adapter mappings, TaskRunner exhaustive projection, docs, fixtures, and tests as one commit on top of the prepared-operation base; do not retain typed and message-derived classification in parallel.
- **Verification boundary**: Run client typecheck/test/build, all three adapter suites, task-runner failure projection tests, built adapter smoke, workspace typecheck/test/build, and strict contract/workflow verification; exact negative cases must prove retryability without error-message matching.
- **Review/acceptance boundary**: `tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: TaskRunner currently maps only PolicyUnsupportedError distinctly while generic start errors and every event-stream failure collapse to retryable=true; session identity/protocol violations, native task failures, and process availability failures have different semantics across three bundled adapters and require one shared typed projection boundary.

## Evidence Contract

- **State/progress path**: `plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260814-0010-typed-runtime-failure-taxonomy.contract.md`, `tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md`, and `tasks/notes/20260814-0010-typed-runtime-failure-taxonomy.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the failure type module, three adapter mappings, TaskRunner exhaustive projection, docs, fixtures, and tests as one commit on top of the prepared-operation base; do not retain typed and message-derived classification in parallel.

## Captured Planning Output

## Recommendation

After the prepared-operation cut lands, define one closed runtime failure vocabulary for post-admission start/run failures and make TaskRunner project `task.fail.retryable` by exhaustive category—not by message strings and not by a universal catch-all. Keep diagnostic `AgentEvent.error` events, but require the adapter/session boundary to terminate failed runs with typed failure evidence. Leave teardown failure to the next work package because it must not rewrite a semantic terminal result.

## P1: Architecture Map

- Shared public contract: `packages/client/src/types.ts`, after Row 1, owns prepared operation and Session interfaces.
- Projection authority: `packages/client/src/daemon/task-runner.ts` maps adapter start errors, async event-stream termination, and success `turn_end` into protocol task terminal messages.
- Provider translation: Pi RPC client/events, Claude process client/events, and Codex process runner/events decide whether a native frame means success, semantic failure, malformed authority, or abrupt infrastructure loss.
- Wire authority: protocol `task.fail.reason` and `task.fail.retryable` remain unchanged; no new AgentEvent or protocol field is needed.
- Diagnostics: adapter stderr/unmapped-frame rings and normalized `error` events remain observability, not retryability authority.
- Out of scope: pre-claim admission decisions (Row 1), process-tree close/teardown receipts (Row 3), provider-specific retry loops, server scheduling policy, protocol versioning, and durable receipt storage.

## P2: Concrete Trace and Pressure Point

Current failure path:

1. A prepared operation starts a vendor process or waits for an authoritative native session id.
2. In the existing code, only `PolicyUnsupportedError` makes start failure non-retryable. Every other thrown value maps to `retryable: true`.
3. During execution, TaskRunner treats a stream that ends without `turn_end` and every iterator exception as retryable.
4. Pi/Claude/Codex currently use generic errors for different facts: spawn/exit availability, malformed first/native terminal frame, and session-id mismatch.
5. Normalized `error` AgentEvents may precede stream end, but TaskRunner does not receive a typed terminal cause; the final retryability is therefore inferred from where control happened to fall out.

Concrete contradictions:

- A session resume request that returns a different authoritative session id is a permanent authority violation for that ask, yet it is retried today.
- A child that exits before producing a terminal frame is an infrastructure loss that may succeed on another device/run and should remain retryable.
- A vendor-native completed failure is not the same as process disappearance. Treating both as retryable can repeat a deterministically failing task; treating both as permanent would suppress legitimate rerouting.
- An untyped custom adapter throw is an adapter-contract violation. Accepting its text as domain semantics would create a shadow parser.

Target path:

1. Every expected post-admission failure crosses the adapter/session boundary as a typed value with phase, category, and retry disposition.
2. Provider translation emits diagnostic error events as before, then terminates the turn with the typed failure; diagnostics never determine retryability.
3. TaskRunner performs an exhaustive projection from the closed category/disposition vocabulary to the existing `task.fail` payload.
4. An untyped thrown value is rejected as an adapter-contract violation and maps fail-closed to non-retryable; its cause is retained for local diagnostics only.
5. Success still requires explicit `turn_end`; stream completion without either success or typed failure becomes a typed infrastructure loss at the adapter boundary, not a TaskRunner guess.

## P3: Decision Rationale

### Failure vocabulary

Use three independent fields on one typed runtime execution failure:

| Field | Closed values | Meaning |
|---|---|---|
| phase | `start`, `run` | Whether publication failed before Session return or an already-published Session failed. |
| category | `semantic`, `infrastructure`, `authority` | Vendor-reported task failure; process/transport availability loss; or violation of pinned session/protocol/config authority. |
| retry disposition | `retryable`, `non-retryable` | Explicit adapter judgment consumed by TaskRunner. No default is inferred from category text. |

Rules:

- Session-id mismatch, malformed authoritative first/terminal frame, and operation-manifest drift are `authority/non-retryable`.
- Spawn failure, process disappearance before native terminal evidence, and broken runtime transport are `infrastructure/retryable`.
- A vendor-native terminal failure after its own retries are exhausted is `semantic/non-retryable` unless the adapter has structured native evidence for retryability. No message substring inference is allowed.
- Admission rejection remains the explicit prepare decision from Row 1 and does not reuse execution failure classes.
- Teardown is deliberately absent. Row 3 defines teardown evidence because semantic completion may already be committed when disposal fails.
- Unknown/untyped failures are adapter-contract violations projected as `authority/non-retryable`, with a stable generic wire reason and local cause logging. This is validation of an invalid state, not semantic fallback.

### Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Keep `PolicyUnsupportedError` plus generic retryable errors | It cannot distinguish permanent authority violation from infrastructure loss and retains the observed bug. |
| Map retryability from error messages/codes in TaskRunner | Creates provider-specific shadow parsers outside the provider adapter. |
| Treat every post-admission failure as retryable | Repeats deterministic semantic/authority failures and can cause fleet churn. |
| Treat every failure as non-retryable | Prevents legitimate reroute/recovery after process or transport loss. |
| Make AgentEvent.error terminal authority | Conflates diagnostics with control state and changes the normalized event contract. |
| Add protocol failure categories now | There is no server consumer; existing reason/retryable wire is sufficient. |
| Include teardown in the same error union | A teardown can fail after semantic task completion; one union would invite rewriting completed into failed. |

## File and Ownership Plan

| Surface | Change |
|---|---|
| `packages/client/src/runtime-failure.ts` or equivalent existing client contract module | Define closed execution failure data/error constructors and exhaustive guards. |
| `packages/client/src/types.ts` and public exports | Expose the required boundary for custom adapters without exposing provider internals. |
| `packages/client/src/daemon/task-runner.ts` | Replace `instanceof PolicyUnsupportedError` and generic run catches with one exhaustive projector; remove message-derived/default retryability. |
| Pi RPC client/session and event mapper | Distinguish native semantic failure, process loss, malformed authority, and success. |
| Claude process client/session and event mapper | Map result failure versus process disappearance and session identity mismatch. |
| Codex process runner/session and event mapper | Map turn.failed, missing thread.started/turn completion, and thread-id mismatch without ending in an untyped queue fallthrough. |
| Client fixtures/tests | Supply typed failures from custom adapters and prove unknown throw rejection. |
| `docs/spec.md`, `docs/security.md`, `docs/architecture/sdk-architecture.md` | Record failure axes, retry authority, and diagnostic-event boundary. |

One implementation worker owns all production files because the exhaustive type and three adapter mappings must stay compile-green in one commit. A separate read-only gatekeeper may review after code freeze. No concurrent writer may edit TaskRunner or adapter contracts.

## Test and Verification Design

- Start matrix: spawn ENOENT/early exit is infrastructure+retryable; authoritative session mismatch and malformed first frame are authority+non-retryable.
- Run matrix: vendor-native terminal failure is semantic+non-retryable; child disappearance before native terminal evidence is infrastructure+retryable; explicit turn_end remains success.
- Custom adapter contract test: throwing bare Error produces stable adapter-contract-violation reason, non-retryable, and no source message is parsed for semantics.
- Diagnostic separation: an `AgentEvent.error` can be forwarded without independently ending the task; typed terminal failure or turn_end remains required.
- Exactly-once terminal tests: a typed failure followed by queue close, late native frame, cancel, or shutdown yields one task terminal message.
- Static guard: production TaskRunner contains no regex/substring matching against runtime error messages and no unconditional retryable=true catch for start/run.
- Positive regression: Pi, Claude, and Codex normal/resume paths and built adapter smoke remain green with byte-compatible task.fail/task.complete wire shapes.
- Required commands: client typecheck/test/build, built adapter smoke, workspace typecheck/test/build, strict workflow and contract verification.

## Rollout and Rollback

- Dependency: Row 1 must be merged and its 0.4.0 contract frozen. This plan does not reopen the RuntimeAdapter shape or 0.3.0 release.
- Rollout: one commit/PR on the Row 1 base; migrate all three adapters and every custom test adapter together.
- Rollback: revert the whole failure taxonomy commit. Do not keep error classes while restoring generic catches or retain both typed and text-derived classification.
- First 10x pressure: one flaky adapter can otherwise trigger repeated fleet reroutes. Acceptance focuses on deterministic retry disposition and exactly-once terminal projection under races.

## Approval Boundary

Approved for execution after Row 1 passed exact-SHA review and landed on `main`. This approval does not authorize teardown/process-group changes or publication.

## Task Breakdown

- [x] Confirm the landed Row 1 prepared-operation contract and freeze the failure boundary it exposes.
- [x] Add the closed phase/category/retry-disposition execution failure vocabulary and public contract documentation.
- [x] Replace TaskRunner start/run catch-all retry mapping with exhaustive typed projection and fail-closed handling of untyped throws.
- [x] Map Pi native semantic, infrastructure, and authority failures to the shared vocabulary.
- [x] Map Claude native semantic, infrastructure, and authority failures to the shared vocabulary.
- [x] Map Codex native semantic, infrastructure, and authority failures to the shared vocabulary.
- [x] Migrate all custom adapter/session fixtures and add exactly-once race coverage.
- [x] Add static no-message-parser/no-default-retry guards plus the full negative/positive matrix.
- [ ] Update spec/security/architecture truth and run the complete verification boundary.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Confirm the landed Row 1 prepared-operation contract and freeze the failure boundary it exposes.
- [x] Add the closed phase/category/retry-disposition execution failure vocabulary and public contract documentation.
- [x] Replace TaskRunner start/run catch-all retry mapping with exhaustive typed projection and fail-closed handling of untyped throws.
- [x] Map Pi native semantic, infrastructure, and authority failures to the shared vocabulary.
- [x] Map Claude native semantic, infrastructure, and authority failures to the shared vocabulary.
- [x] Map Codex native semantic, infrastructure, and authority failures to the shared vocabulary.
- [x] Migrate all custom adapter/session fixtures and add exactly-once race coverage.
- [x] Add static no-message-parser/no-default-retry guards plus the full negative/positive matrix.
- [ ] Update spec/security/architecture truth and run the complete verification boundary.
