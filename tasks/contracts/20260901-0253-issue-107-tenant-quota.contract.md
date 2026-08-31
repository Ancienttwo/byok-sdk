# Task Contract: issue-107-tenant-quota

> **Status**: Fulfilled
> **Plan**: plans/plan-20260901-0253-issue-107-tenant-quota.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 03:21
> **Review File**: `tasks/reviews/20260901-0253-issue-107-tenant-quota.review.md`
> **Notes File**: `tasks/notes/20260901-0253-issue-107-tenant-quota.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The configured reliable-egress tenant byte ceiling spans every Agent spool, but admission currently uses a stale controller snapshot followed by only spool-local serialization. Concurrent Agents can therefore commit more durable bytes than the tenant policy permits.

## Goal

Make tenant quota observation and each new reliable record commit one controller-owned operation across reliable payloads and content receipts, while preserving spool-owned per-Agent quotas and releasing the next operation after a definite failure.

## Scope

- In scope: `AgentEgressController` admission for `appendReliable()` and `appendContentReceipt()`, public cross-Agent race guards, failure release, strict verification, and independent review.
- Out of scope: #106 home identity, multi-process quota authority, reservation ledger, spool persistence format, ack/recover/deactivate semantics, publication/deployment, and GitHub issue mutation.
- Taste constraints: one process-local tenant append authority; keep sanitizer outside the critical section; retain spool-local cursor and per-Agent quota authority; no fallback or second byte ledger.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if correctness requires a shared cross-process transactional store or a spool persistence redesign.

## Falsifier

Two public appends for different Agent homes can both succeed when only one fits, their read-back total exceeds `maxPendingBytesPerTenant`, either reliable variant bypasses the shared gate, or a definite failed append permanently blocks the next operation.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/client/src/daemon/agent-egress-controller.ts` reads `tenantPendingBytes()` before each selected spool's private write queue, so different spools can consume the same pre-append tenant total and independently commit.
- repro: block two public cross-Agent append calls immediately before their spool commits, release both, and observe two winners or a tenant total above the configured ceiling on audit baseline `7a937e5ed8eb5aef102eacb0df9183f296da7e1f`.
- regression_guard: packages/client/src/__tests__/agent-egress-spool.test.ts
- pre_fix_failure_artifact: tasks/notes/20260901-0253-issue-107-tenant-quota.pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260901-0253-issue-107-tenant-quota.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260901-0253-issue-107-tenant-quota.review.md`
- Notes file: `tasks/notes/20260901-0253-issue-107-tenant-quota.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"tenant-reliable-cross-spool-races","kind":"deterministic_test","paths":["*"]},{"id":"tenant-reliable-records-byte-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260901-0253-issue-107-tenant-quota.md
  - tasks/contracts/20260901-0253-issue-107-tenant-quota.contract.md
  - tasks/reviews/20260901-0253-issue-107-tenant-quota.review.md
  - tasks/notes/20260901-0253-issue-107-tenant-quota.notes.md
  - tasks/notes/20260901-0253-issue-107-tenant-quota.pre-fix.txt
  - packages/client/src/daemon/agent-egress-controller.ts
  - packages/client/src/__tests__/agent-egress-spool.test.ts
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
    - tasks/notes/20260901-0253-issue-107-tenant-quota.pre-fix.txt
  tests_pass:
    - path: packages/client/src/__tests__/agent-egress-spool.test.ts
    - path: packages/client/src/__tests__/agent-home-contract.test.ts
  commands_succeed:
    - bun --filter @byok-sdk/client test -- src/__tests__/agent-egress-spool.test.ts src/__tests__/agent-home-contract.test.ts
    - bun run --cwd packages/client typecheck
    - bun run --cwd packages/client build
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: exactly one cross-Agent race winner when only one record fits, for both reliable variants.
- Edge cases: definite failed append releases the next caller; existing per-Agent quota tests remain green.
- Regression risks: tenant-wide fsync head-of-line blocking; multi-process writers remain unsupported by this process-local authority.

## Rollback Point

- Commit / checkpoint: `9d2b05253570c13f235ef4f9aa2a1e94e431c576`.
- Revert strategy: revert the controller tail and focused regression section together.
