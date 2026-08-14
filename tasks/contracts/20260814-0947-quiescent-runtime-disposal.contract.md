# Task Contract: quiescent-runtime-disposal

> **Status**: Active
> **Plan**: plans/plan-20260814-0947-quiescent-runtime-disposal.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-14 09:49
> **Review File**: `tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md`
> **Notes File**: `tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`Session.close()` is fire-and-forget in all three bundled adapters, while `TaskRunner.finish()` deletes active ownership and releases a Git lease before awaiting it. A provider-spawned descendant can therefore keep writing after a replacement task acquires the same workspace. This row replaces best-effort kill with one disposal receipt: semantic terminal authority stays unchanged, but runtime/workspace ownership cannot release until the owned tree is proven quiescent.

## Goal

Ship the 0.4.0 quiescent disposal contract across Pi, Claude, Codex, TaskRunner, daemon shutdown, built smoke, and supported CI OSes. `close()` is idempotent/single-flight and settles only after child, descendants, and task-scoped resources are quiescent. Typed disposal failure is locally observable, retains ownership fail-closed, and never rewrites or duplicates an already-sent semantic terminal.

## Scope

- In scope:
  - shared cross-platform owned-process-tree primitive for all three bundled adapters;
  - public `RuntimeDisposalFailure`, distinct from Row 2 execution failure/retryability;
  - quiescent Session.close, TaskRunner finalization/Git retention, daemon observation/barrier propagation;
  - real descendants, focused tests, built real-server smoke, multi-OS CI, and lifecycle docs.
- Out of scope:
  - protocol-v1 changes, provider wire redesign, runtime IDs, sandbox policy, plugin loaders, and the landed control-socket/daemon-owner ordering.
- Taste constraints: delete direct-child-only and swallowed best-effort teardown; no sleeps, PID mocks, compatibility semantics, second shutdown flow, or generic plugin supervisor.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop before production edits if the real root-plus-descendant fixture does not reproduce the old gap.
- Stop for a platform-specific supervised-launcher redesign if Node process groups cannot bound POSIX descendants or Windows taskkill cannot prove the real descendant gone.
- Never signal a non-positive/unresolved PID, the daemon process group, or a tree not created by the owning adapter.
- Preserve the landed control-socket/daemon-owner lease order and retain ownership after unproven disposal.

## Falsifier

Thesis: delete best-effort kill and make `Session.close()` the one owned-resource receipt. Cheapest proof: each fake runtime spawns a real descendant and reports both PIDs; on the unfixed base, close resolves while the descendant remains alive. The implementation must make both PIDs absent before settlement. Falsifier: if detached POSIX ownership breaks a runtime transport, or Windows cannot prove the descendant gone on existing CI, do not weaken the receipt; stop and use a platform-specific supervised launcher.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260814-0947-quiescent-runtime-disposal.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md`
- Notes file: `tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/
  - .github/workflows/ci.yml
  - docs/spec.md
  - docs/security.md
  - docs/architecture/sdk-architecture.md
  - CHANGELOG.md
  - plans/
  - plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260814-0947-quiescent-runtime-disposal.contract.md
  - tasks/reviews/20260814-0947-quiescent-runtime-disposal.review.md
  - tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md
  - tasks/notes/20260814-0947-quiescent-runtime-disposal.pre-fix.md
  - .ai/context/capabilities.json
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
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
    - packages/client/src/adapters/process-tree.ts
    - tasks/notes/20260814-0947-quiescent-runtime-disposal.pre-fix.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260814-0947-quiescent-runtime-disposal.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/runtime-process-tree.test.ts
    - path: packages/client/src/__tests__/pi-adapter.test.ts
    - path: packages/client/src/__tests__/claude-adapter.test.ts
    - path: packages/client/src/__tests__/daemon-stop-shutdown-parity.test.ts
  commands_succeed:
    - pnpm --filter @byok-sdk/client exec vitest run src/__tests__/task-runner-shutdown.test.ts src/__tests__/git-workspace-task-runner.test.ts src/__tests__/codex-adapter.test.ts
    - pnpm --filter @byok-sdk/client run typecheck
    - pnpm --filter @byok-sdk/client run test
    - pnpm --filter @byok-sdk/client run build
    - pnpm --filter @byok-sdk/client run smoke:adapters
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: root and descendant are absent before close/cancel/stop settles; workspace ownership remains held until success.
- Edge cases: repeated close, terminal/disposal races, resistant descendant escalation, Windows failure, Claude cleanup failure, and retry after failed receipt.
- Regression risks: detached spawn behavior, PID reuse, queue timing, shutdown deadlines, and disposal accidentally entering execution-failure projection.

## Rollback Point

- Commit / checkpoint: exact implementation commit recorded after code freeze.
- Revert strategy: revert process owner, adapters, TaskRunner/observer/shutdown ordering, fixtures/smoke/CI/docs as one unit; never retain detached groups without group disposal.
