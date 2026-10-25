import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Command } from '@byok-sdk/example-bot-collaboration/rules/commands';
import type { CommitRequest, CommitResult } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { TEST_HOST } from './memory-subject.test-support';
import { HostedCollaborationStore, type OutcomeRoutinePorts } from './store';

// The same gate as the dataplane suites (packages/cloud-dataplane/src/__tests__/support/dataplane.ts):
// without BYOK_TEST_POSTGRES_URL the Postgres suites skip; under BYOK_REQUIRE_DATAPLANE=1 that is a failure.
export const POSTGRES_URL = process.env.BYOK_TEST_POSTGRES_URL || undefined;
if (process.env.BYOK_REQUIRE_DATAPLANE === '1' && POSTGRES_URL === undefined) {
  throw new Error('BYOK_REQUIRE_DATAPLANE=1 but BYOK_TEST_POSTGRES_URL is unset. Start the substrate with:\n'
    + '  docker compose -f docker-compose.test.yml up -d --wait\n'
    + '  export BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test');
}

/**
 * The store with its internal commit entry, which takes the K4 callback commands too (#793 D2f-6). The shared K8 commit
 * vectors send an `outcome` through it, as L's vector subject commits through `commitInLedger`.
 */
export class VectorStore extends HostedCollaborationStore {
  override commitIn(scope: string, request: CommitRequest<Command>, clock: () => number, outcome?: OutcomeRoutinePorts): Promise<CommitResult> {
    return super.commitIn(scope, request, clock, outcome);
  }
}

/** A store in a new random schema of the test database. `close` drops the schema. */
export async function openStore(): Promise<{ pool: pg.Pool; store: VectorStore; close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 4 });
  const store = new VectorStore(pool, `hosted_test_${randomBytes(6).toString('hex')}`, { host: TEST_HOST });
  await store.migrate();
  return { pool, store, async close() {
    try { await pool.query(`DROP SCHEMA IF EXISTS "${store.schema}" CASCADE`); } finally { await pool.end(); }
  } };
}
