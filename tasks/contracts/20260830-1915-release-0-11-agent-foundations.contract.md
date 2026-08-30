# Task Contract: release-0-11-agent-foundations

> **Status**: Active
> **Plan**: plans/plan-20260830-1915-release-0-11-agent-foundations.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-30 19:16
> **Review File**: `tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md`
> **Notes File**: `tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The accepted Pi foundations and Agent-memory grant changes currently live on separate source lines, while the only 0.11.0 version train contains just the Agent-memory line. Publishing either line independently would create competing package/version authority and omit foundational runtime behavior from the next minor.

## Goal

Produce one unpublished, clean local 0.11.0 candidate that contains both accepted source lines, preserves the nine-package aligned version train and the independent `@byok-sdk/keys` version, and passes frozen install, package graph, root verification, and exact packed-artifact smoke.

## Scope

- In scope: local merge of `codex/agent-memory-mcp-grant`; conflict resolution across client source, changelog/spec, package manifests, and `bun.lock`; release graph and exact tarball verification; release evidence and workflow projections.
- Out of scope: main merge, push, npm publish, registry readback, tag, GitHub Release, deploy, production rollout, and downstream pinning.
- Taste constraints: one 0.11.0 authority; no duplicate changelog entries, compatibility aliases, workspace overlays, or hand-edited packed artifacts.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Direction is wrong if the merge drops either accepted behavior, any aligned public package differs from 0.11.0, `@byok-sdk/keys` changes from its independent line, frozen install rewrites the lockfile, package graph rejects an internal edge, or exact tarball install/smoke fails. Cheapest proof: inspect conflicts and run package-graph plus focused memory/team/Pi tests before the full pack.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260830-1915-release-0-11-agent-foundations.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md`
- Notes file: `tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"release-contract-tests","kind":"deterministic_test","paths":["*"]},{"id":"exact-packed-artifact-smoke","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - CHANGELOG.md
  - bun.lock
  - docs/spec.md
  - docs/architecture/sdk-architecture.md
  - packages/client/package.json
  - packages/client/README.md
  - packages/client/tsconfig.json
  - packages/client/tsconfig.build.json
  - packages/client/tsup.config.ts
  - packages/client/src/
  - packages/client/scripts/
  - packages/cloud-dataplane/package.json
  - packages/cloud/package.json
  - packages/core/package.json
  - packages/protocol/package.json
  - packages/sdk/package.json
  - packages/server/package.json
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260830-1223-agent-memory-mcp-grant.contract.md
  - tasks/reviews/20260830-1223-agent-memory-mcp-grant.review.md
  - tasks/notes/20260830-1223-agent-memory-mcp-grant.notes.md
  - tasks/contracts/20260830-1831-agent-foundations-integration.contract.md
  - tasks/reviews/20260830-1831-agent-foundations-integration.review.md
  - tasks/notes/20260830-1831-agent-foundations-integration.notes.md
  - tasks/contracts/20260830-1915-release-0-11-agent-foundations.contract.md
  - tasks/reviews/20260830-1915-release-0-11-agent-foundations.review.md
  - tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md
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
    - docs/spec.md
    - packages/client/src/daemon/team-workspace.ts
    - packages/client/src/bin/agent-memory-mcp-server.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260830-1915-release-0-11-agent-foundations.notes.md
    - .ai/harness/runs/20260830-release-0-11-agent-foundations/artifacts/release-manifest.json
  tests_pass:
    - path: packages/client/src/__tests__/pi-adapter.test.ts
    - path: packages/client/src/__tests__/team-workspace.test.ts
    - path: packages/client/src/__tests__/toolset-mcp-grant.test.ts
  commands_succeed:
    - bun install --frozen-lockfile
    - node scripts/release/check-package-graph.mjs
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

- Commit / checkpoint: isolated `codex/release-0-11-agent-foundations` branch before any external publication.
- Revert strategy: remove only this isolated worktree/branch after preserving evidence; no registry, tag, deploy, or production state is created.
