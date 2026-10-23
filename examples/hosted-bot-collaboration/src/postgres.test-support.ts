import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { HostedCollaborationStore } from './store';

// The same gate as the dataplane suites (packages/cloud-dataplane/src/__tests__/support/dataplane.ts):
// without BYOK_TEST_POSTGRES_URL the Postgres suites skip; under BYOK_REQUIRE_DATAPLANE=1 that is a failure.
export const POSTGRES_URL = process.env.BYOK_TEST_POSTGRES_URL || undefined;
if (process.env.BYOK_REQUIRE_DATAPLANE === '1' && POSTGRES_URL === undefined) {
  throw new Error('BYOK_REQUIRE_DATAPLANE=1 but BYOK_TEST_POSTGRES_URL is unset. Start the substrate with:\n'
    + '  docker compose -f docker-compose.test.yml up -d --wait\n'
    + '  export BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test');
}

/** A store in a new random schema of the test database. `close` drops the schema. */
export async function openStore(): Promise<{ pool: pg.Pool; store: HostedCollaborationStore; close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 4 });
  const store = new HostedCollaborationStore(pool, `hosted_test_${randomBytes(6).toString('hex')}`);
  await store.migrate();
  return { pool, store, async close() {
    try { await pool.query(`DROP SCHEMA IF EXISTS "${store.schema}" CASCADE`); } finally { await pool.end(); }
  } };
}
