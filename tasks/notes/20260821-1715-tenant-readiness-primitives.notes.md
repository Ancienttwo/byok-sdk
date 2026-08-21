# U3 tenant readiness primitives notes

## Evidence ledger

- Contract created before implementation: `tasks/contracts/20260821-1715-tenant-readiness-primitives.contract.md`.
- Red-test evidence: before implementation, protocol `tenant-readiness.test.ts`
  rejected `clientVersion`, cloud raised `readTenantReadiness is not a
  function`, and client presence omitted the requested frozen facts.
- Candidate `a448617` was committed before final verification. On that
  candidate, `verify-contract --strict` re-ran all four focused U3 files and
  passed them; the direct disposable Postgres+MinIO command passed the
  readiness migration, durable aggregate, expiry/revocation, isolation, and
  probe-fact assertions (1 file, 1 test).
- Workspace gates on `a448617` passed: `bun run build`, `bun run typecheck`,
  and `bun run test` (the latter includes client 125/1295, cloud 16/181,
  protocol 14/270, core 9/251, and all remaining workspace packages). The
  ordinary workspace dataplane job intentionally skipped service-dependent
  suites; the disposable Postgres+MinIO readiness command above supplied that
  separate evidence.
- `repo-harness run check-task-workflow --strict` remains blocked before code
  inspection because the inherited `.ai/harness/checks/latest.json` is a
  legacy trace, then the refreshed trace resolves no active contract or
  isolated worktree. `verify-contract --strict` passed its other 21 criteria
  but recorded this command as its sole failed criterion and set the contract
  status to `Partial`. This is a harness-activation residual, not a source or
  test failure.

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
  `conn.hello`; the presence projection deliberately sends only
  `id`/`version`/`authPresent`, never the WS capability blob. Long-poll itself
  still has no `conn.hello` frame.

## Risks

- The existing protocol has no long-poll `conn.hello`; the first-hop HTTP
  presence publication is the transport-neutral place to carry the frozen
  identity/readiness facts. This must be documented and tested against the WS
  hello projection.
- `deploy/sql/0010_tenant_readiness.sql` required the matching catalog claim in
  `tests/sql/control_plane_invariants.sql`; both paths are contract-authorized
  because the release gate rejects an unclaimed migration.
- The bounded parent action for the remaining strict failure is to activate
  this U3 plan and contract worktree through the authoritative harness
  workflow, then rerun `repo-harness run check-task-workflow --strict` and
  `repo-harness run verify-contract --contract
  tasks/contracts/20260821-1715-tenant-readiness-primitives.contract.md
  --strict`. U3's allowed paths do not include the missing active-plan or
  active-worktree pointers.
