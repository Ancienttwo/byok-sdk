# Task Contract: device-toolset-discovery

> **Status**: Fulfilled
> **Plan**: plans/plan-20260813-2350-device-toolset-discovery.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-13 23:50
> **Review File**: `tasks/reviews/20260813-2350-device-toolset-discovery.review.md`
> **Notes File**: `tasks/notes/20260813-2350-device-toolset-discovery.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The published toolset-selection seam reports only whether a runtime can project
MCP toolsets. It does not report which logical toolset IDs the paired device
actually configured, so a hosted SaaS cannot distinguish a usable Salesko
device from one that will decline only after delivery. Discovery must expose
logical IDs without moving executable definitions or credentials into cloud.

## Goal

Derive one bounded, deterministic inventory from validated
DaemonConfig.mcpToolsets and project it through conn.hello for embedded
MachineInfo and dispatch preflight, and through authenticated presence for
hosted listPresence, while keeping device-local resolution as the final
fail-closed authority.

## Scope

- In scope: protocol schema and bounds, daemon projection, embedded MachineInfo
  and toolset-aware dispatch preflight, hosted presence projection,
  in-memory/Postgres persistence, forward-only SQL migration, public tests and
  documentation needed to prove the path.
- Out of scope: connector lifecycle/health/reload, remote executable
  definitions, tool-level policy/approval/audit, cloud authorization based on
  presence, browser or provider business logic.
- Taste constraints: one source of truth for ToolsetId validation and inventory
  bounds; omission means legacy/unknown while [] means known-none; no fallback
  inference from runtime capabilities.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If the existing hosted transport has a durable device capability store or
long-poll handshake that already carries device-local configuration, presence
would be the wrong authority. The cheapest proof was the traced real-cloud
Salesko E2E: hosted long-poll sends no conn.hello and listPresence is the only
live device projection. Local task resolution therefore remains authoritative
and the new presence field is explicitly discovery-only.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260813-2350-device-toolset-discovery.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260813-2350-device-toolset-discovery.review.md`
- Notes file: `tasks/notes/20260813-2350-device-toolset-discovery.notes.md`
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
  - docs/
  - deploy/sql/
  - tests/sql/
  - packages/protocol/
  - packages/core/
  - packages/conformance/
  - packages/client/
  - packages/cloud/
  - packages/cloud-dataplane/
  - packages/server/
  - packages/testkit/
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260813-2350-device-toolset-discovery.contract.md
  - tasks/reviews/20260813-2350-device-toolset-discovery.review.md
  - tasks/notes/20260813-2350-device-toolset-discovery.notes.md
  - .ai/harness/
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
    - deploy/sql/0006_device_presence_toolsets.sql
    - packages/client/src/__tests__/real-cloud-salesko-mcp-e2e.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260813-2350-device-toolset-discovery.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/mcp-toolsets.test.ts
  commands_succeed:
    - pnpm --filter @byok-sdk/client exec vitest run src/__tests__/presence-publisher.test.ts
    - pnpm --filter @byok-sdk/client exec vitest run src/__tests__/real-cloud-salesko-mcp-e2e.test.ts
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: hello and hosted presence expose only sorted logical IDs.
- Edge cases: invalid/duplicate/oversized inventory rejects; [] is distinct from omission.
- Regression risks: additive optional protocol field, Postgres forward migration,
  and discovery staleness; local toolset resolution remains the execution gate.

## Rollback Point

- Commit / checkpoint: origin/main at a119b5cf4247278a456c285cbc6470d8e3b9815c.
- Revert strategy: revert the feature commit and leave the forward-only nullable
  Postgres column unused.
