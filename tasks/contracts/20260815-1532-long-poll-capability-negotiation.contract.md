# Task Contract: long-poll-capability-negotiation

> **Status**: Fulfilled
> **Plan**: plans/plan-20260815-1532-long-poll-capability-negotiation.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-15 15:33
> **Review File**: `tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md`
> **Notes File**: `tasks/notes/20260815-1532-long-poll-capability-negotiation.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Pure `@byok-sdk/cloud` deployments are an accepted long-poll-only topology, but the daemon can only learn server protocol capabilities from a WebSocket `conn.ack`. A configured structured result therefore fails as undeliverable even when the active cloud inbound path preserves `task.complete.document`.

## Goal

Make server capability negotiation transport-complete: every successful long-poll response explicitly advertises the current responder's implemented server capabilities, and the daemon applies that advertisement before handling the response's task events.

## Scope

- In scope: additive `EventsPollResponse.capabilities`; client ingestion; `@byok-sdk/cloud` and `@byok-sdk/server` advertisements; regression coverage; protocol documentation.
- Out of scope: downstream salesko code, `truth.records` authority design, runtime extraction templates, releases and deployment.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If a long-poll response carrying `capabilities: ['approval_resolved']` does not make `ConnectionManager.getServerCapabilities()` return that value before its events run, the design is wrong. The cheapest proof is the focused client test.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/client/src/daemon/connection-manager.ts:801` only populated `serverCapabilities` from WS `conn.ack`, while `enterLongPoll()` cleared it and `EventsPollResponse` had no equivalent advertisement, making every pure long-poll topology structurally capability-blind.
- repro: `bun run --filter @byok-sdk/client test -- connection-manager-server-capabilities.test.ts`
- regression_guard: packages/protocol/src/__tests__/http-routes.test.ts
- pre_fix_failure_artifact: .ai/harness/runs/long-poll-capability-negotiation-pre-fix.log

## Workflow Inventory

- Source plan: `plans/plan-20260815-1532-long-poll-capability-negotiation.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md`
- Notes file: `tasks/notes/20260815-1532-long-poll-capability-negotiation.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"sdk-required-checks","kind":"deterministic_test","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/protocol.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260815-1532-long-poll-capability-negotiation.contract.md
  - tasks/reviews/20260815-1532-long-poll-capability-negotiation.review.md
  - tasks/notes/20260815-1532-long-poll-capability-negotiation.notes.md
  - packages/protocol/src/http-api.ts
  - packages/protocol/src/version.ts
  - packages/protocol/src/__tests__/
  - packages/client/src/daemon/long-poll-transport.ts
  - packages/client/src/daemon/connection-manager.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/__tests__/connection-manager-server-capabilities.test.ts
  - packages/client/src/__tests__/fixtures/test-server.ts
  - packages/cloud/src/handlers/events.ts
  - packages/cloud/src/__tests__/mailbox-cursor.test.ts
  - packages/cloud/src/__tests__/route-inventory.test.ts
  - packages/server/src/http.ts
  - packages/server/src/__tests__/
  - .ai/harness/runs/
  - .ai/harness/checks/latest.json
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
    - docs/protocol.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260815-1532-long-poll-capability-negotiation.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/http-routes.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
