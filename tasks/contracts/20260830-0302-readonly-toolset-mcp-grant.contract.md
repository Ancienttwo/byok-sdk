# Task Contract: readonly-toolset-mcp-grant

> **Status**: Active
> **Plan**: plans/plan-20260830-0302-readonly-toolset-mcp-grant.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-30 03:03
> **Review File**: `tasks/reviews/20260830-0302-readonly-toolset-mcp-grant.review.md`
> **Notes File**: `tasks/notes/20260830-0302-readonly-toolset-mcp-grant.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

A projected `requiredToolsets` MCP server is listable but never callable under `policy.mode='readonly'` on Claude and Codex (downstream Gate 0 falsifier, salesko plan `plan-20260830-0134-private-agent-salesko-read-tools`, `@byok-sdk/client` 0.10.1). Toolset projection is core SDK capability; hosts have no legal workaround (`computeEffectivePolicy` intersects `allowTools` with the ceiling). If shipped wrong — e.g. by widening `allowTools` or `approval_policy` — readonly stops meaning readonly.

## Goal

Under `readonly` + `allowTools: []`, the tools of exactly the projected toolset MCP servers are callable on Claude (`--allowedTools mcp__<server>__<tool>` alongside the unchanged `--tools`) and Codex (`mcp_servers.<name>.enabled_tools` + `tools.<tool>.approval_mode="approve"`, generalized from `9110878`), with built-in shell/file/write tools still disabled, nothing granted without a toolset, no tool granted that the toolset registry did not observe via `tools/list`, and Codex < 0.149 rejected before spawn. Then the downstream falsifier passes 9/9 against the locally built client.

## Scope

- In scope: `packages/client/src/adapters/{claude,codex}/**`, `packages/client/src/daemon/task-runner.ts`, `packages/client/src/daemon/toolset-registry.ts`, `packages/client/src/types.ts` (start-input shape), `packages/client/src/__tests__/**`, `packages/client/README.md`, `CHANGELOG.md`.
- Out of scope: protocol/store changes, Pi adapter, any change to reserved-server behaviour beyond reusing its mechanism, release/version bump, merging `codex/packed-host-sdk-helper`.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Direction is wrong if Claude 2.1.251 still auto-denies an MCP tool listed in `--allowedTools` while `--tools ""` is present, or if Codex 0.149 ignores `tools.<tool>.approval_mode="approve"` for a non-reserved server. Cheapest proof point: run the installed CLIs directly with those argv against `apps/local-agent/scripts/gate0-probe-mcp-server.mjs` from the salesko worktree before touching adapter code (the Claude form was already verified manually there).

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260830-0302-readonly-toolset-mcp-grant.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260830-0302-readonly-toolset-mcp-grant.review.md`
- Notes file: `tasks/notes/20260830-0302-readonly-toolset-mcp-grant.notes.md`
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
  - plans/
  - tasks/todos.md
  - packages/client/src/
  - packages/client/README.md
  - CHANGELOG.md
  - tasks/contracts/20260830-0302-readonly-toolset-mcp-grant.contract.md
  - tasks/reviews/20260830-0302-readonly-toolset-mcp-grant.review.md
  - tasks/notes/20260830-0302-readonly-toolset-mcp-grant.notes.md
  - .ai/context/capabilities.json
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
    - plans/plan-20260830-0302-readonly-toolset-mcp-grant.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260830-0302-readonly-toolset-mcp-grant.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/claude-permission-mapping.test.ts
    - path: packages/client/src/__tests__/codex-permission-mapping.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
