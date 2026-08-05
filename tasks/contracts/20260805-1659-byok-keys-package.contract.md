# Task Contract: byok-keys-package

> **Status**: Fulfilled
> **Plan**: plans/plan-20260805-1659-byok-keys-package.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-05 17:02
> **Review File**: `tasks/reviews/20260805-1659-byok-keys-package.review.md`
> **Notes File**: `tasks/notes/20260805-1659-byok-keys-package.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`@byok/keys` makes the already-shipped key-based BYOK implementation (API key in the OS credential store, direct provider calls) consumable as an npm package, and resolves the BYOK name collision between this repo's bring-your-own-agent SDK and aip-main-open's bring-your-own-key product. If the port is wrong, aip-main-open cannot swap at K4 without a behavior change — its golden test `apps/local-agent/src/settings.test.ts:313-318` asserts exact provider-facing wire bytes. If the security boundary is wrong, the M5 pilot audit claim that agent dispatch never touches credentials is polluted.

## Goal

Deliver `packages/keys` as a new `@byok/keys` workspace package, ported layer by layer from `aip-main-open@c6a5385` per `docs/researches/HANDOFF-byok-keys.md`. This contract covers milestone **K0** (skeleton plus the pure-function layer: errors, provider-profile schema, headers, url, and the two transport skeletons with injected `fetchImpl`, all under fully mocked tests). K1-K4 refresh this contract before their own dispatch.

## Scope

- In scope: `packages/keys/**` creation, its workspace registration (including the `pnpm-lock.yaml` entry `pnpm install` produces), the source handoff `docs/researches/HANDOFF-byok-keys.md` that this port's `file:line` references depend on, and the plan/contract/notes/review workflow artifacts.
- Out of scope: `packages/client/**`, `packages/server/**`, `packages/protocol/**` (must not gain a dependency on `keys`); `~/Projects/aip-main-open` (untouched until K4); AiphaBee narrative-domain symbols listed in `docs/researches/HANDOFF-byok-keys.md` §4.5; legacy secret migration.
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
    - packages/keys/package.json
    - packages/keys/src/errors.ts
    - packages/keys/src/provider-profile.ts
    - packages/keys/src/headers.ts
    - packages/keys/src/url.ts
    - packages/keys/src/openai-client.ts
    - packages/keys/src/anthropic-client.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260805-1659-byok-keys-package.notes.md
  tests_pass:
    - path: packages/keys/src/headers.test.ts
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
