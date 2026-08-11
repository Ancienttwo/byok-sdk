# @byok-sdk/cloud-postgres

The durable data plane for the BYOK SDK's hosted device surface: Postgres
implementations of **all ten cloud-local store ports and all seven `@byok-sdk/core`
ports**, the R2/S3 object adapter that backs the blob port, and the forward-only
migration runner that creates the tables they read.

Three store/maintenance compositions plus one transaction authority ship from here. `createPostgresCloudStores` supplies the full
`CloudStores` bundle (`devices`, `pairingCodes`, `nonces`, `dedup`, `tasks`,
`receipts`, `proofReceipts`, `sequence`, `blobs`, `rateLimiter`); `createPostgresCoreStores`
supplies the full `CoreStores` bundle (`mailbox`, `board`, `truth`, `presence`,
`activity`, `objects`, `quota`). Both return every port rather than a subset,
because the conformance suites certify a composition as a whole — there is no
partial bundle for them to run. `createPostgresCloudMaintenance` is the third,
host-only operational composition; it is deliberately outside both port
inventories.

`PostgresTruthCommitter` is the S6 transaction authority rather than another
raw store bundle. It owns the one transaction that couples proof receipt,
terminal/snapshot preconditions, committed object checks, object references,
tenant/hash inline logical accounting and the stored response. A production
cloud composition declares `truth.records` only when it supplies both this
committer and `stores.blobs` as the content-hash keyed `TruthObjectDownloads`
authority; `R2CloudBlobStore` uses the content hash as its blob id, so it
satisfies that contract directly.

```ts
const stores = createPostgresCloudStores(options);
const truthCommitter = new PostgresTruthCommitter({ pool, clock, crypto });

createByokCloud({
  // core, cloud: stores, crypto, tokenSigner, clock, capabilities, ...
  truthCommitter,
  truthObjectDownloads: stores.blobs,
});
```

Two of those ten are not tables. `rateLimiter` is the allow-all reference and
gets no table by design: persisting an allow-all would be a table that is always
empty, and a real limiter is edge work rather than a per-request write. `blobs`
is the R2 adapter described below.

## Blobs

`blobs` mints grants and never carries a byte. `createUpload` writes the
`pending` `object_manifest` row first, then signs a PUT bound to the tenant, the
key, the declared `Content-Length`, the declared `Content-Type`, and an expiry;
the device uploads straight to the object store. `pending → committed` happens
on explicit finalize, behind an unconditional `HEAD` that compares what the store
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
that pass against the test substrate and fail in production. `HEAD` only
observes existence, size and content type; it never verifies SHA-256.

## Cleanup maintenance

`createPostgresCloudMaintenance` builds the separate host-operations
composition. It intentionally does not add methods to the conformance-certified
`CloudBlobStore`: LIST/HEAD/DELETE, retention policy, dead-letter replay and
usage rebuild are host operations, not device blob capabilities.

The host calls `runTenant(tenant, jobId)` from its scheduler. Postgres stores the
job/cursor readback, eligible objects are tombstoned before R2 DELETE, and
manifest plus usage settle once after deletion. An R2 key without a manifest is
first recorded as a pending witness and waits the tenant's orphan grace; it is
never deleted from a single LIST observation. See
`deploy/runbooks/cloud-cleanup.md` for metrics, alerts, replay/discard,
crash recovery and rollback.

`@byok-sdk/cloud` is a stateless handler package — it serves the frozen v1 device
wire contract over ports and owns no storage. This package is one composition of
those ports. It sits here rather than inside `@byok-sdk/cloud` for two reasons: a
`hono` user should not be made to install a database driver, and `@byok-sdk/core`
and `@byok-sdk/cloud` stay loadable on Workers precisely because `pg` never enters
their dependency graph.

Dependency direction is one-way: `cloud-postgres → core + cloud + pg +` the
explicit S3 signer/XML parser. Nothing depends back on it; no ambient AWS
credential-provider chain is installed.

## Migrations

Schema is authored in the repository's `deploy/sql/` directory as plain SQL
files named `NNNN_description.sql`. The four-digit prefix is the only ordering
authority — the same one `pnpm run check:deploy-sql` enforces in CI.

Those files ship inside this package: the build copies them into `dist/sql/`,
and `migrationsDir()` returns that directory from wherever the package is
installed. A host owns **when** migrations run, not a copy of their bytes —
vendoring the SQL into your own repository would make that copy a second source
of truth, free to drift from the runner installed beside it.

```ts
import { createByokPool, migrate, migrationsDir } from '@byok-sdk/cloud-postgres';

const pool = createByokPool({ connectionString: process.env.DATABASE_URL! });
const result = await migrate(pool, migrationsDir());
console.log(result.applied); // e.g. ['0001_cloud_local.sql', ..., '0004_device_proof_truth.sql']
```

`migrate` still takes its directory explicitly, because the same runner also
applies `deploy/sql/` directly for this repository's deploy script and test
suites. `migrationsDir()` is the answer for anyone who installed the package and
has no checkout in reach. The release pack compares the two — filename set and
per-file sha256, in both directions — so a migration that fails to reach the
tarball fails the release instead of a deployment.

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
decode to `bigint`, not to strings. Every byte-count contract in `@byok-sdk/core` is
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
pnpm --filter @byok-sdk/cloud-postgres test
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
  — the same assertion source `@byok-sdk/conformance` runs against the in-memory
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

MIT. Node.js 22.19.0 or newer.
