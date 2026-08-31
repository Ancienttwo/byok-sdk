# Task Contract: issue-110-auth-request-deadline

> **Status**: Verified
> **Plan**: plans/plan-20260901-0411-issue-110-auth-request-deadline.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 04:21
> **Review File**: `tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md`
> **Notes File**: `tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`AuthManager` owns the complete device credential record and its mutation tail, but its pair and renewal HTTP/body reads currently have no cancellation deadline. A stalled peer can therefore retain the mutation tail and daemon ownership lease indefinitely.

## Goal

Bound every AuthManager pairing and renewal request, including response-body reads; daemon shutdown must abort active authentication I/O before awaiting the credential mutation tail. Timeout/cancellation must be distinguishable from revocation and cannot persist a partial credential.

## Scope

- In scope: AuthManager request deadline/controller ownership; daemon configuration composition; CLI config projection assertion; deterministic auth/daemon HTTP and response-body stall tests; strict plan/contract/review/notes and pre-fix evidence.
- Out of scope: protocol/server changes, credential-store schema, retry fallback, revocation semantics, release, merge, push, PR, issue mutation, publish, and deploy.
- Taste constraints: one AuthManager-owned controller authority; no compatibility paths or partial-state recovery.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if bounded response-body reads cannot be attached to the same request authority as fetch without adding a second credential or config authority.

## Falsifier

On unfixed source, a deterministic stalled pair/challenge/token/body response exceeds the short test guard, proving the current request can retain its credential mutation. After the fix, the same stall must reject as a classified deadline/cancellation error, leave `isRevoked()` false, and leave the previous complete credential intact.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: `packages/client/src/daemon/auth-manager.ts` calls `fetch`, `Response.json()`, and `safeErrorText()` without a request signal or a bounded race; `stop()` only clears a timer and awaits the tail, so stalled I/O never releases it.
- repro: run the deterministic stall cases in `packages/client/src/__tests__/daemon-auth.test.ts`; on base `9d2b052` their short guard expires because the request/body never settles.
- regression_guard: packages/client/src/__tests__/daemon-auth.test.ts
- pre_fix_failure_artifact: tasks/notes/20260901-0411-issue-110-auth-request-deadline.pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260901-0411-issue-110-auth-request-deadline.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md`
- Notes file: `tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"auth-deadline-deterministic","kind":"deterministic_test","paths":["packages/client/src/daemon/auth-manager.ts","packages/client/src/daemon/create-daemon.ts","packages/client/src/__tests__/daemon-auth.test.ts","packages/client/src/__tests__/bin-config.test.ts","packages/client/src/__tests__/fixtures/test-server.ts"]},{"id":"daemon-config-runtime","kind":"runtime_readback","paths":["packages/client/src/daemon/create-daemon.ts","packages/client/src/__tests__/bin-config.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260901-0411-issue-110-auth-request-deadline.md
  - tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md
  - tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md
  - tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md
  - tasks/notes/20260901-0411-issue-110-auth-request-deadline.pre-fix.txt
  - packages/client/src/daemon/auth-manager.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/__tests__/daemon-auth.test.ts
  - packages/client/src/__tests__/bin-config.test.ts
  - packages/client/src/__tests__/fixtures/test-server.ts
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
    - packages/client/src/daemon/auth-manager.ts
    - packages/client/src/daemon/create-daemon.ts
    - packages/client/src/__tests__/daemon-auth.test.ts
    - packages/client/src/__tests__/bin-config.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md
    - tasks/notes/20260901-0411-issue-110-auth-request-deadline.pre-fix.txt
  tests_pass:
    - path: packages/client/src/__tests__/daemon-auth.test.ts
    - path: packages/client/src/__tests__/bin-config.test.ts
  commands_succeed:
    - bun run --cwd packages/client test -- src/__tests__/daemon-auth.test.ts src/__tests__/bin-config.test.ts
    - bun run --cwd packages/client typecheck
    - bun run --cwd packages/client build
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: base `9d2b05253570c13f235ef4f9aa2a1e94e431c576`.
- Revert strategy: revert AuthManager request deadline/controller wiring, daemon config composition, fixtures, and coupled regressions together.
