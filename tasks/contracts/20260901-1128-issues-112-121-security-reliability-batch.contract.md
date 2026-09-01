# Task Contract: issues-112-121-security-reliability-batch

> **Status**: Fulfilled
> **Plan**: plans/plan-20260901-1128-issues-112-121-security-reliability-batch.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 11:28
> **Review File**: `tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md`
> **Notes File**: `tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Issues #112-#121 leave credential leakage, cross-tenant blob disclosure,
unbounded transport memory/lifetime, stale connection mutation authority,
silent delivery gaps, post-terminal external side effects, and unrecoverable
pair/blob operations in both public server compositions. The batch must close
those gaps without adding compatibility or best-effort authorities.

## Goal

Deliver one reviewed local commit on top of `d8df33e` that fixes Issues
#112-#121 in the client, hosted cloud/dataplane, and reference server, with
per-issue regression evidence and the required root verification gates.

## Scope

- In scope:
  - recoverable exact-binding pairing completion in hosted and reference paths;
  - structural URL warning redaction;
  - bounded presigned upload bodies and tenant-owned reference blob lookup;
  - explicit replay-gap failure and client cursor refusal;
  - last-socket-wins WebSocket epochs plus finite hello/payload admission;
  - common hosted message admission and live-task side-effect authority;
  - BlobClient deadline and task/daemon cancellation through body completion;
  - focused and root verification, exact-diff review, workflow projections, and
    one coherent local Git commit.
- Out of scope:
  - push, PR creation, npm publish, release/tag, deployment, production migration, production secrets, downstream upgrade, and GitHub issue close/comment mutation.
- Taste constraints: one source of truth; fail closed; no long-lived
  compatibility path, raw credential scrubbing, controller-only durable lock,
  guessed enrollment, silent cursor repair, or post-cancellation finalize.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Stop if exact pairing/message race ownership cannot be represented atomically by
the existing composition without a forward schema change, or if a finite WS
payload limit would reject an envelope that the frozen protocol intentionally
permits. The cheapest proof is a red barrier/plus-one test against the unchanged
baseline before production edits; resolve the contract rather than add fallback.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/server/src/http.ts`, `hub.ts`, `ws-server.ts`, `packages/cloud/src/handlers/{auth,blobs,messages}.ts`, `packages/cloud/src/inbound.ts`, and `packages/client/src/daemon/{create-daemon,connection-manager,blob-client,http-client}.ts` each admit a fallible or attacker-controlled operation before the durable identity/lifecycle/resource authority named by Issues #112-#121.
- repro: run the three dedicated issue-batch regression files against main@d8df33e; they exercise retry-after-pair commit, plus-one uploads/frames, foreign-tenant lookup, evicted cursor, stale sockets, publish admission/termination, URL secret sentinels, and hung/cancelled blob transfers.
- regression_guard: packages/server/src/__tests__/issues-112-120-security-reliability.test.ts
- pre_fix_failure_artifact: tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.pre-fix.log

## Workflow Inventory

- Source plan: `plans/plan-20260901-1128-issues-112-121-security-reliability-batch.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md`
- Notes file: `tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"issues-112-121-regression-matrix","kind":"deterministic_test","paths":["*"]},{"id":"postgres-migration-concurrency-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260901-1128-issues-112-121-security-reliability-batch.contract.md
  - tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md
  - tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.notes.md
  - tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.pre-fix.log
  - docs/protocol.md
  - docs/security.md
  - docs/architecture/
  - packages/AGENTS.md
  - packages/CLAUDE.md
  - packages/client/
  - packages/server/
  - packages/cloud/
  - packages/cloud-dataplane/
  - packages/core/
  - packages/protocol/
  - packages/conformance/
  - examples/basic/
  - deploy/sql/
  - tests/sql/control_plane_invariants.sql
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
    - packages/client/src/__tests__/issues-113-116-121-security-reliability.test.ts
    - packages/server/src/__tests__/issues-112-120-security-reliability.test.ts
    - packages/cloud/src/__tests__/issues-112-114-119-120-security-reliability.test.ts
    - packages/cloud-dataplane/src/__tests__/issues-112-120-security-reliability.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.notes.md
    - tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.pre-fix.log
  tests_pass:
    - path: packages/client/src/__tests__/issues-113-116-121-security-reliability.test.ts
    - path: packages/server/src/__tests__/issues-112-120-security-reliability.test.ts
    - path: packages/cloud/src/__tests__/issues-112-114-119-120-security-reliability.test.ts
    - path: packages/cloud-dataplane/src/__tests__/issues-112-120-security-reliability.test.ts
  commands_succeed:
    - bun run --cwd packages/client test -- src/__tests__/issues-113-116-121-security-reliability.test.ts
    - bun run --cwd packages/server test -- src/__tests__/issues-112-120-security-reliability.test.ts
    - bun run --cwd packages/cloud test -- src/__tests__/issues-112-114-119-120-security-reliability.test.ts
    - bun run --cwd packages/cloud-dataplane test -- src/__tests__/issues-112-120-security-reliability.test.ts
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: every Issue #112-#121 acceptance criterion is mapped to
  a dedicated test and no pre-existing happy path regresses.
- Edge cases: exact/conflicting replay, concurrent winners, task terminal states,
  missing/lying lengths, silent/oversized sockets, stale epochs, cursor floors,
  hung headers/bodies, lifecycle cancellation, IPv6 and secret URL components.
- Regression risks: cross-package store API changes must remove the old authority
  in the same commit; any schema change is forward-only and verified from a
  disposable database, never applied to production.

## Rollback Point

- Commit / checkpoint: main@d8df33e before implementation.
- Revert strategy: revert the single local work-package commit; do not retain a
  partial store/schema or compatibility surface.
