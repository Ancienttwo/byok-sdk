# Sprint: Runtime Adapter Lifecycle Contracts

> **Status**: Draft
> **Slug**: runtime-adapter-lifecycle-contracts
> **Created**: 2026-08-14 00:05
> **Updated**: 2026-08-14 00:13
> **Source PRD**: (none — source research) `docs/researches/2026-08-13_deepseek-harness-extraction-assessment.md`
> **Source Spec**: `docs/spec.md`
> **Goal Mode**: incremental

Program-level sprint container. The Source PRD summary and ordered backlog
decompose product intent into ordered rows. Contract rows become task-contract
slices after `$think` expansion; inline rows stay in the sprint backlog or
active plan Task Breakdown.
`tasks/todos.md` stays the deferred-goal ledger and never carries this backlog.

## PRD

Source of truth: `docs/researches/2026-08-13_deepseek-harness-extraction-assessment.md` plus the current `RuntimeAdapter`/`Session` path in `packages/client`. This Sprint promotes only gaps reproduced in byok-sdk; it does not import DeepSeek Harness's runtime framework.

### Problem

- `TaskRunner.pickAdapter()` checks `capabilities()` before claim, but `handleOffer()` calls `capabilities()` again when emitting `task.claim`, and calls `environmentRequirements()` only after claim. A stateful/custom adapter can therefore be admitted under one capability snapshot and claimed or spawned under another.
- Adapter-specific permanent rejections still occur after claim: Pi without a configured BYOK launcher and invalid lane/runtime/model combinations throw from `start()`. The daemon has already claimed the task and may already have prepared a workspace.
- `PolicyUnsupportedError` is the only typed start-failure class. Session identity/protocol authority violations are generic `Error`s and become `retryable: true`; event-stream failures are likewise collapsed into one catch-all.
- All three bundled `Session.close()` implementations signal termination but do not prove child/process-tree quiescence. `TaskRunner.finish()` deletes active ownership and releases the Git workspace lease before awaiting `close()`, then swallows close failure.

### Users

- SDK embedders implementing a custom `RuntimeAdapter`.
- Operators relying on cancellation, daemon shutdown, and Git-workspace exclusivity.
- Maintainers of the Pi, Claude, and Codex bundled adapters and their release evidence.

### Success Criteria

- One immutable per-offer operation manifest is the authority for admission, `task.claim`, environment construction, provider/model selection, and spawn; permanent unsupported asks decline before claim and before workspace/process side effects.
- Runtime semantic/authority, infrastructure, and teardown failures have distinct typed contracts; TaskRunner never derives retryability from error text or one catch-all default.
- `Session.close()` resolves only after the owned process tree is quiescent; active-task/workspace ownership is not released earlier, and teardown failure remains observable without rewriting an already-sent semantic terminal result.
- The built `@byok-sdk/client` entry exercises all three adapters keylessly through a real server for admission rejection, normal completion, cancellation, and process-tree teardown.

### Acceptance Scenarios

- A Pi BYOK offer with no custody launcher, an unsupported instruction shape, or a mismatched dispatch lane is declined with zero `task.claim`, zero `task.started`, zero workspace creation, and zero child spawn.
- A deliberately stateful custom adapter cannot make the claim capability block, environment allowlist, or spawn selection diverge within one operation; the frozen manifest is reused at every boundary.
- A native session-id mismatch is terminal/non-retryable, a spawn/transport availability failure is retryable, and a teardown failure is reported as teardown evidence rather than changing the semantic task result.
- After cancellation or daemon stop, the test child and a spawned descendant are both gone before `close()`/shutdown resolves; a Git workspace cannot be reacquired during the teardown window.

### Non-goals

- No Cordis/plugin loader, DeepSeek LLM wire, DeepSeek SessionEvent format, dynamic self-modification, runtime-owned credential facade, or last-good compatibility path.
- No second provider/model registry and no movement of Pi's BYOK provider, transport, or agent-loop authority.
- No protocol-v1 wire change and no new runtime id.
- No redesign of `AgentEvent.turn_end` into a new durable receipt in this Sprint: current task protocol/store remain terminal authority; revisit only with a second concrete durable consumer.
- No long-lived compatibility shim for the public `RuntimeAdapter` cut. The contract changes once across the workspace and ships as the next pre-1.0 breaking release after 0.3.0 is frozen.

## Architecture Notes

### Capabilities Touched

- `packages/client/src/types.ts`: public adapter/session contract.
- `packages/client/src/daemon/task-runner.ts`: admission, claim, operation ownership, terminal mapping, and workspace lease lifetime.
- `packages/client/src/adapters/{pi,claude,codex}`: provider-specific validation, process ownership, and native failure mapping.
- `packages/client/scripts/adapter-task-smoke.mjs`: built-entry real-composition evidence.
- `docs/spec.md`, `docs/security.md`, and `docs/architecture/sdk-architecture.md`: authoritative lifecycle and release contract.

### Dependency Order

- Release gate is satisfied as of 2026-08-14: annotated tag `v0.3.0^{}` resolves to `a119b5cf4247278a456c285cbc6470d8e3b9815c`, current main descends from it, and registry readback reports both `@byok-sdk/client@0.3.0` and `byok-sdk@0.3.0` with concrete `dist.integrity`. This Sprint is the 0.4.0 breaking train and every implementation worktree must descend from that frozen release base.
- Row 1 defines the one-shot breaking `RuntimeAdapter` cut and immutable operation authority. Row 2 consumes that manifest to classify post-publication failures. Row 3 consumes both contracts to make disposal quiescent and prove it through the built entry.
- Each row is an independently reviewable merge unit, but no row may preserve both old and new adapter semantics. Full workspace consumers and test fakes cut over in Row 1.

### Risks

- Public API break: custom adapters must migrate atomically; release notes and 0.4.0 package graph are part of Row 1 acceptance.
- Admission purity: `prepare()` must not spawn, create temp files, mutate workspaces, allocate session ids, or read credential values. A side effect before publication fails the design.
- Process-tree portability: POSIX process groups and Windows `taskkill /T` have different mechanics; tests need real child+descendant fixtures on supported CI OSes, not PID mocks alone.
- Shutdown interaction: the separate `shutdown-lease-order` worktree owns control-endpoint/daemon-owner ordering. Row 3 may consume its landed base but must not edit or re-litigate that slice.
- Scope pressure at 10x: custom adapters and concurrent task teardown fail first. Keep one manifest and one lifecycle owner; do not add a generic plugin framework.

## Backlog

Ordered execution queue; keep rows in dependency order. Mode `contract` runs
the full plan -> contract -> worktree flow; `inline` allows primary-tree
execution for small tasks. Every row needs a concrete acceptance line.

| # | Status | Task | Mode | Acceptance | Plan |
|---|--------|------|------|------------|------|
| 1 | [ ] | Prepared runtime operation manifest + pre-claim admission cut | contract | `pnpm --filter @byok-sdk/client run typecheck && pnpm --filter @byok-sdk/client run test` exits 0; negative tests prove unsupported selection/blob instruction/missing Pi launcher emit decline with zero claim/start/spawn/workspace side effects, and one frozen manifest supplies capability/env/selection to claim and start | plans/plan-20260814-0007-prepared-runtime-operation-manifest.md |
| 2 | [ ] | Typed runtime failure taxonomy + retryability projection | contract | `pnpm --filter @byok-sdk/client run test` exits 0; tests prove authority/session mismatch is non-retryable, spawn/transport unavailability is retryable, teardown is a distinct typed failure, and production code contains no message-regex or untyped catch-all retryability fallback | plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md |
| 3 | [ ] | Quiescent process-tree disposal + built adapter lifecycle evidence | contract | `pnpm -r run build && pnpm --filter @byok-sdk/client run test && pnpm --filter @byok-sdk/client run smoke:adapters` exits 0; real child+descendant fixtures prove cancel/stop wait for quiescence and Git workspace ownership is not released before settlement on supported CI OSes | plans/plan-20260814-0011-quiescent-runtime-disposal.md |

## Execution Log

Keep this section last; `repo-harness run sprint-backlog complete-task` appends rows here.

| When | Task | Plan | Result |
|------|------|------|--------|
