# Task Contract: provider-vendor-catalog

> **Status**: Active
> **Plan**: plans/plan-20260906-0018-provider-vendor-catalog.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-06 00:30
> **Review File**: `tasks/reviews/20260906-0018-provider-vendor-catalog.review.md`
> **Notes File**: `tasks/notes/20260906-0018-provider-vendor-catalog.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`@byok-sdk/keys` accepts four provider kinds and carries no vendor endpoint knowledge, so every consumer retypes base URLs and wire dialects by hand and can pair a vendor with the wrong dialect without any check. deepseek-harness already resolves provider routes from a declared vendor catalog; carrying the same facts as declared local configuration removes that hand-typing without inferring anything at runtime.

## Goal

Add a static vendor catalog to `@byok-sdk/keys` (id, display name, base URL in the SDK suffix convention, adapter, auth mode, credential env name) ported from pi-ai 0.84.2 and the harness `llm-deepseek` constant; derive `MODEL_PROVIDER_KINDS` and the SQLite CHECK from it; reject a vendor kind paired with the wrong adapter; fail closed when an existing SQLite store carries stale DDL; extend the client credential deny list with the catalog's new env names; regenerate the api-surface golden; record the source snapshot and exclusions.

## Scope

- In scope: the catalog module and its tests, the kinds derivation and adapter refinement in `provider-profile.ts`, the SQLite DDL derivation and stale-schema guard, one new error code, package exports, the two client deny-list names, the api-surface golden, a research note, a CHANGELOG entry, and this plan's workflow artifacts.
- Out of scope: runtime defaults for `base_url`, model catalogs per vendor, any pi-ai runtime dependency in keys, SQLite in-place migration, auth-mode rule changes, vendors whose endpoint requires account-specific URL segments or OAuth, version bumps, publishing, Salesko changes.
- Taste constraints: catalog entries are data traceable to a named source file; no heuristics on URLs or model names; no compatibility alias for old kind spellings.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if a catalog entry cannot be expressed in the SDK's two dialects without guessing a path.

## Falsifier

A consumer in this repo or Salesko that stores a vendor kind with the other adapter on purpose (for example `anthropic` kind over an OpenAI-compatible proxy) would falsify the adapter rule; cheapest proof is a grep of `provider_kind` fixtures and Salesko profile constructors. None was found in this repo (`openai` and `anthropic` fixtures all use their native adapter).

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260906-0018-provider-vendor-catalog.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260906-0018-provider-vendor-catalog.review.md`
- Notes file: `tasks/notes/20260906-0018-provider-vendor-catalog.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"provider-catalog-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"sqlite-ddl-and-golden-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

Co-shipped scope addition (2026-09-06): the user directed that the
public-package-topology task's committed WIP (`c8664b3`: architecture
projection refresh, cross-harness probe report and evidence, the tmux
collaboration Draft plan, and that contract's own scope additions) merge
together with this branch. Those paths are owned by
`tasks/contracts/20260905-0114-public-package-topology.contract.md`; they are
listed here only so this contract's branch-diff preflight recognises them.
This task made no edits to them.

```yaml
allowed_paths:
  - docs/architecture/index.md
  - docs/architecture/requests/root.md
  - packages/AGENTS.md
  - packages/CLAUDE.md
  - tasks/contracts/20260905-0114-public-package-topology.contract.md
  - docs/researches/2026-09-05_cross-harness-probe.md
  - docs/researches/evidence/2026-09-05-cross-harness/
  - plans/plan-20260905-2239-tmux-cross-harness-collaboration.md
  - plans/plan-20260906-0018-provider-vendor-catalog.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260906-0018-provider-vendor-catalog.contract.md
  - tasks/reviews/20260906-0018-provider-vendor-catalog.review.md
  - tasks/notes/20260906-0018-provider-vendor-catalog.notes.md
  - packages/keys/src/provider-catalog.ts
  - packages/keys/src/provider-catalog.test.ts
  - packages/keys/src/provider-profile.ts
  - packages/keys/src/provider-profile.test.ts
  - packages/keys/src/provider-profile-binding.test.ts
  - packages/keys/src/sqlite-profile-store.ts
  - packages/keys/src/sqlite-profile-store.test.ts
  - packages/keys/src/errors.ts
  - packages/keys/src/index.ts
  - packages/client/src/adapters/provider-credential-environment.ts
  - api-surface/keys.d.ts
  - docs/researches/2026-09-06_deepseek-harness-provider-catalog-port.md
  - CHANGELOG.md
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
    - packages/keys/src/provider-catalog.ts
    - docs/researches/2026-09-06_deepseek-harness-provider-catalog-port.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260906-0018-provider-vendor-catalog.notes.md
  tests_pass:
    - path: packages/keys/src/provider-catalog.test.ts
    - path: packages/keys/src/provider-profile.test.ts
    - path: packages/keys/src/sqlite-profile-store.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/keys typecheck
    - bun run --filter @byok-sdk/keys build
    - bun run --filter @byok-sdk/keys test
    - bun run --filter @byok-sdk/client typecheck
    - bun run check:api-surface
    - bun run check:version-authority
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: every catalog entry parses as a profile with its own adapter and auth mode; the four legacy kinds still parse; a vendor kind with the other adapter is rejected with `PROVIDER_PROFILE_INVALID`; opening a store whose `provider_profile` DDL differs throws `PROVIDER_STORE_SCHEMA_STALE`.
- Edge cases: `custom` keeps today's freedom; `base_url` on a vendor profile may differ from the catalog default (self-hosted gateway); the anthropic-dialect entries carry the `/v1` suffix the SDK client expects.
- Regression risks: existing SQLite stores on developer machines fail closed until recreated; the api-surface golden changes.

## Rollback Point

- Commit / checkpoint: `12278dc` (main before this task).
- Revert strategy: revert the single PR; no persisted data changes shape.
