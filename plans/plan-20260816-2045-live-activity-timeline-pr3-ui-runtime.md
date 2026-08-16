# Plan: Live Activity Timeline PR3 — deterministic UI runtime

> **Status**: Executing
> **Created**: 20260816-2045
> **Slug**: live-activity-timeline-pr3-ui-runtime
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md#pr-3-byok-sdk-ui-runtime
> **Artifact Level**: work-package
> **Promotion Reason**: PR2 has merged the typed bounded activity authority; the next approved proposal slice is the independently consumable pure fold.
> **Verification Boundary**: Reducer/package tests, release graph and isolated package smoke, full workspace checks, exact-target acceptance, required GitHub CI.
> **Rollback Surface**: Remove the additive ui-runtime package, umbrella namespace, lockfile and release-gate entries before registry publication; no data rollback.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260816-2045-live-activity-timeline-pr3-ui-runtime.contract.md`
> **Task Review**: `tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md`
> **Implementation Notes**: `tasks/notes/20260816-2045-live-activity-timeline-pr3-ui-runtime.notes.md`

## Agentic Routing
- Selected route: main-thread
- Routing reason: Captured from waza-think planning output.
- Source ref: docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md#pr-3-byok-sdk-ui-runtime
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260816-2045-live-activity-timeline-pr3-ui-runtime.md`
- Sprint contract: `tasks/contracts/20260816-2045-live-activity-timeline-pr3-ui-runtime.contract.md`
- Sprint review: `tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md`
- Implementation notes: `tasks/notes/20260816-2045-live-activity-timeline-pr3-ui-runtime.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260816-2045-live-activity-timeline-pr3-ui-runtime.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260816-2045-live-activity-timeline-pr3-ui-runtime.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260816-2045-live-activity-timeline-pr3-ui-runtime.md`.

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
- Contract file: `tasks/contracts/20260816-2045-live-activity-timeline-pr3-ui-runtime.contract.md`
- Review file: `tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md`
- Implementation notes file: `tasks/notes/20260816-2045-live-activity-timeline-pr3-ui-runtime.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260816-2045-live-activity-timeline-pr3-ui-runtime.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260816-2045-live-activity-timeline-pr3-ui-runtime.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Remove the additive ui-runtime package, umbrella namespace, lockfile and release-gate entries before registry publication; no data rollback.
- **Verification boundary**: Reducer/package tests, release graph and isolated package smoke, full workspace checks, exact-target acceptance, required GitHub CI.
- **Review/acceptance boundary**: `tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: PR2 has merged the typed bounded activity authority; the next approved proposal slice is the independently consumable pure fold.

## Evidence Contract

- **State/progress path**: `plans/plan-20260816-2045-live-activity-timeline-pr3-ui-runtime.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260816-2045-live-activity-timeline-pr3-ui-runtime.contract.md`, `tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md`, and `tasks/notes/20260816-2045-live-activity-timeline-pr3-ui-runtime.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Remove the additive ui-runtime package, umbrella namespace, lockfile and release-gate entries before registry publication; no data rollback.

## Captured Planning Output

# Live Activity Timeline PR3 — deterministic UI runtime

## Approved design summary

- **Building**: a public `@byok-sdk/ui-runtime` package that deterministically folds the typed, bounded `ActivityTail` authority into a React-free `TaskTimelineSnapshot`. It exposes replay and incremental APIs, preserves native event identity/order, pairs tools only by `toolCallId`, and makes gaps, drops, expiry, unknown events, and unpaired calls explicit.
- **Not building**: browser transport, authentication, redaction, React components, `ThreadMessageLike`, transcript semantics, approval state, persistence, SSE/pagination, synthetic IDs, provider-output inference, or compatibility parsing for legacy `{at, detail}` rows.
- **Approach**: add one small immutable pure-fold package with BYOK workspace dependencies only. Runtime validation delegates to the existing cloud/protocol schemas, so the package does not create a second event or activity authority. Replay and incremental entrypoints share the same fold implementation.
- **Rejected alternative**: putting the reducer in `@byok-sdk/cloud` would avoid one package, but would mix host/storage concerns with a separately consumable view-model runtime and contradict the product boundary already approved in `docs/spec.md`.
- **Premise collapse**: this plan assumes the V1 activity tail remains capacity-bounded. If that stops being true, immutable copying and ordered insertion become the first pressure point; the fix is a new streaming/store contract, not a second reducer authority.

## P1 — architecture map

- `@byok-sdk/protocol` owns `AgentEventOrUnknownSchema`, `AgentEventSchema`, and `isKnownAgentEvent`.
- `@byok-sdk/cloud` owns `TimelineEventSchema`, `TimelineEvent`, `ActivityCursor`, and `ActivityTail` as the sole bounded read model.
- New `@byok-sdk/ui-runtime` owns only deterministic state and view-model projection. It imports BYOK-owned schema/helpers instead of copying discriminants or validators.
- `byok-sdk` exports the new package as the `uiRuntime` namespace. Release graph and pack smoke scripts treat it as a public release-train package.
- The host BFF remains the sole future browser authorization/redaction/transport boundary; PR3 has no network or presentation surface.

## P2 — concrete trace

1. A host receives one typed `ActivityTail` from `readActivity()`.
2. `replayTimeline(tail)` creates state for `tail.taskId`, validates each `TimelineEvent` through the cloud authority, orders by `(batchSeq,eventIndex)`, and folds events in place without partitioning unknown variants away from their position.
3. Each fold deduplicates by `(sourceEnvelopeId,eventIndex)`, rejects identity/order collisions, and uses `toolCallId` as the only tool pairing key.
4. `projectTimeline(state)` returns ordered items plus explicit `gaps`, `dropped`, `capacity`, `cursor`, and `expiresAt` metadata.
5. Incremental consumers call the same `foldTimelineEvent(state,event)` and `withTimelineMetadata(state, metadata)` primitives; repeating an event is idempotent and result-before-use converges when the matching use arrives.
6. Any task mismatch, malformed known event, identity collision, order collision, duplicate incompatible tool observation, or tool-name mismatch fails closed with a typed `TimelineFoldError`.

## P3 — design decision

Use an immutable public state value backed by readonly arrays/maps copied on change. The tail is bounded at 50 by default, so correctness and deterministic replay are more important than mutation tricks. The reducer keeps one ordered event authority inside state and derives items/gaps from it; this makes replay overlap and out-of-order incremental delivery deterministic. At 10x capacity, repeated ordered insertion/reprojection is the first cost, still bounded and local. No cache, worker, or external state is added.

## Public API

The package exports:

- `createTimelineState(taskId, metadata?)`
- `foldTimelineEvent(state, event)`
- `withTimelineMetadata(state, metadata)`
- `replayTimeline(tail)`
- `projectTimeline(state)`
- public readonly types for state metadata, event/order keys, gaps, fragments, the seven V1 item variants, tool states, snapshot, and `TimelineFoldError`

The six tool states are exactly `input-available`, `output-available`, `output-error`, `output-unknown`, `unpaired-use`, and `unpaired-result`. Only native `isError` selects the three output states. Missing `toolCallId` produces a separate unpaired item; no adjacency, tool name, output content, or timing heuristic may pair it.

`needs_approval` remains outside V1 approval semantics but is not dropped: it projects to a neutral unsupported-known placeholder at its original event position. Unknown protocol variants project to neutral unknown placeholders containing identity and type only, not an invented interpretation.

## Fold invariants

- Identity is `(sourceEnvelopeId,eventIndex)`; ordering is `(taskId,batchSeq,eventIndex)`.
- Equal identity with unequal content fails closed; equal order with unequal identity fails closed.
- Timeline items are ordered by their earliest contributing event.
- Consecutive progress events may share one `text-activity` item, but every `{eventKey,text}` fragment remains distinct and ordered.
- Tool use/result observations sharing a nonblank native ID converge regardless of arrival order. Reuse with incompatible tool names or duplicate use/result authority fails closed.
- `isError === false` means `output-available`; `true` means `output-error`; absence means `output-unknown`.
- Artifacts, usage, errors, turn boundaries, unsupported approvals, and unknown events retain their original timeline position.
- Gaps are recomputed from ordered events; the projection never claims a missing prefix before its first observed event. Store-reported `dropped` remains a separate authority.
- Replay and incremental folding of the same event set produce deeply equal snapshots; overlap is idempotent.

## Files and package surface

Expected edits exceed eight files because this adds one public workspace package and must update release/package gates:

- new `packages/ui-runtime/` manifest, build configs, license/readme, source, and tests
- `packages/sdk/package.json` and `packages/sdk/src/index.ts`
- `scripts/release/check-package-graph.mjs`, `scripts/release/pack-and-smoke.mjs`, and registry readback coverage
- `bun.lock`
- `docs/spec.md` implementation-status text
- task plan/contract/review/notes/current/todo artifacts

No credential, external API, MCP server, database migration, or third-party runtime dependency is required.

## Verification

Targeted tests must cover:

- replay versus incremental deep equality and replay overlap idempotence
- same-name concurrent calls paired only by distinct native IDs
- missing IDs as explicit unpaired use/result
- result-before-use convergence
- all three `isError` outcomes without inspecting opaque output
- fragment grouping with exact fragment boundary preservation
- unknown and `needs_approval` placeholders at original order positions
- malformed known event, task mismatch, identity/order collision, incompatible duplicate tool observations, and tool-name mismatch fail closed
- gap, dropped, capacity, cursor, and expiry projection
- package browser-neutrality/no React/no Node built-ins and public package graph/pack import

Required final commands:

- `bun run --filter @byok-sdk/ui-runtime test`
- `bun run --filter @byok-sdk/ui-runtime typecheck`
- `bun run check:release-graph`
- `bun run check:release-pack`
- `bun run build`
- `bun run typecheck`
- `bun run test`
- `repo-harness run check-task-workflow --strict`

## Rollback and release

The package is additive and owns no data. Before release, rollback is removal of the package, umbrella namespace, lockfile entries, and release-gate entries. After publication, normal semver deprecation/removal policy applies; PR3 does not publish a registry release. Ship through one PR after exact-target acceptance and required GitHub CI.

## Task Breakdown

- [ ] Add the public `@byok-sdk/ui-runtime` package and wire release-train, umbrella, lockfile, and pack/readback authority.
- [ ] Define immutable timeline state, item/gap/tool DTOs, typed failures, and metadata projection without React/network/persistence dependencies.
- [ ] Implement shared replay/incremental folding with schema validation, stable identity/order, idempotence, and fail-closed collision handling.
- [ ] Implement tool correlation, three-state outcomes, text fragments, unknown/unsupported placeholders, and gap/loss/TTL projection.
- [ ] Add exhaustive reducer, package-boundary, release-graph, and isolated-pack tests; update product status documentation.
- [ ] Run Deep Waza `$check`, fix every blocking finding, bind exact-target evidence, pass CI, merge, and archive the work package.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Add the public `@byok-sdk/ui-runtime` package and wire release-train, umbrella, lockfile, and pack/readback authority.
- [ ] Define immutable timeline state, item/gap/tool DTOs, typed failures, and metadata projection without React/network/persistence dependencies.
- [ ] Implement shared replay/incremental folding with schema validation, stable identity/order, idempotence, and fail-closed collision handling.
- [ ] Implement tool correlation, three-state outcomes, text fragments, unknown/unsupported placeholders, and gap/loss/TTL projection.
- [ ] Add exhaustive reducer, package-boundary, release-graph, and isolated-pack tests; update product status documentation.
- [ ] Run Deep Waza `$check`, fix every blocking finding, bind exact-target evidence, pass CI, merge, and archive the work package.
