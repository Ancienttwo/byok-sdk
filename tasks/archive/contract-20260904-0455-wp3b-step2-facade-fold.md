> **Archived**: 2026-09-04 04:55
> **Related Plan**: plans/archive/plan-20260903-1505-wp3b-step2-facade-fold.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260904-0455

# Task Contract: wp3b-step2-facade-fold

> **Status**: Fulfilled
> **Plan**: plans/plan-20260903-1505-wp3b-step2-facade-fold.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-04 03:55
> **Review File**: `tasks/reviews/20260903-1505-wp3b-step2-facade-fold.review.md`
> **Notes File**: `tasks/notes/20260903-1505-wp3b-step2-facade-fold.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`@byok-sdk/server` is today a second coordination authority (`hub.ts`, its own task/blob/auth stores, a WebSocket transport) next to `@byok-sdk/cloud`. Every semantic fix lands twice or drifts (§8 R3/R4 were live examples). Step 1 gave the kernel everything the façade needs; this slice makes `createByokServer` a self-hosted façade over the kernel and deletes the duplicate authority and the WebSocket path, measured against Step 0's ten behaviour pins.

## Goal

Reimplement `createByokServer` over `createByokCloud` with façade-owned store composition (server `RateLimiter` as the `InboundRateLimiter`, counting dedup decorator), a `TaskEventRelay` on `observer.onInboundCommitted` with bounded per-task queues, a `TaskHandle` whose `result()` reads back from the store, async `tasks.get/list` (paged) / `readAgentHomeProjection` / `pairing.createPairingCode` / `egress.get` / `machines.list` / `devices.revoke`, pruned `TaskSnapshot`/`HubStats`, `ByokServerEvent` without `device.connected/disconnected`, `DispatchInput.deviceId` still optional (ambient selection rebuilt in the façade). Delete `hub.ts`, `http.ts`, `auth.ts`, `ws-server.ts`, `heartbeat.ts`, `pairing.ts`, `task-store.ts`, `sqlite-task-store.ts`, `blob-store.ts`, `sqlite-blob-store.ts`, `ids.ts` and the tests of those classes; migrate the kept server tests and the client `real-server-*` tests to long-poll; rewrite the three client smoke scripts; keep `examples/basic` typechecking; regenerate `api-surface/server.d.ts`. Nine Step 0 cases pass with only `await` insertions and `.tasks` unwraps. Under the explicit 2026-09-04 owner ruling, case 7 alone is re-pinned to the kernel mailbox authority: reads do not ack, a returned cursor ack is irreversible, and expiry advances the recoverable floor.

## Scope

- In scope: `packages/server/**` (source, tests), `packages/client/scripts/*.mjs`, `packages/client/src/__tests__/fixtures/real-server.ts` and `packages/client/src/__tests__/real-server-*.test.ts`, `examples/basic/server.ts` (minimal), `api-surface/server.d.ts`, design packet corrections, notes. `packages/cloud/src/**` only if a stats counter is unreachable through store decorators (additive hook, recorded) with `api-surface/cloud.d.ts` regenerated.
- Out of scope: client daemon WS transport deletion (Step 4); SQLite adapter and full `examples/basic` migration (Step 3); `docs/**`, `README.md`, `CHANGELOG.md`, `api-surface/client.d.ts` (Step 5); making `deviceId` required (WP4); release, publish.
- Taste constraints: one task authority (`TaskAttemptStore` + receipts); relay holds notifications, never state; no sync bypass, no `TaskStore` adapter, no compatibility shim; fail closed on removed options; nine Step 0 cases keep byte-identical assertions apart from async adaptation, while case 7 is the sole approved semantic re-pin.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop the affected case if a Step 0 assertion outside approved case 7 would have to change; record it and escalate — do not edit the assertion.
- Stop if a kept test's behaviour cannot be expressed on the public surface: list it in the notes; do not delete it silently.

## Falsifier

If any Step 0 case other than case 7 needs more than `await`/`.tasks` edits to pass, the fold changed unapproved behaviour (packet §8). Case 7 must contain only the recorded kernel-mailbox re-pin. Cheapest proof: inspect `git diff origin/main..HEAD -- packages/server/src/__tests__/coordination-characterization.test.ts` by case boundary, and require `bun run --cwd packages/server test` green.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260903-1505-wp3b-step2-facade-fold.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260903-1505-wp3b-step2-facade-fold.review.md`
- Notes file: `tasks/notes/20260903-1505-wp3b-step2-facade-fold.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"facade-fold-deterministic","kind":"deterministic_test","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260903-1505-wp3b-step2-facade-fold.md
  - tasks/contracts/20260903-1505-wp3b-step2-facade-fold.contract.md
  - tasks/reviews/20260903-1505-wp3b-step2-facade-fold.review.md
  - tasks/notes/20260903-1505-wp3b-step2-facade-fold.notes.md
  - tasks/todos.md
  - tasks/current.md
  - bun.lock
  - packages/server/
  - packages/client/scripts/
  - packages/client/src/__tests__/fixtures/real-server.ts
  - packages/client/src/__tests__/real-server-approval-resolved-e2e.test.ts
  - packages/client/src/__tests__/real-server-cancel-redelivery.test.ts
  - packages/client/src/__tests__/real-server-redelivery.test.ts
  - packages/client/src/__tests__/real-server-repair-cursor.test.ts
  - packages/client/src/__tests__/real-server-longpoll-only.test.ts
  - packages/client/src/__tests__/real-server-longpoll-redelivery.test.ts
  - packages/client/src/__tests__/real-server-longpoll-retry-idempotent.test.ts
  - packages/client/src/__tests__/real-server-longpoll-stall-dedup.test.ts
  - packages/client/src/__tests__/real-server-longpoll-steer.test.ts
  - packages/client/src/__tests__/real-server-outbox-chunking.test.ts
  - packages/client/src/__tests__/real-server-outbox-switch.test.ts
  - packages/client/src/__tests__/agent-home-projection.test.ts
  - examples/basic/server.ts
  - examples/basic/README.md
  - api-surface/server.d.ts
  - api-surface/cloud.d.ts
  - api-surface/ui-runtime.d.ts
  - packages/cloud/src/
  - packages/core/src/__tests__/pairing.test.ts
  - packages/ui-runtime/src/approval-types.ts
  - packages/ui-runtime/src/approval-timeline.ts
  - packages/ui-runtime/src/__tests__/approval-timeline.test.ts
  - docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md
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
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/server/src/__tests__/coordination-characterization.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260903-1505-wp3b-step2-facade-fold.notes.md
  tests_pass:
    - path: packages/server/src/__tests__/coordination-characterization.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:api-surface
    - bun run check:version-authority
    - node packages/client/scripts/control-socket-check.mjs wp3b-smoke
    - node packages/client/scripts/ipc-smoke.mjs
    - node packages/client/scripts/adapter-task-smoke.mjs
    - test ! -f packages/server/src/hub.ts
    - test ! -f packages/server/src/ws-server.ts
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: Step 0 ten cases green; nine retain the `await`/`.tasks`-only diff and case 7 exactly matches the owner-approved kernel-mailbox re-pin. `result()` reads back from the store; relay bounded with truncation marker; ambient device selection rebuilt in the façade; `/healthz` opt-in retained.
- Edge cases: rate-limit episode counting per rejected envelope through the decorator; dedup drop counting; `stats().connectedDeviceCount` from unexpired presence; `tasks.list()` paged.
- Regression risks: public API breaking (documented in Step 5); every dropped or unexpressible assertion from 2d must appear in the notes.

## Rollback Point

- Commit / checkpoint: origin/main 0ceb4d4
- Revert strategy: `git revert` the single squash commit; restores `hub.ts`, WS transport, and the old tests whole.
