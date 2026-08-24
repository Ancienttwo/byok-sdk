# Task Contract: agent-home-idempotent-repair

> **Status**: Ready for acceptance
> **Plan**: plans/plan-20260824-1254-agent-home-idempotent-repair.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-24 12:55
> **Review File**: `tasks/reviews/20260824-1254-agent-home-idempotent-repair.review.md`
> **Notes File**: `tasks/notes/20260824-1254-agent-home-idempotent-repair.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

BYOK 0.8.0 treats its durable ordering record as proof that downstream-derived
opaque bytes still exist. Salesko proves that deleting only its `profile.json`
leaves the SDK state intact, so a new exact desired-state request is completed
as idempotent before any product consumer can repair the missing bytes.

## Goal

Enforce the existing generic atomic/idempotent product-consumer contract under
the canonical-home writer lease. Exact revision/hash replay must run `apply` as
an ensure and return `idempotent`; stale/conflict must not run it, failures must
remain unacked/retryable, and no SDK component may know product paths or schema.

## Scope

- In scope: client projection lifecycle/tests, client/protocol/local
  storage docs, aligned 0.8.1/keys 0.3.2 packed RC metadata, full gates, and
  exact frozen Salesko RC acceptance.
- Out of scope: a new public hook/API; Salesko schema or
  path knowledge; cloud polling; revision/hash synthesis; SDK state deletion;
  npm publish, merge, push, tag, deploy, production migration/DDL, secrets, or
  production wiring.
- Taste constraints: one ordering authority; one canonical-home lease; existing
  atomic/idempotent consumer as ensure; exact replay remains externally `idempotent`.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The design is falsified if exact replay can complete without the product consumer,
if stale/conflict invokes any product hook, if ensure failure advances ordering
or cursor, if a repair overlaps task execution, or if the Salesko Phase 2 guard
still leaves `profile.json` absent. Cheapest proof is the focused client regression.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/client/src/agent-home.ts:651-653` returns equal revision/hash as `idempotent` before invoking any product lifecycle, so durable SDK ordering state masks loss of downstream-derived files.
- repro: `bun test packages/client/src/__tests__/agent-home-idempotent-repair.test.ts` on the unfixed 0.8.0 source.
- regression_guard: packages/client/src/__tests__/agent-home-idempotent-repair.test.ts
- pre_fix_failure_artifact: .ai/harness/runs/20260824-1254-agent-home-idempotent-repair/pre-fix-agent-home-idempotent-repair.txt

## Workflow Inventory

- Source plan: `plans/plan-20260824-1254-agent-home-idempotent-repair.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260824-1254-agent-home-idempotent-repair.review.md`
- Notes file: `tasks/notes/20260824-1254-agent-home-idempotent-repair.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"agent-home-ensure-ordering","kind":"deterministic_test","paths":["packages/client/src/agent-home.ts","packages/client/src/__tests__/agent-home-idempotent-repair.test.ts","packages/client/src/__tests__/agent-home-projection.test.ts"]},{"id":"packed-rc-and-downstream-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260824-1254-agent-home-idempotent-repair.md
  - tasks/todos.md
  - tasks/contracts/20260824-1254-agent-home-idempotent-repair.contract.md
  - tasks/reviews/20260824-1254-agent-home-idempotent-repair.review.md
  - tasks/notes/20260824-1254-agent-home-idempotent-repair.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - packages/client/src/agent-home.ts
  - packages/client/src/index.ts
  - packages/client/src/__tests__/agent-home-projection.test.ts
  - packages/client/src/__tests__/agent-home-idempotent-repair.test.ts
  - packages/client/README.md
  - docs/protocol.md
  - docs/host-local-storage-layout.md
  - bun.lock
  - packages/client/package.json
  - packages/cloud-dataplane/package.json
  - packages/cloud/package.json
  - packages/core/package.json
  - packages/keys/package.json
  - packages/protocol/package.json
  - packages/sdk/package.json
  - packages/server/package.json
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
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
    - packages/client/src/agent-home.ts
    - packages/client/src/__tests__/agent-home-idempotent-repair.test.ts
    - docs/protocol.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260824-1254-agent-home-idempotent-repair.notes.md
    - .ai/harness/runs/20260824-1254-agent-home-idempotent-repair/pre-fix-agent-home-idempotent-repair.txt
  tests_pass:
    - path: packages/client/src/__tests__/agent-home-idempotent-repair.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:release-graph
    - bun run check:release-pack
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: exact replay ensures product-derived bytes and
  returns idempotent without creating tasks/runtimes/sessions.
- Edge cases: whole-home loss, intact replay, derived-file loss, hook failure,
  stale/conflict/newer ordering, same-Agent overlap, restart/redelivery.
- Regression risks: hosts that violated the documented idempotent consumer
  contract may observe replayed side effects; release train must close exactly.

## Rollback Point

- Commit / checkpoint: branch base `origin/main` at worktree creation; no RC yet.
- Revert strategy: discard this unpublished branch and disposable RC; revert the
  guard-only Salesko expectation update.
