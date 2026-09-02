# Task Contract: api-surface-golden

> **Status**: Partial
> **Plan**: plans/plan-20260903-0410-api-surface-golden.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-03 04:30
> **Review File**: `tasks/reviews/20260903-0410-api-surface-golden.review.md`
> **Notes File**: `tasks/notes/20260903-0410-api-surface-golden.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Every 0.x train since 0.1.0 changed a downstream-facing type surface (`CloudStores`, `MailboxStore`, `BlobStore`, server config) while only the wire golden gated change, and `README.md` still advertises `byok-sdk@0.8.1` / `@byok-sdk/keys@0.3.2` although npm, `docs/spec.md` and the manifests say `0.12.0` / `0.3.9`. Without a surface golden and a version-string check, the next train ships another undeliberate public change and another stale README.

## Goal

Land, on one branch, two root Node scripts with `node --test` suites, nine committed API-surface goldens, root `package.json` script entries, three CI steps, corrected README version strings, and the two new commands in the root Required Checks lists — with zero runtime, protocol, store, or migration change.

## Scope

- In scope:
  - `scripts/api-surface/check-api-surface.mjs` (+ test): reachable `.d.ts` closure per package from `exports[*].types`, normalised, compared with `api-surface/<pkg>.d.ts`; `--update`, `--package`.
  - `scripts/api-surface/check-version-authority.mjs` (+ test): dispatch version from `packages/core/package.json`, keys version from `packages/keys/package.json`; README and spec strings must match and carry no other semver for those two names.
  - goldens for client, cloud, cloud-dataplane, core, protocol, server, ui-runtime, testkit, keys; `api-surface/README.md`.
  - root `package.json` scripts `check:api-surface`, `check:version-authority`, `test:scripts`; CI steps in `build-test` after `Build`.
  - `README.md` version strings and the two `0.8.1` release paragraphs; root `CLAUDE.md` and `AGENTS.md` Required Checks (identical wording).
- Out of scope:
  - any change under `packages/*/src`, `deploy/`, `docs/spec.md` content, protocol goldens; new dependencies; push, PR, publish, release, tag, deployment.
- Taste constraints: no new dependency; `package.json` is the only version authority (no generated manifest); goldens are byte-exact and regenerated only on purpose; fail closed with a readable diff.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the closure walk needs anything beyond relative-specifier resolution inside `dist/` (a bare-specifier or dynamic import in emitted `.d.ts`).

## Falsifier

If `bun run build` twice in a row from the same commit produces different `.d.ts` bytes for any package, the golden approach is wrong; check first by running the check immediately after regenerating. If README's `0.8.1` was deliberately describing the *published* release while manifests were ahead, the version check would be encoding the wrong authority — `npm view byok-sdk version` returned `0.12.0` on 2026-09-03, so it is not.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260903-0410-api-surface-golden.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260903-0410-api-surface-golden.review.md`
- Notes file: `tasks/notes/20260903-0410-api-surface-golden.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"api-surface-golden-regeneration","kind":"deterministic_test","paths":["api-surface/","scripts/api-surface/"]}]}
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
  - tasks/current.md
  - tasks/contracts/20260903-0410-api-surface-golden.contract.md
  - tasks/reviews/20260903-0410-api-surface-golden.review.md
  - tasks/notes/20260903-0410-api-surface-golden.notes.md
  - scripts/api-surface/
  - api-surface/
  - package.json
  - .github/workflows/ci.yml
  - README.md
  - CLAUDE.md
  - AGENTS.md
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
    - scripts/api-surface/check-api-surface.mjs
    - scripts/api-surface/check-api-surface.test.mjs
    - scripts/api-surface/check-version-authority.mjs
    - scripts/api-surface/check-version-authority.test.mjs
    - api-surface/README.md
    - api-surface/client.d.ts
    - api-surface/cloud.d.ts
    - api-surface/cloud-dataplane.d.ts
    - api-surface/core.d.ts
    - api-surface/protocol.d.ts
    - api-surface/server.d.ts
    - api-surface/ui-runtime.d.ts
    - api-surface/testkit.d.ts
    - api-surface/keys.d.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260903-0410-api-surface-golden.notes.md
  tests_pass: []
  commands_succeed:
    - bun run build
    - bun run check:api-surface
    - bun run check:version-authority
    - bun run test:scripts
    - bun run check:release-graph
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: `check:api-surface` is green immediately after `--update` on a clean build and red after any exported-type edit; `check:version-authority` is red when README or spec disagree with the manifests.
- Edge cases: `export * from './x.js'` specifiers with `.js` suffix resolve to `.d.ts`; directory specifiers resolve to `index.d.ts`; CRLF and `sourceMappingURL` lines are normalised; a package with several `exports` entries (client, cloud-dataplane) walks all of them once.
- Regression risks: none at runtime; CI runtime grows by the three steps only.

## Rollback Point

- Commit / checkpoint: branch base `4cc765f` (main).
- Revert strategy: revert the single commit; no state outside the repo changes.
