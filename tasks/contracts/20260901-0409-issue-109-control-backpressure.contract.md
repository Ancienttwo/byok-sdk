# Task Contract: issue-109-control-backpressure

> **Status**: Active
> **Plan**: plans/plan-20260901-0409-issue-109-control-backpressure.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 04:11
> **Review File**: `tasks/reviews/20260901-0409-issue-109-control-backpressure.review.md`
> **Notes File**: `tasks/notes/20260901-0409-issue-109-control-backpressure.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The authenticated control socket writes every response and stream event directly. A peer that applies kernel backpressure can make the daemon continue output without a retained-byte budget or terminal teardown authority, risking unbounded process memory and orphaned stream producers.

## Goal

Make each control connection own a bounded outbound writer: after `socket.write()` returns `false`, it must not write again before `drain`; retained encoded frames must obey one hard byte ceiling including the first oversized frame; overflow, write error, and disconnect must terminally discard pending output, remove listeners, and abort active stream controllers; normal drain must preserve frame order without changing the synchronous `emit` API.

## Scope

- In scope: one private per-connection writer inside `handleConnection`; outbound response/event delivery; authenticated deterministic and real-connection regression tests; exact plan/contract/review/notes/pre-fix workflow evidence.
- Out of scope: #108 request-ID ownership behavior, wire schemas, request cancellation/timeouts, cross-connection queueing, changing `ControlMethodContext.emit` to async, retry/replay/fallback transport semantics, external acceptance recording, merge/push/PR/issue mutation/release/deploy.
- Taste constraints: one connection-local writer and queue authority; no compatibility/fallback path; close fail-closed when output exceeds the budget or writes fail; preserve the existing public synchronous handler API.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if correctness would require changing the control wire schema or making `emit` asynchronous.

## Falsifier

If a second `socket.write` happens after a false return but before `drain`, any retained queue exceeds its fixed byte cap (including a first oversized frame), terminal transport loss leaves an active stream un-aborted, or a drain reorders frames, this design is wrong. The cheapest proof is a deterministic fake socket test that controls write returns and emits `drain`/close/error.

## Root Cause Evidence

- root_cause: `packages/client/src/daemon/control-server.ts` routes all response/event frames through `sendFrame`, which calls `socket.write(encodeFrame(frame))` independently and ignores the false backpressure signal; no connection-local outbound retained-byte authority exists.
- repro: run `bun run --cwd packages/client test -- src/__tests__/control-server.test.ts` after adding the deterministic fake-socket backpressure guard; on baseline `42a8b92f22fb4f9ba5844c4ded5d1ad6d58d6353`, it observes a second write before `drain` and fails.
- regression_guard: packages/client/src/__tests__/control-server.test.ts
- pre_fix_failure_artifact: tasks/notes/20260901-0409-issue-109-control-backpressure.pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260901-0409-issue-109-control-backpressure.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260901-0409-issue-109-control-backpressure.review.md`
- Notes file: `tasks/notes/20260901-0409-issue-109-control-backpressure.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run the local strict workflow check only. The protocol-2 acceptance policy is frozen for a later independent gate; this slice deliberately does not record an AcceptanceReceipt.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"control-backpressure-fake-socket","kind":"deterministic_test","paths":["packages/client/src/__tests__/control-server.test.ts"]},{"id":"control-backpressure-authenticated-connection","kind":"runtime_readback","paths":["packages/client/src/__tests__/control-server.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260901-0409-issue-109-control-backpressure.md
  - tasks/contracts/20260901-0409-issue-109-control-backpressure.contract.md
  - tasks/reviews/20260901-0409-issue-109-control-backpressure.review.md
  - tasks/notes/20260901-0409-issue-109-control-backpressure.notes.md
  - tasks/notes/20260901-0409-issue-109-control-backpressure.pre-fix.txt
  # Accepted #108 dependency, already fulfilled at this candidate's base;
  # retained here because target-branch normalization includes its exact diff.
  - plans/plan-20260901-0335-issue-108-control-rpc-ids.md
  - tasks/contracts/20260901-0335-issue-108-control-rpc-ids.contract.md
  - tasks/reviews/20260901-0335-issue-108-control-rpc-ids.review.md
  - tasks/notes/20260901-0335-issue-108-control-rpc-ids.notes.md
  - tasks/notes/20260901-0335-issue-108-control-rpc-ids.pre-fix.txt
  # Shared source/test paths below are also inherited #108 dependency paths.
  - packages/client/src/daemon/control-server.ts
  - packages/client/src/__tests__/control-server.test.ts
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
    - docs/spec.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260901-0409-issue-109-control-backpressure.pre-fix.txt
  tests_pass:
    - path: packages/client/src/__tests__/control-server.test.ts
  commands_succeed:
    - bun run --cwd packages/client test -- src/__tests__/control-server.test.ts
    - bun run --cwd packages/client typecheck
    - bun run --cwd packages/client build
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: one connection emits no additional frame after a false `write` until drain, then drains FIFO.
- Edge cases: a first frame above the byte cap is never written; overflow, sync write error, and close discard retained frames/listeners and abort active streams; a close before drain cannot flush later.
- Regression risks: slow consumers now close on a bounded queue rather than inducing unbounded retention; no protocol or public callback signature changes.

## Rollback Point

- Commit / checkpoint: `42a8b92f22fb4f9ba5844c4ded5d1ad6d58d6353` (#108 accepted base).
- Revert strategy: revert only the #109 writer and backpressure tests as one local source candidate; no external state is created.
