> **Archived**: 2026-08-17 02:31
> **Related Plan**: plans/archive/plan-20260817-0219-registry-readback-ui-runtime.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260817-0231

# Task Contract: registry-readback-ui-runtime

> **Status**: Fulfilled
> **Plan**: plans/plan-20260817-0219-registry-readback-ui-runtime.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-17 02:21
> **Review File**: `tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md`
> **Notes File**: `tasks/notes/20260817-0219-registry-readback-ui-runtime.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The npm packages are already published from `de07001`, but the independent
post-publication verifier still asserts the pre-`uiRuntime` umbrella namespace.
That false negative blocks the `v0.4.2` tag and GitHub Release even though the
published bytes passed the frozen pre-publication smoke.

## Goal

Make the post-publication registry readback expect the exact seven exported
umbrella namespaces, prove the frozen `0.4.2` registry graph passes unchanged,
and close the release with a tag that remains bound to published SHA `de07001`.

## Scope

- In scope: one exact expected-export correction in
  `scripts/release/registry-readback.mjs`, one focused regression test, workflow
  evidence, merge, and release closeout.
- Out of scope: package source/manifests/versions, lockfiles, tarballs, npm
  republish, compatibility aliases/fallbacks, deployment, and data migration.
- Taste constraints: preserve an exact fail-closed assertion; do not derive or
  weaken the expected public namespace.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if registry integrity or any internal `0.4.2` dependency edge differs
  from the frozen manifest, or if closing requires changing published bytes.

## Falsifier

If `packages/sdk/src/index.ts` or the frozen tarball does not export
`uiRuntime`, changing the verifier is wrong. The cheapest proof is the already
passing pack smoke plus a clean registry import of `byok-sdk@0.4.2`.

## Root Cause Evidence

- root_cause: scripts/release/registry-readback.mjs:163 asserts six umbrella exports after packages/sdk/src/index.ts added the seventh `uiRuntime` export.
- repro: node scripts/release/registry-readback.mjs --manifest /tmp/byok-release-0.4.2-XM2BjB/release-manifest.json
- regression_guard: tests/unit/registry-readback-ui-runtime.test.ts
- pre_fix_failure_artifact: tasks/notes/registry-readback-ui-runtime.pre-fix.log

## Workflow Inventory

- Source plan: `plans/plan-20260817-0219-registry-readback-ui-runtime.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md`
- Notes file: `tasks/notes/20260817-0219-registry-readback-ui-runtime.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"registry-readback-regression","kind":"deterministic_test","paths":["*"]},{"id":"frozen-registry-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260817-0219-registry-readback-ui-runtime.contract.md
  - tasks/reviews/20260817-0219-registry-readback-ui-runtime.review.md
  - tasks/notes/
  - .ai/context/capabilities.json
  - .claude/templates/
  - scripts/release/registry-readback.mjs
  - tests/unit/registry-readback-ui-runtime.test.ts
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
    - scripts/release/registry-readback.mjs
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260817-0219-registry-readback-ui-runtime.notes.md
    - tasks/notes/registry-readback-ui-runtime.pre-fix.log
  tests_pass:
    - path: tests/unit/registry-readback-ui-runtime.test.ts
  commands_succeed:
    - node scripts/release/registry-readback.mjs --manifest /tmp/byok-release-0.4.2-XM2BjB/release-manifest.json
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: registry-installed umbrella exposes exactly the seven
  published namespaces and excludes `keys`.
- Edge cases: integrity, dependency graph, package imports, and single-version
  closure remain verified by the same readback command.
- Regression risks: the verifier remains a literal independent oracle, so the
  focused unit test pins the required `uiRuntime` entry.

## Rollback Point

- Commit / checkpoint: verifier-only commit after frozen-manifest readback.
- Revert strategy: revert the verifier/test/workflow commit; published npm
  artifacts are immutable and unaffected.
