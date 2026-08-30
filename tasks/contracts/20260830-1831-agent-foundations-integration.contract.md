# Task Contract: agent-foundations-integration

> **Status**: Active
> **Plan**: plans/plan-20260830-1831-agent-foundations-integration.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-30 18:31
> **Review File**: `tasks/reviews/20260830-1831-agent-foundations-integration.review.md`
> **Notes File**: `tasks/notes/20260830-1831-agent-foundations-integration.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Pi needs SDK-supplied web, MCP, subagent, todo, and cross-harness collaboration foundations. The first four exist on isolated branches; this slice integrates only gated work and adds a local TeamWorkspace whose tmux pane is presentation rather than a second message authority. Shipping the pane as terminal-text IPC would make delivery unauthenticated, non-durable, and impossible to audit.

## Goal

Produce a local next-minor candidate combining the approved Pi foundation stack with a durable local TeamWorkspace exposed through one SDK-owned MCP contract to Pi, Claude, and Codex, plus an explicit tmux communication pane that never uses `send-keys` or `capture-pane` for message transport.

## Scope

- In scope: merge the gated readonly-toolset and Pi-foundation branches; local durable TeamWorkspace definitions/messages/member receipts/leases and quotas; authenticated control methods; one reserved MCP helper; `byok-agent team` CLI; explicit absolute-path tmux preflight and read-only watcher; documentation and tests.
- Out of scope: TaskRunner/cloud task binding, protocol/server/cloud changes, runtime prompt injection, native harness launch/auth/sandbox ownership, cross-device rooms, publication/push/tag/deploy, and Windows tmux emulation.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Direction is wrong if a strict MCP client cannot complete initialize/initialized/tools/list, a message can be posted without a valid lease, an ack moves backward or beyond delivered sequence, restart loses an accepted message, or any tmux command contains a message body or invokes `send-keys`/`capture-pane`. Cheapest proof: targeted strict-MCP, restart, lease, receipt, and tmux argv tests before full verification.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260830-1831-agent-foundations-integration.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260830-1831-agent-foundations-integration.review.md`
- Notes file: `tasks/notes/20260830-1831-agent-foundations-integration.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"team-workspace-contract-tests","kind":"deterministic_test","paths":["*"]},{"id":"packed-tmux-runtime-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/architecture/sdk-architecture.md
  - docs/researches/
  - CHANGELOG.md
  - packages/client/package.json
  - packages/client/tsconfig.json
  - packages/client/tsconfig.build.json
  - packages/client/tsup.config.ts
  - packages/client/README.md
  - packages/client/src/
  - packages/client/scripts/
  - bun.lock
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260830-1831-agent-foundations-integration.contract.md
  - tasks/reviews/20260830-1831-agent-foundations-integration.review.md
  - tasks/notes/20260830-1831-agent-foundations-integration.notes.md
  - .ai/context/capabilities.json
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - .claude/templates/
  - src/
  - tests/
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
    - packages/client/src/daemon/team-workspace.ts
    - packages/client/src/bin/team-mcp-server.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260830-1831-agent-foundations-integration.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/team-workspace.test.ts
    - path: packages/client/src/__tests__/team-mcp-server.test.ts
    - path: packages/client/src/__tests__/team-tmux-view.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: frozen integration HEAD after independent gate.
- Revert strategy: revert the source-only integration commits and remove the local `team-workspaces/v1` tree only with explicit operator authorization; no cloud state changes exist.
