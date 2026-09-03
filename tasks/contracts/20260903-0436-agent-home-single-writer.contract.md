# Task Contract: agent-home-single-writer

> **Status**: Active
> **Plan**: plans/plan-20260903-0436-agent-home-single-writer.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-03 04:45
> **Review File**: `tasks/reviews/20260903-0436-agent-home-single-writer.review.md`
> **Notes File**: `tasks/notes/20260903-0436-agent-home-single-writer.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Since 0.12.0 the client serialises execution by `(agentId, sessionRef)` and lets different sessions of one Agent run concurrently in the same canonical Agent home, which is also every session's cwd (`packages/client/src/agent-home.ts:600-632`); no concurrency cap exists in the daemon. Two runtimes can write `MEMORY.md`, `notes/`, `.git/index` or build output at the same time. `README.md:72` and `docs/host-local-storage-layout.md:64` still promise one mutable writer per home, and the only downstream (Salesko, pinned 0.11.0) enqueues chat and research offers for the same `agentId` concurrently while relying on the SDK to decline a busy home. This is the one live runtime-correctness defect in the 2026-09-03 architecture review (V2) and blocks nothing else from being safe.

## Goal

Land, on one branch, a daemon-local admission gate that allows at most `maxConcurrentMutableSessionsPerAgentHome` (default 1) active Attempts per canonical Agent home across every lane, declining retryably before `prepare()`, claim, workspace or process side effects; releasing the slot only after terminal plus quiescent `Session.close()`; readable as a count in daemon/control status; with spec, CHANGELOG and the `client` API golden updated deliberately; and tests for every release path.

## Scope

- In scope:
  - `packages/client/src/agent-home.ts`: per-home active Attempt registry in the lease manager (`activeAttemptCount(home)`), bound to the existing lease lifecycle; release on quiescent disposal only; crash residue reclaimed by the same stable owner identity as today.
  - `packages/client/src/daemon/task-runner.ts`: the gate placed after the existing receive/dedup/pre-cancel/`strictAgentOnly` precedence (`:1560-1573`) and before admission; retryable `task.decline` with reason `agent home busy: <n> active attempt(s)` (no paths, no prompt text); slot release wired to terminal-after-close; a duplicate or pre-cancelled offer never consumes a slot.
  - `packages/client/src/daemon/create-daemon.ts` and `packages/client/src/types.ts`: `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome?: number` validated up front as a positive safe integer (default 1); count projected into `Daemon.status()` and the authenticated local control status.
  - `packages/client/src/__tests__/agent-home-single-writer.test.ts`: same home, second session on a different lane → declined before `prepare()` is called; different homes run in parallel; slot released after terminal + successful close; disposal failure keeps the slot; cancel releases after close; crash residue reclaimed on restart; limit 2 admits two and declines the third; duplicate/pre-cancelled offers do not consume a slot.
  - `docs/spec.md` §Durable Agent homes (`:551-556`): execution serialised per canonical home by default; raising the limit is an explicit host choice with the co-writing caveat.
  - `CHANGELOG.md`: an `## Unreleased` entry "Breaking (Agent home execution): default returns to one active Attempt per canonical Agent home; 0.12.0-style concurrent sessions require explicit `maxConcurrentMutableSessionsPerAgentHome > 1`".
  - `api-surface/client.d.ts`: regenerated deliberately with `bun run check:api-surface -- --update` after rebasing onto main that contains WP1 (if `api-surface/` is absent in this worktree, skip and note it; the orchestrator regenerates at rebase time).
- Out of scope:
  - protocol, cloud, cloud-dataplane, server, keys; any wire or store change; lane-based caps; the AgentHome/Workspace split (WP3A); push, PR, publish, release.
- Taste constraints: fail closed (a failed disposal keeps the slot); no silent fallback to 0.12.0 behaviour; no new abstraction beyond one counter and one config field; decline reason carries counts only.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the gate cannot be placed before `prepare()` without reordering the existing precedence at `task-runner.ts:1560-1573`.

## Falsifier

If the lease manager already prevents a second session from obtaining a lease for the same canonical home in the same process (i.e. the review's reading of `agent-home.ts:600-632` is wrong), this slice is unnecessary; prove first with a red test that two sessions of one Agent both obtain leases and both receive the same cwd on unchanged main. If that test is green (no co-writing possible), stop and report.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260903-0436-agent-home-single-writer.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260903-0436-agent-home-single-writer.review.md`
- Notes file: `tasks/notes/20260903-0436-agent-home-single-writer.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"agent-home-single-writer-regression","kind":"deterministic_test","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260903-0436-agent-home-single-writer.contract.md
  - tasks/reviews/20260903-0436-agent-home-single-writer.review.md
  - tasks/notes/20260903-0436-agent-home-single-writer.notes.md
  - packages/client/src/agent-home.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/daemon/control-protocol.ts
  - packages/client/src/types.ts
  - packages/client/src/index.ts
  - packages/client/src/__tests__/agent-home-single-writer.test.ts
  - packages/client/src/__tests__/agent-home-contract.test.ts
  - docs/spec.md
  - CHANGELOG.md
  - api-surface/client.d.ts
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
    - packages/client/src/__tests__/agent-home-single-writer.test.ts
    - packages/client/src/__tests__/agent-home-contract.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260903-0436-agent-home-single-writer.notes.md
  tests_pass: []
  commands_succeed:
    - bun run --cwd packages/client test -- src/__tests__/agent-home-single-writer.test.ts
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: with the default, a second Agent offer for the same canonical home is declined retryably before any side effect regardless of lane; after the first attempt's terminal and successful close the next offer is admitted; two different homes run concurrently.
- Edge cases: disposal failure keeps the home busy (visible in status); cancel releases only after close; daemon restart reclaims residue via the existing owner identity; duplicate/pre-cancelled offers never consume a slot; `limit = 2` admits two.
- Regression risks: admission ordering at `task-runner.ts:1560-1573` must stay intact (test asserts a duplicate offer is deduped before the busy gate).

## Rollback Point

- Commit / checkpoint: branch base = current `main` at worktree start.
- Revert strategy: revert the single commit; no state outside the repo changes.
