# @byok/cloud-postgres

The durable data plane for the BYOK SDK's hosted device surface: Postgres
implementations of the cloud-local store ports, plus the forward-only migration
runner that creates the tables they read.

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
console.log(result.applied); // e.g. ['0001_cloud_local.sql']
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
pnpm --filter @byok/cloud-postgres test
```

Without `BYOK_TEST_POSTGRES_URL` the database-backed suites skip and say so.
CI's `dataplane` job sets `BYOK_REQUIRE_DATAPLANE=1`, which turns that absence
into a hard failure — the skip path cannot be how CI stays green.

## License

MIT
