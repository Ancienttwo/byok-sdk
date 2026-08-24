# Task Contract: release-0-8-1-enrollment-read-model

> **Status**: Active
> **Plan**: plans/plan-20260824-1648-release-0-8-1-enrollment-read-model.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-24 16:48
> **Review File**: `tasks/reviews/20260824-1648-release-0-8-1-enrollment-read-model.review.md`
> **Notes File**: `tasks/notes/20260824-1648-release-0-8-1-enrollment-read-model.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Salesko cannot truthfully distinguish a complete authenticated enrollment from a legacy invalid record using the published client. The required credential-blind SDK API is source-verified but unpublished, while the already accepted Agent-home repair candidate owns the only unclaimed aligned 0.8.1 release identity.

## Goal

Publish one combined immutable BYOK SDK 0.8.1 train plus `@byok-sdk/keys@0.3.2`, preserving the accepted Agent-home replay repair and adding the public credential-blind enrollment status reader; prove registry/tag/Release identity and enable a fresh exact-pinned Salesko acceptance.

## Scope

- In scope: client read model/export/test/docs; release documentation/evidence; aligned package verification; full gates; npm publication/readback; exact source push; annotated tag and GitHub Release.
- Out of scope: Cloudflare deploy, production migration, secrets mutation, live-device upgrade, provider execution, terminal projection work, or changes to unrelated dirty worktrees.
- Taste constraints: invalid/legacy records return only `re_pair_required`; all other storage/path failures remain errors. No downstream parser or compatibility fallback.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop before publication if the source is dirty, any gate fails, the acceptance receipt is missing/stale, or npm/remote tag/GitHub Release already owns the requested identity inconsistently.
- After the first npm write, continue only at the same immutable versions and preserve exact partial-publication evidence.

## Falsifier

The release is invalid if the public result contains tenant/token/key material, a legacy record becomes `unpaired`, non-record filesystem failures are swallowed, replay repair regresses, packed internal edges split, or registry/tag/source SHA differ.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260824-1648-release-0-8-1-enrollment-read-model.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260824-1648-release-0-8-1-enrollment-read-model.review.md`
- Notes file: `tasks/notes/20260824-1648-release-0-8-1-enrollment-read-model.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"enrollment-read-model","kind":"deterministic_test","paths":["packages/client/src/daemon/store.ts","packages/client/src/index.ts","packages/client/src/__tests__/authenticated-enrollment-status.test.ts","packages/client/README.md"]},{"id":"release-artifact-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - README.md
  - CHANGELOG.md
  - packages/client/README.md
  - packages/client/src/daemon/store.ts
  - packages/client/src/index.ts
  - packages/client/src/__tests__/authenticated-enrollment-status.test.ts
  - packages/client/src/agent-home.ts
  - packages/client/src/__tests__/agent-home-idempotent-repair.test.ts
  - packages/client/src/__tests__/agent-home-projection.test.ts
  - packages/client/package.json
  - packages/cloud-dataplane/package.json
  - packages/cloud/package.json
  - packages/core/package.json
  - packages/keys/package.json
  - packages/protocol/package.json
  - packages/sdk/package.json
  - packages/server/package.json
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
  - bun.lock
  - docs/host-local-storage-layout.md
  - docs/protocol.md
  - plans/plan-20260824-1648-release-0-8-1-enrollment-read-model.md
  - plans/plan-20260824-1254-agent-home-idempotent-repair.md
  - tasks/todos.md
  - tasks/contracts/20260824-1648-release-0-8-1-enrollment-read-model.contract.md
  - tasks/reviews/20260824-1648-release-0-8-1-enrollment-read-model.review.md
  - tasks/notes/20260824-1648-release-0-8-1-enrollment-read-model.notes.md
  - tasks/contracts/20260824-1254-agent-home-idempotent-repair.contract.md
  - tasks/reviews/20260824-1254-agent-home-idempotent-repair.review.md
  - tasks/notes/20260824-1254-agent-home-idempotent-repair.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
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
    - packages/client/src/__tests__/authenticated-enrollment-status.test.ts
    - scripts/release/publish.mjs
    - scripts/release/registry-readback.mjs
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260824-1648-release-0-8-1-enrollment-read-model.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/authenticated-enrollment-status.test.ts
    - path: packages/client/src/__tests__/agent-home-idempotent-repair.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:release-graph
    - node --test scripts/release/pack-and-smoke.test.mjs
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: exact three-state public read model and accepted Agent-home replay repair are present in one immutable release graph.
- Edge cases: no credential projection; storage/path failures propagate; partial publication resumes only the same versions.
- Regression risks: split internal edges, stale tag/source identity, or downstream consumption from a local overlay.

## Rollback Point

- Commit / checkpoint: `bd24a106c462f79764a36f30080afc81dfd6c371`.
- Revert strategy: discard before first registry write; after publication begins complete/read back the same immutable train and never overwrite or retag.
