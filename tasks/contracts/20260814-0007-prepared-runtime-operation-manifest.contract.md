# Task Contract: prepared-runtime-operation-manifest

> **Status**: Active
> **Plan**: plans/plan-20260814-0007-prepared-runtime-operation-manifest.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-14 00:18
> **Review File**: `tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md`
> **Notes File**: `tasks/notes/20260814-0007-prepared-runtime-operation-manifest.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`TaskRunner` currently reads adapter capability and environment authority at different
times, while Pi/Claude/Codex can still reject permanent semantic errors inside
`start()` after claim and workspace work. If the cut is skipped, a custom or stateful
adapter can be selected under one truth and claimed/spawned under another; if it ships
wrong, 0.4.0 custom adapters can leak credentials into diagnostics, allocate resources
before admission, or change protocol-v1 behavior.

## Goal

Ship one coordinated 0.4.0 TypeScript API break in which every runtime adapter exposes
a frozen descriptor and a required side-effect-free per-offer preparation operation.
`TaskRunner` must seal one immutable, credential-free operation manifest before claim
and reuse it for admission, claim, environment projection, provider/model selection,
and start. All bundled adapters, test doubles, built-entry smoke evidence, release
metadata, and authoritative docs move atomically; there is no legacy direct-start path.

## Scope

- In scope: public `RuntimeAdapter` descriptor/prepare/prepared-operation types and exports; TaskRunner admission/claim/start reordering; Pi/Claude/Codex migration; daemon discovery/diagnostics migration; all affected client fixtures/tests; built-entry adapter smoke; aligned dispatch-package 0.4.0 metadata; migration/release notes and lifecycle truth docs.
- Out of scope: protocol-v1 schema/golden changes; new runtime ids; failure taxonomy/retry projection (Sprint Row 2); quiescent process-tree disposal and shutdown-owner ordering (Sprint Row 3/separate worktree); npm publication; Cordis/plugin loading, DeepSeek wire/session formats, provider/model registry duplication, compatibility fallbacks.
- Taste constraints: one source of truth per operation; preparation is pure with respect to spawn/temp/workspace/session allocation and never reads credential values; manifest contains names/selection metadata but no secret values; fail closed on malformed or unsupported input; no optional prepare hook, overload, adapter alias, direct-start fallback, or dual 0.3/0.4 semantics.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if implementation requires a protocol-v1 schema/golden change or a new runtime id.
- Stop if a prepared operation cannot be made side-effect-free before claim, or if the manifest would need credential values.
- Stop if the worktree base is not a descendant of annotated tag `v0.3.0^{}` (`a119b5cf4247278a456c285cbc6470d8e3b9815c`).

## Falsifier

The direction is wrong if a real bundled adapter cannot decide semantic admission and
pin runtime/provider/model/launcher selection before claim without spawning, mutating a
workspace, allocating a session id, or reading a credential value. Check Pi BYOK with a
missing custody launcher first: instrument claim/start/spawn/workspace effects and prove
the prepared decision declines with all counters at zero. If that cannot hold, stop and
return evidence instead of adding a legacy or late-validation path.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260814-0007-prepared-runtime-operation-manifest.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md`
- Notes file: `tasks/notes/20260814-0007-prepared-runtime-operation-manifest.notes.md`
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
  - packages/client/
  - packages/core/package.json
  - packages/protocol/package.json
  - packages/server/package.json
  - packages/cloud/package.json
  - packages/cloud-dataplane/package.json
  - packages/testkit/package.json
  - packages/sdk/package.json
  - packages/conformance/package.json
  - pnpm-lock.yaml
  - scripts/release/check-package-graph.mjs
  - scripts/release/pack-and-smoke.mjs
  - scripts/release/registry-readback.mjs
  - CHANGELOG.md
  - README.md
  - docs/spec.md
  - docs/security.md
  - docs/architecture/sdk-architecture.md
  - plans/plan-20260814-0007-prepared-runtime-operation-manifest.md
  - plans/sprints/20260814-0005-runtime-adapter-lifecycle-contracts.sprint.md
  - tasks/todos.md
  - tasks/contracts/20260814-0007-prepared-runtime-operation-manifest.contract.md
  - tasks/reviews/20260814-0007-prepared-runtime-operation-manifest.review.md
  - tasks/notes/20260814-0007-prepared-runtime-operation-manifest.notes.md
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
    - packages/client/src/types.ts
    - packages/client/src/daemon/task-runner.ts
    - packages/client/scripts/adapter-task-smoke.mjs
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260814-0007-prepared-runtime-operation-manifest.notes.md
  commands_succeed:
    - pnpm --filter @byok-sdk/client run typecheck
    - pnpm --filter @byok-sdk/client run test
    - pnpm --filter @byok-sdk/client run build
    - pnpm --filter @byok-sdk/client run smoke:adapters
    - node scripts/release/check-package-graph.mjs
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: claim and start consume the same frozen operation authority; unsupported selection/instruction/launcher cases decline before resource publication; valid Pi/Claude/Codex tasks still complete through built output.
- Edge cases: descriptor source mutation after preparation, repeated capability reads, missing launcher, unsupported lane/runtime/model/instruction/toolset/session intent, environment allowlist drift, and secret/log serialization.
- Regression risks: public custom-adapter compile break is intentional and documented; protocol-v1 claim bytes and Pi provider/model/transport ownership remain unchanged; process-tree teardown behavior is not claimed by this row.

## Rollback Point

- Commit / checkpoint: worktree must descend from `v0.3.0^{}` = `a119b5cf4247278a456c285cbc6470d8e3b9815c`; record the final implementation commit in notes/review.
- Revert strategy: revert the complete Row 1 commit/package train. Do not restore direct start beside prepared operations or retain mixed 0.3/0.4 adapter semantics.
