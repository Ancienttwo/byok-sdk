# Task Contract: live-activity-timeline-pr2-typed-activity-projection

> **Status**: Fulfilled
> **Plan**: plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-16 19:58
> **Review File**: `tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md`
> **Notes File**: `tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

PR 1 preserved runtime-native tool identity, but the hosted activity authority
still serializes each event into `ActivityEntry { at, detail }`, discarding the
source envelope ID, `task.progress.seq`, and event index. A consumer cannot
replay deterministically, distinguish identity from order, expose gaps, or fold
unknown events in place without parsing a legacy string and inventing a second
authority. PR 2 replaces that public/store shape once, before the UI runtime is
introduced.

## Goal

Replace the string activity tail with a typed, bounded `TimelineEvent` read
model carrying `sourceEnvelopeId`, `taskId`, `batchSeq`, `eventIndex`,
`receivedAt`, and `AgentEventOrUnknown`; return dropped/capacity/expiry and a
deterministic cursor from the single `readActivity()` port. Move the activity
port from protocol-free `@byok-sdk/core` into `@byok-sdk/cloud`, provide
equivalent in-memory/Postgres implementations and shared conformance, and
require direct `/byok/activity` writers to supply the same identity/order
authority. Do not retain a detail-string reader, dual write, or parser.

## Scope

- In scope: typed DTO/store port; core→cloud activity ownership cut; inbound
  envelope and direct activity POST projection; in-memory/Postgres parity;
  tenant isolation, capacity/dropped/TTL/cursor/order/concurrency/burst tests;
  coordinated TTL-drain deployment runbook; PR 1 archive artifacts.
- Out of scope: `@byok-sdk/ui-runtime`, React/presentation, browser route,
  SaaS user auth/redaction, SSE/pagination transport, approval events, database
  table replacement, protocol version bump, package version/release.
- Taste constraints: preserve `core !→ protocol`; no legacy `detail` API,
  parser, dual read/write, synthetic IDs, or order heuristics. The existing
  JSONB row remains the sole bounded store authority. Identity is
  `(sourceEnvelopeId,eventIndex)` and ordering/cursor is
  `(taskId,batchSeq,eventIndex)`.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If activity can remain in `@byok-sdk/core` while exposing the protocol-owned
typed event without violating the executable `core !→ protocol` invariant, the
ownership move is unnecessary. The cheapest proof is core's dependency and
constraint tests: current architecture explicitly freezes core as zod-only and
protocol-free, while cloud already depends on both packages. A failing
in-memory/Postgres shared conformance or concurrent append test falsifies the
chosen store contract.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md`
- Notes file: `tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"sdk-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"activity-store-conformance","kind":"deterministic_test","paths":["packages/cloud/src/activity.ts","packages/cloud/src/stores/in-memory/activity.ts","packages/cloud-dataplane/src/stores/activity.ts","packages/conformance/src/cloud/activity.ts"]},{"id":"postgres-activity-burst","kind":"runtime_readback","paths":["packages/cloud-dataplane/src/__tests__/board-concurrency.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - deploy/runbooks/
  - plans/
  - plans/archive/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md
  - tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md
  - tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - packages/core/src/presence.ts
  - packages/core/src/stores.ts
  - packages/core/src/ports-contract.ts
  - packages/core/src/index.ts
  - packages/core/src/in-memory/
  - packages/core/src/__tests__/constraints.test.ts
  - packages/cloud/src/activity.ts
  - packages/cloud/src/coordination.ts
  - packages/cloud/src/inbound.ts
  - packages/cloud/src/cloud.ts
  - packages/cloud/src/index.ts
  - packages/cloud/src/tenant-stores.ts
  - packages/cloud/src/handlers/presence.ts
  - packages/cloud/src/stores/ports.ts
  - packages/cloud/src/stores/in-memory/
  - packages/cloud/src/__tests__/
  - packages/cloud-dataplane/src/stores/core/
  - packages/cloud-dataplane/src/stores/activity.ts
  - packages/cloud-dataplane/src/stores/index.ts
  - packages/cloud-dataplane/src/runtime.ts
  - packages/cloud-dataplane/README.md
  - packages/cloud-dataplane/src/__tests__/
  - packages/conformance/src/core/
  - packages/conformance/src/cloud/
  - packages/conformance/src/index.ts
  - packages/client/src/__tests__/fixtures/real-cloud.ts
  - packages/client/src/__tests__/real-cloud-salesko-mcp-e2e.test.ts
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/cloud/src/activity.ts
    - packages/cloud/src/stores/in-memory/activity.ts
    - packages/conformance/src/cloud/activity.ts
    - deploy/runbooks/activity-tail-cutover.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md
  tests_pass:
    - path: packages/cloud/src/__tests__/activity-store-conformance.test.ts
    - path: packages/cloud/src/__tests__/board-streams.test.ts
    - path: packages/cloud/src/__tests__/inbound-gate.test.ts
    - path: packages/cloud-dataplane/src/__tests__/activity-conformance.test.ts
    - path: packages/cloud-dataplane/src/__tests__/board-concurrency.test.ts
    - path: packages/core/src/__tests__/constraints.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: typed entries retain source envelope, batch sequence,
  event index, receive time and parsed event; one host read returns bounded
  typed state plus cursor/loss/TTL metadata.
- Edge cases: unknown event position, malformed known event rejection,
  producer drops plus eviction, expiry reset, tenant isolation, result ordering,
  concurrent writers, direct activity POST validation.
- Regression risks: accidentally adding `core → protocol`; JSONB decoder
  accepting legacy details; cursor drift between in-memory/Postgres; losing one
  concurrent batch; violating immutable migration or package export guards.

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
