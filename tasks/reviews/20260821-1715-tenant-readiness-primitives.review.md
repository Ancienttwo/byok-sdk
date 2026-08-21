# U3 tenant readiness primitives review

Status: Pending candidate verification; parent release decision remains separate.

Review scope is limited to the contract paths. Confirm:

- tenant isolation and set-wise durable aggregation;
- `now >= expiresAt` and revoked-residual semantics in both stores;
- zero/level/multi-tenant parity;
- one U4a `localAgentRelease` authority across WS and first-hop presence;
- omission of unprobed runtime/auth facts;
- no publish/deploy/registry/production mutation and no U2/U5 surface drift.

Evidence and findings will be added after the bounded verification runs.

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
  optional active-device presence facts in the same tenant-scoped answer.

## Verification

- Candidate verification is pending. Record only current-command output after
  the committed candidate has completed targeted, real-Postgres, workspace,
  and strict-workflow checks.

## Residual risks

- Registry, publish, deploy, production migration, and production readiness
  remain unverified and unauthorized here.
