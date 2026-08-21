# Task Contract: transport-diagnostics

> **Status**: Fulfilled
> **Plan**: plans/plan-20260821-2336-transport-diagnostics.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-21 23:36
> **Review File**: `tasks/reviews/20260821-2336-transport-diagnostics.review.md`
> **Notes File**: `tasks/notes/20260821-2336-transport-diagnostics.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Transport failures today are unobservable: WS upgrade rejection carries only a status code, long-poll drain errors swallow route context, and the blob content proxy conflates upstream-unreachable, mid-stream interruption, and not-found into one `undefined`. Operators cannot correlate a failure to a route/host, and a mid-transfer blob failure is indistinguishable from a missing blob. Pattern source: raft-study 1.0.18 delta F-007, adapted to BYOK idiom (user-approved slice).

## Goal

Typed transport error diagnostics: (1) client WS/long-poll transport errors carry `{transport, host, path}` built at one structural-redaction site (parsed URL; userinfo/query/fragment dropped); (2) cloud `BlobContentProxy.readContent` returns a `BlobReadResult` union distinguishing `blob_upstream_unavailable` (before upstream response) from `blob_upstream_stream_interrupted` (after), both mapped to 502, with `undefined` keeping its not-found→404 meaning. No retries, no fallbacks, no semantic or wire change. Full breakdown in the plan's `## Task Breakdown` (client half already landed in this worktree).

## Scope

- In scope: packages/client transport error surfaces (url.ts, ws-transport.ts, long-poll-transport.ts), packages/cloud blob proxy port + handler + in-memory store + exports, the two new test files.
- Out of scope: protocol bytes, task semantics, `RuntimeExecutionFailure.retry`, any observability sink, `packages/server`'s separate BlobStore port, retries/recovery behavior.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If any existing caller relies on `readContent` returning bare content (not a result union) outside the in-memory store, the port change ripples wider than one implementor — cheapest proof: grep `readContent` implementors/callers in packages/cloud before editing (already done: in-memory store is the only implementor; packages/server's `BlobStore.readContent` is a different port).

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260821-2336-transport-diagnostics.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260821-2336-transport-diagnostics.review.md`
- Notes file: `tasks/notes/20260821-2336-transport-diagnostics.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"transport-endpoint-redaction-test","kind":"deterministic_test","paths":["packages/client/src/daemon/url.ts"]},{"id":"ws-upgrade-endpoint-readback","kind":"runtime_readback","paths":["packages/client/src/daemon/url.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260821-2336-transport-diagnostics.md
  - tasks/contracts/20260821-2336-transport-diagnostics.contract.md
  - tasks/reviews/20260821-2336-transport-diagnostics.review.md
  - tasks/notes/20260821-2336-transport-diagnostics.notes.md
  - packages/client/src/daemon/url.ts
  - packages/client/src/daemon/ws-transport.ts
  - packages/client/src/daemon/long-poll-transport.ts
  - packages/client/src/__tests__/transport-error-diagnostics.test.ts
  - packages/cloud/src/stores/ports.ts
  - packages/cloud/src/handlers/blobs.ts
  - packages/cloud/src/stores/in-memory/blobs.ts
  - packages/cloud/src/index.ts
  - packages/cloud/src/__tests__/blob-content-proxy-failure-modes.test.ts
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
    - packages/client/src/daemon/url.ts
    - packages/client/src/__tests__/transport-error-diagnostics.test.ts
    - packages/cloud/src/__tests__/blob-content-proxy-failure-modes.test.ts
  artifacts_exist:
    - tasks/notes/20260821-2336-transport-diagnostics.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/transport-error-diagnostics.test.ts
    - path: packages/cloud/src/__tests__/blob-content-proxy-failure-modes.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: worktree base `bb3c1a1` (= origin/main, v0.6.0).
- Revert strategy: delete branch `slice/transport-diagnostics`; the change is additive (error metadata + result union) and unreleased.
