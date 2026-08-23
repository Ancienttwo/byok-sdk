# Task Contract: authenticated-enrollment-tenant-projection

> **Status**: Active
> **Plan**: plans/plan-20260823-2025-authenticated-enrollment-tenant-projection.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-23 20:27
> **Review File**: `tasks/reviews/20260823-2025-authenticated-enrollment-tenant-projection.review.md`
> **Notes File**: `tasks/notes/20260823-2025-authenticated-enrollment-tenant-projection.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Cloud pairing already authenticates and persists the tenant carried by a
single-use enrollment code, but `PairResponse` drops that binding and the local
daemon accepts an independently authored `AgentEgressConfig.tenantId`. Salesko
cannot compose Agent-first egress without inventing an unauthenticated tenant
source. Shipping only part of this change would preserve the same cross-tenant
authority gap behind a different API.

## Goal

Project one typed, bounded, opaque, non-secret tenant binding from authenticated
pairing code/device row through required `PairResponse.tenantId` into the one
atomic client `DeviceRecord`; preserve it exactly on renewal, atomically replace
it on re-pair, and make that enrollment record the only tenant source for daemon
Agent egress/content/ack composition. Reject old or tampered records and prepare
an unreleased aligned 0.7.0 plus keys 0.3.0 release candidate.

## Scope

- In scope: protocol schema/types/docs; cloud and reference pair handlers;
  authenticated device-row projection; client record validation/atomic storage,
  restart, renewal and re-pair; daemon egress/hosted-journal binding; focused negative tests;
  disposable Postgres evidence; exact candidate versions/lock/release graph;
  independent frozen-subject acceptance.
- Out of scope: Salesko code/Profile schema/config, JWT/access-token parsing,
  deviceId derivation, shadow tenant stores, legacy dual-read/fallback,
  production migration/deploy/secrets, merge/push/npm publication/registry
  mutation or downstream pin/cutover.
- Taste constraints: tenantId is required, opaque, bounded and non-secret;
  cloud pairing/device record and local DeviceRecord are the only sequential
  authorities. Missing legacy records fail closed with explicit re-pair. No
  optional compatibility field or long-lived migration path. Host-authored
  `AgentEgressConfig.tenantId` and `HostedJournalConfig.tenantId` are removed.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the implementation would need tenantId from Profile/config, token
  parsing, deviceId inference or any second persistent store.
- Stop before merge, push, publish, deploy, production DDL or secret mutation;
  this contract ends at accepted source/release-candidate evidence.

## Falsifier

The direction is wrong if the authenticated pairing code/device row does not
already own tenantId, or if daemon egress can still start without the exact
persisted enrollment binding. Cheapest proof: trace
`PairingCodeStore.redeem -> AuthPlane.redeemAndRegister -> PairResponse ->
AuthManager.pair -> DeviceStore.load -> buildDaemonWithAdapters` and search for
all remaining `agentEgress.tenantId`/token-decoding sources.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260823-2025-authenticated-enrollment-tenant-projection.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260823-2025-authenticated-enrollment-tenant-projection.review.md`
- Notes file: `tasks/notes/20260823-2025-authenticated-enrollment-tenant-projection.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/protocol.md
  - docs/host-local-storage-layout.md
  - CHANGELOG.md
  - package.json
  - bun.lock
  - packages/core/package.json
  - packages/protocol/package.json
  - packages/protocol/src/
  - packages/cloud/package.json
  - packages/cloud/src/
  - packages/server/package.json
  - packages/server/src/
  - packages/client/package.json
  - packages/client/src/
  - packages/cloud-dataplane/package.json
  - packages/cloud-dataplane/src/
  - packages/testkit/package.json
  - packages/testkit/src/
  - packages/ui-runtime/package.json
  - packages/sdk/package.json
  - packages/keys/package.json
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260823-2025-authenticated-enrollment-tenant-projection.contract.md
  - tasks/reviews/20260823-2025-authenticated-enrollment-tenant-projection.review.md
  - tasks/notes/20260823-2025-authenticated-enrollment-tenant-projection.notes.md
  - .ai/context/capabilities.json
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
    - docs/spec.md
    - docs/protocol.md
    - packages/protocol/src/http-api.ts
    - packages/cloud/src/handlers/auth.ts
    - packages/server/src/http.ts
    - packages/client/src/daemon/store.ts
    - packages/client/src/daemon/auth-manager.ts
    - packages/client/src/daemon/create-daemon.ts
    - packages/client/src/__tests__/authenticated-enrollment-tenant-projection.test.ts
    - packages/cloud-dataplane/src/__tests__/authenticated-enrollment-tenant-projection.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260823-2025-authenticated-enrollment-tenant-projection.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/http-api.test.ts
    - path: packages/cloud/src/__tests__/authenticated-enrollment-tenant-projection.test.ts
    - path: packages/server/src/__tests__/authenticated-enrollment-tenant-projection.test.ts
    - path: packages/client/src/__tests__/authenticated-enrollment-tenant-projection.test.ts
    - path: packages/cloud-dataplane/src/__tests__/authenticated-enrollment-tenant-projection.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:release-graph
    - node scripts/release/pack-and-smoke.test.mjs
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: exact authenticated tenant survives pair, disk, restart,
  renewal and daemon egress/content/ack; re-pair replaces the entire binding.
- Edge cases: malformed/oversize response, cross-tenant tamper, legacy record,
  token payload disagreement, restart, concurrent/failed atomic save and re-pair.
- Regression risks: wire/API break, stale fixture responses, hidden host-authored
  tenant config, secret logging and candidate graph skew.

## Rollback Point

- Commit / checkpoint: `main@6fb8d674f55d53c5ba4917a8d6275874def48141`.
- Revert strategy: revert the complete unreleased source/RC unit; no registry,
  remote or downstream authority is mutated by this contract.
