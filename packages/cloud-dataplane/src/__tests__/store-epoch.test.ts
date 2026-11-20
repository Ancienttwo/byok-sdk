/**
 * The store wire-epoch fence on the Worker-loadable cloud composition (#1757
 * D-7). Wire v8 starts on a new database: `0041_wire_v8.sql` refuses a
 * database that holds rows and then writes `byok_wire_epoch`, and
 * `createPostgresCloudStores` refuses any epoch but `PROTOCOL_VERSION`.
 *
 * Two layers: a substrate-free one over a recording pool stand-in, which pins
 * the typed refusal and the read-only SQL and runs everywhere; and a Postgres
 * one over the real `deploy/sql`, which skips without the dataplane substrate.
 */
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createMutableClock } from '@byok-sdk/core';
import { PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { migrate } from '../migrate';
import { createByokPool, type ByokPool } from '../pool';
import * as runtime from '../runtime';
import {
  createPostgresCloudStores,
  POSTGRES_STORE_EPOCH_UNSUPPORTED,
  PostgresStoreEpochUnsupportedError,
  type PostgresObjectStorageOptions,
} from '../stores/index';
import { createDataplaneScope, POSTGRES_URL, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

/** Install the released wire v7 schema before exercising the v8 cut. */
async function wireV7Migrations(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'byok-wire-v7-'));
  for (const name of await readdir(DEPLOY_SQL)) {
    if (name.endsWith('.sql') && name < '0041') await copyFile(join(DEPLOY_SQL, name), join(directory, name));
  }
  return directory;
}

/** Constructing the blob store opens no connection, so a static config is enough for the fence. */
const OBJECT_STORAGE: PostgresObjectStorageOptions = {
  endpoint: 'http://127.0.0.1:9',
  bucket: 'byok-store-epoch',
  accessKeyId: 'unused',
  secretAccessKey: 'unused',
  region: 'us-east-1',
  signingClock: { now: () => new Date() },
};

/** A never-connected pool whose `query` answers the epoch reads: `undefined` is a database without the table. */
function epochPool(epoch: number | undefined): { readonly pool: ByokPool; readonly queries: string[] } {
  const queries: string[] = [];
  const pool = Object.assign(createByokPool({ connectionString: 'postgres://byok:byok@127.0.0.1:1/never_connected' }), {
    async query(sql: string) {
      queries.push(sql);
      return sql.includes('to_regclass') ? { rows: [{ present: epoch !== undefined }] } : { rows: [{ epoch }] };
    },
  }) as unknown as ByokPool;
  return { pool, queries };
}

const compose = (pool: ByokPool) =>
  createPostgresCloudStores({ rateLimit: { tokensPerSecond: 1_000, burst: 1_000 }, pool, clock: createMutableClock(), crypto: createWebCrypto(), objectStorage: OBJECT_STORAGE });

describe('store wire-epoch fence (substrate-free)', () => {
  it('is exported from the Worker runtime entry, and the factory has no synchronous form', () => {
    expect(runtime.PostgresStoreEpochUnsupportedError).toBe(PostgresStoreEpochUnsupportedError);
    expect(runtime.POSTGRES_STORE_EPOCH_UNSUPPORTED).toBe('POSTGRES_STORE_EPOCH_UNSUPPORTED');
    const pending = compose(epochPool(PROTOCOL_VERSION).pool);
    expect(pending).toBeInstanceOf(Promise);
    return pending;
  });

  it('returns the full composition over a database of this epoch, after read-only queries', async () => {
    const { pool, queries } = epochPool(PROTOCOL_VERSION);
    const stores = await compose(pool);
    expect(Object.keys(stores).sort()).toEqual([
      'activity', 'agentMessageDraft', 'approvals', 'blobs', 'cancellations', 'dedup', 'devices', 'egress', 'nonces',
      'pairing', 'pairingCodes', 'proofReceipts', 'rateLimiter', 'receipts', 'steerRefusals', 'taskArchive', 'tasks',
    ]);
    for (const sql of queries) expect(sql.trimStart()).toMatch(/^SELECT /u);
  });

  it.each([
    ['no epoch table', undefined],
    ['an older epoch', PROTOCOL_VERSION - 1],
    ['a newer epoch', PROTOCOL_VERSION + 1],
  ])('refuses %s with the typed error and returns no stores', async (_label, epoch) => {
    const refusal = await compose(epochPool(epoch).pool).then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(PostgresStoreEpochUnsupportedError);
    expect(refusal).toMatchObject({ code: POSTGRES_STORE_EPOCH_UNSUPPORTED, requiredEpoch: PROTOCOL_VERSION });
    expect((refusal as PostgresStoreEpochUnsupportedError).foundEpoch).toBe(epoch);
  });
});

describe.skipIf(SKIP_DATAPLANE)(`store wire-epoch fence [postgres] — ${SKIP_REASON}`, () => {
  it('opens epoch 8 on a new database', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      expect((await scope.pool.query('SELECT epoch FROM byok_wire_epoch')).rows).toEqual([{ epoch: PROTOCOL_VERSION }]);
      expect((await compose(scope.pool)).steerRefusals).toBeDefined();
    } finally {
      await scope.dispose();
    }
  });

  it('refuses to migrate a database that holds rows, changes nothing, and the composition refuses it', async () => {
    const scope = await createDataplaneScope();
    const directory = await wireV7Migrations();
    try {
      await migrate(scope.pool, directory);
      // Host configuration counts: a new database has none before its migrations finish.
      await scope.pool.query(
        `INSERT INTO storage_entitlement (tenant_id, version, hard_limit_bytes, max_object_bytes, max_inline_bytes, mailbox_limit_bytes, retention_policy_id)
         VALUES ('tenant-v7', 1, 1000, 100, 10, 1000, 'default')`,
      );
      const ledger = async () => (await scope.pool.query('SELECT version FROM byok_schema_migration ORDER BY version')).rows;
      const before = await ledger();

      await expect(migrate(scope.pool, DEPLOY_SQL)).rejects.toThrow('0041_wire_v8: table storage_entitlement holds rows');
      expect(await ledger()).toEqual(before);
      expect((await scope.pool.query('SELECT epoch FROM byok_wire_epoch')).rows).toEqual([{ epoch: 7 }]);
      await expect(compose(scope.pool)).rejects.toMatchObject({ code: POSTGRES_STORE_EPOCH_UNSUPPORTED, requiredEpoch: PROTOCOL_VERSION });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await scope.dispose();
    }
  });

  it('reads partitions in another schema, and ignores the rest of a shared database', async () => {
    const scope = await createDataplaneScope();
    const other = `${scope.schema}_other`;
    const admin = createByokPool({ connectionString: POSTGRES_URL!, max: 1 });
    const directory = await wireV7Migrations();
    try {
      await migrate(scope.pool, directory);
      await admin.query(`CREATE SCHEMA "${other}" AUTHORIZATION "${scope.role}"`);
      await scope.pool.query(`CREATE TABLE host_partitioned (k integer NOT NULL) PARTITION BY LIST (k)`);
      await scope.pool.query(`CREATE TABLE "${other}".leaf PARTITION OF host_partitioned FOR VALUES IN (1)`);
      await scope.pool.query(`CREATE TABLE "${other}".unrelated (k integer)`);
      await scope.pool.query(`INSERT INTO "${other}".unrelated VALUES (1)`);
      await scope.pool.query(`INSERT INTO "${other}".leaf VALUES (1)`);

      await expect(migrate(scope.pool, DEPLOY_SQL)).rejects.toThrow('0041_wire_v8: table host_partitioned holds rows');
      await scope.pool.query(`DELETE FROM "${other}".leaf`);
      await expect(migrate(scope.pool, DEPLOY_SQL)).resolves.toMatchObject({ applied: ['0041_wire_v8.sql'] });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS "${other}" CASCADE`);
      await admin.end();
      await scope.dispose();
    }
  });
});
