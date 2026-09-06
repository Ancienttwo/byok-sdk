# Task Contract: release-entrypoint-artifacts

> **Status**: Partial
> **Plan**: plans/plan-20260906-2023-release-entrypoint-artifacts.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-06 20:30
> **Review File**: `tasks/reviews/20260906-2023-release-entrypoint-artifacts.review.md`
> **Notes File**: `tasks/notes/20260906-2023-release-entrypoint-artifacts.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The frozen 0.14.0 / keys 0.4.0 candidate has green CI at `aa1d347`, yet the release driver cannot publish those accepted bytes: it always repacks (which the operator machine cannot finish), tags before publishing and reading back (the runbook requires the reverse), and CI never uploads the tarballs it accepted. Releasing today would either republish unverified bytes or tag an unpublished train.

## Goal

`scripts/release/publish.mjs` gains `--artifacts <dir>` that consumes a CI-produced `release-manifest.json` for the exact `HEAD` (re-hashing every tarball, refusing any mismatch, skipping build and pack); its execute path runs account gate (`npm whoami` and `tfa.mode === 'auth-and-writes'`, no override) → publish (`--provenance` only under `GITHUB_ACTIONS`) → registry readback → annotated tag, with the tag-exists precondition before any side effect; CI's ubuntu `npm-release-pack` leg uploads `release-pack-<sha>`; the runbook step 5 states the sequence; tests prove the failure modes and the ordering.

## Scope

- In scope: `publish.mjs`, new `publish.test.mjs` wired into `test:scripts`, one `upload-artifact` step in `ci.yml`, runbook step 5, CHANGELOG, workflow artifacts.
- Out of scope: any actual publish/tag/push, `pack-and-smoke.mjs`, `registry-readback.mjs` internals, version bumps, Salesko.
- Taste constraints: fail closed everywhere; no retry, no `--skip-*` flags, no override for the 2FA policy; one manifest format.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if `npm profile get --json` cannot express `tfa.mode` for token-authenticated sessions; report rather than skip the gate.

## Falsifier

If `bun pm pack` output is not byte-stable across CI runs for the same SHA, the re-hash in `--artifacts` mode would still pass (it hashes the downloaded bytes), so determinism is not assumed anywhere; nothing to falsify beyond the tests.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260906-2023-release-entrypoint-artifacts.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260906-2023-release-entrypoint-artifacts.review.md`
- Notes file: `tasks/notes/20260906-2023-release-entrypoint-artifacts.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"release-scripts-tests","kind":"deterministic_test","paths":["*"]},{"id":"artifacts-dry-run-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260906-2023-release-entrypoint-artifacts.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260906-2023-release-entrypoint-artifacts.contract.md
  - tasks/reviews/20260906-2023-release-entrypoint-artifacts.review.md
  - tasks/notes/20260906-2023-release-entrypoint-artifacts.notes.md
  - scripts/release/publish.mjs
  - scripts/release/publish.test.mjs
  - scripts/release/fixtures/
  - package.json
  - .github/workflows/ci.yml
  - deploy/runbooks/release-responsibility.md
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
    - scripts/release/publish.mjs
    - scripts/release/publish.test.mjs
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260906-2023-release-entrypoint-artifacts.notes.md
  tests_pass: []
  commands_succeed:
    - bun run test:scripts
    - bun run check:release-graph
    - bun run check:version-authority
    - node -e "const fs=require('node:fs');const s=fs.readFileSync('scripts/release/publish.mjs','utf8');const e=s.indexOf('--- Step');const pub=s.indexOf(\"'publish',\");const rb=s.indexOf('registry-readback.mjs');const tag=s.indexOf(\"['tag', '-a'\");if(!(pub>0&&rb>pub&&tag>rb))throw new Error('execute order must be publish -> readback -> tag')"
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: `--artifacts` verifies `sourceGitSha`, `releaseVersion`, per-package file existence and sha256, and skips build/pack; execute order is account gate → publish → readback → tag; `--out-dir` and `--artifacts` are mutually exclusive; the dry run prints verified digests.
- Edge cases: partially published train (publish set subset) with artifacts present; artifact present for an already-published package (ignored); `tfa.mode` missing or `auth-only` refused; `GITHUB_ACTIONS` unset → no `--provenance`, logged.
- Regression risks: the runbook and the script now agree; operators must download the CI artifact before publishing.

## Rollback Point

- Commit / checkpoint: `aa1d347` (origin/main before this task).
- Revert strategy: revert the PR; no registry side effects.
