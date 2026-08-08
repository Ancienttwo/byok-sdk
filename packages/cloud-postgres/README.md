# @byok/cloud-postgres

The durable data plane for the BYOK SDK's hosted device surface: Postgres
implementations of **all nine cloud-local store ports and all seven `@byok/core`
ports**, the R2/S3 object adapter that backs the blob port, and the forward-only
migration runner that creates the tables they read.

Two compositions ship from here. `createPostgresCloudStores` supplies the full
`CloudStores` bundle (`devices`, `pairingCodes`, `nonces`, `dedup`, `tasks`,
`receipts`, `sequence`, `blobs`, `rateLimiter`); `createPostgresCoreStores`
supplies the full `CoreStores` bundle (`mailbox`, `board`, `truth`, `presence`,
`activity`, `objects`, `quota`). Both return every port rather than a subset,
because the conformance suites certify a composition as a whole — there is no
partial bundle for them to run.

Two of those nine are not tables. `rateLimiter` is the allow-all reference and
gets no table by design: persisting an allow-all would be a table that is always
empty, and a real limiter is edge work rather than a per-request write. `blobs`
is the R2 adapter described below.

## Blobs

`blobs` mints grants and never carries a byte. `createUpload` writes the
`pending` `object_manifest` row first, then signs a PUT bound to the tenant, the
key, the declared `Content-Length`, the declared `Content-Type`, and an expiry;
the device uploads straight to the object store. `pending → committed` happens
on first download, behind an unconditional `HEAD` that compares what the store
actually holds against what was declared — a signed length proves what one
client sent, not what is at the key now.

Two consequences worth stating outright:

- **This composition supplies no `BlobContentProxy`.** The two
  `/byok/blobs/:id/content` routes exist for compositions that have nowhere else
  to put bytes; a device uploading directly to R2 is exactly what having no
  byte-proxy path means. A hosted deployment therefore declares
  `blobs.presigned` and **not** `blobs.contentproxy`, and the routes do not
  mount. See `deploy/env/hosted.env.example`.
- **The `blobId` is the content hash.** There is no surrogate object id, so
  every read is `(tenant, hash)` against the manifest primary key and object
  keys are built at one point from a value core already validated. A non-hex id
  cannot become a `ContentHash`, so it cannot reach key construction.

`x-amz-checksum-sha256` is deliberately not signed. MinIO honors it, but R2's S3
compatibility table implements SHA-256 as `COMPOSITE` only — not the
`FULL_OBJECT` type a single-shot PutObject uses — so signing it would mint URLs
that pass against the test substrate and fail in production. The `HEAD`
re-verification was never conditional on it.

`@byok/cloud` is a stateless handler package — it serves the frozen v1 device
wire contract over ports and owns no storage. This package is one composition of
those ports. It sits here rather than inside `@byok/cloud` for two reasons: a
`hono` user should not be made to install a database driver, and `@byok/core`
and `@byok/cloud` stay loadable on Workers precisely because `pg` never enters
their dependency graph.

Dependency direction is one-way: `cloud-postgres → core + cloud + pg`. Nothing
depends back on it.

## Migrations

Schema lives in the repository's `deploy/sql/` directory as plain SQL files
named `NNNN_description.sql`. The four-digit prefix is the only ordering
authority — the same one `pnpm run check:deploy-sql` enforces in CI.

```ts
import { createByokPool, migrate } from '@byok/cloud-postgres';

const pool = createByokPool({ connectionString: process.env.DATABASE_URL! });
const result = await migrate(pool, '/path/to/deploy/sql');
console.log(result.applied); // e.g. ['0001_cloud_local.sql', '0002_core_domain.sql']
```

The runner:

- takes a session-level `pg_advisory_lock`, so two deploy jobs starting together
  cannot both apply the same file;
- bootstraps its own `byok_schema_migration(version, checksum, applied_at)`
  ledger — the only DDL in this package, since everything else belongs to a file
  under `deploy/sql/`;
- applies each file and its ledger row in **one transaction**, so a crash leaves
  a migration entirely applied or entirely absent;
- verifies the sha256 of every already-applied file against the ledger and
  **stops** on a mismatch. Published migrations are immutable: fix a mistake with
  a new file, never by editing an old one;
- has **no down path**. Rollback is "revert the application, leave the tables".

A consequence of per-file transactions: a statement that cannot run inside one
(`CREATE INDEX CONCURRENTLY`) cannot appear in a migration file.

## Pool

`createByokPool` exists to configure one thing that matters: `int8` columns
decode to `bigint`, not to strings. Every byte-count contract in `@byok/core` is
`bigint`, and a default-configured `pg` pool would hand the stores strings —
turning `usage.reservedBytes > limit` into a lexicographic comparison that
answers a different question without throwing. The parser is installed on the
pool config, never on the process-wide `pg.types` registry, so composing this
SDK cannot change how a host's own database code decodes results.

## Testing

The suites need a real Postgres, and get one from the repository's
`docker-compose.test.yml`:

```sh
docker compose -f docker-compose.test.yml up -d --wait
export BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test
export BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100
pnpm --filter @byok/cloud-postgres test
```

Both variables, one gate: the compose file starts Postgres and MinIO together,
and the blob port writes a manifest row and signs against the object store in
the same call. Without either, the database-backed suites skip and say so. CI's
`dataplane` job sets `BYOK_REQUIRE_DATAPLANE=1`, which turns that absence into a
hard failure — the skip path cannot be how CI stays green.

Every case migrates a fresh schema from empty through the real runner over the
real `deploy/sql/` files, so "fresh install + migrate-up" is a property of each
test rather than a step someone remembers. What runs:

- `runCloudConformance('postgres', ...)` and `runCoreConformance('postgres', ...)`
  — the same assertion source `@byok/conformance` runs against the in-memory
  compositions, with that package zero-diff. An assertion that needed a
  composition-specific branch would be a port-contract bug to escalate, not a
  test to adjust.
- `tests/sql/control_plane_invariants.sql`, executed post-migration. It asserts
  that every unique index on a tenant-owned table leads with `tenant_id`, with a
  two-entry whitelist. Operators run the identical file against a live database
  with `psql -f`; the TypeScript side only runs it and checks it did not raise.
- The migrate runner's fault suite, and the reservation-admission concurrency
  test that pins `reserve`'s no-oversell property against real contention.
- The object suite, against the compose MinIO. Seven of its nine assertions are
  about what a presigned URL binds to, and a binding asserted against our own
  verifier is self-certifying — so MinIO adjudicates them as an independent
  SigV4 implementation, and nothing stubs a signature check. The two that are
  about retry semantics go through a fault injector wrapped around `fetch`,
  which replaces individual attempts and never answers a request itself.

## License

MIT
