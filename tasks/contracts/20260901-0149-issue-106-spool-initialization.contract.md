# Task Contract: issue-106-spool-initialization

> **Status**: Active
> **Plan**: plans/plan-20260901-0149-issue-106-spool-initialization.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 02:16
> **Review File**: `tasks/reviews/20260901-0149-issue-106-spool-initialization.review.md`
> **Notes File**: `tasks/notes/20260901-0149-issue-106-spool-initialization.notes.md`

## Why

The durable spool's pending map, cursor, and write queue are instance-local. First-open must therefore have one home-bound live authority before any caller can append.

## Goal

Make concurrent first appends for one AgentRef/home share exactly one spool, preserve both records with unique monotonic cursors, retry after shared open failure, and fail closed if the same AgentRef is presented with another home.

## Scope

- In scope: `AgentEgressController.spoolFor`, its in-flight slot, and deterministic public append tests.
- Out of scope: tenant quota atomicity, controller-wide append serialization, spool persistence format, cross-profile parallelism, cancellation/deactivation, cloud transport, release/deploy/issue mutation.
- Taste constraints: one authority; exact home binding; identity-safe cleanup; no compatibility fallback or second spool cache.

## Stop Conditions

- Stop if the fix requires changing spool persistence or AgentRef wire contracts.
- Stop if the deterministic guard cannot force two callers through the first-open boundary.
- Stop if existing restart/ack behavior regresses.

## Falsifier

Two concurrent public appends can open two spool instances, lose a successful record from `reliableRecords()`, allocate duplicate/non-monotonic cursors, prevent retry after failure, or silently reuse another home.

## Root Cause Evidence

- root_cause: audit baseline `7a937e5` checked the spool cache, awaited `AgentReliableSpool.open()`, and only then inserted the instance, allowing two first callers to create independent cursor/write authorities.
- repro: block the first open, start two public appends for the same AgentRef/home, release both, and observe more than one open plus incomplete/duplicate live state on the audit baseline.
- regression_guard: packages/client/src/__tests__/agent-egress-spool.test.ts
- pre_fix_failure_artifact: tasks/notes/20260901-0149-issue-106-spool-initialization.pre-fix.txt

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"agent-spool-first-open-authority","kind":"deterministic_test","paths":["packages/client/src/__tests__/agent-egress-spool.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260901-0149-issue-106-spool-initialization.md
  - tasks/todos.md
  - tasks/contracts/20260901-0149-issue-106-spool-initialization.contract.md
  - tasks/reviews/20260901-0149-issue-106-spool-initialization.review.md
  - tasks/notes/20260901-0149-issue-106-spool-initialization.notes.md
  - tasks/notes/20260901-0149-issue-106-spool-initialization.pre-fix.txt
  - packages/client/src/daemon/agent-egress-controller.ts
  - packages/client/src/__tests__/agent-egress-spool.test.ts
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/client/src/daemon/agent-egress-controller.ts
    - packages/client/src/__tests__/agent-egress-spool.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260901-0149-issue-106-spool-initialization.pre-fix.txt
  tests_pass:
    - path: packages/client/src/__tests__/agent-egress-spool.test.ts
    - path: packages/client/src/__tests__/agent-home-contract.test.ts
  commands_succeed:
    - bun --filter @byok-sdk/client test -- src/__tests__/agent-egress-spool.test.ts src/__tests__/agent-home-contract.test.ts
    - bun run --cwd packages/client typecheck
    - bun run --cwd packages/client build
    - git diff --check
```

## Rollback Point

- Commit / checkpoint: `9d2b05253570c13f235ef4f9aa2a1e94e431c576`.
- Revert strategy: revert the home-bound slot/checks and their focused tests together.
