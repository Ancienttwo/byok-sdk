# Task Contract: tenant-readiness-primitives

> **Status**: Fulfilled
> **Plan**: plans/plan-20260821-1715-tenant-readiness-primitives.md
> **Task Profile**: migration
> **Workflow Profile**: strict
> **Owner**: `/root/u4_release_hygiene`
> **Capability ID**: root
> **Review File**: `tasks/reviews/20260821-1715-tenant-readiness-primitives.review.md`
> **Notes File**: `tasks/notes/20260821-1715-tenant-readiness-primitives.notes.md`

Evidence boundary: local source/tests and a separately identified real-Postgres run only. This contract authorizes no registry, publish, deploy, production migration, or secret mutation.

## Objective

Expose one SDK-owned, tenant-scoped readiness projection composed from durable
device rows and the lossy, TTL-bounded presence projection. The aggregate is a
read model only: it must not become an execution, authorization, scheduling,
capability, or admission authority.

The public projection MUST:

- count active paired devices and revoked devices separately;
- count only unexpired presence rows, with `now >= expiresAt` treated as absent;
- exclude revoked devices from every online/presence count, including residual
  presence rows left after revocation;
- return deterministic zeroes for a tenant with no devices or no live presence,
  and deterministic counts for every declared presence level;
- include one tenant-scoped per-device observation in the same aggregate,
  carrying durable product/name/revocation state and optional unexpired
  release/protocol/runtime/auth facts for active devices, so consumers do not
  re-join `listDevices()` and `listPresence()`;
- preserve tenant isolation and work for multiple tenants in one store;
- omit unavailable release/runtime/auth facts rather than guessing or falling
  back to host state;
- use U4a `localAgentRelease` as the sole client-version authority;
- make the WS `conn.hello` and the first HTTP long-poll presence publication
  carry the same frozen release/readiness facts;
- use real runtime/auth probes only, with no semver gate, scheduler/load score,
  host fallback, or capability heuristic.

Presence remains lossy and non-authoritative. The aggregate is an observed
tenant read model, not a claim that a tenant is ready to execute work.

## Allowed paths

The machine-readable scope below is authoritative for contract verification.

```yaml
allowed_paths:
  - plans/plan-20260821-1715-tenant-readiness-primitives.md
  - tasks/contracts/20260821-1715-tenant-readiness-primitives.contract.md
  - tasks/notes/20260821-1715-tenant-readiness-primitives.notes.md
  - tasks/reviews/20260821-1715-tenant-readiness-primitives.review.md
  - docs/spec.md
  - docs/protocol.md
  - deploy/sql/0010_tenant_readiness.sql
  - tests/sql/control_plane_invariants.sql
  - packages/core/src/presence.ts
  - packages/core/src/in-memory/presence.ts
  - packages/core/src/index.ts
  - packages/core/src/__tests__/tenant-readiness.test.ts
  - packages/cloud/src/stores/ports.ts
  - packages/cloud/src/stores/ports-contract.ts
  - packages/cloud/src/tenant-stores.ts
  - packages/cloud/src/cloud.ts
  - packages/cloud/src/handlers/presence.ts
  - packages/cloud/src/stores/in-memory/device-directory.ts
  - packages/cloud/src/index.ts
  - packages/cloud/src/__tests__/tenant-readiness.test.ts
  - packages/cloud-dataplane/src/stores/core/presence.ts
  - packages/cloud-dataplane/src/stores/devices.ts
  - packages/cloud-dataplane/src/stores/index.ts
  - packages/cloud-dataplane/src/runtime.ts
  - packages/cloud-dataplane/src/index.ts
  - packages/cloud-dataplane/src/__tests__/tenant-readiness.test.ts
  - packages/client/src/daemon/presence-publisher.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/daemon/connection-manager.ts
  - packages/client/src/daemon/ws-transport.ts
  - packages/client/src/daemon/long-poll-transport.ts
  - packages/client/src/__tests__/tenant-readiness.test.ts
  - packages/client/src/__tests__/daemon-conn-hello-capabilities.test.ts
  - packages/client/src/__tests__/presence-publisher.test.ts
  - packages/client/src/__tests__/real-cloud-longpoll.test.ts
  - packages/protocol/src/messages.ts
  - packages/protocol/src/http-api.ts
  - packages/protocol/src/codec.ts
  - packages/protocol/src/index.ts
  - packages/protocol/src/__tests__/tenant-readiness.test.ts
  - packages/protocol/src/__tests__/message-schema-changes.test.ts
  - packages/protocol/src/__tests__/freeze-guard.test.ts
  - packages/protocol/src/__tests__/golden/v1.envelopes.ndjson
  - packages/protocol/src/__tests__/golden/v1.frozen.json
  - packages/conformance/src/__tests__/tenant-readiness.test.ts
  - .ai/harness/checks/latest.json
  - .ai/harness/checks/change-assessment.latest.json
  - .ai/harness/runs/
  - .ai/harness/worktrees/.gitkeep
  - .ai/harness/failures/.gitkeep
  - .ai/harness/handoff/.gitkeep
```

No other source, package manifest, release script/manifest, U2 terminal usage,
or U5 erasure surface is in scope.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Required red-to-green evidence

Before implementation, add focused red tests for the public aggregate,
expiry/revocation/tenant isolation, protocol identity projection, and parity
between WS hello and first-hop presence. Capture the failing output. Then run
the corresponding targeted tests after implementation.

The final evidence set must include, where the environment permits:

1. focused U3 core/cloud/protocol/client tests;
2. a real Postgres readiness test against the repository's configured test
   database, including migration application and in-memory/Postgres parity;
3. `bun run build`;
4. `bun run typecheck`;
5. `bun run test`;
6. `repo-harness run check-task-workflow --strict`;
7. `repo-harness run verify-contract --strict` (or the repository's exact
   contract-verification invocation);
8. a clean candidate pack/smoke check only if it is required by the existing
   task workflow; it must not publish or mutate a registry.

Do not represent local evidence as registry or production evidence. A missing
real-Postgres service, blocked harness, or unrelated pre-existing failure is a
reported residual risk, not permission to weaken this contract.

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
    - docs/protocol.md
    - deploy/sql/0010_tenant_readiness.sql
    - packages/core/src/presence.ts
    - packages/cloud/src/cloud.ts
    - packages/cloud-dataplane/src/stores/devices.ts
    - packages/client/src/daemon/create-daemon.ts
    - packages/protocol/src/http-api.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260821-1715-tenant-readiness-primitives.notes.md
    - tasks/reviews/20260821-1715-tenant-readiness-primitives.review.md
  tests_pass:
    - path: packages/cloud/src/__tests__/tenant-readiness.test.ts
    - path: packages/cloud-dataplane/src/__tests__/tenant-readiness.test.ts
    - path: packages/client/src/__tests__/tenant-readiness.test.ts
    - path: packages/protocol/src/__tests__/tenant-readiness.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - repo-harness run check-deploy-sql-order
```

## Exit conditions

The contract is complete only when the public API, both store compositions,
protocol projections, and client first-hop paths satisfy the objective and all
required feasible checks have current output. Any remaining failure must be
reported with the exact command/output and a bounded parent action.
