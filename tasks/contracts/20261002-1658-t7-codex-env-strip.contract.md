# Task Contract: t7-codex-env-strip

> **Status**: Fulfilled
> **Plan**: plans/plan-20261002-1658-t7-codex-env-strip.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: chris
> **Capability ID**: root
> **Last Updated**: 2026-10-02 16:58
> **Review File**: `tasks/reviews/20261002-1658-t7-codex-env-strip.review.md`
> **Notes File**: `tasks/notes/20261002-1658-t7-codex-env-strip.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Codex operator credential overrides currently contradict the documented subscription exclusion and can reach the final runtime child.

## Goal

Top-level Codex strips the shared bounded credential inventory even under operator allow, preserves allowed config, and uses the same measurement projection. Deliver local commit and requested T7 report.

## Scope

- In scope: Codex final env, shared bounded credential names, corresponding measurement projection, regression tests and docs.
- Out of scope: sixth-edge, vendor changes, auth-store inspection, deployment, push, PR, merge or deleting branches/worktrees.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If deleting env credentials removes required CLI-managed login discovery, or measurement differs from the real child after the fix, stop as BLOCKED. HOME/USER and allowed CODEX_HOME must remain.

## Root Cause Evidence

- root_cause: CodexAdapter.start copies input.env without subscription exclusion after TaskRunner.buildRuntimeEnv admits explicitly allowed credentials.
- repro: bun run --cwd packages/client test src/__tests__/task-runner-environment.test.ts
- regression_guard: packages/client/src/__tests__/task-runner-environment.test.ts
- pre_fix_failure_artifact: tasks/notes/20261002-1658-t7-codex-env-strip.pre-fix.log

## Workflow Inventory

- Source plan: `plans/plan-20261002-1658-t7-codex-env-strip.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20261002-1658-t7-codex-env-strip.review.md`
- Notes file: `tasks/notes/20261002-1658-t7-codex-env-strip.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol": 1, "oracles": [{"id": "fixture-and-policy-tests", "kind": "deterministic_test", "paths": ["*"]}, {"id": "codex-child-env-receipt", "kind": "runtime_readback", "paths": ["packages/client/src/adapters/codex/codex-adapter.ts", "packages/client/src/__tests__/fixtures/fake-codex.mjs", "packages/client/src/__tests__/task-runner-environment.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/adapters/codex/codex-adapter.ts
  - packages/client/src/adapters/provider-credential-environment.ts
  - packages/client/src/__tests__/task-runner-environment.test.ts
  - packages/client/src/__tests__/implementation-identity-extraction.test.ts
  - packages/client/src/__tests__/fixtures/fake-codex.mjs
  - packages/implementation-identity/src/environment.ts
  - packages/implementation-identity/src/identity.ts
  - packages/implementation-identity/src/__tests__/measurement-vectors.test.ts
  - packages/implementation-identity/src/__tests__/sdk-memory-identity.test.ts
  - api-surface/implementation-identity.d.ts
  - docs/security.md
  - docs/spec.md
  - plans/plan-20261002-1658-t7-codex-env-strip.md
  - tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md
  - tasks/reviews/20261002-1658-t7-codex-env-strip.review.md
  - tasks/notes/20261002-1658-t7-codex-env-strip.notes.md
  - tasks/notes/20261002-1658-t7-codex-env-strip.pre-fix.log
  - tasks/todos.md
  - .codegraph/
  - docs/architecture/
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
    - packages/client/src/__tests__/task-runner-environment.test.ts
  artifacts_exist:
    - tasks/notes/20261002-1658-t7-codex-env-strip.pre-fix.log
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "build",
      "kind": "command",
      "command": "bun run build",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "T7 approved spec and repository required verification",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "codex-env-regression",
      "kind": "package_test",
      "path": "packages/client/src/__tests__/task-runner-environment.test.ts",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "T7 approved spec and repository required verification",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "typecheck",
      "kind": "command",
      "command": "bun run typecheck",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "T7 approved spec and repository required verification",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "all-tests",
      "kind": "command",
      "command": "bun run test",
      "cwd": ".",
      "phase": "verification",
      "cost": "expensive",
      "evidence_policy": "current_exact",
      "necessity": "T7 approved spec and repository required verification",
      "inputs": {
        "env": [
          "BYOK_TEST_BUN_BIN",
          "BYOK_REQUIRE_BUN"
        ]
      }
    },
    {
      "id": "api-surface",
      "kind": "command",
      "command": "bun run check:api-surface",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "T7 approved spec and repository required verification",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "version-authority",
      "kind": "command",
      "command": "bun run check:version-authority",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "T7 approved spec and repository required verification",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "architecture-sync",
      "kind": "command",
      "command": "repo-harness run check-architecture-sync",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "T7 approved spec and repository required verification",
      "inputs": {
        "env": []
      }
    },
    {
      "id": "capability-validation",
      "kind": "command",
      "command": "repo-harness run capability-resolver validate --format text",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "T7 approved spec and repository required verification",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes (Human Review)

- Runtime fixture covers final child env for both runtime and subscription selections; shared tests pin policy and measurement. Full suite is explicitly required by owner and covers both touched packages; expected several minutes. Formal full-test environment explicitly supplies the existing BYOK_TEST_BUN_BIN and BYOK_REQUIRE_BUN=1 so Bun-dependent tests execute.
- Native Codex login and Windows smoke remain unverified; tests do not access auth stores or secrets.
- Root workflow strict check runs separately to avoid verification recursion.

## Rollback Point

- Commit / checkpoint: base f2098ecb; single local T7 commit recorded in requested report.
- Revert strategy: revert reviewed T7 diff; no external mutations.

## PM Harness Closeout Authorization

PM authorized at 17:40 to reverify and remove only the stale PID1271 expensive-run lock, obtain CodeGraph proof and execute the formal expensive run. CodeGraph indexing and provider-owned architecture projections are in scope. Runtime assertions, timeouts and skips remain unchanged. Local commits only; no push.
