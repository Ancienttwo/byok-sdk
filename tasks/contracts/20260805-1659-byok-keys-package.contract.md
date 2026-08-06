# Task Contract: byok-keys-package

> **Status**: Fulfilled
> **Plan**: plans/plan-20260805-1659-byok-keys-package.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-06 10:05
> **Review File**: `tasks/reviews/20260805-1659-byok-keys-package.review.md`
> **Notes File**: `tasks/notes/20260805-1659-byok-keys-package.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`@byok/keys` makes the already-shipped key-based BYOK implementation (API key in the OS credential store, direct provider calls) consumable as an npm package, and resolves the BYOK name collision between this repo's bring-your-own-agent SDK and aip-main-open's bring-your-own-key product. If the port is wrong, aip-main-open cannot swap at K4 without a behavior change — its golden test `apps/local-agent/src/settings.test.ts:313-318` asserts exact provider-facing wire bytes. If the security boundary is wrong, the M5 pilot audit claim that agent dispatch never touches credentials is polluted.

## Goal

Deliver `packages/keys` as a new `@byok/keys` workspace package, ported layer by layer from `aip-main-open@c6a5385` per `docs/researches/HANDOFF-byok-keys.md`. K4 refreshes this contract before its own dispatch.

This contract covers milestone **K3 — the settings-page server decision**, projected from the plan's `## Task Breakdown` K3 entry (`plans/plan-20260805-1659-byok-keys-package.md:133`), which is the authority for what "done" means here:

> K3 Settings-page server decision: ship as `@byok/keys/settings-server` subpath with branding and invoke-protocol parameterized, or drop it; either way add the two-security-models boundary declaration to `docs/security.md` and the package README

The decision is taken: **drop the settings-page server.** K3 is therefore a documentation slice that records the exclusion and its consequences, and ships no runtime code. Five acceptance targets:

1. **README states the exclusion.** `packages/keys/README.md` gains a "Not in this package" section giving the reason the local settings-page HTTP server is deliberately excluded (the host owns its own UI; this is a library, not a local web server; a key custodian does not open a listening port) and the host's alternative (drive `ProviderRegistry` directly). It must state the **security-property transfer**: the guarantee that the key never leaves the machine is now underwritten by the host's page, not by this package. The same edit fixes two stale claims: the `Status:` line still says K0, and the security-boundary section still says the full declaration "lands in `docs/security.md` at milestone K3" when it already landed.
2. **`docs/security.md` gains a third enforceable consequence.** The existing section is *not* rewritten; one bullet is appended after the two current ones: a key custodian opens no listening port, and this repo's local control plane is `@byok/client`'s Unix control socket (`packages/client/src/daemon/control-server.ts`).
3. **The Node floor is documented, not raised.** `packages/keys/package.json` keeps `engines.node: ">=20"`. The README states the split — on Node 20 the package is fully usable through `InMemoryProviderProfileStore`, while `SqliteProviderProfileStore` needs 22.5+ and fails closed with `PROVIDER_STORE_UNAVAILABLE` via `isSqliteAvailable()` — and names the trigger that would justify raising the floor (a consumer requiring on-disk persistence as an install-time guarantee).
4. **The plan's K4 entry names the adapter work.** Dropping the settings server means aip-main-open keeps its own `settings.ts`, so the K4 entry must name the three surfaces an aip-side adapter has to supply for `settings.test.ts` to pass unchanged: `testConfiguration()`, the multi-kind `delete(kind, providerId)` / `list()` signatures, and code-based error identification for `publicSettingsError()`.
5. **The deferred ledger records the generic test hook.** `tasks/todos.md` gains a row for a generic `ProviderRegistry.testConnection()`, with why it is deferred and what would trigger it.

One constraint binds the milestone: this is a documentation slice. No source or test file changes, and the package's test counts must be identical before and after.

## Scope

- In scope: `packages/keys/**` creation, its workspace registration (including the `pnpm-lock.yaml` entry `pnpm install` produces), the source handoff `docs/researches/HANDOFF-byok-keys.md` that this port's `file:line` references depend on, and the plan/contract/notes/review workflow artifacts.
- Out of scope: `packages/client/**`, `packages/server/**`, `packages/protocol/**` (must not gain a dependency on `keys`); `~/Projects/aip-main-open` (untouched until K4); AiphaBee narrative-domain symbols listed in `docs/researches/HANDOFF-byok-keys.md` §4.5; legacy secret migration.
- Out of scope for K3 specifically: any runtime code or test change — this is a documentation slice, so `packages/keys/src/**` is deliberately absent from `allowed_paths` below and the test counts must not move. Raising `engines.node` is also out of scope: the floor is documented, not changed. The settings-page HTTP server itself (`settings.ts:107,244,262-274,493,836,1422`) is not ported at all, which is the decision this milestone records.
- Carried forward from K2: the platform-selecting default secret-store factory and the scope data-directory manifest remain unscheduled and are tracked in `tasks/todos.md`; the plan names them in no milestone entry.
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
  # K3 is docs-only: the package's source tree is deliberately NOT allowed here,
  # so the scope gate itself enforces "no runtime change" rather than trusting it.
  - packages/keys/README.md
  - docs/security.md
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
    - packages/keys/README.md
    - docs/security.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260805-1659-byok-keys-package.notes.md
  files_contain:
    # Target 1: the exclusion, its reason, and the security-property transfer.
    - path: packages/keys/README.md
      pattern: "^## Not in this package"
    - path: packages/keys/README.md
      pattern: "listening port"
    - path: packages/keys/README.md
      pattern: "ProviderRegistry"
    # Target 3: the Node floor split, both halves named.
    - path: packages/keys/README.md
      pattern: "InMemoryProviderProfileStore"
    - path: packages/keys/README.md
      pattern: "PROVIDER_STORE_UNAVAILABLE"
    - path: packages/keys/README.md
      pattern: "isSqliteAvailable"
    # Target 3: the floor is pinned positively, not only guarded negatively.
    - path: packages/keys/package.json
      pattern: '"node": ">=20"' 
    # Target 2: the third enforceable consequence, pointing at the real file.
    - path: docs/security.md
      pattern: "packages/client/src/daemon/control-server\.ts"
    - path: docs/security.md
      pattern: "listening port"
    # Target 4: K4 carries the adapter requirement.
    - path: plans/plan-20260805-1659-byok-keys-package.md
      pattern: "testConfiguration\(\)"
    - path: plans/plan-20260805-1659-byok-keys-package.md
      pattern: "publicSettingsError\(\)"
    # Target 5: the deferred ledger row.
    - path: tasks/todos.md
      pattern: "testConnection\(\)"
  files_not_contain:
    # Target 1: the two stale claims this milestone retires.
    - path: packages/keys/README.md
      pattern: "Status: \*\*K0\*\*"
    - path: packages/keys/README.md
      pattern: "security\.md. at milestone K3"
    # Target 3: the Node floor is documented, not raised.
    - path: packages/keys/package.json
      pattern: '"node": ">=22'
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
