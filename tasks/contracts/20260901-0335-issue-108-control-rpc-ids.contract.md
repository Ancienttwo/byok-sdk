# Task Contract: issue-108-control-rpc-ids

> **Status**: Active
> **Plan**: plans/plan-20260901-0335-issue-108-control-rpc-ids.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 03:37
> **Review File**: `tasks/reviews/20260901-0335-issue-108-control-rpc-ids.review.md`
> **Notes File**: `tasks/notes/20260901-0335-issue-108-control-rpc-ids.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The control socket correlates every response/event to a connection-local request ID, but the server currently tracks only stream controllers and lets a duplicate ID replace the existing owner. The displaced stream cannot be reliably aborted or distinguished from later frames.

## Goal

Enforce at most one in-flight unary or stream operation for each request ID on one authenticated control connection, reject duplicates with `duplicate_request_id`, release ownership by exact record identity, and abort every active stream on disconnect.

## Scope

- In scope: `handleConnection` request ownership for unary and stream handlers; authenticated socket regression tests for duplicate, cross-kind, completion/rejection, and disconnect races; strict verification and independent review.
- Out of scope: outbound backpressure/queueing (#109), request timeouts, cancellation protocol, cross-connection ID uniqueness, client-generated ID policy, daemon method semantics, publication/deployment, and GitHub issue mutation.
- Taste constraints: one connection-local ownership map; register before handler invocation; no replacement, generation inference, fallback, or compatibility path; preserve existing response and unknown-method semantics.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if correctness requires changing the wire request/response schema or adding cancellation/timeouts.

## Falsifier

Two handlers start concurrently under one connection/request ID; a completing or rejected handler can release another record's ownership; a duplicate is accepted across unary/stream kinds; or disconnect fails to abort each active stream exactly once.

## Root Cause Evidence

- root_cause: `packages/client/src/daemon/control-server.ts` keeps only `activeStreams`, overwrites it with `set(id, controller)`, and later performs unconditional `delete(id)`, so the request ID is not exclusive ownership and cleanup is not identity-safe.
- repro: run the authenticated socket duplicate-ID regression in `packages/client/src/__tests__/control-server.test.ts` on audit baseline `7a937e5ed8eb5aef102eacb0df9183f296da7e1f` and observe the duplicate handler start.
- regression_guard: packages/client/src/__tests__/control-server.test.ts
- pre_fix_failure_artifact: tasks/notes/20260901-0335-issue-108-control-rpc-ids.pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260901-0335-issue-108-control-rpc-ids.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260901-0335-issue-108-control-rpc-ids.review.md`
- Notes file: `tasks/notes/20260901-0335-issue-108-control-rpc-ids.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"control-rpc-duplicate-id-socket-guard","kind":"deterministic_test","paths":["*"]},{"id":"control-rpc-handler-lifetime-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260901-0335-issue-108-control-rpc-ids.md
  - tasks/contracts/20260901-0335-issue-108-control-rpc-ids.contract.md
  - tasks/reviews/20260901-0335-issue-108-control-rpc-ids.review.md
  - tasks/notes/20260901-0335-issue-108-control-rpc-ids.notes.md
  - tasks/notes/20260901-0335-issue-108-control-rpc-ids.pre-fix.txt
  - packages/client/src/daemon/control-server.ts
  - packages/client/src/__tests__/control-server.test.ts
```

## Evidence Requirements

```yaml
evidence_requirements:
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
    - tasks/notes/20260901-0335-issue-108-control-rpc-ids.pre-fix.txt
  tests_pass:
    - path: packages/client/src/__tests__/control-server.test.ts
  commands_succeed:
    - bun run --cwd packages/client test -- src/__tests__/control-server.test.ts
    - bun run --cwd packages/client typecheck
    - bun run --cwd packages/client build
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: duplicate active IDs fail closed before a second handler starts, across both handler kinds.
- Edge cases: handler completion and rejection release only their own record; disconnect aborts all active stream controllers once.
- Regression risks: a handler that never settles retains its ID as before; the map is intentionally per connection, not global.

## Rollback Point

- Commit / checkpoint: `9d2b05253570c13f235ef4f9aa2a1e94e431c576`.
- Revert strategy: revert the request registry and focused dispatch tests together.
