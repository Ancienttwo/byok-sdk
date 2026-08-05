# Task Contract: byok-keys-package

> **Status**: Fulfilled
> **Plan**: plans/plan-20260805-1659-byok-keys-package.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-05 18:40
> **Review File**: `tasks/reviews/20260805-1659-byok-keys-package.review.md`
> **Notes File**: `tasks/notes/20260805-1659-byok-keys-package.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`@byok/keys` makes the already-shipped key-based BYOK implementation (API key in the OS credential store, direct provider calls) consumable as an npm package, and resolves the BYOK name collision between this repo's bring-your-own-agent SDK and aip-main-open's bring-your-own-key product. If the port is wrong, aip-main-open cannot swap at K4 without a behavior change — its golden test `apps/local-agent/src/settings.test.ts:313-318` asserts exact provider-facing wire bytes. If the security boundary is wrong, the M5 pilot audit claim that agent dispatch never touches credentials is polluted.

## Goal

Deliver `packages/keys` as a new `@byok/keys` workspace package, ported layer by layer from `aip-main-open@c6a5385` per `docs/researches/HANDOFF-byok-keys.md`. K3-K4 refresh this contract before their own dispatch.

This contract covers milestone **K2 — the Registry layer**, projected from the plan's `## Task Breakdown` K2 entry (`plans/plan-20260805-1659-byok-keys-package.md:132`), which is the authority for what "done" means here:

> K2 Registry layer: configure/resolve lifecycle plus pluggable profile persistence (InMemory + SQLite, following the server package's `InMemoryTaskStore`/`SqliteTaskStore` pattern); port the in-package version of the §4.3 golden test

Three acceptance targets follow from that entry:

1. **Configure/resolve lifecycle.** A registry that owns the write path (`configure()` persists the non-secret profile and puts the API key in the injected `SecretStore`) and the read path (`resolveDefaultModelProvider()` reads profile plus secret and builds a transport client), ported from `providers.ts:1212` and `providers.ts:1331-1348` (plan Detailed Design, "Data Flow").
2. **Pluggable profile persistence.** A profile-store contract with two implementations — in-memory and SQLite — following `@byok/server`'s `TaskStore` / `InMemoryTaskStore` / `SqliteTaskStore` shape as a *pattern only*: `keys` must not gain a dependency on `server` (see Security Boundary in the plan). The SQLite schema and its `0o600` file mode come from `providers.ts:109-140,158`.
3. **The §4.3 golden test, in-package.** `docs/researches/HANDOFF-byok-keys.md` §4.3 names three parity assertions that must hold at the registry boundary rather than through aip's HTTP settings page: the provider actually receives `Authorization: Bearer <canary>` at `https://api.openai.com/v1/chat/completions`, the SQLite file does not contain the plaintext key, and the registry's status output does not contain the plaintext key.

One constraint binds the milestone: the secret never enters the profile store or any status projection — it lives only in the `SecretStore`, which is the property target 3 exists to prove.

## Scope

- In scope: `packages/keys/**` creation, its workspace registration (including the `pnpm-lock.yaml` entry `pnpm install` produces), the source handoff `docs/researches/HANDOFF-byok-keys.md` that this port's `file:line` references depend on, and the plan/contract/notes/review workflow artifacts.
- Out of scope: `packages/client/**`, `packages/server/**`, `packages/protocol/**` (must not gain a dependency on `keys`); `~/Projects/aip-main-open` (untouched until K4); AiphaBee narrative-domain symbols listed in `docs/researches/HANDOFF-byok-keys.md` §4.5; legacy secret migration.
- Out of scope for K2 specifically: the settings-page HTTP server that the source's §4.3 golden test drives (explicitly K3); the source's `#migrateLegacyModelSecret` legacy-secret migration (already out of scope above); the `market_data` / `mcp_http` profile branch, which stays in aip per §4.5.
- Correction to the K1 revision of this contract: that revision recorded the platform-selecting default secret-store factory (with its release-channel prefix selection) and the scope data-directory manifest as belonging to K2. The plan's K2 entry names neither, and the plan is the authority, so both stay **unscheduled** rather than being absorbed here. Neither blocks K2: the registry takes its `SecretStore` by constructor injection exactly as the source's registry does (`providers.ts:1168-1178`), so no platform factory is needed to build or verify the lifecycle. Both are recorded in `tasks/todos.md` so they are not lost.
- Taste constraints: follow the existing package layout in this repo (tsup, vitest, zod schema style from `protocol`); `keys` builds with `platform: 'node'`, not `protocol`'s `'neutral'`.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

What observable evidence would prove this task's direction wrong, and the cheapest proof point to check first. Leave as-is if not applicable.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260805-1659-byok-keys-package.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260805-1659-byok-keys-package.review.md`
- Notes file: `tasks/notes/20260805-1659-byok-keys-package.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Verification commands (the milestone gate, per the plan's Verification Boundary):
  - `pnpm -r run typecheck`
  - `pnpm -r run test`
  - `pnpm -r run build`
  - `repo-harness run check-task-workflow --strict`
- Contract verification command: `repo-harness run verify-contract --contract tasks/contracts/20260805-1659-byok-keys-package.contract.md --strict` (mirrors `plans/plan-20260805-1659-byok-keys-package.md:92`). Recorded here rather than under `exit_criteria.commands_succeed`: `verify-contract` executes every `commands_succeed` entry through `bash -c` (`scripts/verify-contract.sh:964-977`) and `is_evidence_producer_command` (`:512-522`) does not exclude it, so listing it inside its own contract would make the run invoke itself until the bounded verification budget is exhausted.
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

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
  - tasks/contracts/20260805-1659-byok-keys-package.contract.md
  - tasks/reviews/20260805-1659-byok-keys-package.review.md
  - tasks/notes/20260805-1659-byok-keys-package.notes.md
  - .ai/context/capabilities.json
  - docs/researches/
  - .claude/templates/
  - packages/keys/
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
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
    # K2 acceptance target 1: configure/resolve lifecycle
    - packages/keys/src/registry.ts
    # K2 acceptance target 2: pluggable profile persistence, both implementations
    - packages/keys/src/profile-store.ts
    - packages/keys/src/sqlite-support.ts
    - packages/keys/src/sqlite-profile-store.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260805-1659-byok-keys-package.notes.md
  tests_pass:
    # Target 1. Only the SQLite-free suites are listed here. One root cause,
    # two faces: `node:sqlite` is absent both from Bun ("No such built-in
    # module", bun 1.3.14) and from Node below 22.5 — and verify-contract runs
    # each tests_pass entry as `bun test <path>`
    # (scripts/verify-contract.sh:940) while CI runs the matrix on Node 20 and
    # 22. The three suites that open a database therefore cannot run on either,
    # for a runtime reason rather than a code one.
    # The code-level response is `isSqliteAvailable()` in
    # packages/keys/src/sqlite-support.ts (the predicate @byok/server already
    # uses): those suites gate on it and skip rather than fail, so the CI Node
    # 20 leg is green — verified locally on Node 20.17.0, 301 passed |
    # 27 skipped. The contract gate keeps them off tests_pass because the bun
    # runner is a separate matter; they are not dropped, since `pnpm -r run
    # test` under commands_succeed runs the whole package on Node 22.22 through
    # vitest — this repo's actual test runner — and covers all four suites.
    - path: packages/keys/src/registry.test.ts
    # Covered via commands_succeed (`pnpm -r run test`), not here:
    #   packages/keys/src/profile-store.test.ts        (target 2, both stores)
    #   packages/keys/src/sqlite-profile-store.test.ts (target 2, on disk)
    #   packages/keys/src/registry.golden.test.ts      (target 3, §4.3 parity)
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint:
- Revert strategy:
