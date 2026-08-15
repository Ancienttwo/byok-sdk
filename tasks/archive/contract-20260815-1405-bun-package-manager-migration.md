> **Archived**: 2026-08-15 14:05
> **Related Plan**: plans/archive/plan-20260815-1301-bun-package-manager-migration.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260815-1405

# Task Contract: bun-package-manager-migration

> **Status**: Fulfilled
> **Plan**: plans/plan-20260815-1301-bun-package-manager-migration.md
> **Task Profile**: migration
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-15 13:22
> **Review File**: `tasks/reviews/20260815-1301-bun-package-manager-migration.review.md`
> **Notes File**: `tasks/notes/20260815-1301-bun-package-manager-migration.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The repository currently has two toolchain authorities: pnpm owns workspace
installation and orchestration while Bun is separately pinned for harness-only
CI steps. A partial cut would make local, CI, and release dependency graphs
disagree.

## Goal

Replace pnpm with Bun 1.3.14 as the sole package manager and workspace script
orchestrator; pin development and CI to Node 22.22.3 while setting the public
dispatch compatibility floor to >=22.22.0. Preserve Vitest semantics, npm
tarball contents, and sequential test execution.

## Scope

- In scope: root workspace/lockfile authority, exact Node development/CI pin,
  public Node floor, CI, release pack tooling, package lifecycle scripts, active
  operator docs/templates, structural tests, and removal of the unrecoverable
  stale root architecture queue card authorized during ship closeout.
- Out of scope: replacing Vitest with `bun:test`, changing unrelated dependency
  versions, changing npm package semantics, or rewriting history.
- Taste constraints: atomic authority cut; no pnpm fallback or dual lockfile.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction fails if Bun 1.3.14 cannot install one cross-platform lockfile or
`bun pm pack` cannot produce installable tarballs with resolved workspace
versions. Cheapest proof: `bun ci`, then pack and install one dependent package.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260815-1301-bun-package-manager-migration.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260815-1301-bun-package-manager-migration.review.md`
- Notes file: `tasks/notes/20260815-1301-bun-package-manager-migration.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"bun-node-contract-tests","kind":"deterministic_test","paths":["*"]},{"id":"release-and-sea-runtime-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - package.json
  - .node-version
  - bun.lock
  - .npmrc
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - .github/workflows/ci.yml
  - AGENTS.md
  - CLAUDE.md
  - README.md
  - docs/spec.md
  - docs/architecture/index.md
  - docs/architecture/requests/root.md
  - docs/architecture/sdk-architecture.md
  - docker-compose.test.yml
  - deploy/scripts/migrate
  - deploy/runbooks/postgres-rls.md
  - scripts/release/
  - packages/
  - examples/
  - templates/
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260815-1301-bun-package-manager-migration.contract.md
  - tasks/reviews/20260815-1301-bun-package-manager-migration.review.md
  - tasks/notes/20260815-1301-bun-package-manager-migration.notes.md
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
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
    - bun.lock
    - .node-version
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260815-1301-bun-package-manager-migration.notes.md
  tests_pass:
    - path: packages/cloud-dataplane/src/__tests__/constraints.test.ts
  commands_succeed:
    - bun ci
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:release-pack
    - npx --yes --package node@22.22.3 -c 'node --version && templates/packaging/sea/smoke-test.sh'
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: one Bun workspace/lockfile authority; Node runtime and
  public package behavior unchanged.
- Edge cases: Windows command discovery, native install scripts, sequential
  test pressure, and workspace protocol rewriting during pack.
- Regression risks: platform-specific optional dependencies or tarball manifest
  ordering may diverge and must fail frozen install/release smoke.

## Rollback Point

- Commit / checkpoint: pre-migration HEAD.
- Revert strategy: revert the migration change to restore pnpm manifests,
  lockfile, CI, release scripts, and docs together.
