# Task Contract: win32-job-object-ownership

> **Status**: Active
> **Plan**: plans/plan-20260906-0130-win32-job-object-ownership.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-06 01:40
> **Review File**: `tasks/reviews/20260906-0130-win32-job-object-ownership.review.md`
> **Notes File**: `tasks/notes/20260906-0130-win32-job-object-ownership.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

When the daemon dies, nothing in the adapter disposal chain runs: POSIX detached process groups and win32 descendants outlive it. Three fixes hardened the win32 `taskkill` sweep without touching that gap, and `process-tree.ts` names it out of scope. A kernel-owned Job Object and a synchronous host-exit sweep close it structurally instead of by sweep tuning.

## Goal

Every owned runtime process tree is (a) on win32 assigned to a daemon-wide `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` job immediately after spawn, with adoption failure or a missing `koffi` module failing closed before any run handle is published, and (b) on every platform registered with a once-installed synchronous `process` `exit` handler that kills still-live trees. `koffi` ships as an exact-pinned `optionalDependencies` entry of `@byok-sdk/client`, is never loaded off win32, and the release-graph invariant text and checks are extended accordingly.

## Scope

- In scope: new `win32-job-object.ts`, `adoptOwnedProcessTree` and the host-exit registry in `process-tree.ts`, the three adapter spawn sites, `packages/client/package.json` + `tsup.config.ts` + `bun.lock`, `scripts/release/check-package-graph.mjs` comment and optional-dependency checks (plus its fixtures/tests if they exist), client tests, CHANGELOG, this plan's workflow artifacts.
- Out of scope: sandboxing, restricted tokens, ACLs, PowerShell janitors, SEA packaging changes, a platform-scoped sub-package for koffi, changes to the taskkill walk or quiescence measurement, public API additions (no new exports from `@byok-sdk/client` index files).
- Taste constraints: no degraded path on win32; POSIX code must not import koffi even lazily; DI seams follow the existing `platform`/`spawnFn`/`killFn` convention in `process-tree.ts`.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if koffi 3.2.0 cannot bind the six kernel32 functions on Windows (report from the windows-latest CI leg or a local Windows run).

## Falsifier

A Windows host in Salesko's user base where `AssignProcessToJobObject` is denied for ordinary processes would falsify the fail-closed rule; cheapest proof is the windows-latest CI leg plus the Win32 error code the typed failure carries.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260906-0130-win32-job-object-ownership.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260906-0130-win32-job-object-ownership.review.md`
- Notes file: `tasks/notes/20260906-0130-win32-job-object-ownership.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"client-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"host-exit-real-process-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260906-0130-win32-job-object-ownership.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260906-0130-win32-job-object-ownership.contract.md
  - tasks/reviews/20260906-0130-win32-job-object-ownership.review.md
  - tasks/notes/20260906-0130-win32-job-object-ownership.notes.md
  - packages/client/src/adapters/win32-job-object.ts
  - packages/client/src/adapters/process-tree.ts
  - packages/client/src/adapters/claude/process-client.ts
  - packages/client/src/adapters/codex/process-runner.ts
  - packages/client/src/adapters/pi/rpc-client.ts
  - packages/client/src/__tests__/win32-job-object.test.ts
  - packages/client/src/__tests__/host-exit-backstop.test.ts
  - packages/client/src/__tests__/runtime-process-tree.test.ts
  - packages/client/src/__tests__/win32-process-tree-quiescence.test.ts
  - packages/client/src/__tests__/adapter-disposal-parity.test.ts
  - packages/client/src/__tests__/fixtures/
  - packages/client/package.json
  - packages/client/tsup.config.ts
  - bun.lock
  - scripts/release/check-package-graph.mjs
  - scripts/release/fixtures/
  - api-surface/client.d.ts
  - CHANGELOG.md
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
    - packages/client/src/adapters/win32-job-object.ts
    - packages/client/src/__tests__/host-exit-backstop.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260906-0130-win32-job-object-ownership.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/win32-job-object.test.ts
    - path: packages/client/src/__tests__/host-exit-backstop.test.ts
    - path: packages/client/src/__tests__/adapter-disposal-parity.test.ts
    - path: packages/client/src/__tests__/win32-process-tree-quiescence.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/client typecheck
    - bun run --filter @byok-sdk/client build
    - bun run --filter @byok-sdk/client test
    - bun run check:release-graph
    - bun run check:api-surface
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: on win32 a spawned runtime child is assigned to the kill-on-close job before the adapter publishes; missing koffi or a failed assignment closes the child and surfaces a typed failure; on all platforms a daemon `process.exit()` kills live owned trees synchronously.
- Edge cases: adoption after the child already exited; koffi present but `AssignProcessToJobObject` denied; child spawns grandchildren before assignment (documented residual); exit handler must not throw or await.
- Regression risks: ~3 MB (koffi 1.8 MB + one @koromix/koffi-<os>-<arch> prebuilt 1.2 MB) on every platform; Windows hosts that deny job assignment lose runtime dispatch entirely (by decision).

## Rollback Point

- Commit / checkpoint: `b052d8a` (main before this task).
- Revert strategy: revert the single PR; no persisted state.
