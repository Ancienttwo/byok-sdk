> **Archived**: 2026-07-24 11:24
> **Related Plan**: plans/archive/plan-20260724-0138-local-git-task-workspaces.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260724-1124

# Task Contract: local-git-task-workspaces

> **Status**: Fulfilled
> **Plan**: plans/plan-20260724-0138-local-git-task-workspaces.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-07-24 01:38
> **Review File**: `tasks/reviews/20260724-0138-local-git-task-workspaces.review.md`
> **Notes File**: `tasks/notes/20260724-0138-local-git-task-workspaces.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Connected coding agents currently run in plain daemon-owned directories, so they have no shared, recoverable checkpoint convention and Codex must bypass its Git repository check. This task adds local Git as a code-progress and salvage layer while preserving the server task state machine as the only lifecycle authority. Shipping it incorrectly could leak repository metadata, corrupt recoverable work, revive interrupted tasks, or weaken the existing claim/cancellation ordering.

## Goal

Deliver a disabled-by-default `gitWorkspace: { mode: 'local-checkpoints' }` client feature that initializes each daemon-owned task directory as a local Git repository, gives every bundled adapter the same safe checkpoint guidance, records coarse private recovery state, exposes read-only workspace status through the CLI, and preserves existing plain-workspace behavior when disabled. The implementation must not change protocol or server code and must never perform destructive or network Git operations.

## Scope

- In scope: optional client configuration and public types; no-shell Git preflight/init/read-only observation; private versioned ledger; workspace/session writer leases; legacy session-record compatibility; TaskRunner lifecycle integration; Codex repo-check behavior; redacted local observer/audit events; read-only `byok-agent workspaces`; security/operator documentation; unit, real-Git, resume, privacy, lifecycle, and Windows CI coverage.
- User-authorized adoption/closeout scope: refresh the canonical standard adoption; keep the root `CLAUDE.md`/`AGENTS.md` Required Checks aligned; maintain tracked scaffolding under `plans/archive/`, `plans/prds/`, and `plans/sprints/`; refresh `.ai/harness/` policy, workflow-contract, state, recovery, check, run, receipt, and related readiness artifacts; refresh CodeGraph index/readiness; update `tasks/current.md` and the existing review/notes files; and touch the root `package.json` only if needed for canonical required checks (existing scripts are expected to require no edit).
- Out of scope: existing-checkout attachment; repository discovery; clone/fetch/pull/push; worktrees; automatic `git add` or commit; Git identity changes; checkout/merge/rebase/stash/reset/clean; branch or workspace deletion; Git notes/hidden refs; server-side Git metadata; protocol/server changes; automatic continuation of interrupted protocol tasks; edits under `packages/protocol/**` or `packages/server/**`; lockfile changes; and publishing or other release side effects.
- Taste constraints: keep Git orchestration adapter-neutral and concentrated in the workspace manager; reuse secure storage and atomic-write primitives; expose only opaque IDs, booleans, counts, timestamps, and stable error categories outside the private ledger; preserve every existing TaskRunner ordering invariant.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if protocol or server changes become necessary.
- Stop if implementation requires automatic commit, identity mutation, network Git, history rewriting, destructive cleanup, or workspace deletion.
- Stop if private ledger/ownership state cannot be secured with existing POSIX and Windows primitives.
- Stop if the Git-enabled path cannot preserve pre-claim lease acquisition, post-start cancellation, synchronous active registration, and one terminal outcome.

## Falsifier

The direction is wrong if a daemon-owned task repository cannot be initialized, observed, interrupted, and reused through a valid `sessionRef` without weakening existing lifecycle ordering or introducing server/wire state. The cheapest proof point is a real-Git test with a stub adapter: initialize one task repository, create an ordinary agent-side commit, complete it, restart the daemon, and reuse the exact repository only through the persisted session plus matching ledger record while emitting no Git fields on the wire.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260724-0138-local-git-task-workspaces.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260724-0138-local-git-task-workspaces.review.md`
- Notes file: `tasks/notes/20260724-0138-local-git-task-workspaces.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Adoption/closeout authorization: the user explicitly authorized this scope expansion to close Repo Harness adoption readiness and ship gates; it does not fabricate test results, acceptance, or publishing/release evidence.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260724-0138-local-git-task-workspaces.md
  - plans/archive/
  - plans/prds/
  - plans/sprints/
  - tasks/current.md
  - tasks/contracts/20260724-0138-local-git-task-workspaces.contract.md
  - tasks/reviews/20260724-0138-local-git-task-workspaces.review.md
  - tasks/notes/20260724-0138-local-git-task-workspaces.notes.md
  - .ai/harness/
  - .ai/hooks/lib/workflow-state.sh
  - .claude/templates/prd.template.md
  - .codegraph/
  - CLAUDE.md
  - AGENTS.md
  - package.json
  - packages/client/src/daemon/
  - packages/client/src/bin/
  - packages/client/src/adapters/codex/codex-adapter.ts
  - packages/client/src/types.ts
  - packages/client/src/index.ts
  - packages/client/src/__tests__/
  - packages/client/package.json
  - .github/workflows/ci.yml
  - docs/security.md
  - docs/spec.md
  - examples/basic/README.md
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
    - packages/client/src/daemon/git-workspace.ts
    - packages/client/src/daemon/git-workspace-store.ts
    - packages/client/src/bin/commands/workspaces.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260724-0138-local-git-task-workspaces.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/git-workspace.test.ts
    - path: packages/client/src/__tests__/git-workspace-store.test.ts
    - path: packages/client/src/__tests__/git-workspace-task-runner.test.ts
    - path: packages/client/src/__tests__/bin-workspaces.test.ts
  commands_succeed:
    - pnpm --filter @byok/client typecheck
    - pnpm --filter @byok/client test
    - pnpm --filter @byok/client build
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: disabled mode is byte-for-byte legacy behavior; enabled mode initializes and reuses daemon-owned Git repositories, records optional agent commits, and exposes only local coarse status.
- Edge cases: unborn HEAD, dirty/uncommitted terminal state, corrupt/future ledger, missing Git, session mismatch, duplicate offers, concurrent session reuse, interruption, shutdown, Windows path/DACL behavior, and observation failure.
- Regression risks: TaskRunner claim/start/cancel/terminal ordering, session continuity, audit redaction, Codex argv, resource-limit teardown, and accidental wire/server changes.

## Rollback Point

- Commit / checkpoint: the implementation commit produced in the contract-owned worktree after all exit criteria pass.
- Revert strategy: remove `gitWorkspace` from operator configuration and restart for immediate operational rollback; preserve all task repositories and ledger records for manual salvage. Code rollback is additive and requires no wire/server migration.
