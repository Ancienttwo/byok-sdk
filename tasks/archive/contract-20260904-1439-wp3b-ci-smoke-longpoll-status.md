> **Archived**: 2026-09-04 14:39
> **Related Plan**: plans/archive/plan-20260904-1428-wp3b-ci-smoke-longpoll-status.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260904-1439
> **Archive Projection V1**: `plans/plan-20260904-1428-wp3b-ci-smoke-longpoll-status.md` => `plans/archive/plan-20260904-1428-wp3b-ci-smoke-longpoll-status.md`
> **Archive Projection V1**: `tasks/notes/20260904-1428-wp3b-ci-smoke-longpoll-status.notes.md` => `tasks/archive/notes-20260904-1439-wp3b-ci-smoke-longpoll-status.md`
> **Archive Projection V1**: `tasks/contracts/20260904-1428-wp3b-ci-smoke-longpoll-status.contract.md` => `tasks/archive/contract-20260904-1439-wp3b-ci-smoke-longpoll-status.md`
> **Archive Projection V1**: `tasks/reviews/20260904-1428-wp3b-ci-smoke-longpoll-status.review.md` => `tasks/archive/review-20260904-1439-wp3b-ci-smoke-longpoll-status.md`

# Task Contract: wp3b-ci-smoke-longpoll-status

> **Status**: Fulfilled
> **Plan**: plans/archive/plan-20260904-1428-wp3b-ci-smoke-longpoll-status.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-04 14:29
> **Review File**: `tasks/archive/review-20260904-1439-wp3b-ci-smoke-longpoll-status.md`
> **Notes File**: `tasks/archive/notes-20260904-1439-wp3b-ci-smoke-longpoll-status.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

PR #133 exact-head CI showed that the built adapter smoke still consumes the deleted WebSocket fallback status. The credential-isolation audit invokes the same smoke, so one stale CI consumer blocks both required jobs and the authorized merge.

## Goal

Make the built adapter and credential-audit runtime oracle consume the long-poll-only daemon status contract, with no compatibility field or WS-only tuning input, then restore exact-head CI eligibility.

## Scope

- In scope: adapter smoke predicate/configuration/comments; stale long-poll test comments; task workflow artifacts.
- Out of scope: production transport behavior, server routes, credential audit policy, release/publish/deploy.
- Taste constraints: reject the obsolete status/configuration instead of restoring an alias or ignored compatibility input.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The built adapter smoke still times out before the first adapter task, the credential audit cannot execute that workload, or any touched current script/test still claims WS fallback/degraded transport semantics.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/archive/plan-20260904-1428-wp3b-ci-smoke-longpoll-status.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/archive/review-20260904-1439-wp3b-ci-smoke-longpoll-status.md`
- Notes file: `tasks/archive/notes-20260904-1439-wp3b-ci-smoke-longpoll-status.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"built-adapter-longpoll-smoke","kind":"runtime_readback","paths":["*"]},{"id":"longpoll-current-contract","kind":"deterministic_test","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/archive/plan-20260904-1428-wp3b-ci-smoke-longpoll-status.md
  - plans/archive/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/workstreams/root/
  - tasks/archive/contract-20260904-1439-wp3b-ci-smoke-longpoll-status.md
  - tasks/archive/review-20260904-1439-wp3b-ci-smoke-longpoll-status.md
  - tasks/archive/notes-20260904-1439-wp3b-ci-smoke-longpoll-status.md
  - packages/client/scripts/adapter-task-smoke.mjs
  - packages/client/src/
  - packages/client/package.json
  - packages/protocol/src/
  - bun.lock
  - api-surface/client.d.ts
  - api-surface/protocol.d.ts
  - api-surface/server.d.ts
  - docs/
  - README.md
  - CHANGELOG.md
  - examples/basic/README.md
  - packages/AGENTS.md
  - packages/CLAUDE.md
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
    - packages/client/scripts/adapter-task-smoke.mjs
    - packages/client/src/__tests__/real-cloud-longpoll.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/archive/notes-20260904-1439-wp3b-ci-smoke-longpoll-status.md
  tests_pass:
    - path: packages/client/src/__tests__/real-cloud-longpoll.test.ts
  commands_succeed:
    - bun run build
    - bun run --filter @byok-sdk/client smoke:adapters
    - bun run typecheck
    - bun run test
    - bun run check:api-surface
    - bun run check:version-authority
    - repo-harness run check-task-workflow --strict
    - repo-harness run check-architecture-sync
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: the real embedded-server smoke reaches connected state and completes all three adapter task lifecycles.
- Edge cases: the Linux credential audit must still launch the same smoke under strace.
- Regression risks: a status predicate could pass before server-observed connection; the smoke retains its machine-list readback immediately afterward.

## Rollback Point

- Commit / checkpoint: existing PR #133 feature branch.
- Revert strategy: revert the CI-oracle follow-up commit only.
