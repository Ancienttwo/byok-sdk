> **Archived**: 2026-08-10 15:36
> **Related Plan**: plans/archive/plan-20260810-1514-adr-025-device-agent-identity.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260810-1536

# Task Contract: adr-025-device-agent-identity

> **Status**: Fulfilled
> **Plan**: plans/plan-20260810-1514-adr-025-device-agent-identity.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-10 15:16
> **Review File**: `tasks/reviews/20260810-1514-adr-025-device-agent-identity.review.md`
> **Notes File**: `tasks/notes/20260810-1514-adr-025-device-agent-identity.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

BYOK already identifies and routes work to many paired Devices, but it has no
persistent Agent resource or Agent-to-Device placement authority. The RAFT
Computer 1.0.15 client demonstrates that those are separate layers. Without a
frozen boundary, a future fleet slice could incorrectly reuse runtime or task
identity, creating split-brain lifecycle and hidden scheduling authority.

## Goal

Accept ADR-025 as a docs-only authority decision: distinguish Device, Agent,
AgentPlacement/AgentObservation, Task, and RuntimeSession; state that current
BYOK remains multi-device + multi-runtime + task-session rather than a
first-class multi-Agent fleet; preserve protocol v1 and authorize no code.

## Scope

- In scope: one ADR, one canonical architecture subsection/ledger row, and one
  research index entry plus workflow evidence.
- Out of scope: schemas, stores, routes, protocol envelopes, daemon supervisor,
  scheduling, migration, AiphaBee product code, publication, merge, or release.
- Taste constraints: describe current and target states separately; one
  placement authority; generation/lease fencing; no first-connected fallback,
  compatibility shim, or RAFT multi-control-plane fan-out.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is wrong if current source already exposes a stable Agent record
with lifecycle/placement authority, or if the proposed wording claims such a
feature exists. Cheapest proof: trace dispatch from device selection through
TaskStore/task.offer/runtime session and inspect the final docs diff for any
production or protocol path.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260810-1514-adr-025-device-agent-identity.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260810-1514-adr-025-device-agent-identity.review.md`
- Notes file: `tasks/notes/20260810-1514-adr-025-device-agent-identity.notes.md`
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
  - docs/researches/agent-identity-placement-decision.md
  - docs/architecture/sdk-architecture.md
  - docs/researches/README.md
  - plans/plan-20260810-1514-adr-025-device-agent-identity.md
  - tasks/current.md
  - tasks/todos.md
  - tasks/contracts/20260810-1514-adr-025-device-agent-identity.contract.md
  - tasks/reviews/20260810-1514-adr-025-device-agent-identity.review.md
  - tasks/notes/20260810-1514-adr-025-device-agent-identity.notes.md
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
    - docs/researches/agent-identity-placement-decision.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260810-1514-adr-025-device-agent-identity.notes.md
  commands_succeed:
    - rg -n "ADR-025|AgentPlacement|RuntimeSession" docs/researches/agent-identity-placement-decision.md docs/architecture/sdk-architecture.md docs/researches/README.md
    - git diff --check -- docs/researches/agent-identity-placement-decision.md docs/architecture/sdk-architecture.md docs/researches/README.md
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: documentation only; current Local Agent CLI runtime path is unchanged.
- Edge cases: stale placement, unavailable Device, multi-control-plane attachment, Agent migration.
- Regression risks: wording may be mistaken for an implemented fleet promise.

## Rollback Point

- Commit / checkpoint: `origin/main@9d02167` before projection.
- Revert strategy: revert the bounded docs/workflow commit; no runtime state changes.
