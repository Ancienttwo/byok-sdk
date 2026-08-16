# Task Contract: p5-keys-truth-store

> **Status**: Active
> **Plan**: plans/plan-20260817-0026-p5-keys-truth-store.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-17 00:26
> **Review File**: `tasks/reviews/20260817-0026-p5-keys-truth-store.review.md`
> **Notes File**: `tasks/notes/20260817-0026-p5-keys-truth-store.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

P5 is the already-triggered architecture cut that lets a host persist non-secret
provider-profile truth with tenant isolation, content integrity, and revision
conflict semantics. Today `@byok-sdk/keys` has only process-local or SQLite
profile authority, while `TruthStore` is the platform's canonical tenant-first
snapshot port. If this is skipped, profile metadata cannot participate in the
platform truth model. If it ships wrong, secrets can cross into cloud storage,
concurrent hosts can silently overwrite one another, or the dispatch plane can
gain an illegal dependency on credential-adjacent code.

## Goal

Deliver one coordinated breaking cut in `@byok-sdk/keys`: make
`ProviderProfileStore` async, add a tenant-bound TruthStore adapter that stores
the complete bounded provider registry as one deterministic, versioned,
secret-free CAS snapshot, preserve existing registry behavior across InMemory
and SQLite adapters, and update the package/security/release graph so
`keys -> core` is the only permitted BYOK package edge. Conflicts and malformed
authority must fail closed; no dual-write, auto-merge, protocol edge, migration,
publish, or deploy is part of this task.

## Scope

- In scope:
  - async profile-store port and coordinated registry/launcher/test cut;
  - tenant-bound TruthStore adapter, deterministic aggregate codec, SHA-256,
    CAS and integrity validation;
  - shared behavioral and truth-specific negative tests;
  - public exports, package metadata/lockfile/release graph, spec/security/
    architecture/README updates, and P5 ledger closeout;
- Out of scope:
  - protocol/wire changes, cloud routes, secret transport, automatic remote-to-SQLite replication, Pi launcher redesign, production deployment, npm publish.
- Taste constraints: one selected persistence authority; whole-registry CAS;
  secrets remain OS-local; reject stale/malformed authority without retry,
  merge, fallback, dual read, or dual write.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the aggregate cannot preserve delete plus at-most-one-enabled
  atomically, if any truth body needs secret material, if Pi custody would need
  daemon/network access to the secret, or if a forbidden package edge is
  required.

## Falsifier

The direction is wrong if one bounded registry snapshot cannot preserve public
profile behavior, deterministic bytes, and CAS conflict observability without
a second authority. The cheapest proof is one shared store suite against
InMemory, SQLite, and `InMemoryTruthStore`, including two writers from the same
revision and inspection of every captured truth body for secret absence.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260817-0026-p5-keys-truth-store.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260817-0026-p5-keys-truth-store.review.md`
- Notes file: `tasks/notes/20260817-0026-p5-keys-truth-store.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"keys-truth-store-contract","kind":"deterministic_test","paths":["packages/keys/src/**"]},{"id":"keys-security-boundary","kind":"security_review","paths":["packages/keys/**","scripts/release/check-package-graph.mjs","docs/security.md"]},{"id":"keys-package-runtime","kind":"runtime_readback","paths":["packages/keys/package.json","bun.lock"]}]}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/security.md
  - docs/architecture/sdk-architecture.md
  - ARCHITECTURE-PROPOSAL-byok-platform.md
  - packages/keys/
  - packages/core/src/in-memory/truth.ts
  - packages/core/src/truth.ts
  - scripts/release/check-package-graph.mjs
  - bun.lock
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/contracts/20260817-0026-p5-keys-truth-store.contract.md
  - tasks/reviews/20260817-0026-p5-keys-truth-store.review.md
  - tasks/notes/20260817-0026-p5-keys-truth-store.notes.md
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
    - packages/keys/src/profile-store.ts
    - packages/keys/src/truth-profile-store.ts
    - packages/keys/src/truth-profile-store.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260817-0026-p5-keys-truth-store.notes.md
  tests_pass:
    - path: packages/keys/src/profile-store.test.ts
    - path: packages/keys/src/truth-profile-store.test.ts
    - path: packages/keys/src/registry.golden.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/keys test
    - bun run --filter @byok-sdk/keys build
    - bun run --filter @byok-sdk/keys typecheck
    - bun scripts/release/check-package-graph.mjs
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: registry behavior is identical across selected adapters;
  TruthStore adds tenant isolation, hash/size validation and explicit CAS.
- Edge cases: empty registry, update/delete/default switch, stale writer,
  malformed/object/hash/size/duplicate/secret-shaped body, tenant separation.
- Regression risks: public sync-to-async cut, Node/package dependency floor,
  launcher read-only SQLite composition, independent keys versioning.

## Rollback Point

- Commit / checkpoint: frozen implementation subject before acceptance receipt.
- Revert strategy: revert the coordinated PR before any separate publication;
  no production migration or deployment exists in this scope.
