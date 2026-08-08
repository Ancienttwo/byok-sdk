# Postgres row-level security — optional hardening, not relied upon

> **Status**: documented, deliberately not enabled
> **Applies to**: any hosted deployment of `deploy/sql/` + `@byok/cloud-postgres`
> **Sprint box**: S4A.5 "Postgres optional RLS hardening documented but not relied upon"

## The ruling

Tenant isolation in this system is enforced by three layers, none of which is RLS:

1. **The port contract.** Every store method's first parameter is a required `TenantId`
   (`packages/cloud/src/stores/ports.ts`, `packages/core/src/stores.ts`), with two documented
   pre-tenant exceptions whose credential is itself what resolves the tenant.
2. **The tenant facade.** A handler never holds a `TenantId`. It receives `TenantStores`, built
   only from an authenticated `Principal`, with the tenant pre-applied to every method
   (`packages/cloud/src/tenant-stores.ts`); `constraints.test.ts` asserts no handler names a
   `TenantId` at all.
3. **The key discipline, machine-checked.** Every tenant-owned table's primary key and every
   UNIQUE index starts with `tenant_id`, asserted against `pg_index`/`pg_constraint` by
   `tests/sql/control_plane_invariants.sql` with exactly two reviewed exceptions
   (`device.device_id`, `pairing_code.code`). A query that could reach another tenant's row by a
   naked key path would have to add an index the catalog assertion refuses.

RLS is **not** a fourth layer of that list, and it is **not relied upon** by any assertion,
suite, or deployment gate in this repository. Turning it off changes nothing about the
guarantees above; turning it on changes nothing either. That is the point of writing this down.

## Why it is not the enforcement layer

A second enforcement authority is worse than one, not better:

- **Two authorities disagree silently.** If RLS is what stops a cross-tenant read, then the
  conformance suite — which runs the same assertions against an in-memory composition that has
  no database at all — is testing a different isolation model than production uses. The suite
  would go green on a port contract that leaks, and the leak would only appear the day someone
  runs the same code against a database without the policies.
- **It cannot be tested where it matters.** The catalog assertion is deterministic and
  planner-independent. An RLS assertion is a claim about a session variable being set on every
  connection in every pool in every process, which is exactly the kind of thing that is true
  until one code path opens a connection differently.
- **The credential is one role.** The composition connects as a single application role
  (`ByokPoolOptions.connectionString`). RLS policies keyed on a session GUC that the same
  application sets are a guard the application holds the key to — defense in depth against a
  SQL-injection class this codebase has no string-concatenated SQL to be vulnerable to (every
  store uses parameterized queries), not against the isolation bugs that are actually plausible.

## If a deployment wants it anyway

RLS is legitimate defense in depth for an operator whose threat model includes direct database
access by other applications sharing the instance. The shape below is what such an operator
would apply — **outside** `deploy/sql/`, as their own operational change:

```sql
-- Per tenant-owned table. `object_manifest` shown; repeat per table.
ALTER TABLE object_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_manifest FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON object_manifest
  USING (tenant_id = current_setting('byok.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('byok.tenant_id', true));
```

and every connection would have to `SET LOCAL byok.tenant_id = ...` inside each transaction.

Three consequences an operator must accept before doing this:

- **The pool is shared across tenants.** `createByokPool` hands out connections from one pool
  and the stores are tenant-first, not tenant-pinned; a `SET` that outlives a transaction would
  make the NEXT checkout of that connection read the previous tenant's scope. `SET LOCAL` inside
  an explicit transaction is the only safe form, and several store methods today are single
  autocommit statements with no transaction to scope it to.
- **The migration runner and the ledger are not tenant-scoped.** `byok_schema_migration` has no
  `tenant_id`; policies must exclude it or the runner locks itself out.
- **It is theirs to maintain.** Nothing in this repository will notice if a policy is missing
  from a table added by a later migration. If that matters to a deployment, the policy check
  belongs in that deployment's own migration review, not in `check:deploy-sql`.

## Verification

There is nothing to verify here, and that is the ruling being recorded. The layers that ARE
relied upon are verified by:

- `pnpm -r test` — the conformance suite's tenant-isolation dimension on both compositions
  (`packages/conformance/src/cloud/tenant-isolation.ts`, `.../core/tenant-isolation.ts`).
- `packages/cloud-postgres/src/__tests__/invariants.test.ts` — the catalog assertions in
  `tests/sql/control_plane_invariants.sql`, including its own mutation check.
- `packages/cloud-postgres/src/__tests__/object-suite.test.ts` — the object plane's tenant
  binding, adjudicated by the object store rather than by us.
