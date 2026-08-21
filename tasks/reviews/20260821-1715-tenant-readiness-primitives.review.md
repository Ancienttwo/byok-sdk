# U3 tenant readiness primitives review

Status: Partial — source and real-substrate verification passed on candidate
`a448617`; the inherited harness has no active contract/worktree pointer, so
the strict workflow and contract verification cannot complete. Parent release
decision remains separate.

Review scope is limited to the contract paths. Confirm:

- tenant isolation and set-wise durable aggregation;
- `now >= expiresAt` and revoked-residual semantics in both stores;
- zero/level/multi-tenant parity;
- one U4a `localAgentRelease` authority across WS and first-hop presence;
- omission of unprobed runtime/auth facts;
- no publish/deploy/registry/production mutation and no U2/U5 surface drift.

The source review and bounded verification are complete; the harness activation
residual is recorded below.

## P1/P2/P3 findings

- P1: durable `device` rows remain cloud/dataplane authority; `device_presence`
  remains lossy TTL observation; U4a release identity remains client authority;
  `ByokCloud.readTenantReadiness` is a host control-plane read model.
- P2: pairing/revocation and presence publication enter tenant-bound stores;
  the in-memory reference aggregates filtered presence, while Postgres joins
  the tenant's active/revoked device set to only `expires_at > now` rows in one
  SQL aggregate.
- P3: no scheduler, load score, semver gate, host fallback, capability
  heuristic, or admission path was added. At scale the SQL aggregate avoids a
  host-side list join; revoked residual rows are excluded by the durable device
  set. `TenantReadiness.devices[]` carries the durable device projection and
  optional active-device presence facts in the same tenant-scoped answer. The
  HTTP presence publisher projects the U4a runtime snapshot to bounded
  id/version/auth facts, so capabilities do not create an unbounded second
  transport contract.

## Verification

- `BYOK_REQUIRE_DATAPLANE=1 BYOK_TEST_POSTGRES_URL=… BYOK_TEST_S3_ENDPOINT=…
  bun run --filter @byok-sdk/cloud-dataplane test --
  tenant-readiness.test.ts` → PASS (1 file, 1 test) against disposable
  Postgres+MinIO, including migration application.
- `bun run build` → PASS; `bun run typecheck` → PASS (all 15 workspace
  typechecks); `bun run test` → PASS. The ordinary full suite reported its
  expected service-dependent dataplane skips, while the required readiness
  case was run separately with the real substrate above.
- `repo-harness run verify-contract --contract
  tasks/contracts/20260821-1715-tenant-readiness-primitives.contract.md
  --strict` → Partial: 21 criteria passed, including all four focused U3
  tests and deploy SQL ordering; its only failure was the strict workflow
  command below.
- `repo-harness run check-task-workflow --strict` → FAIL before code checks:
  latest trace was legacy, and the refreshed state has no active contract or
  isolated worktree. Exact first failure: `schema must be
  repo-harness-run-trace.v1; missing field: task_profile; missing field:
  active_plan; missing field: worktree`.

## Residual risks

- Registry, publish, deploy, production migration, and production readiness
  remain unverified and unauthorized here.
- Parent must activate the U3 plan/contract worktree in the harness before
  rerunning the strict workflow and contract verifier; this contract's allowed
  paths exclude those global activation pointers.
