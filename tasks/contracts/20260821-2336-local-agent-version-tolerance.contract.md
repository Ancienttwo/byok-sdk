# Task Contract: local-agent-version-tolerance

> **Status**: Active
> **Plan**: plans/plan-20260821-2336-local-agent-version-tolerance.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-21 23:36
> **Review File**: `tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md`
> **Notes File**: `tasks/notes/20260821-2336-local-agent-version-tolerance.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The Local Agent already reports its release through WS and hosted presence, and
the product contract already says Latest is not a runtime gate. The self-hosted
server currently drops `conn.hello.clientVersion` before its public
`machines.list()` read model, leaving operators unable to observe the same
release fact on the reference server and leaving the old-release behavior
without an end-to-end self-hosted proof.

## Goal

Retain the existing optional WS `clientVersion` in live server connection state,
expose it through `MachineInfo`, and prove a daemon reporting an older release
still connects and completes work when protocol and capability contracts match.

## Scope

- In scope: the additive self-hosted `MachineInfo.clientVersion` projection,
  WS-to-hub forwarding, fake-daemon fixtures, focused compatibility tests, and
  the matching product-contract sentence.
- Out of scope: protocol/schema/version bumps, Latest fetch, minimum-version
  policy, updater behavior, SemVer capability inference, publication, merge,
  deployment, and concurrent connector work.
- Taste constraints: one exact release fact; missing stays unknown; no fallback,
  inference, or release-based behavior gate.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If a fake daemon with `clientVersion: 0.5.0` cannot receive `conn.ack`, complete a
normal task, and read back exactly `0.5.0` without any protocol change, this
projection is not sufficient. The focused server integration test is the
cheapest proof.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260821-2336-local-agent-version-tolerance.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md`
- Notes file: `tasks/notes/20260821-2336-local-agent-version-tolerance.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260821-2336-local-agent-version-tolerance.contract.md
  - tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md
  - tasks/notes/20260821-2336-local-agent-version-tolerance.notes.md
  - packages/server/src/types.ts
  - packages/server/src/hub.ts
  - packages/server/src/ws-server.ts
  - packages/server/src/__tests__/test-support.ts
  - packages/server/src/__tests__/integration.test.ts
  - docs/architecture/requests/
  - .ai/harness/runs/
  - .ai/harness/checks/
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
    - tasks/notes/20260821-2336-local-agent-version-tolerance.notes.md
  tests_pass:
    - path: packages/server/src/__tests__/integration.test.ts
  commands_succeed:
    - bun run --cwd packages/server typecheck
    - bun run --cwd packages/server build
    - bun run typecheck
    - repo-harness run check-architecture-sync
    - repo-harness run check-task-sync
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: older release identity is observable and never compared
  for connection or dispatch eligibility.
- Edge cases: missing identity remains absent; unsupported protocol remains a
  separate 1002 rejection.
- Regression risks: positional `registerConnection` callers must retain their
  existing argument meaning; tests cover both explicit and omitted identity.

## Rollback Point

- Commit / checkpoint: `origin/main@bb3c1a1b364d03a688fd765b6070d91ca4823e7a`
- Revert strategy: revert the additive `MachineInfo` field, hub forwarding,
  fixtures, tests, and spec sentence together.
