# U3 tenant readiness primitives notes

## Evidence ledger

- Contract created before implementation: `tasks/contracts/20260821-1715-tenant-readiness-primitives.contract.md`.
- Red-test evidence: before implementation, protocol `tenant-readiness.test.ts`
  rejected `clientVersion`, cloud raised `readTenantReadiness is not a
  function`, and client presence omitted the requested frozen facts.
- Candidate verification is in progress. Final targeted, real-Postgres,
  workspace, and strict-workflow outcomes are recorded only after their
  commands complete against the committed candidate.

## Decisions

- The SDK owns the aggregate read model; host composition must not join device
  and presence lists or derive a readiness/admission decision.
- Presence is a TTL-bounded projection. Revocation is durable authority, so a
  residual presence row never contributes to an observed online count.
- U4a `localAgentRelease.version` is the only client-version source. Missing
  runtime/auth facts remain omitted.
- PostgreSQL uses one tenant-scoped aggregate query with an injected clock;
  in-memory keeps the same observable semantics through its reference stores.
- `TenantReadiness.devices[]` is the single per-device projection: durable
  state is always present, while active-device presence facts are optional and
  revoked/expired observations are omitted.
- The first HTTP presence publication is the transport-neutral long-poll
  first-hop. It carries the same per-start release/runtime snapshot as WS
  `conn.hello`; long-poll itself still has no `conn.hello` frame.

## Risks

- The existing protocol has no long-poll `conn.hello`; the first-hop HTTP
  presence publication is the transport-neutral place to carry the frozen
  identity/readiness facts. This must be documented and tested against the WS
  hello projection.
- `deploy/sql/0010_tenant_readiness.sql` required the matching catalog claim in
  `tests/sql/control_plane_invariants.sql`; both paths are contract-authorized
  because the release gate rejects an unclaimed migration.
