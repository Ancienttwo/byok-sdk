# Task Contract: terminal-inference-usage

> **Status**: Fulfilled
> **Plan**: `plans/plan-20260821-1710-terminal-inference-usage.md`
> **Task Profile**: code-change
> **Owner**: ancienttwo
> **Capability ID**: U2
> **Last Updated**: 2026-08-21 18:48
> **Review File**: `tasks/reviews/20260821-1710-terminal-inference-usage.review.md`
> **Notes File**: `tasks/notes/20260821-1710-terminal-inference-usage.notes.md`

## Goal

Add one optional, bounded `TerminalInferenceUsage` projection to every terminal
payload (`task.complete`, `task.fail`, `task.cancelled`). Omission remains legal
for old daemons. Client code projects only observed runtime facts and the already
frozen `localAgentRelease.version`; cloud exposes the winning first terminal's
same typed object. This is observability, never billing, quota, entitlement, or
usage-accounting authority.

## Scope

- In scope: protocol schema/codec/goldens; terminal client construction; the
  `create-daemon` composition seam that passes its existing frozen release
  identity to `TaskRunner`; cloud typed terminal projection; this work-package's
  docs, tests, and workflow artifacts.
- Out of scope: `TenantStorageUsage`, storage/quota/billing/entitlement,
  release manifests/scripts, publish/deploy, production migrations, secret
  mutation, U1 cancellation semantics, U3 readiness, and U5 erasure.
- No compatibility fallback: absent is the only old-daemon representation;
  unknown metrics are omitted, never inferred or converted to zero.

## P1 — Authority map

- `@byok-sdk/protocol` owns the bounded terminal observation contract.
- A started `TaskRunner` owns its device-side elapsed observation and its
  terminal projection; runtime id is the selected adapter descriptor, provider
  and model are emitted only when a runtime observation exposes them.
- `DaemonConfig.localAgentRelease`, resolved and frozen once by U4a, owns
  `clientVersion`; `create-daemon.ts` only passes that existing value through.
- `@byok-sdk/cloud` owns canonical first-terminal receipt storage and its typed
  `TerminalResult` read model.

## P2 — Concrete trace

Adapter terminal observation emits a normalized `usage` AgentEvent before its
terminal signal (Codex/Claude) → `TaskRunner` retains the **last observed**
usage event for that run, never sums events → terminal envelope's optional
`usage` → inbound gate stores canonical first terminal → `readTaskResult()`
projects that same object. Pi has no native usage observation in its current
RPC contract, therefore it omits the optional block rather than constructing a
usage fact from independently known runtime, release version, or duration.

## P3 — Decision

Use a dedicated `TerminalInferenceUsage`, not `TenantStorageUsage`: token and
duration observations are provider/device telemetry and have no billing
meaning. Bound every string and number at the protocol boundary; reject malformed
values, timestamps, unsafe/non-integer/negative or oversized counts. At 10x,
receipt payload bounds fail first rather than growing a terminal record without
limit. The smallest coherent path is a one-way typed projection with no raw
receipt consumer.

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260821-1710-terminal-inference-usage.md
  - tasks/contracts/20260821-1710-terminal-inference-usage.contract.md
  - tasks/notes/20260821-1710-terminal-inference-usage.notes.md
  - tasks/reviews/20260821-1710-terminal-inference-usage.review.md
  - docs/protocol.md
  - docs/spec.md
  - packages/protocol/src/messages.ts
  - packages/protocol/src/index.ts
  - packages/protocol/src/codec.ts
  - packages/protocol/src/envelope.ts
  - packages/protocol/src/__tests__/
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/__tests__/task-runner-terminal-inference-usage.test.ts
  - packages/client/src/__tests__/real-cloud-longpoll.test.ts
  - packages/client/src/adapters/codex/events.ts
  - packages/client/src/adapters/claude/events.ts
  - packages/client/src/adapters/pi/events.ts
  - packages/client/src/__tests__/codex-events.test.ts
  - packages/client/src/__tests__/claude-events.test.ts
  - packages/client/src/__tests__/pi-events.test.ts
  - packages/cloud/src/terminal-result.ts
  - packages/cloud/src/inbound.ts
  - packages/cloud/src/cloud.ts
  - packages/cloud/src/__tests__/terminal-result.test.ts
  - .ai/harness/checks/latest.json
  - .ai/harness/checks/change-assessment.latest.json
  - .ai/harness/runs/
  - .ai/harness/worktrees/.gitkeep
  - .ai/harness/failures/.gitkeep
  - .ai/harness/handoff/.gitkeep
```

## Exit Criteria

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

```yaml
exit_criteria:
  files_exist:
    - tasks/notes/20260821-1710-terminal-inference-usage.notes.md
    - tasks/reviews/20260821-1710-terminal-inference-usage.review.md
  tests_pass: []
  commands_succeed:
    - bun run --filter @byok-sdk/protocol test -- terminal-inference-usage.test.ts freeze-guard.test.ts
    - bun run --filter @byok-sdk/client test -- task-runner-terminal-inference-usage.test.ts task-runner-runtime-failure.test.ts
    - bun run --filter @byok-sdk/cloud test -- terminal-result.test.ts
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Rollback Point

- Commit / checkpoint: `2e5331a` plus this worktree's pre-U2 state.
- Revert strategy: revert the one U2 commit; omission retains old-daemon wire
  validity and no persisted billing/state schema is introduced.
