# Task Contract: connector-readonly-operability

> **Status**: Fulfilled
> **Plan**: plans/plan-20260821-2325-connector-readonly-operability.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-22 00:22
> **Review File**: `tasks/reviews/20260821-2325-connector-readonly-operability.review.md`
> **Notes File**: `tasks/notes/20260821-2325-connector-readonly-operability.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`DaemonConfig.mcpToolsets` is currently a construction-time snapshot. A host
cannot apply a local config change without restarting the daemon, and live
status cannot distinguish registry configuration from connector lifecycle
evidence. If reload is added without one atomic authority, TaskRunner, presence,
and `conn.hello` can drift. If lifecycle is inferred from config, operators see
false readiness. The direction is therefore one content-addressed local registry
plus explicit host observations; SaaS never receives or supplies executable
definitions.

## Goal

Deliver a device-local MCP toolset registry that supports validated,
expected-revision compare-and-swap reload over the authenticated control socket,
uses one current snapshot for future offer admission and discovery projection,
preserves already-admitted task projections, and exposes bounded/redacted live
status. Concrete lifecycle states are accepted only as explicit host evidence;
otherwise status is `unobserved`.

## Scope

- In scope: registry validation/canonical revision/atomic replacement; explicit
  host lifecycle observation API; TaskRunner snapshot reads; current logical-id
  reads for presence and reconnect hello; authenticated `toolsets.reload`; CLI
  reload/status rendering; focused tests and durable documentation.
- Out of scope: daemon-owned connector supervision; remote install or executable
  definitions; enable/disable; MCP tool-level mutation policy; protocol schema
  changes; publish/deploy/production mutation; the user-owned dirty
  `docs/architecture/index.md` and `docs/architecture/requests/root.md`.
- Taste constraints: one registry authority, no dual read or compatibility
  shim; absent lifecycle evidence remains `unobserved`; receipts and status may
  expose ids/counts/revisions/state/version/timestamps/reason codes only, never
  command/args/env/header/credential bytes.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the change requires a wire-protocol schema revision or remote
  executable definition.
- Stop if concrete lifecycle state cannot remain explicit host evidence.
- Stop after three fail/fix/reverify rounds for the same issue.

## Falsifier

Falsifier: truthful `ready | degraded | crashed` requires daemon-owned long-lived
process supervision. If observed, stop at explicit `unobserved` and defer
supervision to a separate architecture package. Cheapest proof: a two-offer
test shows the first offer keeps the old sealed MCP projection, the second uses
the post-reload snapshot, and invalid/stale reload preserves the prior revision.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260821-2325-connector-readonly-operability.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260821-2325-connector-readonly-operability.review.md`
- Notes file: `tasks/notes/20260821-2325-connector-readonly-operability.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"connector-toolset-required-checks","kind":"deterministic_test","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/researches/
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260821-2325-connector-readonly-operability.contract.md
  - tasks/reviews/20260821-2325-connector-readonly-operability.review.md
  - tasks/notes/20260821-2325-connector-readonly-operability.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - packages/client/src/types.ts
  - packages/client/src/index.ts
  - packages/client/src/daemon/toolset-registry.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/presence-publisher.ts
  - packages/client/src/daemon/connection-manager.ts
  - packages/client/src/daemon/ws-transport.ts
  - packages/client/src/daemon/control-protocol.ts
  - packages/client/src/bin/byok-agent.ts
  - packages/client/src/bin/format.ts
  - packages/client/src/bin/commands/status.ts
  - packages/client/src/bin/commands/toolsets.ts
  - packages/client/src/__tests__/mcp-toolsets.test.ts
  - packages/client/src/__tests__/daemon-control-socket.test.ts
  - packages/client/src/__tests__/presence-publisher.test.ts
  - packages/client/src/__tests__/bin-commands.test.ts
  - packages/client/src/__tests__/bin-format.test.ts
  - packages/client/src/__tests__/bin-start-command.test.ts
  - packages/client/src/__tests__/daemon-conn-hello-capabilities.test.ts
  - packages/client/src/__tests__/salesko-mcp-e2e.test.ts
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
    - packages/client/src/daemon/toolset-registry.ts
    - packages/client/src/bin/commands/toolsets.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260821-2325-connector-readonly-operability.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/mcp-toolsets.test.ts
    - path: packages/client/src/__tests__/daemon-control-socket.test.ts
    - path: packages/client/src/__tests__/presence-publisher.test.ts
    - path: packages/client/src/__tests__/bin-commands.test.ts
    - path: packages/client/src/__tests__/bin-format.test.ts
    - path: packages/client/src/__tests__/daemon-conn-hello-capabilities.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: reload is atomic/CAS/idempotent; future offers and
  discovery read the current snapshot; current tasks retain their sealed input.
- Edge cases: empty registry, invalid config, stale revision, definition change
  clearing observation, same definition retaining observation, restart-stable
  revision, daemon unavailable.
- Regression risks: stale discovery projection, command/args leakage in local
  status, changing already-admitted task inputs, fabricated readiness.

## Rollback Point

- Commit / checkpoint: pre-implementation `main@bb3c1a1b364d03a688fd765b6070d91ca4823e7a`.
- Revert strategy: remove the new local reload/status surface and registry
  indirection, restoring the existing startup-only snapshot. No migration or
  remote state rollback is involved.
