# @byok-sdk/cloud-dataplane

The durable data plane for the BYOK SDK's hosted device surface: Postgres
implementations of **all ten cloud-local store ports and all seven `@byok-sdk/core`
ports**, the R2/S3 object adapter that backs the blob port, and the forward-only
migration runner that creates the tables they read.

Four store/maintenance compositions plus one transaction authority ship from here. `createPostgresCloudStores` supplies the full
`CloudStores` bundle (`activity`, `devices`, `pairingCodes`, `nonces`, `dedup`, `tasks`,
`receipts`, `proofReceipts`, `blobs`, `rateLimiter`); `createPostgresCoreStores`
supplies the full `CoreStores` bundle (`mailbox`, `board`, `truth`, `presence`,
`objects`, `quota`, `skillPacks`). Both return every port rather than a subset,
because the conformance suites certify a composition as a whole — there is no
partial bundle for them to run. `createPostgresCloudMaintenance` is the third,
host-only operational composition; `createPostgresTenantErasure` is the fourth,
Node-only destructive operator composition. Both deliberately sit outside port
inventories.

`PostgresDeviceAssertionReplayAuthority` is a separate online security
authority for connector-binding exchanges. Its unique key makes consumption an
atomic `INSERT ... ON CONFLICT DO NOTHING` decision, and bounded expiry cleanup
keeps the short-lived ledger finite. It is intentionally not a `CloudStores`
member: hosts opt into assertion exchange explicitly, while connector sessions
and provider credentials stay outside this package.

`PostgresTruthCommitter` is the S6 transaction authority rather than another
raw store bundle. It owns the one transaction that couples proof receipt,
terminal/snapshot preconditions, committed object checks, object references,
tenant/hash inline logical accounting and the stored response. A production
cloud composition declares `truth.records` only when it supplies both this
committer and `stores.blobs` as the content-hash keyed `TruthObjectDownloads`
authority; `R2CloudBlobStore` uses the content hash as its blob id, so it
satisfies that contract directly.

```ts
const stores = await createPostgresCloudStores(options);
const truthCommitter = new PostgresTruthCommitter({ pool, clock, crypto });
const mailboxWake = createPostgresMailboxWake({ connectionString: sessionDsn, onError: reportWakeError });

createByokCloud({
  mailboxWake,
  // core, cloud: stores, crypto, tokenSigner, clock, capabilities, ...
  truthCommitter,
  truthObjectDownloads: stores.blobs,
});
```

Two of those nine are not tables. `rateLimiter` is the allow-all reference and
gets no table by design: persisting an allow-all would be a table that is always
empty, and a real limiter is edge work rather than a per-request write. That
limiter only covers authenticated devices; the unauthenticated pair, challenge
and token routes reach Postgres on every request and need an edge limit (or
`createByokCloud`'s `publicRouteLimiter`) — see
`deploy/runbooks/hosted-operations.md`, "Public routes and edge rate limits".
`blobs` is the R2 adapter described below.

### Wire-major startup fence

`createPostgresCloudStores` is async. Before it returns any store it reads every
pending mailbox (`outbox`) row and rejects with
`PostgresMailboxProtocolUnsupportedError` (`code`
`POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED`, plus `requiredVersion`, `tenantId`,
`deviceId` and `seq` of the first offending row) if any body is not a wire
envelope of the build's `PROTOCOL_VERSION` (3). Acked and expired rows are
history and are not inspected. The check is read-only: no row is rewritten,
reclassified or deleted, and there is no synchronous variant that skips it.

When it fails, keep the database and drain the mailbox with the previous SDK
(stop new submissions, let every pending row be delivered and acked), then
upgrade; or start a new database and re-enroll devices, with the Host
resubmitting unfinished work from its own intent. `createPostgresCoreStores`
carries no fence: the core `MailboxStore` port treats bodies as opaque, and only
the cloud composition gives them wire-envelope meaning.

The scan walks the pending rows of every tenant in primary-key pages, so it
costs one read of the pending mailbox per composition. On Workers the
composition is built per invocation (see below), so that read happens on every
invocation.

## Deployment compositions

Two entries, one data plane, and the host picks the composition explicitly —
the SDK never detects where it is running and never falls back between the two.

- **Node/VPS resident service.** Import the package root
  (`@byok-sdk/cloud-dataplane`) and talk to Postgres and R2/S3 directly. The
  migration runner, cleanup/maintenance, and tenant erasure run in-process:
  this is the entry that carries the Node-only operations.
- **Cloudflare Workers.** Import `@byok-sdk/cloud-dataplane/runtime` — the
  online request path alone (pool, both store compositions, R2 blob store,
  truth committer). Its graph never reaches a node builtin beyond what
  `nodejs_compat` provides, so `pg` stays external in this package's build and
  is satisfied by the platform: Hyperdrive terminates the database connection,
  and R2 is reached over `fetch` with `aws4fetch`. Migrations, cleanup, and
  tenant erasure have
  no place on a Worker — they read files off disk — so run them from a CI job
  or an operator's Node process against the direct DSN:

  ```ts
  import { createByokPool, createPostgresCloudStores } from '@byok-sdk/cloud-dataplane/runtime';

  const pool = createByokPool({ connectionString: env.BYOK_PG.connectionString });
  ```

  Pool lifecycle follows the composition. On Node/VPS the Pool is
  process-scoped, and the host calls `pool.end()` at shutdown. On Workers,
  create the Pool inside each `fetch`/`queue` handler — per invocation,
  exactly like the `worker-smoke` probes already do — and never hold one in
  module or global scope: cross-request pool reuse is forbidden, not a
  preference. A Worker invocation's end cleans up its client connections, so
  `pool.end()` is usually unnecessary there.

Same contracts, same SQL, same Postgres + R2 authority either way. There is no
D1 and no Durable Objects variant, and the runtime entry is a strict subset of
the root rather than a second implementation: `src/index.ts` re-exports
`src/runtime.ts` wholesale, so the two surfaces cannot drift. The boundary is
build-enforced — the runtime entry compiles under the neutral platform, which
fails the build the moment its graph reaches a node builtin — and CI exercises
the Worker composition for real through the `worker-smoke/` fixture (packaged
with `wrangler deploy --dry-run`, served by `wrangler dev` against the test
substrate; see Testing below).

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

### `keyPrefix`: one bucket, several deployments

Object keys default to `tenants/<tenant>/objects/sha256/<hex>` at the bucket
root. `R2BlobStoreOptions.keyPrefix` puts a namespace in front of that —
`keyPrefix: 'acme/prod'` writes `acme/prod/tenants/<tenant>/objects/sha256/<hex>`
— so a host running more than one product against one R2 account no longer needs
a bucket per product. Omit the option and the key is the unprefixed layout, byte
for byte.

**It is immutable per deployment, and it is only for a new one.** The same field
builds the key on write and on read; nothing falls back to a second layout, and
nothing will be added that does — a dual-read across an old and a new prefix
would make two key layouts authoritative for the same object at the same time.
So changing `keyPrefix` on a deployment that has already stored objects strands
them: still in the bucket, no longer addressable, invisible to the cleanup
maintenance surface. Moving an existing deployment onto a prefix means a
separate, operator-invoked, one-shot copy of the objects themselves, which this
SDK does not provide.

The value is validated when the store is constructed, never afterwards (there is
no setter): slash-joined segments of lowercase alphanumerics, `.`, `_` and `-`,
each segment starting with an alphanumeric — no leading or trailing slash, no
empty segment, no uppercase, nothing that would be percent-encoded. Anything else
throws a `ByokCoreError` with code `object_key_prefix_invalid` at construction.
`keyPrefix: ''` is refused rather than treated as "no prefix": an empty string is
what an unset environment variable looks like, and accepting it would silently
decide where a deployment's objects live.

`x-amz-checksum-sha256` is deliberately not signed. The S4A-c probe found the
then-substrate MinIO honoring it, but R2's S3 compatibility table implements SHA-256 as `COMPOSITE` only — not the
`FULL_OBJECT` type a single-shot PutObject uses — so signing it would mint URLs
that pass against the test substrate and fail in production. `HEAD` only
observes existence, size and content type; it never verifies SHA-256.

## Cleanup maintenance

`createPostgresCloudMaintenance` builds the separate host-operations
composition. It intentionally does not add methods to the conformance-certified
`CloudBlobStore`: LIST/HEAD/DELETE, dead-letter replay and
usage rebuild are host operations, not device blob capabilities.

The Host scheduler calls `cloud.runMaintenance({ tenant, now, policy, limit })`.
Read the existing policy with
`new PostgresRetentionPolicyStore(pool, clock).readRetentionPolicy(tenant)`
from `@byok-sdk/cloud-dataplane/runtime` and pass it directly: its four fields
use the kernel's bigint milliseconds. Policy writes use the same store; a missing
entitlement-selected policy fails closed.
`createPostgresCoreStores` requires the real `objectStorage` configuration;
standalone `PostgresObjectStore` requires a physical deletion authority.
Each port has one bounded `collectExpired`, and each object consumes one
shared retry/tombstone/delete budget. PG holds the same-hash manifest row
across physical deletion and accounting settlement to prevent concurrent
recreation from losing bytes. `cleanup_job` remains installed without writers.

`reconcileObjectStorage(tenant)` is an explicit operator API. A previously
untracked R2 key first becomes a pending witness and waits fresh orphan grace.
See `deploy/runbooks/cloud-cleanup.md` for reports, scheduling, replay/discard,
crash recovery and accounting repair. Identity receipts and redeemed pairing
code rows remain protected; the production request receipt class is empty.

`@byok-sdk/cloud` is a stateless handler package — it serves the frozen v1 device
wire contract over ports and owns no storage. This package is one composition of
those ports. It sits here rather than inside `@byok-sdk/cloud` for two reasons: a
`hono` user should not be made to install a database driver, and `@byok-sdk/core`
and `@byok-sdk/cloud` stay loadable on Workers precisely because `pg` never enters
their dependency graph.

## Tenant erasure

`createPostgresTenantErasure` is a separate Node-only operator primitive, not a
zero-retention shortcut and not `PostgresCloudCleanup` with a different cursor.
It owns the product-table inventory, FK-safe deletion order, one operation id,
CAS lease, bounded R2/SQL pages, and completed receipt. The
`tenant_erasure_operation` row is package/operator control evidence rather than
tenant product data: it deliberately remains after completion. The migration
ledger, deployment config, and every other tenant are never touched.

The host must authorize the request and quiesce product writes before starting;
the SDK cannot manufacture a host write fence. Use a direct Postgres DSN, never
a request-path pooler, and configure the exact same immutable `keyPrefix` used
by the serving blob composition.

```ts
import {
  createByokPool,
  createPostgresTenantErasure,
  type TenantErasureResult,
} from '@byok-sdk/cloud-dataplane';

const pool = createByokPool({ connectionString: env.BYOK_DIRECT_DATABASE_URL });
const erasure = createPostgresTenantErasure({
  pool,
  clock: { now: () => new Date() },
  objectStorage: {
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
    keyPrefix: 'production', // omit only when the deployment has always been unprefixed
    signingClock: { now: () => new Date() },
  },
});

const result: TenantErasureResult = await erasure.eraseTenant(tenantId, operationId);
// `outstanding` / `partial`: retry the same operationId; `conflict`: another
// unfinished operation owns this tenant; `completed`: retain the receipt.
```

Erasure lists only the canonical `tenants/<tenant>/objects/sha256/...` namespace
(with the configured deployment prefix), deletes each listed canonical object
before any product table page, and persists progress only after the delete
returns. A missing/canonical object is a replay-safe delete; a malformed key
under that namespace is schema/layout drift and returns typed `partial` without
starting SQL deletion. A response loss/crash between R2 and SQL replays the
object deletion before it can advance to rows. See
`deploy/runbooks/tenant-erasure.md` for the operator sequence and recovery
rules.

Dependency direction is one-way: `cloud-dataplane → core + cloud + protocol +
pg +` the explicit S3 signer/XML parser. The protocol edge is used only by the
host-owned dead-letter replay path to rebind frozen envelope bytes to the new
mailbox sequence; core remains protocol-free. Nothing depends back on it; no ambient AWS
credential-provider chain is installed.

## E2EE member state

`PostgresE2eeMemberStore` is the store behind the E2EE member calls of
`ByokCloud` (#654 E2c): `appendMemberChainEntries`, `readMemberChain`,
`putScopeKeyPackages`, `readScopeKeyPackages`, `readMemberKeyRegistration` and
`relayClientPairingMac`. It ships from `./runtime`. Pass it as the
`e2eeMemberStore` option; without it, those calls throw
`e2ee_member_store_unavailable`.

```ts
import { PostgresE2eeMemberStore } from '@byok-sdk/cloud-dataplane/runtime';

const cloud = createByokCloud({
  // ...the usual stores...
  e2eeMemberStore: new PostgresE2eeMemberStore(pool, clock),
});
```

Migration `0027_e2ee_member.sql` adds five tables. The store keeps each signed
value as the canonical JSON the writer sent, so a replay compares by bytes. It
holds no key and verifies no signature; members do.

- `e2ee_member_chain_entry`: first writer wins per `(tenant_id, seq)`. An
  append must start at the stored head plus one.
- `e2ee_scope_epoch`: the first package of a scope epoch fixes its `keyId`.
  A package with another `keyId` is refused; a package with the same `keyId`
  replaces its recipient's row (a KEM re-wrap).
- `e2ee_scope_key_package`, `e2ee_member_key` and `e2ee_pairing_mac`: the
  packages, the device registrations and the pairing MACs. A MAC is returned
  only before its expiry; the next write replaces it, so there is no sweep.

Device revocation and machine supersession delete the device's registration,
MACs and the packages addressed to its member in the device transaction.
Tenant erasure deletes all five tables.

Migration `0029_e2ee_member_kem_floor.sql` adds `e2ee_member_kem_floor`: an
append that stores a `rotate` entry raises its member's KEM floor, and a
package put refuses a package below its recipient's floor with
`e2ee_scope_key_package_stale`. Both take the member's transaction lock after
the scope locks. It also adds the index of the device's paged read of its own
packages. Tenant erasure deletes the floor table too.

## Task redaction

`createPostgresTaskRedactionStore` is the store behind `ByokCloud.redactTasks`
(#654 E5a). It ships from `./runtime`, so a Worker can run it over Hyperdrive.
Pass it as the `taskRedactionStore` option; without it, `redactTasks` throws
`task_redaction_unavailable`.

```ts
import { createPostgresTaskRedactionStore } from '@byok-sdk/cloud-dataplane/runtime';

const cloud = createByokCloud({
  // ...the usual stores...
  taskRedactionStore: createPostgresTaskRedactionStore({ pool, clock, objectStorage }),
});
const { tasks } = await cloud.redactTasks(tenantId, { taskIds: ['task-1'] });
// Per task: `redacted`, `already_redacted`, `not_found`, or `refused` with
// `task_not_terminal` / `pending_delivery`. A refused task can be retried.
```

For each terminal task the store replaces the stored bodies (task receipts,
the Agent message admission, acked and expired mailbox rows) with a body-free
tombstone that keeps the SHA-256, the byte length and the envelope type. Rows
stay, so receipt fences, mailbox cursors and the dead-letter floor keep their
meaning. It clears the free-text `task` columns, deletes the activity, approval
and draft rows, and deletes each object that the bodies name when no reference,
reserved upload, other receipt body or pending mailbox row of the tenant holds
it (a substring match on the hash, one unindexed scan per object). An object that only a running task's upload names is not seen (E3b). Use the same `objectStorage` (and `keyPrefix`) as
the blob composition. When the task has no terminal receipt, the store writes a
tombstone under that key, so a late device terminal stores nothing. The objects
go first and the rows next, so a retry after any failure is safe; until the
retry, the bodies can name deleted objects. A `task-redaction:<taskId>` receipt
records the counts. A late progress or approval report can add a row after the
call; call it again to delete that row. Backups, replicas and logs are not
reached.

## Migrations

Schema is authored in the repository's `deploy/sql/` directory as plain SQL
files named `NNNN_description.sql`. The four-digit prefix is the only ordering
authority — the same one `bun run check:deploy-sql` enforces in CI.

Those files ship inside this package: the build copies them into `dist/sql/`,
and `migrationsDir()` returns that directory from wherever the package is
installed. A host owns **when** migrations run, not a copy of their bytes —
vendoring the SQL into your own repository would make that copy a second source
of truth, free to drift from the runner installed beside it.

```ts
import {
  createByokPool,
  migrate,
  migrationsDir,
  verifyMigrations,
} from '@byok-sdk/cloud-dataplane';

const pool = createByokPool({ connectionString: process.env.DATABASE_URL! });
const result = await migrate(pool, migrationsDir());
console.log(result.applied); // e.g. ['0001_cloud_local.sql', ..., '0004_device_proof_truth.sql']
const applied = await verifyMigrations(pool);
console.log(applied); // exact ordered [{ version, checksum }, ...] rows
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

`verifyMigrations(pool, directory = migrationsDir())` is a Node-only root export
for readiness/readback checks. It reads the package migration files and the
existing `byok_schema_migration` ledger, returning exact rows in migration order
only when every version and checksum matches. Missing rows, unexpected rows,
checksum drift, and an absent ledger table throw one aggregate
`MigrationStateMismatchError` with stable `issues` ordering. Verification never
creates the ledger or applies migrations; `./runtime` does not export it.

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
bun run --filter @byok-sdk/cloud-dataplane test
```

Both variables, one gate: the compose file starts Postgres and SeaweedFS together,
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
- The object suite, against the compose SeaweedFS (pinned by tag and digest; it
  replaced MinIO when MinIO withdrew its public images). Seven of its nine
  assertions are about what a presigned URL binds to, and a binding asserted
  against our own verifier is self-certifying — so SeaweedFS adjudicates them
  as an independent SigV4 implementation, and nothing stubs a signature check.
  The two that are about retry semantics go through a fault injector wrapped
  around `fetch`, which replaces individual attempts and never answers a
  request itself.
- The worker suites, always for packaging and opt-in for serving:
  `worker-packaging.test.ts` dry-runs `wrangler deploy` over `worker-smoke/`
  on every run, and `worker-e2e.test.ts` additionally serves that fixture with
  `wrangler dev` (local workerd) against the same Postgres when you set
  `BYOK_TEST_WORKER_DATAPLANE=1`. CI's `dataplane` job sets it, plus the
  `BYOK_REQUIRE_WORKER_DATAPLANE` flag that turns an unmet gate into a hard
  failure.

## License

MIT. Node.js 24.22.1 or newer.

## Wake-driven long-poll migration (#410)

Apply `0024_mailbox_wake.sql` through the package migration runner. Its
`outbox` AFTER INSERT trigger signals pending rows at commit, covering normal
append, atomic cancellation and dead-letter replay. Rollback does not notify.
The fixed-size `md5(tenant_id || '\n' || device_id)` payload contains no ids or
message contents. Hash collisions cause extra reads, never a lost delivery.

On Node, import `createPostgresMailboxWake` from the package root, create one
instance per process with a **session-mode DSN**, and inject it into
`createByokCloud({ mailboxWake, ... })`. It owns one dedicated `pg.Client` and
never takes a pool slot, even with many simultaneous holds. Add one connection
per process to the `max_connections` budget. At shutdown await
`mailboxWake.close()` as well as `pool.end()`.

The listener reconnects with bounded exponential backoff and wakes every local
subscription after each successful LISTEN. A self-NOTIFY probe checks each new
connection; missing notifications and connection failures go to `onError`, or
to the default labelled console error. `probeTimeoutMs` defaults to 5 seconds.
`onError` must not throw. A transaction-mode PgBouncer DSN cannot keep a LISTEN
session; the probe reports this configuration failure. Hints may be lost or
repeated, so `fallbackMs` (default 5 seconds) still bounds delivery latency.

The listener is Node-only and absent from `./runtime`. Hyperdrive cannot carry
LISTEN/NOTIFY. Workers Hosts import the portable runtime stores and inject a
new `createInProcessMailboxWake({ fallbackMs: 1_000 })` from `@byok-sdk/cloud`
per invocation; cross-isolate writes are observed within that interval.
A low-latency Durable Object wake is outside this package's current scope.

Deployment order is independent of correctness: new code without the trigger
uses fallback reads; the trigger without listeners only emits unused hints.
`longPollIntervalMs` and `DEFAULT_LONG_POLL_INTERVAL_MS` are deleted. Do not
carry the old hold loop alongside the wake port.

Runtime dependencies and size budgets: [entry dependency contract](../../README.md#entry-dependencies).
